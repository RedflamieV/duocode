// Постоянное соединение с `codex app-server` (JSON-RPC построчно через stdio).
// Один процесс обслуживает все чаты; события раздаются по threadId.
const path = require('path');
const { EventEmitter } = require('events');
const { spawnTool } = require('../env');
const { clip, killTree } = require('./util');

class CodexServer extends EventEmitter {
  constructor(getCommand) {
    super();
    this.getCommand = getCommand;
    this.proc = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.threads = new Map(); // threadId -> обработчик событий хода
    this.loaded = new Set(); // треды, открытые в текущем процессе
    this.info = new Map(); // threadId -> { model, effort } из ответа сервера
    this.stderr = '';
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawnTool(this.getCommand(), ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        this.ready = null;
        reject(new Error(`${err.message}. Установите Codex и перезапустите DuoCode.`));
        return;
      }
      this.proc = proc;
      let buf = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          this.onMessage(msg);
        }
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (c) => {
        this.stderr = (this.stderr + c).slice(-4000);
      });
      const fail = (err) => {
        this.proc = null;
        this.ready = null;
        this.loaded.clear();
        for (const { reject: rj } of this.pending.values()) rj(err);
        this.pending.clear();
        for (const h of this.threads.values()) h.onExit && h.onExit(err);
        reject(err);
      };
      proc.on('error', (err) => fail(err));
      proc.on('exit', (code) => fail(new Error(`codex app-server завершился (код ${code}). ${this.stderr.trim().slice(-500)}`)));

      this.rawRequest('initialize', {
        clientInfo: { name: 'duocode', title: 'DuoCode', version: '2.0.0' },
        capabilities: null,
      })
        .then(() => {
          this.send({ method: 'initialized' });
          resolve();
        })
        .catch(reject);
    });
    return this.ready;
  }

  send(msg) {
    if (this.proc) this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  rawRequest(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
    });
  }

  async request(method, params) {
    await this.start();
    return this.rawRequest(method, params);
  }

  onMessage(msg) {
    // ответ на наш запрос
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || `${p.method}: ошибка`));
      else p.resolve(msg.result);
      return;
    }
    // запрос от сервера (подтверждения и т. п.)
    if (msg.id !== undefined && msg.method) {
      const threadId = msg.params && msg.params.threadId;
      const h = threadId && this.threads.get(threadId);
      const reply = (result) => this.send({ id: msg.id, result });
      const replyError = (message) => this.send({ id: msg.id, error: { code: -32000, message } });
      if (h && h.onRequest) h.onRequest(msg.method, msg.params, reply, replyError);
      else replyError('DuoCode: нет обработчика для ' + msg.method);
      return;
    }
    // уведомление
    if (msg.method === 'account/rateLimits/updated') {
      this.emit('ratelimits', msg.params && msg.params.rateLimits);
      return;
    }
    const threadId = msg.params && msg.params.threadId;
    const h = threadId && this.threads.get(threadId);
    if (h && h.onNotification) h.onNotification(msg.method, msg.params);
  }

  stop() {
    killTree(this.proc);
  }
}

const SANDBOX = {
  ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  edits: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  // как пресет Auto в Codex: работает в песочнице и сам просит разрешение, когда нужно выйти за неё
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  full: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
  plan: { approvalPolicy: 'never', sandbox: 'read-only' },
};

// План: Codex только изучает проект и предлагает план, ничего не меняя.
const PLAN_PREFIX =
  '[Режим планирования DuoCode: ничего не меняй и не запускай команды, которые что-то изменяют. Изучи проект и задачу, ' +
  'затем закончи ответ подробным пошаговым планом. Пользователь утвердит план или попросит доработать.]\n\n';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function userInput(text, attachments = []) {
  const images = attachments.filter((a) => IMAGE_EXT.has(path.extname(a.path).toLowerCase()));
  const files = attachments.filter((a) => !images.includes(a));
  const list = files.length ? `\n\nПриложенные файлы:\n${files.map((f) => `- ${f.path}`).join('\n')}` : '';
  return [{ type: 'text', text: text + list, text_elements: [] }, ...images.map((i) => ({ type: 'localImage', path: i.path }))];
}

// writableRoots — дополнительные папки проекта, в которые Codex тоже может писать
function sandboxPolicy(mode, writableRoots = []) {
  if (mode === 'full') return { type: 'dangerFullAccess' };
  if (mode === 'plan') return { type: 'readOnly', networkAccess: true };
  return { type: 'workspaceWrite', writableRoots, networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

function threadParams({ cwd, mode, model, config, instructions }) {
  const s = SANDBOX[mode] || SANDBOX.ask;
  const p = { cwd, approvalPolicy: s.approvalPolicy, sandbox: s.sandbox, config, developerInstructions: instructions };
  if (model) p.model = model;
  return p;
}

function itemPart(item, prev) {
  switch (item.type) {
    case 'agentMessage':
      return { id: item.id, kind: 'text', text: item.text || (prev && prev.text) || '' };
    case 'reasoning': {
      const text = [...(item.summary || [])].join('\n\n') || (prev && prev.text) || '';
      return text ? { id: item.id, kind: 'thinking', text } : null;
    }
    case 'plan':
      return { id: item.id, kind: 'thinking', title: 'План', text: item.text };
    case 'commandExecution': {
      const failed = item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0);
      return {
        id: item.id,
        kind: 'tool',
        icon: 'terminal',
        title: 'Команда',
        command: item.command,
        output: clip(item.aggregatedOutput != null ? item.aggregatedOutput : (prev && prev.output) || '', 20000),
        status: item.status === 'inProgress' ? 'running' : failed ? 'error' : 'ok',
        exitCode: item.exitCode,
      };
    }
    case 'fileChange':
      return {
        id: item.id,
        kind: 'tool',
        icon: 'edit',
        title: item.changes.length > 1 ? `Правки в ${item.changes.length} файлах` : 'Правка',
        subtitle: item.changes.map((c) => c.path).join(', '),
        files: item.changes.map((c) => ({ path: c.path, diff: clip(c.diff, 20000), kind: c.kind && c.kind.type })),
        status: item.status === 'inProgress' ? 'running' : item.status === 'completed' ? 'ok' : 'error',
      };
    case 'mcpToolCall': {
      if (item.server === 'duo') return null; // делегирование рисует DuoCode
      const out = item.result
        ? (item.result.content || []).map((c) => (c && c.type === 'text' ? c.text : '')).join('\n')
        : item.error
          ? item.error.message
          : '';
      return {
        id: item.id,
        kind: 'tool',
        icon: 'tool',
        title: `${item.server}: ${item.tool}`,
        subtitle: clip(JSON.stringify(item.arguments), 160),
        output: clip(out, 20000),
        status: item.status === 'inProgress' ? 'running' : item.status === 'completed' ? 'ok' : 'error',
      };
    }
    case 'contextCompaction':
      return { id: item.id, kind: 'tool', icon: 'compact', title: 'Контекст сжат', status: 'ok' };
    case 'exitedReviewMode':
      return item.review ? { id: item.id, kind: 'text', text: item.review } : null;
    case 'webSearch':
      return { id: item.id, kind: 'tool', icon: 'web', title: 'Поиск в интернете', subtitle: item.query, status: 'ok' };
    default:
      return null;
  }
}

/**
 * Один ход Codex в треде. События — как у runClaude: part, draft, session, done.
 * onApproval(kind, data) → Promise<'allow'|'allowSession'|'deny'>
 */
function runCodex(server, { prompt, action, review, attachments, plan, threadId, fork, cwd, mode, model, effort, config, instructions, onApproval, onQuestion, writableRoots = [] }) {
  const turnMode = plan ? 'plan' : mode;
  const ev = new EventEmitter();
  const parts = new Map();
  let turnId = null;
  let tid = null;
  let finished = false;
  let lastText = '';

  const emitPart = (p) => {
    if (!p) return;
    parts.set(p.id, p);
    ev.emit('part', p);
  };

  const finish = (res) => {
    if (finished) return;
    finished = true;
    if (tid) server.threads.delete(tid);
    ev.emit('draft', '');
    ev.emit('done', res);
  };

  const handler = {
    onNotification(method, params) {
      if (turnId && params.turnId && params.turnId !== turnId) return;
      switch (method) {
        case 'item/started':
        case 'item/completed': {
          const item = params.item;
          const p = itemPart(item, parts.get(item.id));
          if (item.type === 'agentMessage' && method === 'item/completed') {
            lastText = item.text || lastText;
            ev.emit('draft', '');
          }
          if (p && (p.kind !== 'text' || p.text)) emitPart(p);
          break;
        }
        case 'item/agentMessage/delta': {
          const p = parts.get(params.itemId) || { id: params.itemId, kind: 'text', text: '' };
          p.text = (p.text || '') + params.delta;
          parts.set(p.id, p);
          ev.emit('draft', p.text, 'text', p.id);
          break;
        }
        case 'item/reasoning/summaryTextDelta': {
          const p = parts.get(params.itemId) || { id: params.itemId, kind: 'thinking', text: '' };
          p.text = (p.text || '') + params.delta;
          emitPart({ ...p });
          break;
        }
        case 'item/commandExecution/outputDelta': {
          const p = parts.get(params.itemId);
          if (p) emitPart({ ...p, output: clip((p.output || '') + params.delta, 20000) });
          break;
        }
        case 'turn/plan/updated': {
          const plan = params.plan || [];
          emitPart({
            id: 'plan-' + (params.turnId || turnId),
            kind: 'tool',
            icon: 'todo',
            title: 'План',
            status: 'ok',
            todos: plan.map((s) => ({ text: s.step, status: s.status === 'inProgress' ? 'in_progress' : s.status })),
          });
          break;
        }
        case 'thread/tokenUsage/updated': {
          const u = params.tokenUsage || {};
          ev.emit('context', { used: u.last ? u.last.totalTokens : null, window: u.modelContextWindow || null });
          break;
        }
        case 'error':
          if (!params.willRetry) ev.emit('warning', params.error && params.error.message);
          break;
        case 'turn/completed': {
          const turn = params.turn || {};
          const error = turn.status === 'failed' ? (turn.error && turn.error.message) || 'Ход Codex завершился ошибкой' : null;
          finish({ text: lastText, error, stopped: turn.status === 'interrupted' });
          break;
        }
        default:
          break;
      }
    },
    async onRequest(method, params, reply) {
      try {
        if (method === 'item/commandExecution/requestApproval') {
          const d = await onApproval('command', {
            title: 'Codex хочет выполнить команду',
            command: params.command,
            detail: params.reason,
          });
          reply({ decision: d === 'allow' ? 'accept' : d === 'allowSession' ? 'acceptForSession' : 'decline' });
        } else if (method === 'item/fileChange/requestApproval') {
          const p = parts.get(params.itemId);
          const d = await onApproval('edit', {
            title: 'Codex хочет изменить файлы',
            detail: params.reason || (p && p.subtitle),
            files: p && p.files,
          });
          reply({ decision: d === 'allow' ? 'accept' : d === 'allowSession' ? 'acceptForSession' : 'decline' });
        } else if (method === 'mcpServer/elicitation/request') {
          if (params.serverName === 'duo') {
            reply({ action: 'accept', content: {}, _meta: null });
            return;
          }
          const d = await onApproval('tool', { title: `Codex: запрос от ${params.serverName}`, detail: params.message });
          reply({ action: d === 'deny' ? 'decline' : 'accept', content: {}, _meta: null });
        } else if (method === 'item/permissions/requestApproval') {
          const d = await onApproval('permissions', {
            title: 'Codex просит расширенные права',
            detail: params.reason || JSON.stringify(params.permissions),
          });
          if (d === 'deny') reply({ permissions: {}, scope: 'turn' });
          else reply({ permissions: params.permissions || {}, scope: d === 'allowSession' ? 'session' : 'turn' });
        } else if (method === 'item/tool/requestUserInput') {
          const answers = await onQuestion(
            (params.questions || []).map((q) => ({
              id: q.id,
              header: q.header,
              question: q.question,
              options: (q.options || []).map((o) => ({ label: o.label, description: o.description })),
              multiSelect: false,
              allowOther: q.isOther !== false,
            })),
          );
          const out = {};
          for (const [id, list] of Object.entries(answers || {})) out[id] = { answers: list };
          reply({ answers: out });
        } else {
          reply({});
        }
      } catch {
        reply({ decision: 'decline' });
      }
    },
    onExit(err) {
      finish({ text: lastText, error: err.message });
    },
  };

  (async () => {
    const tp = threadParams({ cwd, mode, model, config, instructions });
    let r = null;
    if (fork && threadId) {
      r = await server.request('thread/fork', { threadId, ...tp, ephemeral: false, excludeTurns: true });
    } else if (threadId && server.loaded.has(threadId)) {
      tid = threadId;
    } else if (threadId) {
      try {
        r = await server.request('thread/resume', { threadId, ...tp, excludeTurns: true });
      } catch (err) {
        // тред не найден (файл сессии удалён или перенесён) — DuoCode начнёт новый с историей чата
        return finish({ text: '', error: err.message, lost: true });
      }
    } else {
      r = await server.request('thread/start', tp);
    }
    if (r) {
      tid = r.thread.id;
      server.info.set(tid, { model: r.model, effort: r.reasoningEffort });
    }
    server.loaded.add(tid);
    server.threads.set(tid, handler);
    const info = server.info.get(tid) || {};
    if (model) info.model = model;
    if (effort) info.effort = effort;
    server.info.set(tid, info);
    ev.emit('session', tid, info.model, info.effort);
    const s = SANDBOX[turnMode] || SANDBOX.ask;
    const turnParams = {
      threadId: tid,
      input: userInput((plan ? PLAN_PREFIX : '') + prompt, attachments),
      approvalPolicy: s.approvalPolicy,
      sandboxPolicy: sandboxPolicy(turnMode, writableRoots),
    };
    if (model) turnParams.model = model;
    if (effort) turnParams.effort = effort;
    if (action === 'compact') {
      // сжатие идёт отдельным ходом; его id придёт в уведомлениях
      await server.request('thread/compact/start', { threadId: tid });
      return;
    }
    const t =
      action === 'review'
        ? await server.request('review/start', { threadId: tid, delivery: 'inline', target: review ? { type: 'custom', instructions: review } : { type: 'uncommittedChanges' } })
        : await server.request('turn/start', turnParams);
    turnId = t.turn.id;
    if (ev.stopped) server.request('turn/interrupt', { threadId: tid, turnId }).catch(() => {});
  })().catch((err) => finish({ text: '', error: err.message }));

  ev.steer = (text, files) => {
    if (finished || ev.stopped || !tid || !turnId) return false;
    server.request('turn/steer', { threadId: tid, expectedTurnId: turnId, input: userInput(text, files) }).catch((err) => ev.emit('warning', 'Не удалось дописать: ' + err.message));
    return true;
  };

  ev.stop = () => {
    ev.stopped = true;
    if (tid && turnId) server.request('turn/interrupt', { threadId: tid, turnId }).catch(() => finish({ text: lastText, stopped: true }));
    else if (!tid) finish({ text: '', stopped: true });
  };
  return ev;
}

module.exports = { CodexServer, runCodex };
