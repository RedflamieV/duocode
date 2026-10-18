// Ядро DuoCode: общие чаты, где работают Claude Code и Codex.
// - каждый агент держит свою сессию (Claude session id / Codex thread id) внутри чата;
// - перед каждым ходом агент получает сводку того, что в чате произошло без него;
// - агенты вызывают друг друга через MCP-инструменты ask_codex / ask_claude (см. bridge/mcp.js);
// - подтверждения действий обоих агентов показываются прямо в чате.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const { runClaude, toolPart } = require('./agents/claude');
const { runCodex } = require('./agents/codex');
const { clip, uid } = require('./agents/util');
const { expandCodexPrompt, REVIEW_PROMPT, CODEX_INIT_PROMPT } = require('./commands');
const memory = require('./memory');
const projects = require('./projects');
const gitx = require('./git');

const AGENTS = ['claude', 'codex'];
const NAME = { claude: 'Claude', codex: 'Codex' };
const peer = (a) => (a === 'claude' ? 'codex' : 'claude');
const short = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

const INSTRUCTIONS = {
  claude: `You are running inside DuoCode, a desktop app where the user works with two coding agents in one shared chat: you (Claude Code, by Anthropic) and Codex (by OpenAI). Both of you work in the same project folder.
- You have the tool mcp__duo__ask_codex. Use it to delegate a task to Codex, to get an independent review or a second opinion, or whenever the user asks you to involve Codex. Codex's final answer comes back to you as the tool result, and the user watches Codex work live in the chat.
- A message may start with a <duocode_context> block. It is the part of the shared chat you did not take part in (messages addressed to Codex and Codex's answers). Treat it as shared chat history.
- Do not delegate trivial things, and do not ask Codex to redo finished work unless the user wants a comparison.
- When the user writes only to you, you are the lead on the task. The user did this on purpose to save tokens: call Codex yourself only when it clearly adds value (an independent review of risky changes, a second opinion on a hard decision, a parallel subtask), then continue on your own. Calling Codex costs the user's Codex limits.
- The block <duocode_memory> is the shared project memory that both agents see. When you learn a durable fact or the user makes a decision worth keeping (conventions, architecture choices, commands, gotchas), save it with the tool mcp__duo__remember. Keep notes short; do not save chatter or temporary state.
- Reply in the language the user writes in.`,
  codex: `You are running inside DuoCode, a desktop app where the user works with two coding agents in one shared chat: you (Codex, by OpenAI) and Claude Code (by Anthropic). Both of you work in the same project folder.
- You have the MCP tool ask_claude (server "duo"). Use it to delegate a task to Claude, to get an independent review or a second opinion, or whenever the user asks you to involve Claude. Claude's final answer comes back to you as the tool result, and the user watches Claude work live in the chat.
- A message may start with a <duocode_context> block. It is the part of the shared chat you did not take part in (messages addressed to Claude and Claude's answers). Treat it as shared chat history.
- Do not delegate trivial things, and do not ask Claude to redo finished work unless the user wants a comparison.
- When the user writes only to you, you are the lead on the task. The user did this on purpose to save tokens: call Claude yourself only when it clearly adds value (an independent review of risky changes, a second opinion on a hard decision, a parallel subtask), then continue on your own. Calling Claude costs the user's Claude limits.
- A <duocode_memory> block, when present, is the shared project memory that both agents see. When you learn a durable fact or the user makes a decision worth keeping (conventions, architecture choices, commands, gotchas), save it with the MCP tool remember (server "duo"). Keep notes short; do not save chatter or temporary state.
- Reply in the language the user writes in.`,
};

class Rooms extends EventEmitter {
  constructor({ store, runDir, bridge, codex, getSettings, checkpoints, worktreeDir, pickAgent }) {
    super();
    this.store = store;
    this.runDir = runDir;
    this.bridge = bridge; // { command, script, port, token }
    this.codex = codex;
    this.getSettings = getSettings;
    this.checkpoints = checkpoints;
    this.worktreeDir = worktreeDir;
    this.pickAgent = pickAgent;
    this.pipelines = new Map(); // id -> { roomId, cancelled }
    this.rooms = new Map();
    this.runs = new Map(); // messageId -> { room, agent, msg, handle }
    this.main = new Map(); // `${roomId}:${agent}` -> messageId основного хода агента
    this.queues = new Map(); // `${roomId}:${agent}` -> [{ prompt, userMsgId }]
    this.approvals = new Map(); // approvalId -> { room, msg, part, resolve, toolName }
    this.allowed = new Map(); // `${roomId}:claude` -> Set(toolName), «разрешить всегда в этом чате»
    this.dirty = new Map(); // roomId -> Set(messageId) для пакетной отправки в окно
    this.flushTimer = null;

    fs.mkdirSync(runDir, { recursive: true });

    for (const room of store.loadAll()) {
      // старые версии обрезали заголовок с хвостом «… (ещё N симв.)»
      room.title = String(room.title || '').replace(/\n?… \(ещё \d+ симв\.\)$/, '…');
      for (const m of room.messages) {
        if (m.role === 'agent' && m.status === 'running') {
          m.status = 'stopped';
          m.draft = '';
        }
        for (const p of m.parts || []) {
          if (p.kind === 'approval' && p.status === 'pending') p.status = 'expired';
          if (p.kind === 'delegate' && p.status === 'running') p.status = 'stopped';
          if (p.kind === 'tool' && p.status === 'running') p.status = 'stopped';
        }
        if (m.role === 'user') m.queued = [];
      }
      this.rooms.set(room.id, room);
    }
  }

  // ---------- Чтение ----------

  summary(room) {
    const running = {};
    for (const a of AGENTS) running[a] = [...this.runs.values()].some((r) => r.room.id === room.id && r.agent === a);
    const waiting = [...this.approvals.values()].some((ap) => ap.room.id === room.id);
    return { id: room.id, title: room.title, cwd: room.cwd, projectId: room.projectId || null, updatedAt: room.updatedAt, settings: room.settings, context: room.context || {}, running, waiting };
  }

  list() {
    return [...this.rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((r) => this.summary(r));
  }

  get(id) {
    const room = this.rooms.get(id);
    return room ? { ...room, ...this.summary(room) } : null;
  }

  // ---------- Изменение ----------

  create({ cwd, title, projectId = null }) {
    const now = Date.now();
    const defaults = this.getSettings().newChat || {};
    const room = {
      id: uid('room-'),
      title: title || 'Новый чат',
      cwd,
      projectId,
      createdAt: now,
      updatedAt: now,
      settings: {
        mode: defaults.mode || 'ask',
        delegation: defaults.delegation || 'auto',
        // модели и размышления для новых чатов — из Настроек → Агенты
        claudeModel: defaults.claudeModel || '',
        claudeEffort: defaults.claudeEffort || '',
        codexModel: defaults.codexModel || '',
        codexEffort: defaults.codexEffort || '',
      },
      sessions: { claude: null, codex: null },
      seen: { claude: now, codex: now },
      messages: [],
    };
    this.rooms.set(room.id, room);
    this.store.save(room, true);
    this.emitRooms();
    return this.get(room.id);
  }

  importSession({ tool, sessionId, cwd, title, projectId = null }) {
    const room = this.rooms.get(this.create({ cwd, title: short(title, 60), projectId }).id);
    room.sessions[tool] = sessionId;
    room.messages.push({
      id: uid('m'),
      role: 'system',
      ts: Date.now(),
      text: `Продолжение сессии ${NAME[tool]}: «${short(title, 120)}». ${NAME[tool]} помнит её целиком.`,
    });
    this.touch(room);
    return this.get(room.id);
  }

  rename(id, title) {
    const room = this.rooms.get(id);
    if (!room) return;
    room.title = short(String(title || '').trim(), 80) || room.title;
    // переименование не поднимает чат наверх списка
    this.store.save(room);
    this.emitRooms();
    return this.get(id);
  }

  updateSettings(id, patch) {
    const room = this.rooms.get(id);
    if (!room) return;
    room.settings = { ...room.settings, ...patch };
    this.touch(room);
    return room.settings;
  }

  remove(id) {
    this.stop(id);
    this.rooms.delete(id);
    this.store.remove(id);
    this.emitRooms();
  }

  touch(room) {
    room.updatedAt = Date.now();
    this.store.save(room);
    this.emitRooms();
  }

  // ---------- Сообщения ----------

  send(id, { text, targets, attachments = [], plan = false, duel = false, pipeline = null }) {
    const room = this.rooms.get(id);
    text = (text || '').trim();
    let routed = null;
    if (targets && targets.includes('auto')) {
      routed = this.pickAgent();
      targets = [routed.agent];
    }
    targets = (targets || []).filter((t) => AGENTS.includes(t));
    if (room && pipeline && text) return this.runPipeline(room, pipeline, text, attachments);
    if (room && duel && targets.length === 2 && text) return this.duel(room, text, attachments);
    if (!room || (!text && !attachments.length) || !targets.length) return;
    if (!text) text = 'Посмотри вложения.';
    if (/^\/[\w:.-]+/.test(text)) return this.command(room, text, targets);

    // Агенту, который сейчас работает, сообщение дописывается прямо в идущую работу.
    const fresh = [];
    for (const agent of targets) {
      const mainId = this.main.get(`${room.id}:${agent}`);
      const run = mainId && this.runs.get(mainId);
      if (run && !plan && run.handle && run.handle.steer && run.handle.steer(text, attachments)) {
        run.msg.parts.push({ id: uid('s'), kind: 'steer', text, attachments });
        this.markDirty(room, run.msg);
      } else {
        fresh.push(agent);
      }
    }
    if (!fresh.length) return this.touch(room);

    const userMsg = { id: uid('m'), role: 'user', text, targets: fresh, attachments, plan, routed: routed && routed.reason, ts: Date.now(), queued: [] };
    room.messages.push(userMsg);
    if (room.title === 'Новый чат') room.title = short(text.split('\n')[0], 60);

    for (const agent of fresh) {
      const key = `${room.id}:${agent}`;
      const job = { prompt: text, attachments, plan, userMsgId: userMsg.id };
      if (this.main.has(key)) {
        if (!this.queues.has(key)) this.queues.set(key, []);
        this.queues.get(key).push(job);
        userMsg.queued.push(agent);
      } else {
        this.runAgent(room, agent, job);
      }
    }
    this.markDirty(room, userMsg);
    this.touch(room);
  }

  // Команды «/». Встроенные работают для обоих агентов, остальные — свои команды Claude и промпты Codex.
  command(room, text, targets) {
    const [, name, rest = ''] = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(text);
    const args = rest.trim();
    const userMsg = { id: uid('m'), role: 'user', text, targets, ts: Date.now(), queued: [], command: name };
    room.messages.push(userMsg);
    this.markDirty(room, userMsg);
    const note = (t) => {
      const m = { id: uid('m'), role: 'system', ts: Date.now(), text: t };
      room.messages.push(m);
      this.markDirty(room, m);
    };

    for (const agent of targets) {
      const busy = this.main.has(`${room.id}:${agent}`);
      if (name === 'clear') {
        if (busy) {
          note(`${NAME[agent]} сейчас работает — начать с чистого листа можно после.`);
          continue;
        }
        room.sessions[agent] = null;
        room.seen[agent] = Date.now();
        if (room.memorySeen) room.memorySeen[agent] = room.memorySeen[`${agent}Dirs`] = null;
        if (room.context) room.context[agent] = null;
        note(`${NAME[agent]} начинает с чистого листа: прошлая переписка этого чата ему больше не видна.`);
        continue;
      }
      if (busy) {
        note(`${NAME[agent]} сейчас работает — команда /${name} доступна, когда он закончит.`);
        continue;
      }
      if (name === 'compact') {
        if (!room.sessions[agent]) note(`У ${NAME[agent]} пока нечего сжимать.`);
        else if (agent === 'claude') this.runAgent(room, agent, { prompt: '/compact', raw: true });
        else this.runAgent(room, agent, { prompt: '', raw: true, action: 'compact' });
      } else if (name === 'review') {
        if (agent === 'claude') this.runAgent(room, agent, { prompt: REVIEW_PROMPT + (args ? `\n\nОсобое внимание: ${args}` : '') });
        else this.runAgent(room, agent, { prompt: '', raw: true, action: 'review', review: args || null });
      } else if (name === 'init') {
        if (agent === 'claude') this.runAgent(room, agent, { prompt: '/init', raw: true });
        else this.runAgent(room, agent, { prompt: CODEX_INIT_PROMPT });
      } else if (agent === 'claude') {
        this.runAgent(room, agent, { prompt: text, raw: true });
      } else {
        const expanded = expandCodexPrompt(name, args);
        if (expanded) this.runAgent(room, agent, { prompt: expanded });
        else note(`У Codex нет команды /${name}. Свои команды Codex лежат в папке ~/.codex/prompts.`);
      }
    }
    this.touch(room);
  }

  // ---------- Откат правок ----------

  async revert(roomId, msgId, redo = false) {
    const room = this.rooms.get(roomId);
    const msg = room && room.messages.find((m) => m.id === msgId);
    const cp = msg && msg.checkpoint;
    if (!cp) return { ok: false };
    // старый формат (до проектов из нескольких папок): одна папка room.cwd
    const parts = cp.parts || [{ dir: room.cwd, before: cp.before, after: cp.after, files: cp.files }];
    const r = { restored: 0, removed: 0 };
    for (const p of parts) {
      const x = await this.checkpoints.restore(p.dir, redo ? p.after : p.before, p.files.map((f) => f.path));
      r.restored += x.restored;
      r.removed += x.removed;
    }
    cp.reverted = !redo;
    this.markDirty(room, msg);
    this.touch(room);
    return { ok: true, ...r };
  }

  async checkpointDiff(roomId, msgId, file) {
    const room = this.rooms.get(roomId);
    const msg = room && room.messages.find((m) => m.id === msgId);
    if (!msg || !msg.checkpoint) return '';
    const cp = msg.checkpoint;
    const parts = cp.parts || [{ dir: room.cwd, before: cp.before, after: cp.after, files: cp.files }];
    const many = parts.length > 1 || (cp.parts && cp.files.some((f) => f.path.includes('/') && !parts[0].files.some((x) => x.path === f.path)));
    for (const p of parts) {
      const prefix = `${path.basename(p.dir)}/`;
      const rel = p.files.find((f) => f.path === file || (many && prefix + f.path === file));
      if (rel) return this.checkpoints.diff(p.dir, p.before, p.after, rel.path);
    }
    return '';
  }

  // ---------- Дуэль: оба агента решают задачу в своих копиях проекта ----------

  async duel(room, text, attachments) {
    const userMsg = { id: uid('m'), role: 'user', text, targets: AGENTS, attachments, duel: true, ts: Date.now(), queued: [] };
    room.messages.push(userMsg);
    if (room.title === 'Новый чат') room.title = short(text.split('\n')[0], 60);
    this.markDirty(room, userMsg);
    this.touch(room);
    const note = (t) => {
      const m = { id: uid('m'), role: 'system', ts: Date.now(), text: t };
      room.messages.push(m);
      this.markDirty(room, m);
    };
    if (!(await gitx.isRepo(room.cwd))) {
      note('Раздельный режим работает только в git-репозитории — запускаю обоих в общей папке. Создать репозиторий можно в панели «Изменения».');
      for (const a of AGENTS) this.runAgent(room, a, { prompt: text, attachments });
      return;
    }
    const base = await gitx.snapshotCommit(room.cwd);
    const duelId = uid('duel-');
    const card = { id: duelId, role: 'duel', ts: Date.now(), status: 'running', base, results: {} };
    const runs = [];
    for (const a of AGENTS) {
      const dir = path.join(this.worktreeDir, `${duelId}-${a}`);
      if (!base || !(await gitx.addWorktree(room.cwd, dir, base))) {
        note('Не удалось создать отдельные копии проекта — запускаю обоих в общей папке.');
        for (const b of AGENTS) this.runAgent(room, b, { prompt: text, attachments });
        return;
      }
      card.results[a] = { dir, status: 'running' };
      runs.push(this.runAgent(room, a, { prompt: text, attachments, cwd: dir, isolated: true, duelId }));
    }
    room.messages.push(card);
    this.markDirty(room, card);
    await Promise.all(
      runs.map(async ({ msg, done }) => {
        await done;
        const res = card.results[msg.agent];
        const ch = await gitx.worktreeChanges(res.dir, base);
        const patchFile = path.join(this.worktreeDir, `${duelId}-${msg.agent}.patch`);
        fs.writeFileSync(patchFile, ch.patch);
        Object.assign(res, { status: msg.status, files: ch.files, diff: clip(ch.diff, 200000), patchFile, msgId: msg.id });
        this.markDirty(room, card);
      }),
    );
    card.status = 'pending';
    this.markDirty(room, card);
    this.touch(room);
  }

  async applyDuel(roomId, duelId, choice) {
    const room = this.rooms.get(roomId);
    const card = room && room.messages.find((m) => m.id === duelId);
    if (!card || card.status !== 'pending') return { ok: false };
    let result = { ok: true };
    if (choice !== 'none') {
      const res = card.results[choice];
      result = await gitx.applyPatch(room.cwd, res.patchFile);
      if (!result.ok) {
        card.error = `Не удалось применить вариант ${NAME[choice]}: ${result.output}`;
        this.markDirty(room, card);
        return result;
      }
    }
    card.status = choice === 'none' ? 'discarded' : `applied:${choice}`;
    card.error = null;
    for (const res of Object.values(card.results)) {
      await gitx.removeWorktree(room.cwd, res.dir).catch(() => {});
      if (res.patchFile) fs.rm(res.patchFile, () => {});
    }
    const m = { id: uid('m'), role: 'system', ts: Date.now(), text: choice === 'none' ? 'Ни один вариант не применён.' : `Применён вариант ${NAME[choice]}.` };
    room.messages.push(m);
    this.markDirty(room, m);
    this.markDirty(room, card);
    this.touch(room);
    return result;
  }

  // ---------- Сценарии: шаги по очереди, каждый видит результат предыдущих ----------

  async runPipeline(room, pipeline, task, attachments = []) {
    const id = uid('pl-');
    const state = { roomId: room.id, cancelled: false };
    this.pipelines.set(id, state);
    const steps = pipeline.steps || [];
    try {
      for (let i = 0; i < steps.length; i++) {
        if (state.cancelled) break;
        const step = steps[i];
        const agent = AGENTS.includes(step.agent) ? step.agent : 'claude';
        const label = `${pipeline.name} · шаг ${i + 1} из ${steps.length}`;
        const prompt = (step.prompt || '{task}').replace(/\{task\}/g, task);
        const userMsg = { id: uid('m'), role: 'user', text: prompt, targets: [agent], attachments: i === 0 ? attachments : [], pipeline: label, ts: Date.now(), queued: [] };
        room.messages.push(userMsg);
        if (room.title === 'Новый чат') room.title = short(task.split('\n')[0], 60);
        this.markDirty(room, userMsg);
        this.touch(room);
        // ждём, пока агент освободится от своего хода
        while (this.main.has(`${room.id}:${agent}`) && !state.cancelled) await new Promise((r) => setTimeout(r, 500));
        if (state.cancelled) break;
        const { done } = this.runAgent(room, agent, { prompt, attachments: i === 0 ? attachments : [], pipeline: label });
        const r = await done;
        if (r.error || r.stopped) break;
      }
    } finally {
      this.pipelines.delete(id);
    }
  }

  // ---------- Поиск и экспорт ----------

  search(q) {
    const needle = (q || '').trim().toLowerCase();
    if (needle.length < 2) return [];
    const out = [];
    for (const room of this.rooms.values()) {
      for (const m of room.messages) {
        const text = m.role === 'user' ? m.text : m.role === 'agent' ? m.finalText || m.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n') : '';
        if (!text) continue;
        const i = text.toLowerCase().indexOf(needle);
        if (i < 0) continue;
        const from = Math.max(0, i - 40);
        out.push({
          roomId: room.id,
          roomTitle: room.title,
          msgId: m.parentId || m.id,
          who: m.role === 'user' ? 'Вы' : NAME[m.agent],
          snippet: (from ? '…' : '') + text.slice(from, i + needle.length + 80).replace(/\s+/g, ' '),
          ts: m.ts,
        });
        if (out.length >= 60) return out;
      }
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  exportMarkdown(id) {
    const room = this.rooms.get(id);
    if (!room) return '';
    const lines = [`# ${room.title}`, '', `Проект: \`${room.cwd}\``, `Экспорт: ${new Date().toLocaleString()}`, ''];
    for (const m of room.messages) {
      if (m.role === 'user') lines.push(`## Вы → ${m.targets.map((t) => NAME[t]).join(' и ')}`, '', m.text, '');
      else if (m.role === 'system') lines.push(`> ${m.text}`, '');
      else if (m.role === 'agent') {
        const head = m.parentId ? `### ${NAME[m.agent]} (по запросу ${NAME[m.requestedBy]})` : `## ${NAME[m.agent]}${m.model ? ` · ${m.model}` : ''}`;
        lines.push(head, '');
        for (const p of m.parts) {
          if (p.kind === 'text') lines.push(p.text, '');
          else if (p.kind === 'tool') lines.push(`- _${p.title}${p.subtitle ? `: ${p.subtitle}` : ''}${p.command ? `: \`${p.command.split('\n')[0]}\`` : ''}_`);
          else if (p.kind === 'delegate') lines.push(`- _подключил ${NAME[p.to]}: ${clip(p.prompt, 200)}_`);
        }
        if (m.error) lines.push('', `**Ошибка:** ${m.error}`);
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  // Кнопки под планом Codex: выполнить или доработать.
  planAction(roomId, msgId, action, feedback) {
    const room = this.rooms.get(roomId);
    const msg = room && room.messages.find((m) => m.id === msgId);
    const part = msg && msg.parts.find((p) => p.kind === 'planReady');
    if (!part || part.status !== 'pending') return;
    part.status = action === 'run' ? 'approved' : 'revise';
    this.markDirty(room, msg);
    if (action === 'run') this.send(roomId, { text: 'План утверждён. Выполняй его.', targets: [msg.agent] });
    else this.send(roomId, { text: `Доработай план: ${feedback || ''}`.trim(), targets: [msg.agent], plan: true });
  }

  stop(id) {
    for (const [key, q] of this.queues) if (key.startsWith(id + ':')) q.length = 0;
    const room = this.rooms.get(id);
    if (room) {
      for (const m of room.messages) {
        if (m.role === 'user' && m.queued && m.queued.length) {
          m.queued = [];
          this.markDirty(room, m);
        }
      }
    }
    for (const [aid, ap] of this.approvals) if (ap.room.id === id) this.respondApproval(id, aid, 'deny');
    for (const run of this.runs.values()) {
      if (run.room.id !== id) continue;
      run.stopRequested = true;
      if (run.handle) run.handle.stop();
    }
    for (const p of this.pipelines.values()) if (p.roomId === id) p.cancelled = true;
  }

  // Сводка того, что агент пропустил в общем чате.
  buildContext(room, agent) {
    const since = room.seen[agent] || 0;
    const lines = [];
    for (const m of room.messages) {
      if (m.role === 'user' && m.ts > since && !m.targets.includes(agent)) {
        lines.push(`— Пользователь написал ${NAME[peer(agent)]}: ${clip(m.text, 3000)}`);
      } else if (
        m.role === 'agent' &&
        m.agent !== agent &&
        m.requestedBy !== agent &&
        m.finishedAt > since &&
        m.finalText
      ) {
        const who = m.requestedBy ? `${NAME[m.agent]} (по запросу ${NAME[m.requestedBy]})` : NAME[m.agent];
        lines.push(`— ${who} ответил: ${clip(m.finalText, 6000)}`);
      }
    }
    room.seen[agent] = Date.now();
    if (!lines.length) return '';
    return `<duocode_context>\nЧто произошло в общем чате DuoCode без тебя:\n${lines.join('\n')}\n</duocode_context>\n\n`;
  }

  // isolated: ход в отдельной копии проекта (дуэль) — без общей сессии агента и без отката.
  // Пересказ чата для новой сессии агента, когда прежняя пропала.
  history(room, agent, skip) {
    const lines = [];
    let size = 0;
    for (const m of [...room.messages].reverse()) {
      if (skip.includes(m.id)) continue;
      let line = null;
      if (m.role === 'user') line = `Пользователь${m.targets && m.targets.length === 1 ? ` (→ ${NAME[m.targets[0]]})` : ''}: ${clip(m.text, 2000)}`;
      else if (m.role === 'agent' && m.finalText) line = `${m.agent === agent ? 'Ты' : NAME[m.agent]}${m.requestedBy ? ` (по запросу ${NAME[m.requestedBy]})` : ''}: ${clip(m.finalText, 2500)}`;
      if (!line) continue;
      if (size + line.length > 16000) break;
      lines.unshift(line);
      size += line.length;
    }
    if (!lines.length) return '';
    return `<duocode_history>\nТвоя прежняя сессия в этом чате недоступна, поэтому это новая сессия. Вот последняя часть переписки из DuoCode — продолжай с учётом её:\n${lines.join('\n\n')}\n</duocode_history>\n\n`;
  }

  runAgent(room, agent, opts) {
    const { prompt, raw = false, action = null, review = null, attachments = [], plan = false, requestedBy = null, parentId = null, cwd = null, isolated = false, duelId = null, pipeline = null } = opts;
    const s = room.settings;
    const runModel = (agent === 'claude' ? s.claudeModel : s.codexModel) || '';
    const runEffort = (agent === 'claude' ? s.claudeEffort : s.codexEffort) || '';
    const key = `${room.id}:${agent}`;
    const fork = isolated || this.main.has(key); // агент занят своим ходом — работаем в ответвлении сессии
    const workDir = cwd || room.cwd;
    const msg = {
      id: uid('m'),
      role: 'agent',
      agent,
      status: 'running',
      parts: [],
      draft: '',
      requestedBy,
      parentId,
      ts: Date.now(),
      finishedAt: null,
      fork: fork && !isolated,
      plan,
      duelId,
      pipeline,
      effort: runEffort || null,
    };
    room.messages.push(msg);
    if (!fork) this.main.set(key, msg.id);

    // raw: команда Claude должна стоять в самом начале сообщения, без сводки чата
    let fullPrompt = raw ? '' : this.buildContext(room, agent);
    if (requestedBy) {
      fullPrompt += `[Запрос от ${NAME[requestedBy]} через DuoCode. Твой итоговый ответ целиком вернётся ${NAME[requestedBy]}, поэтому отвечай по делу и самодостаточно.]\n\n`;
    }
    if (isolated) {
      fullPrompt += `[Режим сравнения DuoCode: ${NAME[peer(agent)]} параллельно решает ту же задачу в своей копии проекта. Работай самостоятельно, не вызывай ${NAME[peer(agent)]}. Пользователь сравнит два решения и выберет одно.]\n\n`;
    }
    fullPrompt += prompt;

    const run = { room, agent, msg, handle: null, stopRequested: false };
    this.runs.set(msg.id, run);
    this.markDirty(room, msg);
    this.emitRooms();

    // папки проекта: основная — рабочая папка агента, остальные он тоже видит и может менять
    const folders = projects.roomFolders(this.getSettings(), room);
    const projectNote = folders.extra.length
      ? `This project "${folders.project ? folders.project.name : path.basename(folders.main)}" spans several folders. Main (current working) folder: ${workDir}. Other project folders you can read and edit: ${folders.extra.join('; ')}.`
      : '';

    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));
    const tmpFiles = [];
    let before = null;

    const finish = async (r) => {
      // прежней сессии агента больше нет — начинаем новую, передаём ей историю чата и повторяем сообщение
      if (r.lost && !opts.recovered && !isolated && !fork && !action) {
        for (const f of tmpFiles) fs.rm(f, () => {});
        room.sessions[agent] = null;
        if (room.memorySeen) room.memorySeen[agent] = room.memorySeen[`${agent}Dirs`] = null;
        this.runs.delete(msg.id);
        if (this.main.get(key) === msg.id) this.main.delete(key);
        // сорвавшийся ход превращаем в заметку (тот же id — окно заменит его, а не оставит висеть)
        const recap = raw ? '' : this.history(room, agent, [msg.id, opts.userMsgId]);
        for (const k of Object.keys(msg)) if (k !== 'id') delete msg[k];
        Object.assign(msg, {
          role: 'system',
          ts: Date.now(),
          text: `Прежняя сессия ${NAME[agent]} не найдена (Claude Code и Codex со временем удаляют старые сессии). Начинаю новую и передаю ей историю этого чата.`,
        });
        this.markDirty(room, msg);
        const next = this.runAgent(room, agent, { ...opts, prompt: recap + prompt, recovered: true });
        next.done.then(resolveDone);
        return;
      }
      msg.status = r.stopped ? 'stopped' : r.error ? 'error' : 'done';
      msg.error = r.error || null;
      msg.finalText = r.text || '';
      msg.cost = r.cost;
      msg.draft = '';
      for (const p of msg.parts) if (p.kind === 'tool' && p.status === 'running') p.status = r.error ? 'error' : 'ok';
      for (const [aid, ap] of this.approvals) if (ap.msg.id === msg.id) this.respondApproval(room.id, aid, 'deny');
      if (plan && agent === 'codex' && msg.status === 'done' && !requestedBy) {
        msg.parts.push({ id: uid('p'), kind: 'planReady', status: 'pending' });
      }
      for (const f of tmpFiles) fs.rm(f, () => {});
      // снимок после хода: что агент поменял в файлах всех папок проекта — для кнопки «Откатить»
      if (before && !isolated) {
        const parts = [];
        for (const b of before) {
          const after = await this.checkpoints.snapshot(b.dir).catch(() => null);
          const files = after ? await this.checkpoints.changes(b.dir, b.tree, after).catch(() => []) : [];
          if (files.length) parts.push({ dir: b.dir, before: b.tree, after, files });
        }
        const many = before.length > 1;
        const files = parts.flatMap((p) => p.files.map((f) => ({ ...f, dir: p.dir, label: many ? `${path.basename(p.dir)}/${f.path}` : f.path })));
        if (files.length) msg.checkpoint = { parts, files: files.map((f) => ({ status: f.status, path: f.label })), reverted: false };
      }
      msg.finishedAt = Date.now();
      this.runs.delete(msg.id);
      this.markDirty(room, msg);
      if (this.main.get(key) === msg.id) {
        this.main.delete(key);
        this.nextInQueue(room, agent);
      }
      this.touch(room);
      this.emit('finished', room, msg);
      resolveDone(r);
    };

    const start = async () => {
      const dirs = isolated ? null : [projects.roomFolders(this.getSettings(), room).main, ...folders.extra];
      if (dirs) {
        before = [];
        for (const dir of dirs) {
          const tree = await this.checkpoints.snapshot(dir).catch(() => null);
          if (tree) before.push({ dir, tree });
        }
      }
      const settings = this.getSettings();
      const env = {
        ELECTRON_RUN_AS_NODE: '1',
        DUO_PORT: String(this.bridge.port),
        DUO_TOKEN: this.bridge.token,
        DUO_ROOM: room.id,
      };
      const memoryBlock = memory.block(room.cwd);
      // Память и состав папок идут в сообщении, только когда изменились с прошлого раза.
      // Системная подсказка остаётся неизменной, иначе каждое изменение памяти сбрасывало бы кэш
      // всей переписки и агент заново платил бы за неё полную цену.
      if (!room.memorySeen) room.memorySeen = {};
      const seen = room.memorySeen;
      const digest = (s) => (s ? crypto.createHash('sha1').update(s).digest('hex') : '');
      let prefix = '';
      if (!raw) {
        const memHash = digest(memoryBlock);
        if (memoryBlock && (isolated || seen[agent] !== memHash)) prefix += `${memoryBlock}\n\n`;
        if (!isolated) seen[agent] = memHash;
        const dirsHash = digest(projectNote);
        if (projectNote && !isolated && seen[`${agent}Dirs`] !== dirsHash) prefix += `[${projectNote}]\n\n`;
        if (!isolated) seen[`${agent}Dirs`] = dirsHash;
      }
      let handle;
      if (agent === 'claude') {
        const mcpFile = path.join(this.runDir, `${msg.id}.mcp.json`);
        const promptFile = path.join(this.runDir, `${msg.id}.prompt.md`);
        tmpFiles.push(mcpFile, promptFile);
        fs.writeFileSync(
          mcpFile,
          JSON.stringify({
            mcpServers: {
              duo: { type: 'stdio', command: this.bridge.command, args: [this.bridge.script], env: { ...env, DUO_AGENT: 'claude', DUO_RUN: msg.id } },
            },
          }),
        );
        fs.writeFileSync(promptFile, INSTRUCTIONS.claude);
        handle = runClaude({
          command: settings.claudeCommand,
          prompt: prefix + fullPrompt,
          attachments,
          plan,
          cwd: workDir,
          sessionId: isolated ? null : room.sessions.claude,
          fork: fork && !isolated && !!room.sessions.claude,
          mode: room.settings.mode,
          model: runModel,
          effort: runEffort,
          mcpConfigPath: mcpFile,
          systemPromptPath: promptFile,
          addDirs: isolated ? [] : folders.extra,
        });
      } else {
        const text = prefix + fullPrompt;
        handle = runCodex(this.codex, {
          prompt: text,
          action,
          review,
          attachments,
          plan,
          threadId: room.sessions.codex,
          fork: fork && !!room.sessions.codex,
          cwd: workDir,
          mode: room.settings.mode,
          model: runModel,
          effort: runEffort,
          writableRoots: isolated ? [] : folders.extra,
          instructions: INSTRUCTIONS.codex,
          config: {
            'mcp_servers.duo': {
              command: this.bridge.command,
              args: [this.bridge.script],
              env: { ...env, DUO_AGENT: 'codex' },
              startup_timeout_sec: 30,
              tool_timeout_sec: 3600,
            },
          },
          onApproval: (kind, data) => this.requestApproval(room, msg, data),
          onQuestion: (questions) => this.requestAnswers(room, msg, questions),
        });
      }
      run.handle = handle;

      handle.on('part', (p) => {
        const i = msg.parts.findIndex((x) => x.id === p.id);
        if (i >= 0) msg.parts[i] = { ...msg.parts[i], ...p };
        else msg.parts.push(p);
        this.markDirty(room, msg);
      });
      handle.on('draft', (text, kind) => {
        msg.draft = text || '';
        msg.draftKind = kind || 'text';
        this.markDirty(room, msg);
      });
      handle.on('session', (sid, model, effort) => {
        if (!fork && sid) room.sessions[agent] = sid;
        if (model) msg.model = model;
        if (effort) msg.effort = effort;
        this.markDirty(room, msg);
      });
      handle.on('ratelimit', (info) => this.emit('claude-ratelimit', info));
      handle.on('context', (c) => {
        if (fork) return;
        if (!room.context) room.context = {};
        const cur = { ...(room.context[agent] || {}) };
        for (const [k, v] of Object.entries(c)) if (v != null) cur[k] = v;
        room.context[agent] = cur;
        this.emitRooms();
      });
      handle.on('warning', (w) => {
        if (w) msg.warning = w;
        this.markDirty(room, msg);
      });
      handle.on('done', (r) => finish(r).catch(() => resolveDone(r)));
      if (run.stopRequested) handle.stop();
    };

    start().catch((err) => finish({ text: '', error: err.message }));
    return { msg, done };
  }

  nextInQueue(room, agent) {
    const key = `${room.id}:${agent}`;
    const q = this.queues.get(key);
    if (!q || !q.length) return;
    const next = q.shift();
    const userMsg = room.messages.find((m) => m.id === next.userMsgId);
    if (userMsg) {
      userMsg.queued = (userMsg.queued || []).filter((a) => a !== agent);
      this.markDirty(room, userMsg);
    }
    this.runAgent(room, agent, next);
  }

  // ---------- Подтверждения ----------

  requestApproval(room, msg, data, toolName = null) {
    const part = { ...data, id: uid('a'), kind: 'approval', status: 'pending' };
    msg.parts.push(part);
    this.markDirty(room, msg);
    this.emitRooms();
    this.emit('attention', room, msg, part);
    return new Promise((resolve) =>
      this.approvals.set(part.id, { room, msg, part, toolName, resolve: (decision, feedback) => resolve(feedback ? { decision, feedback } : decision) }),
    );
  }

  // Вопросы агента пользователю. answers: { [questionId]: [ответы] } или null, если пропустил.
  requestAnswers(room, msg, questions) {
    const part = { id: uid('q'), kind: 'question', status: 'pending', questions };
    msg.parts.push(part);
    this.markDirty(room, msg);
    this.emitRooms();
    this.emit('attention', room, msg, part);
    return new Promise((resolve) => this.approvals.set(part.id, { room, msg, part, resolve, question: true }));
  }

  respondApproval(roomId, approvalId, decision, extra) {
    const ap = this.approvals.get(approvalId);
    if (!ap || ap.room.id !== roomId) return false;
    this.approvals.delete(approvalId);
    if (ap.question) {
      ap.part.status = decision === 'deny' ? 'skipped' : 'answered';
      ap.part.answers = decision === 'deny' ? null : extra;
      this.markDirty(ap.room, ap.msg);
      this.emitRooms();
      ap.resolve(decision === 'deny' ? null : extra);
      return true;
    }
    ap.part.status = decision === 'deny' ? 'denied' : 'allowed';
    if (extra) ap.part.feedback = extra;
    if (decision === 'allowSession' && ap.toolName) {
      const key = `${roomId}:claude`;
      if (!this.allowed.has(key)) this.allowed.set(key, new Set());
      this.allowed.get(key).add(ap.toolName);
    }
    this.markDirty(ap.room, ap.msg);
    this.emitRooms();
    ap.resolve(decision, extra);
    return true;
  }

  // ---------- Мост (вызовы из bridge/mcp.js) ----------

  findRun(roomId, agent, runId) {
    if (runId && this.runs.has(runId)) return this.runs.get(runId);
    const mainId = this.main.get(`${roomId}:${agent}`);
    if (mainId && this.runs.has(mainId)) return this.runs.get(mainId);
    return [...this.runs.values()].find((r) => r.room.id === roomId && r.agent === agent) || null;
  }

  async handleBridge({ room: roomId, agent, run: runId, tool, args }) {
    const room = this.rooms.get(roomId);
    if (!room || !AGENTS.includes(agent)) return { isError: true, text: 'Чат DuoCode не найден' };
    const from = this.findRun(roomId, agent, runId);
    if (!from) return { isError: true, text: 'В DuoCode нет активного хода для этого вызова' };

    if (tool === 'approve') {
      const toolName = args.tool_name;
      const input = args.input || {};
      const allow = { text: JSON.stringify({ behavior: 'allow', updatedInput: input }) };
      const deny = (message) => ({ text: JSON.stringify({ behavior: 'deny', message }) });

      if (toolName === 'AskUserQuestion') {
        const questions = (input.questions || []).map((q) => ({
          id: q.question,
          header: q.header,
          question: q.question,
          options: q.options || [],
          multiSelect: !!q.multiSelect,
          allowOther: true,
        }));
        const answers = await this.requestAnswers(room, from.msg, questions);
        if (!answers) return deny('Пользователь пропустил вопрос. Продолжай на своё усмотрение или спроси обычным сообщением.');
        const flat = {};
        for (const [q, list] of Object.entries(answers)) flat[q] = list.join(', ');
        return { text: JSON.stringify({ behavior: 'allow', updatedInput: { ...input, answers: flat } }) };
      }

      if (toolName === 'ExitPlanMode') {
        const r = await this.requestApproval(room, from.msg, { title: 'Claude предлагает план', plan: input.plan || '' });
        const decision = typeof r === 'object' ? r.decision : r;
        if (decision === 'deny') {
          const feedback = typeof r === 'object' ? r.feedback : '';
          return deny(feedback ? `Пользователь просит доработать план: ${feedback}` : 'Пользователь не утвердил план. Спроси, что изменить.');
        }
        return allow;
      }

      // после утверждения плана Claude работает в обычном режиме — применяем режим чата сами
      const mode = room.settings.mode;
      const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
      if (mode === 'full' || ((mode === 'edits' || mode === 'auto') && EDITS.has(toolName))) return allow;

      const set = this.allowed.get(`${roomId}:claude`);
      if (toolName.startsWith('mcp__duo__') || (set && set.has(toolName))) return allow;
      const p = toolPart('x', toolName, input);
      const decision = await this.requestApproval(
        room,
        from.msg,
        { title: `Claude хочет: ${p.title.toLowerCase()}`, subtitle: p.subtitle, command: p.command, files: p.files, toolName },
        toolName,
      );
      if (decision === 'deny') {
        return { text: JSON.stringify({ behavior: 'deny', message: 'Пользователь отклонил это действие в DuoCode.' }) };
      }
      return allow;
    }

    if (tool === 'remember') {
      const note = String(args.note || '').trim();
      if (!note) return { isError: true, text: 'Пустая заметка' };
      memory.append(room.cwd, note, NAME[agent]);
      from.msg.parts.push({ id: uid('r'), kind: 'tool', icon: 'memory', title: 'Запомнил', subtitle: short(note, 200), status: 'ok' });
      this.markDirty(room, from.msg);
      this.emit('memory', room.cwd);
      return { text: 'Сохранено в общую память проекта.' };
    }

    const to = tool === 'ask_codex' ? 'codex' : tool === 'ask_claude' ? 'claude' : null;
    if (!to || to === agent) return { isError: true, text: `Неизвестный инструмент ${tool}` };
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return { isError: true, text: 'Пустой запрос' };
    const policy = room.settings.delegation || 'auto';
    if (policy === 'off') {
      return { isError: true, text: `Пользователь запретил в этом чате вызывать ${NAME[to]}. Справься сам.` };
    }
    if (from.msg.requestedBy) {
      return {
        isError: true,
        text: `Этот ход уже выполняется по запросу ${NAME[from.msg.requestedBy]}, поэтому вызвать ${NAME[to]} отсюда нельзя (иначе агенты будут ждать друг друга вечно). Ответь сам — ответ вернётся ${NAME[from.msg.requestedBy]}.`,
      };
    }

    if (policy === 'ask') {
      const r = await this.requestApproval(room, from.msg, { title: `${NAME[agent]} хочет подключить ${NAME[to]}`, subtitle: short(prompt, 600) });
      if ((typeof r === 'object' ? r.decision : r) === 'deny') {
        return { isError: true, text: `Пользователь не разрешил подключать ${NAME[to]} для этого запроса. Продолжай сам.` };
      }
    }

    const part = { id: uid('d'), kind: 'delegate', to, prompt, status: 'running', childId: null };
    from.msg.parts.push(part);
    const child = this.runAgent(room, to, { prompt, requestedBy: agent, parentId: from.msg.id });
    part.childId = child.msg.id;
    this.markDirty(room, from.msg);

    const r = await child.done;
    part.status = r.stopped ? 'stopped' : r.error ? 'error' : 'done';
    this.markDirty(room, from.msg);
    if (r.stopped) return { isError: true, text: `Пользователь остановил ${NAME[to]}.` };
    if (r.error) return { isError: true, text: `${NAME[to]} завершился с ошибкой: ${r.error}` };
    return { text: r.text || `(${NAME[to]} ничего не ответил)` };
  }

  // ---------- Отправка обновлений в окно ----------

  markDirty(room, msg) {
    if (!this.dirty.has(room.id)) this.dirty.set(room.id, new Set());
    this.dirty.get(room.id).add(msg.id);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 60);
  }

  flush() {
    this.flushTimer = null;
    for (const [roomId, ids] of this.dirty) {
      const room = this.rooms.get(roomId);
      if (!room) continue;
      const msgs = room.messages.filter((m) => ids.has(m.id));
      this.emit('messages', roomId, msgs);
      this.store.save(room);
    }
    this.dirty.clear();
  }

  emitRooms() {
    clearTimeout(this.roomsTimer);
    this.roomsTimer = setTimeout(() => this.emit('rooms', this.list()), 30);
  }

  shutdown() {
    for (const run of this.runs.values()) run.handle && run.handle.stop();
    this.store.flush(this.rooms);
  }
}

module.exports = { Rooms, AGENTS };
