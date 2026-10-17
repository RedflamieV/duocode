// Ядро DuoCode: общие чаты, где работают Claude Code и Codex.
// - каждый агент держит свою сессию (Claude session id / Codex thread id) внутри чата;
// - перед каждым ходом агент получает сводку того, что в чате произошло без него;
// - агенты вызывают друг друга через MCP-инструменты ask_codex / ask_claude (см. bridge/mcp.js);
// - подтверждения действий обоих агентов показываются прямо в чате.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { runClaude, toolPart } = require('./agents/claude');
const { runCodex } = require('./agents/codex');
const { clip, uid } = require('./agents/util');

const AGENTS = ['claude', 'codex'];
const NAME = { claude: 'Claude', codex: 'Codex' };
const peer = (a) => (a === 'claude' ? 'codex' : 'claude');

const INSTRUCTIONS = {
  claude: `You are running inside DuoCode, a desktop app where the user works with two coding agents in one shared chat: you (Claude Code, by Anthropic) and Codex (by OpenAI). Both of you work in the same project folder.
- You have the tool mcp__duo__ask_codex. Use it to delegate a task to Codex, to get an independent review or a second opinion, or whenever the user asks you to involve Codex. Codex's final answer comes back to you as the tool result, and the user watches Codex work live in the chat.
- A message may start with a <duocode_context> block. It is the part of the shared chat you did not take part in (messages addressed to Codex and Codex's answers). Treat it as shared chat history.
- Do not delegate trivial things, and do not ask Codex to redo finished work unless the user wants a comparison.
- Reply in the language the user writes in.`,
  codex: `You are running inside DuoCode, a desktop app where the user works with two coding agents in one shared chat: you (Codex, by OpenAI) and Claude Code (by Anthropic). Both of you work in the same project folder.
- You have the MCP tool ask_claude (server "duo"). Use it to delegate a task to Claude, to get an independent review or a second opinion, or whenever the user asks you to involve Claude. Claude's final answer comes back to you as the tool result, and the user watches Claude work live in the chat.
- A message may start with a <duocode_context> block. It is the part of the shared chat you did not take part in (messages addressed to Claude and Claude's answers). Treat it as shared chat history.
- Do not delegate trivial things, and do not ask Claude to redo finished work unless the user wants a comparison.
- Reply in the language the user writes in.`,
};

class Rooms extends EventEmitter {
  constructor({ store, runDir, bridge, codex, getSettings }) {
    super();
    this.store = store;
    this.runDir = runDir;
    this.bridge = bridge; // { command, script, port, token }
    this.codex = codex;
    this.getSettings = getSettings;
    this.rooms = new Map();
    this.runs = new Map(); // messageId -> { room, agent, msg, handle }
    this.main = new Map(); // `${roomId}:${agent}` -> messageId основного хода агента
    this.queues = new Map(); // `${roomId}:${agent}` -> [{ prompt, userMsgId }]
    this.approvals = new Map(); // approvalId -> { room, msg, part, resolve, toolName }
    this.allowed = new Map(); // `${roomId}:claude` -> Set(toolName), «разрешить всегда в этом чате»
    this.dirty = new Map(); // roomId -> Set(messageId) для пакетной отправки в окно
    this.flushTimer = null;

    fs.mkdirSync(runDir, { recursive: true });
    this.claudePromptFile = path.join(runDir, 'claude-instructions.md');
    fs.writeFileSync(this.claudePromptFile, INSTRUCTIONS.claude);

    for (const room of store.loadAll()) {
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
    return { id: room.id, title: room.title, cwd: room.cwd, updatedAt: room.updatedAt, settings: room.settings, running, waiting };
  }

  list() {
    return [...this.rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((r) => this.summary(r));
  }

  get(id) {
    const room = this.rooms.get(id);
    return room ? { ...room, ...this.summary(room) } : null;
  }

  // ---------- Изменение ----------

  create({ cwd, title }) {
    const now = Date.now();
    const room = {
      id: uid('room-'),
      title: title || 'Новый чат',
      cwd,
      createdAt: now,
      updatedAt: now,
      settings: { mode: 'ask', claudeModel: '', claudeEffort: '', codexModel: '', codexEffort: '' },
      sessions: { claude: null, codex: null },
      seen: { claude: now, codex: now },
      messages: [],
    };
    this.rooms.set(room.id, room);
    this.store.save(room, true);
    this.emitRooms();
    return this.get(room.id);
  }

  importSession({ tool, sessionId, cwd, title }) {
    const room = this.rooms.get(this.create({ cwd, title: clip(title, 60) }).id);
    room.sessions[tool] = sessionId;
    room.messages.push({
      id: uid('m'),
      role: 'system',
      ts: Date.now(),
      text: `Продолжение сессии ${NAME[tool]}: «${clip(title, 120)}». ${NAME[tool]} помнит её целиком.`,
    });
    this.touch(room);
    return this.get(room.id);
  }

  rename(id, title) {
    const room = this.rooms.get(id);
    if (!room) return;
    room.title = clip(title.trim(), 80) || room.title;
    this.touch(room);
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

  send(id, { text, targets }) {
    const room = this.rooms.get(id);
    text = (text || '').trim();
    targets = (targets || []).filter((t) => AGENTS.includes(t));
    if (!room || !text || !targets.length) return;

    const userMsg = { id: uid('m'), role: 'user', text, targets, ts: Date.now(), queued: [] };
    room.messages.push(userMsg);
    if (room.title === 'Новый чат') room.title = clip(text.split('\n')[0], 60);

    for (const agent of targets) {
      const key = `${room.id}:${agent}`;
      if (this.main.has(key)) {
        if (!this.queues.has(key)) this.queues.set(key, []);
        this.queues.get(key).push({ prompt: text, userMsgId: userMsg.id });
        userMsg.queued.push(agent);
      } else {
        this.runAgent(room, agent, { prompt: text });
      }
    }
    this.markDirty(room, userMsg);
    this.touch(room);
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
    for (const run of this.runs.values()) if (run.room.id === id) run.handle && run.handle.stop();
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

  runAgent(room, agent, { prompt, requestedBy = null, parentId = null }) {
    const key = `${room.id}:${agent}`;
    const fork = this.main.has(key); // агент занят своим ходом — работаем в ответвлении сессии
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
      fork,
      effort: (agent === 'claude' ? room.settings.claudeEffort : room.settings.codexEffort) || null,
    };
    room.messages.push(msg);
    if (!fork) this.main.set(key, msg.id);

    let fullPrompt = this.buildContext(room, agent);
    if (requestedBy) {
      fullPrompt += `[Запрос от ${NAME[requestedBy]} через DuoCode. Твой итоговый ответ целиком вернётся ${NAME[requestedBy]}, поэтому отвечай по делу и самодостаточно.]\n\n`;
    }
    fullPrompt += prompt;

    const settings = this.getSettings();
    const env = {
      ELECTRON_RUN_AS_NODE: '1',
      DUO_PORT: String(this.bridge.port),
      DUO_TOKEN: this.bridge.token,
      DUO_ROOM: room.id,
    };
    let handle;
    let mcpFile = null;
    if (agent === 'claude') {
      mcpFile = path.join(this.runDir, `${msg.id}.mcp.json`);
      fs.writeFileSync(
        mcpFile,
        JSON.stringify({
          mcpServers: {
            duo: {
              type: 'stdio',
              command: this.bridge.command,
              args: [this.bridge.script],
              env: { ...env, DUO_AGENT: 'claude', DUO_RUN: msg.id },
            },
          },
        }),
      );
      handle = runClaude({
        command: settings.claudeCommand,
        prompt: fullPrompt,
        cwd: room.cwd,
        sessionId: room.sessions.claude,
        fork: fork && !!room.sessions.claude,
        mode: room.settings.mode,
        model: room.settings.claudeModel,
        effort: room.settings.claudeEffort,
        mcpConfigPath: mcpFile,
        systemPromptPath: this.claudePromptFile,
      });
    } else {
      handle = runCodex(this.codex, {
        prompt: fullPrompt,
        threadId: room.sessions.codex,
        fork: fork && !!room.sessions.codex,
        cwd: room.cwd,
        mode: room.settings.mode,
        model: room.settings.codexModel,
        effort: room.settings.codexEffort,
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
      });
    }

    const run = { room, agent, msg, handle };
    this.runs.set(msg.id, run);
    this.markDirty(room, msg);
    this.emitRooms();

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
    handle.on('warning', (w) => {
      if (w) msg.warning = w;
      this.markDirty(room, msg);
    });

    const done = new Promise((resolve) => {
      handle.on('done', (r) => {
        msg.status = r.stopped ? 'stopped' : r.error ? 'error' : 'done';
        msg.error = r.error || null;
        msg.finalText = r.text || '';
        msg.cost = r.cost;
        msg.finishedAt = Date.now();
        msg.draft = '';
        for (const p of msg.parts) if (p.kind === 'tool' && p.status === 'running') p.status = r.error ? 'error' : 'ok';
        for (const [aid, ap] of this.approvals) if (ap.msg.id === msg.id) this.respondApproval(room.id, aid, 'deny');
        this.runs.delete(msg.id);
        if (mcpFile) fs.rm(mcpFile, () => {});
        this.markDirty(room, msg);
        if (this.main.get(key) === msg.id) {
          this.main.delete(key);
          this.nextInQueue(room, agent);
        }
        this.touch(room);
        this.emit('finished', room, msg);
        resolve(r);
      });
    });
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
    this.runAgent(room, agent, { prompt: next.prompt });
  }

  // ---------- Подтверждения ----------

  requestApproval(room, msg, data, toolName = null) {
    const part = { id: uid('a'), kind: 'approval', status: 'pending', ...data };
    msg.parts.push(part);
    this.markDirty(room, msg);
    this.emitRooms();
    this.emit('attention', room, msg, part);
    return new Promise((resolve) => this.approvals.set(part.id, { room, msg, part, resolve, toolName }));
  }

  respondApproval(roomId, approvalId, decision) {
    const ap = this.approvals.get(approvalId);
    if (!ap || ap.room.id !== roomId) return;
    this.approvals.delete(approvalId);
    ap.part.status = decision === 'deny' ? 'denied' : 'allowed';
    if (decision === 'allowSession' && ap.toolName) {
      const key = `${roomId}:claude`;
      if (!this.allowed.has(key)) this.allowed.set(key, new Set());
      this.allowed.get(key).add(ap.toolName);
    }
    this.markDirty(ap.room, ap.msg);
    this.emitRooms();
    ap.resolve(decision);
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

    const to = tool === 'ask_codex' ? 'codex' : tool === 'ask_claude' ? 'claude' : null;
    if (!to || to === agent) return { isError: true, text: `Неизвестный инструмент ${tool}` };
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return { isError: true, text: 'Пустой запрос' };
    if (from.msg.requestedBy) {
      return {
        isError: true,
        text: `Этот ход уже выполняется по запросу ${NAME[from.msg.requestedBy]}, поэтому вызвать ${NAME[to]} отсюда нельзя (иначе агенты будут ждать друг друга вечно). Ответь сам — ответ вернётся ${NAME[from.msg.requestedBy]}.`,
      };
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
