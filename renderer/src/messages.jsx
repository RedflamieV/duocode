import { useState, useMemo } from 'preact/hooks';
import { Icon, Avatar } from './icons.jsx';
import { renderMarkdown } from './markdown.js';

export const NAME = { claude: 'Claude', codex: 'Codex' };
export const peerOf = (a) => (a === 'claude' ? 'codex' : 'claude');

export const EFFORT_NAME = {
  none: 'без размышлений',
  minimal: 'минимальный',
  low: 'низкий',
  medium: 'средний',
  high: 'высокий',
  xhigh: 'очень высокий',
  max: 'максимальный',
};

// claude-opus-5-5 → Opus 5.5; остальные имена показываем как есть
export function prettyModel(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id || '');
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

function ModelTag({ msg }) {
  if (!msg.model && !msg.effort) return null;
  const effort = msg.effort ? EFFORT_NAME[msg.effort] || msg.effort : null;
  return (
    <span class="model-tag" title="Модель и уровень размышлений, которые отвечали в этом сообщении">
      {msg.model ? prettyModel(msg.model) : 'модель по умолчанию'}
      {effort && <span class="model-effort">{effort}</span>}
    </span>
  );
}

function Markdown({ text, class: cls = '' }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class={`md ${cls}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Status({ status }) {
  if (status === 'running') return <span class="spinner" />;
  if (status === 'ok') return <Icon name="check" size={14} class="ok" />;
  if (status === 'error') return <Icon name="x" size={14} class="err" />;
  return null;
}

function Diff({ files, cwd }) {
  return (
    <div class="diffs">
      {files.map((f, i) => (
        <div class="diff" key={i}>
          <div class="diff-head">
            <Icon name="read" size={13} />
            <button class="link" onClick={() => window.duo.openFile(cwd, f.path)} title="Открыть файл">
              {f.path}
            </button>
            {f.kind === 'add' && <span class="tag">новый</span>}
            {f.kind === 'delete' && <span class="tag">удалён</span>}
          </div>
          <pre class="diff-body">
            {(f.diff || '').split('\n').map((line, j) => {
              const c = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
              return (
                <div class={`dl ${c}`} key={j}>
                  {line || ' '}
                </div>
              );
            })}
          </pre>
        </div>
      ))}
    </div>
  );
}

function Todos({ todos }) {
  return (
    <ul class="todos">
      {todos.map((t, i) => (
        <li key={i} class={t.status}>
          <span class="todo-box">{t.status === 'completed' ? <Icon name="check" size={11} /> : null}</span>
          {t.text}
        </li>
      ))}
    </ul>
  );
}

function ToolPart({ part, cwd }) {
  const hasBody = part.command || part.output || (part.files && part.files.length) || (part.todos && part.todos.length);
  const [open, setOpen] = useState(part.icon === 'todo' || (part.icon === 'edit' && part.files && part.files.length === 1 && (part.files[0].diff || '').split('\n').length < 14));
  return (
    <div class={`tool ${open ? 'open' : ''} ${part.status}`}>
      <button class="tool-row" onClick={() => hasBody && setOpen(!open)} disabled={!hasBody}>
        <Icon name={part.icon || 'tool'} size={14} class="tool-icon" />
        <span class="tool-title">{part.title}</span>
        {part.icon === 'terminal' && part.command && !open ? <code class="tool-sub">{part.command.split('\n')[0]}</code> : part.subtitle ? <span class="tool-sub">{part.subtitle}</span> : null}
        <span class="tool-status">
          <Status status={part.status} />
        </span>
        {hasBody ? <Icon name={open ? 'down' : 'right'} size={14} class="chev" /> : null}
      </button>
      {open && (
        <div class="tool-body">
          {part.command && <pre class="cmd">{part.icon === 'terminal' ? '$ ' : ''}{part.command}</pre>}
          {part.files && part.files.length > 0 && <Diff files={part.files} cwd={cwd} />}
          {part.todos && <Todos todos={part.todos} />}
          {part.output && <pre class="out">{part.output}</pre>}
        </div>
      )}
    </div>
  );
}

function Thinking({ part }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`thinking ${open ? 'open' : ''}`}>
      <button class="tool-row" onClick={() => setOpen(!open)}>
        <Icon name="sparkles" size={14} class="tool-icon" />
        <span class="tool-title">{part.title || 'Размышления'}</span>
        {!open && <span class="tool-sub">{part.text.slice(0, 140)}</span>}
        <Icon name={open ? 'down' : 'right'} size={14} class="chev" />
      </button>
      {open && <Markdown text={part.text} class="muted-md" />}
    </div>
  );
}

function Approval({ part, roomId, agent }) {
  const decide = (d) => window.duo.approve(roomId, part.id, d);
  const pending = part.status === 'pending';
  return (
    <div class={`approval ${part.status}`}>
      <div class="approval-head">
        <Icon name="shield" size={16} />
        <b>{part.title}</b>
      </div>
      {part.subtitle && <div class="approval-sub">{part.subtitle}</div>}
      {part.detail && <div class="approval-sub">{part.detail}</div>}
      {part.command && <pre class="cmd">$ {part.command}</pre>}
      {part.files && part.files.length > 0 && <Diff files={part.files} />}
      {pending ? (
        <div class="approval-actions">
          <button class="btn primary" onClick={() => decide('allow')}>
            Разрешить
          </button>
          <button class="btn" onClick={() => decide('allowSession')} title={agent === 'claude' ? 'Больше не спрашивать про этот инструмент в этом чате' : 'Больше не спрашивать про похожие действия в этой сессии'}>
            Разрешать всегда
          </button>
          <button class="btn ghost" onClick={() => decide('deny')}>
            Отклонить
          </button>
        </div>
      ) : (
        <div class="approval-result">{part.status === 'allowed' ? 'Разрешено' : part.status === 'denied' ? 'Отклонено' : 'Запрос устарел'}</div>
      )}
    </div>
  );
}

function Delegate({ part, from, room, byId }) {
  const child = part.childId && byId.get(part.childId);
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <div class={`delegate to-${part.to}`}>
      <div class="delegate-head">
        <Avatar agent={from} size={18} />
        <Icon name="swap" size={14} class="muted" />
        <Avatar agent={part.to} size={18} />
        <span>
          <b>{NAME[from]}</b> подключил <b>{NAME[part.to]}</b>
        </span>
        <span class="delegate-status">
          {part.status === 'running' ? 'работает…' : part.status === 'done' ? 'ответ получен' : part.status === 'error' ? 'ошибка' : 'остановлено'}
        </span>
      </div>
      <button class={`delegate-prompt ${showPrompt ? 'open' : ''}`} onClick={() => setShowPrompt(!showPrompt)} title="Показать запрос целиком">
        {part.prompt}
      </button>
      {child && (
        <div class="delegate-child">
          <AgentMessage msg={child} room={room} byId={byId} nested />
        </div>
      )}
    </div>
  );
}

function Parts({ msg, room, byId }) {
  return msg.parts.map((p) => {
    switch (p.kind) {
      case 'text':
        return <Markdown key={p.id} text={p.text} />;
      case 'thinking':
        return <Thinking key={p.id} part={p} />;
      case 'tool':
        return <ToolPart key={p.id} part={p} cwd={room.cwd} />;
      case 'approval':
        return <Approval key={p.id} part={p} roomId={room.id} agent={msg.agent} />;
      case 'delegate':
        return <Delegate key={p.id} part={p} from={msg.agent} room={room} byId={byId} />;
      default:
        return null;
    }
  });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function duration(msg) {
  if (!msg.finishedAt) return '';
  const s = Math.round((msg.finishedAt - msg.ts) / 1000);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

export function AgentMessage({ msg, room, byId, nested = false, onReview }) {
  const [copied, setCopied] = useState(false);
  const running = msg.status === 'running';
  const empty = !msg.parts.length && !msg.draft;
  const copy = () => {
    window.duo.copy(msg.finalText || msg.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div class={`msg agent ${msg.agent} ${nested ? 'nested' : ''} ${msg.status}`}>
      <div class="msg-head">
        <Avatar agent={msg.agent} size={nested ? 20 : 24} />
        <span class="msg-name">{NAME[msg.agent]}</span>
        {msg.requestedBy && !nested && <span class="badge">по запросу {NAME[msg.requestedBy]}</span>}
        {msg.fork && <span class="badge" title="Агент был занят, поэтому запрос выполнен в ответвлении его сессии">параллельно</span>}
        <ModelTag msg={msg} />
        {running && <span class="working">работает…</span>}
        {msg.status === 'stopped' && <span class="msg-meta">остановлен</span>}
      </div>
      <div class="msg-body">
        <Parts msg={msg} room={room} byId={byId} />
        {msg.draft ? msg.draftKind === 'thinking' ? <div class="thinking live"><Icon name="sparkles" size={14} /> <span class="tool-sub">{msg.draft.slice(-200)}</span></div> : <Markdown text={msg.draft} class="streaming" /> : null}
        {running && empty && <div class="typing"><i /><i /><i /></div>}
        {msg.error && (
          <div class="error-box">
            <Icon name="alert" size={15} />
            <span>{msg.error}</span>
          </div>
        )}
        {msg.warning && !msg.error && running && <div class="warn-line">{msg.warning}</div>}
      </div>
      {!running && !nested && (
        <div class="msg-actions">
          <button class="icon-btn" onClick={copy} title="Копировать ответ">
            <Icon name={copied ? 'check' : 'copy'} size={14} />
          </button>
          {onReview && msg.status === 'done' && (
            <button class="chip-btn" onClick={() => onReview(msg)} title={`${NAME[peerOf(msg.agent)]} получит этот ответ и проверит его`}>
              <Icon name="review" size={14} />
              Попросить {NAME[peerOf(msg.agent)]} проверить
            </button>
          )}
          <span class="msg-meta">
            {fmtTime(msg.ts)}
            {duration(msg) ? ` · ${duration(msg)}` : ''}
            {msg.cost ? ` · $${msg.cost.toFixed(3)}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

export function UserMessage({ msg }) {
  const both = msg.targets.length > 1;
  return (
    <div class="msg user">
      <div class="user-to">
        {both ? 'Claude и Codex' : NAME[msg.targets[0]]}
        {msg.targets.map((t) => (
          <i class={`dot ${t}`} key={t} />
        ))}
        {msg.queued && msg.queued.length > 0 && <span class="queued">· в очереди у {msg.queued.map((a) => NAME[a]).join(' и ')}</span>}
      </div>
      <div class="bubble">{msg.text}</div>
    </div>
  );
}

export function SystemMessage({ msg }) {
  return (
    <div class="msg system">
      <Icon name="clock" size={14} />
      {msg.text}
    </div>
  );
}
