// Один ход Claude Code: `claude -p --output-format stream-json`, промпт идёт через stdin.
// Сырые события CLI превращаются в «части» сообщения, которые рисует интерфейс.
const { EventEmitter } = require('events');
const { spawnTool } = require('../env');
const { clip, simpleDiff, killTree } = require('./util');

const HIDDEN_TOOLS = new Set(['ToolSearch']);

function toolPart(id, name, input = {}) {
  const base = { id, kind: 'tool', name, status: 'running' };
  const file = input.file_path || input.notebook_path || input.path;
  switch (name) {
    case 'Bash':
      return { ...base, icon: 'terminal', title: input.description || 'Команда', command: input.command };
    case 'Edit':
      return { ...base, icon: 'edit', title: 'Правка', subtitle: file, files: [{ path: file, diff: simpleDiff(input.old_string, input.new_string) }] };
    case 'MultiEdit':
      return {
        ...base,
        icon: 'edit',
        title: 'Правки',
        subtitle: file,
        files: (input.edits || []).map((e) => ({ path: file, diff: simpleDiff(e.old_string, e.new_string) })),
      };
    case 'Write':
      return { ...base, icon: 'edit', title: 'Новый файл', subtitle: file, files: [{ path: file, diff: simpleDiff('', input.content) }] };
    case 'NotebookEdit':
      return { ...base, icon: 'edit', title: 'Правка ноутбука', subtitle: file };
    case 'Read':
      return { ...base, icon: 'read', title: 'Чтение', subtitle: file };
    case 'Grep':
      return { ...base, icon: 'search', title: 'Поиск по коду', subtitle: input.pattern };
    case 'Glob':
      return { ...base, icon: 'search', title: 'Поиск файлов', subtitle: input.pattern };
    case 'WebFetch':
      return { ...base, icon: 'web', title: 'Открыл страницу', subtitle: input.url };
    case 'WebSearch':
      return { ...base, icon: 'web', title: 'Поиск в интернете', subtitle: input.query };
    case 'TodoWrite':
      return { ...base, icon: 'todo', title: 'План', todos: (input.todos || []).map((t) => ({ text: t.content, status: t.status })) };
    case 'Task':
    case 'Agent':
      return { ...base, icon: 'agent', title: 'Субагент', subtitle: input.description, command: input.prompt };
    default:
      if (name.startsWith('mcp__')) {
        const [, server, tool] = name.split('__');
        return { ...base, icon: 'tool', title: `${server}: ${tool}`, subtitle: clip(JSON.stringify(input), 160) };
      }
      return { ...base, icon: 'tool', title: name, subtitle: clip(JSON.stringify(input), 160) };
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && c.type === 'text' ? c.text : '')).join('\n');
  return '';
}

/**
 * Запускает один ход. Возвращает EventEmitter с событиями:
 *  part(part)            — новая или обновлённая часть сообщения
 *  draft(text)           — текст, который печатается прямо сейчас
 *  session(id)           — id сессии Claude Code
 *  ratelimit(info)       — свежие данные о лимитах из CLI
 *  done({ text, error, cost, usage })
 */
function runClaude({ command, prompt, cwd, sessionId, fork, mode, model, effort, mcpConfigPath, systemPromptPath, env }) {
  const ev = new EventEmitter();
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  args.push('--mcp-config', mcpConfigPath, '--append-system-prompt-file', systemPromptPath);
  args.push('--allowedTools', 'mcp__duo__ask_codex');
  if (mode === 'full') args.push('--permission-mode', 'bypassPermissions');
  else {
    if (mode === 'edits') args.push('--permission-mode', 'acceptEdits');
    args.push('--permission-prompt-tool', 'mcp__duo__approve');
  }
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (sessionId) {
    args.push('--resume', sessionId);
    if (fork) args.push('--fork-session');
  }

  let proc;
  try {
    proc = spawnTool(command || 'claude', args, {
      cwd,
      env: { ...process.env, ...env, MCP_TOOL_TIMEOUT: '3600000', MCP_TIMEOUT: '30000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    setImmediate(() => ev.emit('done', { text: '', error: `${err.message}. Установите Claude Code и перезапустите DuoCode.` }));
    ev.stop = () => {};
    return ev;
  }

  const parts = new Map();
  let draft = '';
  let draftKind = 'text';
  let finished = false;
  let stderr = '';
  let lastText = '';
  let n = 0;

  const emitPart = (p) => {
    parts.set(p.id, p);
    ev.emit('part', p);
  };

  const finish = (res) => {
    if (finished) return;
    finished = true;
    ev.emit('draft', '');
    ev.emit('done', res);
  };

  const handle = (e) => {
    switch (e.type) {
      case 'system':
        if (e.subtype === 'init' && e.session_id) ev.emit('session', e.session_id, e.model);
        break;
      case 'stream_event': {
        const se = e.event || {};
        if (se.type === 'content_block_start') {
          draft = '';
          draftKind = se.content_block && se.content_block.type === 'thinking' ? 'thinking' : 'text';
        } else if (se.type === 'content_block_delta' && se.delta) {
          if (se.delta.type === 'text_delta') draft += se.delta.text;
          else if (se.delta.type === 'thinking_delta') draft += se.delta.thinking;
          else break;
          ev.emit('draft', draft, draftKind);
        }
        break;
      }
      case 'assistant': {
        if (e.parent_tool_use_id) break; // внутренности субагентов не показываем
        for (const block of (e.message && e.message.content) || []) {
          if (block.type === 'text' && block.text) {
            lastText = block.text;
            emitPart({ id: `t${n++}`, kind: 'text', text: block.text });
          } else if (block.type === 'thinking' && block.thinking) {
            emitPart({ id: `r${n++}`, kind: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            if (HIDDEN_TOOLS.has(block.name) || block.name.startsWith('mcp__duo__')) continue;
            emitPart(toolPart(block.id, block.name, block.input));
          }
        }
        draft = '';
        ev.emit('draft', '');
        break;
      }
      case 'user': {
        const content = (e.message && e.message.content) || [];
        if (!Array.isArray(content)) break;
        for (const c of content) {
          if (c.type !== 'tool_result' || !parts.has(c.tool_use_id)) continue;
          const p = parts.get(c.tool_use_id);
          const out = resultText(c.content);
          const update = { ...p, status: c.is_error ? 'error' : 'ok' };
          if (p.icon === 'terminal' || p.icon === 'agent' || p.icon === 'tool' || p.icon === 'web' || c.is_error) {
            update.output = clip(out, 20000);
          }
          emitPart(update);
        }
        break;
      }
      case 'rate_limit_event':
        ev.emit('ratelimit', e.rate_limit_info);
        break;
      case 'result':
        finish({
          text: e.result || lastText,
          error: e.is_error ? e.result || 'Claude завершился с ошибкой' : null,
          cost: e.total_cost_usd,
          usage: e.usage,
          sessionId: e.session_id,
        });
        break;
      default:
        break;
    }
  };

  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        // не JSON — игнорируем
      }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => {
    stderr = (stderr + c).slice(-4000);
  });
  proc.on('error', (err) => finish({ text: '', error: err.message }));
  proc.on('close', (code) => {
    if (ev.stopped) finish({ text: lastText, error: null, stopped: true });
    else finish({ text: lastText, error: code ? stderr.trim() || `Claude завершился с кодом ${code}` : null });
  });

  proc.stdin.end(prompt);

  ev.stop = () => {
    ev.stopped = true;
    killTree(proc);
  };
  return ev;
}

module.exports = { runClaude, toolPart };
