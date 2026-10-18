import { useState, useMemo, useContext } from 'preact/hooks';
import { PrefsContext } from './prefs.js';
import { Icon, Avatar } from './icons.jsx';
import { renderMarkdown } from './markdown.js';
import { Attachments, imageUrl } from './attachments.jsx';
import { DiffView } from './panels.jsx';

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

function Markdown({ text, class: cls = '', cwd = '' }) {
  const html = useMemo(() => renderMarkdown(text, cwd), [text, cwd]);
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
      {part.image && (
        <div class="tool-image">
          <img class="zoomable" src={imageUrl(part.image)} alt="" loading="lazy" onError={(e) => (e.target.parentNode.style.display = 'none')} />
        </div>
      )}
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
  const prefs = useContext(PrefsContext);
  const [open, setOpen] = useState(prefs.expandThinking);
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

// Вопрос агента с вариантами ответа (AskUserQuestion у Claude, request_user_input у Codex).
function Question({ part, roomId, agent }) {
  const [picked, setPicked] = useState({});
  const [other, setOther] = useState({});
  const pending = part.status === 'pending';
  const toggle = (q, label) => {
    const cur = picked[q.id] || [];
    const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    setPicked({ ...picked, [q.id]: next });
    if (!q.multiSelect) setOther({ ...other, [q.id]: '' });
  };
  const answers = {};
  for (const q of part.questions) {
    const list = [...(picked[q.id] || [])];
    if ((other[q.id] || '').trim()) {
      if (q.multiSelect) list.push(other[q.id].trim());
      else list.splice(0, list.length, other[q.id].trim());
    }
    answers[q.id] = list;
  }
  const ready = part.questions.every((q) => answers[q.id].length);
  return (
    <div class={`question ${part.status}`}>
      <div class="approval-head">
        <Icon name="question" size={16} />
        <b>{NAME[agent]} спрашивает</b>
      </div>
      {part.questions.map((q) => (
        <div class="q" key={q.id}>
          <div class="q-text">{q.question}</div>
          {pending ? (
            <>
              <div class="q-options">
                {q.options.map((o) => {
                  const on = (picked[q.id] || []).includes(o.label);
                  return (
                    <button key={o.label} class={`q-option ${on ? 'on' : ''}`} onClick={() => toggle(q, o.label)}>
                      <span class={q.multiSelect ? 'check' : 'radio'} />
                      <span>
                        <b>{o.label}</b>
                        {o.description && <small>{o.description}</small>}
                      </span>
                    </button>
                  );
                })}
              </div>
              {q.allowOther !== false && (
                <input
                  class="q-other"
                  placeholder="Свой ответ…"
                  value={other[q.id] || ''}
                  onInput={(e) => {
                    setOther({ ...other, [q.id]: e.target.value });
                    if (!q.multiSelect && e.target.value) setPicked({ ...picked, [q.id]: [] });
                  }}
                />
              )}
            </>
          ) : (
            <div class="approval-result">{part.answers && part.answers[q.id] ? `Ваш ответ: ${part.answers[q.id].join(', ')}` : 'Вопрос пропущен'}</div>
          )}
        </div>
      ))}
      {pending && (
        <div class="approval-actions">
          <button class="btn primary" disabled={!ready} onClick={() => window.duo.approve(roomId, part.id, 'allow', answers)}>
            Ответить
          </button>
          <button class="btn ghost" onClick={() => window.duo.approve(roomId, part.id, 'deny')}>
            Пропустить
          </button>
        </div>
      )}
    </div>
  );
}

// План Claude (ExitPlanMode): утвердить и выполнить или попросить доработать.
function PlanApproval({ part, roomId }) {
  const [revise, setRevise] = useState(false);
  const [feedback, setFeedback] = useState('');
  const pending = part.status === 'pending';
  return (
    <div class={`plan-card ${part.status}`}>
      <div class="approval-head">
        <Icon name="todo" size={16} />
        <b>{part.title}</b>
      </div>
      <Markdown text={part.plan} class="plan-body" />
      {pending ? (
        revise ? (
          <div class="revise">
            <textarea rows={3} autoFocus placeholder="Что изменить в плане?" value={feedback} onInput={(e) => setFeedback(e.target.value)} />
            <div class="approval-actions">
              <button class="btn primary" disabled={!feedback.trim()} onClick={() => window.duo.approve(roomId, part.id, 'deny', feedback.trim())}>
                Отправить на доработку
              </button>
              <button class="btn ghost" onClick={() => setRevise(false)}>
                Назад
              </button>
            </div>
          </div>
        ) : (
          <div class="approval-actions">
            <button class="btn primary" onClick={() => window.duo.approve(roomId, part.id, 'allow')}>
              Выполнить план
            </button>
            <button class="btn" onClick={() => setRevise(true)}>
              Доработать
            </button>
          </div>
        )
      ) : (
        <div class="approval-result">
          {part.status === 'allowed' ? 'План утверждён' : part.feedback ? `Отправлен на доработку: ${part.feedback}` : part.status === 'denied' ? 'План не утверждён' : 'Запрос устарел'}
        </div>
      )}
    </div>
  );
}

// План Codex: он уже в тексте ответа, здесь только кнопки.
function PlanReady({ part, roomId, msgId, agent }) {
  const [revise, setRevise] = useState(false);
  const [feedback, setFeedback] = useState('');
  if (part.status !== 'pending') {
    return <div class="plan-ready done">{part.status === 'approved' ? 'План утверждён и отправлен на выполнение' : 'План отправлен на доработку'}</div>;
  }
  return (
    <div class="plan-ready">
      {revise ? (
        <div class="revise">
          <textarea rows={3} autoFocus placeholder="Что изменить в плане?" value={feedback} onInput={(e) => setFeedback(e.target.value)} />
          <div class="approval-actions">
            <button class="btn primary" disabled={!feedback.trim()} onClick={() => window.duo.planAction(roomId, msgId, 'revise', feedback.trim())}>
              Отправить на доработку
            </button>
            <button class="btn ghost" onClick={() => setRevise(false)}>
              Назад
            </button>
          </div>
        </div>
      ) : (
        <div class="approval-actions">
          <button class="btn primary" onClick={() => window.duo.planAction(roomId, msgId, 'run')}>
            Выполнить план
          </button>
          <button class="btn" onClick={() => setRevise(true)}>
            Доработать
          </button>
          <span class="muted small">{NAME[agent]} ничего не менял, только предложил план</span>
        </div>
      )}
    </div>
  );
}

function Approval({ part, roomId, agent }) {
  if (part.kind === 'approval' && part.plan !== undefined) return <PlanApproval part={part} roomId={roomId} />;
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

const STEP_WORDS = {
  terminal: ['команда', 'команды', 'команд'],
  edit: ['правка', 'правки', 'правок'],
  read: ['чтение', 'чтения', 'чтений'],
  search: ['поиск', 'поиска', 'поисков'],
  web: ['запрос в сеть', 'запроса в сеть', 'запросов в сеть'],
};

function plural(n, [one, few, many]) {
  const d = n % 10;
  const h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
}

// Подряд идущие шаги (команды, чтение, правки, размышления) одной строкой «N шагов».
function StepsGroup({ steps, cwd }) {
  const [open, setOpen] = useState(false);
  const running = steps.some((s) => s.status === 'running');
  const failed = steps.some((s) => s.status === 'error');
  const counts = {};
  for (const s of steps) if (STEP_WORDS[s.icon]) counts[s.icon] = (counts[s.icon] || 0) + 1;
  const summary = Object.entries(counts)
    .map(([k, n]) => `${n} ${plural(n, STEP_WORDS[k])}`)
    .join(', ');
  const last = steps[steps.length - 1];
  return (
    <div class={`steps-group ${open ? 'open' : ''}`}>
      <button class="tool-row" onClick={() => setOpen(!open)}>
        <Icon name="todo" size={14} class="tool-icon" />
        <span class="tool-title">
          {steps.length} {plural(steps.length, ['шаг', 'шага', 'шагов'])}
        </span>
        <span class="tool-sub">{running ? `${last.title}${last.subtitle ? ': ' + last.subtitle : ''}` : summary}</span>
        <span class="tool-status">{running ? <span class="spinner" /> : failed ? <Icon name="x" size={14} class="err" /> : <Icon name="check" size={14} class="ok" />}</span>
        <Icon name={open ? 'down' : 'right'} size={14} class="chev" />
      </button>
      {open && (
        <div class="steps-body">
          {steps.map((p) => (p.kind === 'thinking' ? <Thinking key={p.id} part={p} /> : <ToolPart key={p.id} part={p} cwd={cwd} />))}
        </div>
      )}
    </div>
  );
}

function Parts({ msg, room, byId }) {
  const prefs = useContext(PrefsContext);
  if (prefs.steps === 'grouped') {
    const out = [];
    let group = [];
    const flush = () => {
      if (group.length === 1) out.push(group[0].kind === 'thinking' ? <Thinking key={group[0].id} part={group[0]} /> : <ToolPart key={group[0].id} part={group[0]} cwd={room.cwd} />);
      else if (group.length) out.push(<StepsGroup key={group[0].id} steps={group} cwd={room.cwd} />);
      group = [];
    };
    for (const p of msg.parts) {
      // картинки, которые агент смотрел, не прячем в свёрнутую группу шагов
      if ((p.kind === 'tool' && p.icon !== 'todo' && !p.image) || p.kind === 'thinking') group.push(p);
      else {
        flush();
        out.push(renderPart(p, msg, room, byId));
      }
    }
    flush();
    return out;
  }
  return msg.parts.map((p) => renderPart(p, msg, room, byId));
}

function renderPart(p, msg, room, byId) {
  switch (p.kind) {
    case 'text':
      return <Markdown key={p.id} text={p.text} cwd={room.cwd} />;
    case 'thinking':
      return <Thinking key={p.id} part={p} />;
    case 'tool':
      return <ToolPart key={p.id} part={p} cwd={room.cwd} />;
    case 'approval':
      return <Approval key={p.id} part={p} roomId={room.id} agent={msg.agent} />;
    case 'question':
      return <Question key={p.id} part={p} roomId={room.id} agent={msg.agent} />;
    case 'planReady':
      return <PlanReady key={p.id} part={p} roomId={room.id} msgId={msg.id} agent={msg.agent} />;
    case 'steer':
      return (
        <div class="steer" key={p.id}>
          <span class="steer-label">Вы дописали</span>
          <div class="bubble">{p.text}</div>
          <Attachments items={p.attachments || []} />
        </div>
      );
    case 'delegate':
      return <Delegate key={p.id} part={p} from={msg.agent} room={room} byId={byId} />;
    default:
      return null;
  }
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function duration(msg) {
  if (!msg.finishedAt) return '';
  const s = Math.round((msg.finishedAt - msg.ts) / 1000);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

// Что агент поменял в файлах за этот ответ — с откатом и возвратом.
function CheckpointBar({ msg, room }) {
  const cp = msg.checkpoint;
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [diff, setDiff] = useState('');
  const [busy, setBusy] = useState(false);
  const n = cp.files.length;
  const word = n % 10 === 1 && n % 100 !== 11 ? 'файл' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'файла' : 'файлов';
  const toggle = async (f) => {
    if (file === f) return setFile(null);
    setFile(f);
    setDiff(await window.duo.checkpointDiff(room.id, msg.id, f));
  };
  const run = async (redo) => {
    if (!redo && !confirm(`Вернуть ${n} ${word} к состоянию до этого ответа? Если после ответа в этих файлах что-то менялось, эти правки тоже пропадут.`)) return;
    setBusy(true);
    await window.duo.revert(room.id, msg.id, redo);
    setBusy(false);
  };
  return (
    <div class={`checkpoint ${cp.reverted ? 'reverted' : ''}`}>
      <div class="checkpoint-row">
        <button class="link-btn" onClick={() => setOpen(!open)}>
          <Icon name={open ? 'down' : 'right'} size={13} />
          {cp.reverted ? `Откачено: ${n} ${word}` : `Изменено ${n} ${word}`}
        </button>
        {cp.reverted ? (
          <button class="chip-btn" disabled={busy} onClick={() => run(true)} title="Снова применить изменения этого ответа">
            <Icon name="redo" size={13} /> Вернуть
          </button>
        ) : (
          <button class="chip-btn" disabled={busy} onClick={() => run(false)} title="Вернуть файлы к состоянию до этого ответа">
            <Icon name="undo" size={13} /> Откатить
          </button>
        )}
      </div>
      {open && (
        <ul class="cp-files">
          {cp.files.map((f) => (
            <li key={f.path}>
              <button class="link-btn" onClick={() => toggle(f.path)}>
                <span class={`git-kind ${f.status === 'A' ? 'new' : f.status === 'D' ? 'deleted' : 'modified'}`}>{f.status}</span>
                {f.path}
              </button>
              {file === f.path && <DiffView diff={diff} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Дуэль: оба агента решили задачу в своих копиях проекта, пользователь выбирает вариант.
export function DuelCard({ card, room }) {
  const [view, setView] = useState(null);
  const pending = card.status === 'pending';
  const apply = (choice) => window.duo.duelApply(room.id, card.id, choice);
  return (
    <div class="duel">
      <div class="approval-head">
        <Icon name="swap" size={16} />
        <b>Сравнение решений</b>
        <span class="muted small">
          {card.status === 'running' ? 'агенты работают в своих копиях проекта…' : pending ? 'выберите вариант — он применится к проекту' : card.status === 'discarded' ? 'ничего не применено' : `применён вариант ${NAME[card.status.split(':')[1]]}`}
        </span>
      </div>
      <div class="duel-cols">
        {['claude', 'codex'].map((a) => {
          const r = card.results[a] || {};
          return (
            <div class={`duel-col ${card.status === 'applied:' + a ? 'chosen' : ''}`} key={a}>
              <div class="duel-col-head">
                <Avatar agent={a} size={18} />
                <b>{NAME[a]}</b>
                <span class="muted small">{r.status === 'running' ? 'работает…' : r.files ? `${r.files.length} файл(ов)` : ''}</span>
              </div>
              {r.files && (
                <ul class="cp-files">
                  {r.files.slice(0, 12).map((f) => (
                    <li key={f.path}>
                      <span class={`git-kind ${f.status === 'A' ? 'new' : f.status === 'D' ? 'deleted' : 'modified'}`}>{f.status}</span> {f.path}
                    </li>
                  ))}
                  {r.files.length > 12 && <li class="muted">и ещё {r.files.length - 12}</li>}
                </ul>
              )}
              {r.diff && (
                <button class="link small" onClick={() => setView(view === a ? null : a)}>
                  {view === a ? 'Скрыть изменения' : 'Показать изменения'}
                </button>
              )}
              {pending && r.files && r.files.length > 0 && (
                <button class="btn small primary duel-apply" onClick={() => apply(a)}>
                  Применить вариант {NAME[a]}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {view && card.results[view] && <DiffView diff={card.results[view].diff} />}
      {card.error && <div class="error-box">{card.error}</div>}
      {pending && (
        <div class="approval-actions">
          <button class="btn small ghost" onClick={() => apply('none')}>
            Ничего не применять
          </button>
        </div>
      )}
    </div>
  );
}

export function AgentMessage({ msg, room, byId, nested = false, onReview }) {
  const prefs = useContext(PrefsContext);
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
        {msg.plan && <span class="badge">план</span>}
        {msg.duelId && <span class="badge" title="Работает в своей копии проекта">сравнение</span>}
        {msg.pipeline && <span class="badge">{msg.pipeline}</span>}
        {msg.fork && <span class="badge" title="Агент был занят, поэтому запрос выполнен в ответвлении его сессии">параллельно</span>}
        <ModelTag msg={msg} />
        {running && <span class="working">работает…</span>}
        {msg.status === 'stopped' && <span class="msg-meta">остановлен</span>}
      </div>
      <div class="msg-body">
        <Parts msg={msg} room={room} byId={byId} />
        {msg.draft ? msg.draftKind === 'thinking' ? <div class="thinking live"><Icon name="sparkles" size={14} /> <span class="tool-sub">{msg.draft.slice(-200)}</span></div> : <Markdown text={msg.draft} class="streaming" cwd={room.cwd} /> : null}
        {running && empty && <div class="typing"><i /><i /><i /></div>}
        {msg.error && (
          <div class="error-box">
            <Icon name="alert" size={15} />
            <span>{msg.error}</span>
          </div>
        )}
        {msg.warning && !msg.error && running && <div class="warn-line">{msg.warning}</div>}
      </div>
      {msg.interrupted && !nested && <Interrupted msg={msg} room={room} />}
      {msg.checkpoint && !running && !nested && <CheckpointBar msg={msg} room={room} />}
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
          <span class="msg-meta" hidden={!prefs.showCost}>
            {fmtTime(msg.ts)}
            {duration(msg) ? ` · ${duration(msg)}` : ''}
            {msg.cost ? ` · $${msg.cost.toFixed(3)}` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

// Ход прервался, потому что DuoCode закрыли. «Продолжить» — только у последнего ответа этого агента.
function Interrupted({ msg, room }) {
  const later = room.messages.some((m) => m.role === 'agent' && m.agent === msg.agent && !m.parentId && m.ts > msg.ts);
  return (
    <div class="interrupted">
      <Icon name="alert" size={13} />
      <span>Прервано: DuoCode закрыли, пока {NAME[msg.agent]} работал. Сделанное до этого сохранилось{msg.checkpoint && !msg.checkpoint.reverted ? ', правки можно откатить' : ''}.</span>
      {!later && (
        <button
          class="chip-btn"
          onClick={() =>
            window.duo.send(room.id, {
              text: 'Продолжи с того места, где остановился: DuoCode закрыли посреди твоей работы. Сначала проверь, что уже успел сделать, и доделай задачу.',
              targets: [msg.agent],
            })
          }
        >
          <Icon name="play" size={13} /> Продолжить
        </button>
      )}
    </div>
  );
}

export function UserMessage({ msg, roomId }) {
  const both = msg.targets.length > 1;
  return (
    <div class={`msg user ${msg.local ? 'local' : ''}`}>
      <div class="user-to">
        {both ? 'Claude и Codex' : NAME[msg.targets[0]]}
        {msg.targets.map((t) => (
          <i class={`dot ${t}`} key={t} />
        ))}
        {msg.plan && <span class="queued plan-tag">· сначала план</span>}
        {msg.duel && <span class="queued plan-tag">· раздельно, для сравнения</span>}
        {msg.pipeline && <span class="queued plan-tag">· {msg.pipeline}</span>}
        {msg.queued && msg.queued.length > 0 && <span class="queued">· в очереди у {msg.queued.map((a) => NAME[a]).join(' и ')}</span>}
      </div>
      {msg.routed && <div class="routed">{msg.routed}</div>}
      <div class="bubble">{msg.text}</div>
      {msg.attachments && msg.attachments.length > 0 && <Attachments items={msg.attachments} />}
      {msg.unsent && msg.unsent.length > 0 && roomId && (
        <div class="interrupted user-side">
          <Icon name="alert" size={13} />
          <span>Не отправлено {msg.unsent.map((a) => NAME[a]).join(' и ')}: DuoCode закрылся, пока сообщение ждало очереди.</span>
          <button class="chip-btn" onClick={() => window.duo.resend(roomId, msg.id)}>
            Отправить
          </button>
        </div>
      )}
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
