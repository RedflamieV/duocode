// Один ход Claude Code: `claude -p --output-format stream-json`, промпт идёт через stdin.
// Сырые события CLI превращаются в «части» сообщения, которые рисует интерфейс.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnTool, isWin } = require('../env');
const { clip, simpleDiff, killTree } = require('./util');

// Эти вызовы DuoCode показывает своими карточками (вопрос, план) или не показывает вовсе.
const HIDDEN_TOOLS = new Set(['ToolSearch', 'AskUserQuestion', 'ExitPlanMode']);
const isPlanFile = (input) => /[\\/]\.claude[\\/]plans[\\/]/.test((input && input.file_path) || '');

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// Сообщение пользователя в формате stream-json: текст, картинки и пути к остальным файлам.
function userContent(text, attachments = []) {
  const content = [];
  const files = [];
  for (const a of attachments) {
    const type = IMAGE_TYPES[path.extname(a.path).toLowerCase()];
    if (type) {
      try {
        content.push({ type: 'image', source: { type: 'base64', media_type: type, data: fs.readFileSync(a.path).toString('base64') } });
        continue;
      } catch {
        // не прочитали — передадим путём
      }
    }
    files.push(a);
  }
  const list = files.length ? `\n\nПриложенные файлы:\n${files.map((f) => `- ${f.path}`).join('\n')}` : '';
  content.unshift({ type: 'text', text: text + list });
  return content;
}

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
      if (file && IMAGE_TYPES[path.extname(file).toLowerCase()]) return { ...base, icon: 'read', title: 'Посмотрел картинку', subtitle: file, image: file };
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

const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n || 0));

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
 * ev.steer(text, attachments) дописывает сообщение в идущую работу; false — если процесс уже закрывается.
 */
function runClaude({ command, prompt, attachments, plan, cwd, sessionId, fork, mode, model, effort, mcpConfigPath, systemPromptPath, settingsPath, env, addDirs = [] }) {
  const ev = new EventEmitter();
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  args.push('--mcp-config', mcpConfigPath, '--append-system-prompt-file', systemPromptPath);
  // дополнительные настройки Claude Code (например, язык ответов) — добавляются к настройкам пользователя
  if (settingsPath) args.push('--settings', settingsPath);
  // свои инструменты DuoCode не требуют подтверждения: браузер изолирован и виден пользователю
  args.push('--allowedTools', 'mcp__duo__ask_codex', 'mcp__duo__remember', ...['open', 'read', 'click', 'type', 'scroll', 'screenshot', 'back'].map((t) => `mcp__duo__browser_${t}`), ...['start', 'read', 'write', 'stop'].map((t) => `mcp__duo__terminal_${t}`), 'mcp__duo__ask_user');
  // в режиме плана Claude сам вызывает ExitPlanMode, а DuoCode показывает план на утверждение
  if (plan) args.push('--permission-mode', 'plan', '--permission-prompt-tool', 'mcp__duo__approve');
  else if (mode === 'full') args.push('--permission-mode', 'bypassPermissions');
  else {
    if (mode === 'edits') args.push('--permission-mode', 'acceptEdits');
    // auto: Claude Code сам оценивает риск действия и спрашивает только о рискованном
    if (mode === 'auto') args.push('--permission-mode', 'auto');
    args.push('--permission-prompt-tool', 'mcp__duo__approve');
  }
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  for (const d of addDirs) args.push('--add-dir', d);
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
  let result = null;
  let cost = 0;
  let closeTimer = null;
  let inputOpen = true;
  const closeInput = () => {
    if (!inputOpen) return;
    inputOpen = false;
    proc.stdin.end();
  };
  const write = (content) => proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');

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

  let retrying = false;
  const handle = (e) => {
    switch (e.type) {
      case 'system':
        if (e.subtype === 'init' && e.session_id) ev.emit('session', e.session_id, e.model);
        // Claude Code сам повторяет запрос при сбое сети или сервера — показываем это, а не молчим
        if (e.subtype === 'api_retry') {
          const sec = Math.round((e.retry_delay_ms || e.retry_in_ms || 0) / 1000);
          const why = e.is_network_down || !e.error_status ? 'нет связи с Anthropic' : `сервер Anthropic ответил ${e.error_status}`;
          ev.emit('warning', `Переподключаюсь: ${why}. Попытка ${e.attempt || '?'}${e.max_retries ? ` из ${e.max_retries}` : ''}${sec ? `, через ${sec} с` : ''}…`);
          retrying = true;
        }
        if (e.subtype === 'compact_boundary' && e.compact_metadata) {
          const m = e.compact_metadata;
          emitPart({ id: `c${n++}`, kind: 'tool', icon: 'compact', status: 'ok', title: 'Контекст сжат', subtitle: `${fmtK(m.pre_tokens)} → ${fmtK(m.post_tokens)} токенов` });
          ev.emit('context', { used: m.post_tokens });
        }
        break;
      case 'autocompact_state':
        if (e.value && e.value.effective_window) ev.emit('context', { window: e.value.effective_window, threshold: e.value.threshold });
        break;
      case 'stream_event': {
        if (retrying) {
          retrying = false;
          ev.emit('warning', ''); // связь вернулась
        }
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
        const u = e.message && e.message.usage;
        if (u) ev.emit('context', { used: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0) });
        for (const block of (e.message && e.message.content) || []) {
          if (block.type === 'text' && block.text) {
            lastText = block.text;
            emitPart({ id: `t${n++}`, kind: 'text', text: block.text });
          } else if (block.type === 'thinking' && block.thinking) {
            emitPart({ id: `r${n++}`, kind: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            if (HIDDEN_TOOLS.has(block.name) || block.name.startsWith('mcp__duo__') || isPlanFile(block.input)) continue;
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
        for (const mu of Object.values(e.modelUsage || {})) if (mu && mu.contextWindow) ev.emit('context', { window: mu.contextWindow });
        // дописанные сообщения могут дать ещё один ход в том же процессе, поэтому ждём закрытия
        cost += e.total_cost_usd || 0;
        result = {
          text: e.result || lastText,
          error: e.is_error ? e.result || 'Claude завершился с ошибкой' : null,
          cost,
          usage: e.usage,
          sessionId: e.session_id,
        };
        clearTimeout(closeTimer);
        closeTimer = setTimeout(closeInput, 1500);
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
  proc.on('close', (code, signal) => {
    clearTimeout(closeTimer);
    if (ev.stopped) finish({ text: lastText, error: null, stopped: true, cost });
    else {
      let r = result;
      if (!r && (code || signal)) {
        // процесс закрылся посреди хода, не дойдя до итога, — DuoCode перезапустит его и попросит продолжить
        const said = stderr.replace(/\x1b\[[0-9;]*m/g, '').trim();
        const outside = !said && (signal || (isWin && code === 1)) ? ' Похоже, его процесс завершили извне — например, командой, останавливающей все процессы Node.' : '';
        r = { text: lastText, error: `Claude Code неожиданно завершился (${signal ? `сигнал ${signal}` : `код ${code}`}).${said ? ` ${clip(said, 400)}` : outside}`, crashed: true, cost };
      } else if (!r) r = { text: lastText, error: null };
      // сессии нет на диске: Claude Code сам удаляет старые (cleanupPeriodDays, по умолчанию 30 дней)
      if (r.error && sessionId && /No conversation found/i.test(stderr + r.error)) r.lost = true;
      finish(r);
    }
  });
  proc.stdin.on('error', () => {});

  write(userContent(prompt, attachments));

  ev.steer = (text, files) => {
    if (!inputOpen || finished || ev.stopped || ev.paused) return false;
    clearTimeout(closeTimer);
    write(userContent(text, files));
    return true;
  };

  ev.stop = () => {
    ev.stopped = true;
    killTree(proc);
  };

  // Пауза: мягко прервать текущий шаг (как Esc в Claude Code) — сессия и контекст сохраняются.
  ev.interrupt = () => {
    if (!inputOpen || finished) return ev.stop();
    ev.paused = true;
    proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: `pause-${Date.now()}`, request: { subtype: 'interrupt' } }) + '\n');
    // не ответил на прерывание — останавливаем жёстко
    setTimeout(() => {
      if (finished) return;
      ev.stopped = true;
      killTree(proc);
    }, 10000);
  };
  return ev;
}

module.exports = { runClaude, toolPart };
