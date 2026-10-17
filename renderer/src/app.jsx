import { render } from 'preact';
import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { Icon, Avatar } from './icons.jsx';
import { Attachments } from './attachments.jsx';
import { AgentMessage, UserMessage, SystemMessage, NAME, peerOf, EFFORT_NAME } from './messages.jsx';

const duo = window.duo;
const baseName = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');

const MODES = [
  { id: 'ask', name: 'Спрашивать', hint: 'Агенты спрашивают разрешение на команды и правки' },
  { id: 'edits', name: 'Авто-правки', hint: 'Правки файлов без вопросов, команды — с подтверждением' },
  { id: 'full', name: 'Полный доступ', hint: 'Всё без вопросов и без песочницы. Только для проектов, которым вы доверяете' },
];

const CLAUDE_MODELS = [
  { id: '', name: 'По умолчанию', description: 'Модель из настроек Claude Code' },
  { id: 'opus', name: 'Opus', description: 'Самая сильная, для сложных задач' },
  { id: 'sonnet', name: 'Sonnet', description: 'Быстрая и сильная, на каждый день' },
  { id: 'haiku', name: 'Haiku', description: 'Самая быстрая и экономная' },
];

const CLAUDE_EFFORTS = [
  { id: 'low', description: 'Быстрые ответы на простые вопросы' },
  { id: 'medium', description: 'Баланс скорости и глубины' },
  { id: 'high', description: 'Думает тщательнее' },
  { id: 'xhigh', description: 'Ещё глубже, заметно медленнее' },
  { id: 'max', description: 'Максимум размышлений: долго и дорого по лимитам' },
];

const TARGETS = [
  { id: 'claude', name: 'Claude', agents: ['claude'] },
  { id: 'codex', name: 'Codex', agents: ['codex'] },
  { id: 'both', name: 'Оба', agents: ['claude', 'codex'] },
];

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}

function fmtAgo(ts) {
  const s = (Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 1000;
  if (s < 60) return 'сейчас';
  if (s < 3600) return `${Math.floor(s / 60)} мин`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} дн`;
  return new Date(ts).toLocaleDateString();
}

function fmtUntil(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return 'сброс сейчас';
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `через ${d} д ${h} ч`;
  if (h > 0) return `через ${h} ч ${m % 60} мин`;
  return `через ${m % 60} мин`;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}

// ---------- Лимиты ----------

function LimitBlock({ agent, data, today, auth }) {
  const [open, setOpen] = useState(false);
  const windows = (data && data.ok && data.windows) || [];
  const main = windows.slice(0, 2);
  const rest = windows.slice(2);
  return (
    <div class={`limit ${agent}`}>
      <div class="limit-title">
        <Avatar agent={agent} size={16} />
        <b>{NAME[agent]}</b>
        {data && data.plan && <span class="plan">{data.plan}</span>}
        {today && <span class="today" title="Токенов за сегодня по локальным логам">{fmtTokens(today.total)} сегодня</span>}
      </div>
      {auth && auth.loggedIn === false ? (
        <div class="login-row">
          <span class="limit-note warn">Не выполнен вход</span>
          <button class="btn small" onClick={() => duo.login(agent)}>
            Войти
          </button>
        </div>
      ) : (
        <>
          {!data && <div class="limit-note">Загрузка…</div>}
          {data && !data.ok && <div class="limit-note warn">{data.error}</div>}
        </>
      )}
      {[...main, ...(open ? rest : [])].map((w) => {
        const pct = Math.max(0, Math.min(100, Math.round(w.percent)));
        return (
          <div class="limit-row" key={w.label} title={w.resetsAt ? `Сброс ${new Date(w.resetsAt).toLocaleString()}` : ''}>
            <div class="limit-meta">
              <span>{w.label}</span>
              <span class="limit-pct">{pct}%</span>
            </div>
            <div class="bar">
              <i class={pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : ''} style={{ width: pct + '%' }} />
            </div>
            <div class="limit-reset">{fmtUntil(w.resetsAt)}</div>
          </div>
        );
      })}
      {rest.length > 0 && (
        <button class="link small" onClick={() => setOpen(!open)}>
          {open ? 'Скрыть' : `Ещё ${rest.length}`}
        </button>
      )}
      {data && data.note && <div class="limit-note">Данные {data.note}</div>}
    </div>
  );
}

function Limits({ limits, onRefresh, refreshing, env }) {
  return (
    <div class="limits">
      <div class="limits-head">
        <span class="section">Лимиты</span>
        <button class={`icon-btn ${refreshing ? 'spin' : ''}`} onClick={onRefresh} title="Обновить">
          <Icon name="refresh" size={13} />
        </button>
      </div>
      <LimitBlock agent="claude" data={limits.claude} today={limits.today && limits.today.claude} auth={env && env.claude} />
      <LimitBlock agent="codex" data={limits.codex} today={limits.today && limits.today.codex} auth={env && env.codex} />
    </div>
  );
}

// ---------- Боковая панель ----------

function UpdateBanner({ update }) {
  if (!update || (update.status !== 'ready' && update.status !== 'downloading')) return null;
  return (
    <div class={`update-banner ${update.status}`}>
      <Icon name="refresh" size={14} />
      {update.status === 'ready' ? (
        <>
          <span>Версия {update.version} готова</span>
          <button class="btn small primary" onClick={() => duo.installUpdate()}>
            Перезапустить
          </button>
        </>
      ) : (
        <span>Загружается версия {update.version}…</span>
      )}
    </div>
  );
}

function Sidebar({ rooms, currentId, onOpen, onNew, limits, onRefreshLimits, refreshing, onSettings, env, update }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const filtered = rooms.filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase()) || (r.cwd || '').toLowerCase().includes(q.toLowerCase()));
    const map = new Map();
    for (const r of filtered) {
      const key = r.cwd || '';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    return [...map.entries()];
  }, [rooms, q]);

  return (
    <aside class="sidebar">
      <div class="drag brand">
        <span class="logo">
          <i class="claude" />
          <i class="codex" />
        </span>
        DuoCode
      </div>
      <button class="new-chat" onClick={onNew}>
        <Icon name="plus" size={16} />
        Новый чат
      </button>
      <input class="search" type="search" placeholder="Поиск чатов" value={q} onInput={(e) => setQ(e.target.value)} />
      <nav class="rooms">
        {groups.length === 0 && <div class="rooms-empty">{rooms.length ? 'Ничего не найдено' : 'Чатов пока нет'}</div>}
        {groups.map(([cwd, list]) => (
          <div class="group" key={cwd}>
            <div class="group-title" title={cwd}>
              <Icon name="folder" size={13} />
              {baseName(cwd) || 'Без проекта'}
            </div>
            {list.map((r) => (
              <button key={r.id} class={`room ${r.id === currentId ? 'active' : ''}`} onClick={() => onOpen(r.id)}>
                <span class="room-title">{r.title}</span>
                <span class="room-side">
                  {r.waiting && <span class="waiting" title="Ждёт вашего подтверждения" />}
                  {r.running.claude && <i class="pulse claude" title="Claude работает" />}
                  {r.running.codex && <i class="pulse codex" title="Codex работает" />}
                  {!r.running.claude && !r.running.codex && !r.waiting && <span class="room-time">{fmtAgo(r.updatedAt)}</span>}
                </span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <Limits limits={limits} onRefresh={onRefreshLimits} refreshing={refreshing} env={env} />
      <UpdateBanner update={update} />
      <button class="settings-btn" onClick={onSettings}>
        <Icon name="settings" size={15} />
        Настройки
      </button>
    </aside>
  );
}

// ---------- Поле ввода ----------

function parseMention(text, fallback) {
  const m = text.match(/^\s*@(claude|codex|оба|both|клод|кодекс)\b[\s,:]*/i);
  if (!m) return { text, target: fallback };
  const w = m[1].toLowerCase();
  const target = w === 'claude' || w === 'клод' ? 'claude' : w === 'codex' || w === 'кодекс' ? 'codex' : 'both';
  return { text: text.slice(m[0].length), target };
}

function Composer({ onSend, onStop, running, busy = [], target, setTarget, autoFocus, placeholder }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [plan, setPlan] = useState(false);
  const [drag, setDrag] = useState(false);
  const ref = useRef();

  useEffect(() => {
    if (autoFocus && ref.current) ref.current.focus();
  }, [autoFocus]);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 260) + 'px';
  }, [text]);

  const mention = parseMention(text, target);
  const effective = mention.target;
  const agents = TARGETS.find((t) => t.id === effective).agents;
  const steering = !plan && agents.some((a) => busy.includes(a));
  const canSend = mention.text.trim() || files.length;

  const addFiles = (list) => setFiles((cur) => [...cur, ...list.filter((f) => !cur.some((c) => c.path === f.path))]);

  const onPaste = async (e) => {
    const items = [...(e.clipboardData ? e.clipboardData.items : [])].filter((i) => i.kind === 'file');
    if (!items.length) return;
    e.preventDefault();
    for (const item of items) {
      const file = item.getAsFile();
      const p = duo.pathForFile(file);
      if (p) addFiles(await duo.describeFiles([p]));
      else addFiles([await duo.saveAttachment(file.name || 'снимок.png', new Uint8Array(await file.arrayBuffer()))]);
    }
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDrag(false);
    const paths = [...e.dataTransfer.files].map((f) => duo.pathForFile(f)).filter(Boolean);
    if (paths.length) addFiles(await duo.describeFiles(paths));
  };

  const submit = () => {
    if (!canSend) return;
    onSend(mention.text, agents, { attachments: files, plan });
    setText('');
    setFiles([]);
    setPlan(false);
  };

  const hint = steering
    ? `${agents.filter((a) => busy.includes(a)).map((a) => NAME[a]).join(' и ')} сейчас работает — сообщение допишется в его работу`
    : plan
      ? 'Сначала план: агент изучит задачу и предложит план, вы его утвердите'
      : 'Enter — отправить · Shift+Enter — новая строка';

  return (
    <div
      class={`composer ${drag ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      <Attachments items={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder || 'Напишите задачу… (@claude или @codex — кому адресовать)'}
        onInput={(e) => setText(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div class="composer-bar">
        <button class="icon-btn" onClick={async () => addFiles(await duo.pickAttachments())} title="Прикрепить файлы или картинки (можно вставить скриншот через Ctrl+V или перетащить)">
          <Icon name="clip" size={16} />
        </button>
        <div class="segmented" role="radiogroup" aria-label="Кому отправить">
          {TARGETS.map((t) => (
            <button
              key={t.id}
              class={`seg ${t.id} ${effective === t.id ? 'active' : ''}`}
              onClick={() => setTarget(t.id)}
              role="radio"
              aria-checked={effective === t.id}
            >
              {t.agents.map((a) => (
                <i class={`dot ${a}`} key={a} />
              ))}
              {t.name}
            </button>
          ))}
        </div>
        <button class={`toggle ${plan ? 'on' : ''}`} onClick={() => setPlan(!plan)} title="Сначала план: агент ничего не меняет, а предлагает план на утверждение">
          <Icon name="todo" size={14} />
          План
        </button>
        <span class={`composer-hint ${steering ? 'steer' : ''}`}>{hint}</span>
        {running && (
          <button class="stop-btn" onClick={onStop} title="Остановить всех агентов в этом чате">
            <Icon name="stop" size={16} />
          </button>
        )}
        <button class="send-btn" onClick={submit} disabled={!canSend} title={steering ? 'Дописать в текущую работу' : 'Отправить'}>
          <Icon name={steering ? 'plus' : 'up'} size={16} />
        </button>
      </div>
    </div>
  );
}

// ---------- Чат ----------

function codexEfforts(models, id) {
  const m = models.find((x) => x.id === id) || models.find((x) => x.isDefault) || models[0];
  if (m && m.efforts && m.efforts.length) return m.efforts;
  return ['low', 'medium', 'high', 'xhigh'].map((e) => ({ id: e }));
}

// Держит ленту прижатой к низу, пока пользователь сам не прокрутил вверх.
function useStickyScroll() {
  const ref = useRef();
  const inner = useRef();
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner.current);
    el.scrollTop = el.scrollHeight;
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    const el = ref.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const stickNow = () => {
    stick.current = true;
    ref.current.scrollTop = ref.current.scrollHeight;
  };
  return [ref, inner, onScroll, stickNow];
}

function Select({ value, options, onChange, title }) {
  return (
    <label class="select" title={title}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option value={o.id} key={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <Icon name="down" size={13} />
    </label>
  );
}

// Настройка агента в чате: модель и уровень размышлений.
function AgentChip({ agent, model, effort, models, efforts, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const modelName = (models.find((m) => m.id === model) || models[0]).name;
  return (
    <div class="menu-wrap" ref={ref}>
      <button class={`agent-chip ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} title={`Модель и уровень размышлений ${NAME[agent]}`}>
        <Avatar agent={agent} size={16} />
        <span>{model ? modelName : NAME[agent]}</span>
        <span class="chip-effort">{effort ? EFFORT_NAME[effort] || effort : 'авто'}</span>
        <Icon name="down" size={13} />
      </button>
      {open && (
        <div class="menu agent-menu">
          <div class="menu-section">Модель {NAME[agent]}</div>
          {models.map((m) => (
            <button key={m.id} class={`menu-option ${m.id === model ? 'selected' : ''}`} onClick={() => onChange({ model: m.id })}>
              <span class="radio" />
              <span>
                <b>{m.name}</b>
                {m.description && <small>{m.description}</small>}
              </span>
            </button>
          ))}
          <div class="menu-section">Уровень размышлений</div>
          <button class={`menu-option ${!effort ? 'selected' : ''}`} onClick={() => onChange({ effort: '' })}>
            <span class="radio" />
            <span>
              <b>Авто</b>
              <small>Как настроено в {NAME[agent]} по умолчанию</small>
            </span>
          </button>
          {efforts.map((e) => (
            <button key={e.id} class={`menu-option ${e.id === effort ? 'selected' : ''}`} onClick={() => onChange({ effort: e.id })}>
              <span class="radio" />
              <span>
                <b>{EFFORT_NAME[e.id] ? EFFORT_NAME[e.id][0].toUpperCase() + EFFORT_NAME[e.id].slice(1) : e.id}</b>
                {e.description && <small>{e.description}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RoomHeader({ room, codexModels, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(room.title);
  const [menu, setMenu] = useState(false);
  useEffect(() => setTitle(room.title), [room.title]);
  const s = room.settings;
  const set = (patch) => duo.setRoomSettings(room.id, patch);
  const mode = MODES.find((m) => m.id === s.mode) || MODES[0];

  return (
    <header class="room-header drag">
      <div class="room-heading no-drag">
        {editing ? (
          <input
            class="title-input"
            value={title}
            autoFocus
            onInput={(e) => setTitle(e.target.value)}
            onBlur={() => {
              setEditing(false);
              duo.renameRoom(room.id, title);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.target.blur();
              if (e.key === 'Escape') {
                setTitle(room.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <h1 onDblClick={() => setEditing(true)} title="Дважды щёлкните, чтобы переименовать">
            {room.title}
          </h1>
        )}
        <button class="project-chip" onClick={() => duo.openProject(room.cwd)} title={room.cwd}>
          <Icon name="folder" size={13} />
          {baseName(room.cwd)}
        </button>
      </div>
      <div class="room-controls no-drag">
        <Select value={s.mode} options={MODES} onChange={(v) => set({ mode: v })} title={mode.hint} />
        <AgentChip
          agent="claude"
          model={s.claudeModel || ''}
          effort={s.claudeEffort || ''}
          models={CLAUDE_MODELS}
          efforts={CLAUDE_EFFORTS}
          onChange={(p) => set('model' in p ? { claudeModel: p.model } : { claudeEffort: p.effort })}
        />
        <AgentChip
          agent="codex"
          model={s.codexModel || ''}
          effort={s.codexEffort || ''}
          models={[{ id: '', name: 'По умолчанию', description: 'Модель из настроек Codex' }, ...codexModels.map((m) => ({ id: m.id, name: m.name, description: m.isDefault ? 'модель по умолчанию' : '' }))]}
          efforts={codexEfforts(codexModels, s.codexModel)}
          onChange={(p) => {
            if ('model' in p) {
              const ok = codexEfforts(codexModels, p.model).some((e) => e.id === s.codexEffort);
              set({ codexModel: p.model, ...(ok ? {} : { codexEffort: '' }) });
            } else set({ codexEffort: p.effort });
          }}
        />
        <div class="menu-wrap">
          <button class="icon-btn" onClick={() => setMenu(!menu)} title="Ещё">
            <Icon name="more" size={16} />
          </button>
          {menu && (
            <div class="menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); setEditing(true); }}>
                <Icon name="edit" size={14} /> Переименовать
              </button>
              <button onClick={() => { setMenu(false); duo.openProject(room.cwd); }}>
                <Icon name="external" size={14} /> Открыть папку проекта
              </button>
              <button class="danger" onClick={() => { setMenu(false); onDelete(); }}>
                <Icon name="trash" size={14} /> Удалить чат
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function RoomView({ room, codexModels, onDelete }) {
  const [target, setTargetState] = useState(() => store(`target:${room.id}`) || 'both');
  const setTarget = (t) => {
    setTargetState(t);
    store(`target:${room.id}`, t);
  };
  const byId = useMemo(() => new Map(room.messages.map((m) => [m.id, m])), [room.messages]);
  const top = room.messages.filter((m) => !m.parentId);
  const running = room.running && (room.running.claude || room.running.codex);
  const [scrollRef, innerRef, onScroll, stickNow] = useStickyScroll();

  const send = (text, agents, opts = {}) => {
    stickNow();
    return duo.send(room.id, { text, targets: agents, ...opts });
  };
  const review = (msg) =>
    send(
      `Проверь последний ответ ${NAME[msg.agent]} выше: найди ошибки и слабые места, предложи улучшения. Если всё хорошо — так и скажи.`,
      [peerOf(msg.agent)],
    );

  const onClick = (e) => {
    const btn = e.target.closest('.copy-code');
    if (btn) {
      const code = btn.closest('.codeblock').querySelector('code');
      duo.copy(code.innerText);
      btn.textContent = 'Скопировано';
      setTimeout(() => (btn.textContent = 'Копировать'), 1500);
    }
  };

  return (
    <section class="room-view">
      <RoomHeader room={room} codexModels={codexModels} onDelete={onDelete} />
      <div class="scroll" ref={scrollRef} onScroll={onScroll} onClick={onClick}>
        <div class="thread" ref={innerRef}>
          {top.length === 0 && (
            <div class="thread-empty">
              <p>
                Пишите задачу ниже. Выберите, кому её адресовать: <b>Claude</b>, <b>Codex</b> или <b>обоим</b>. Агенты видят, что делал другой, и могут
                сами подключать друг друга.
              </p>
            </div>
          )}
          {top.map((m) =>
            m.role === 'user' ? (
              <UserMessage msg={m} key={m.id} />
            ) : m.role === 'system' ? (
              <SystemMessage msg={m} key={m.id} />
            ) : (
              <AgentMessage msg={m} room={room} byId={byId} key={m.id} onReview={review} />
            ),
          )}
        </div>
      </div>
      <div class="composer-wrap">
        <Composer
          onSend={send}
          onStop={() => duo.stop(room.id)}
          running={running}
          busy={['claude', 'codex'].filter((a) => room.running && room.running[a])}
          target={target}
          setTarget={setTarget}
          autoFocus={room.id}
        />
      </div>
    </section>
  );
}

// ---------- Новый чат ----------

function EnvWarning({ env }) {
  if (!env) return null;
  const missing = ['claude', 'codex'].filter((a) => !env[a]);
  const loggedOut = ['claude', 'codex'].filter((a) => env[a] && env[a].loggedIn === false);
  if (!missing.length && !loggedOut.length) return null;
  const win = env.platform === 'win32';
  const hints = {
    claude: win ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
    codex: 'npm i -g @openai/codex',
  };
  return (
    <div class="env-warning">
      <Icon name="alert" size={16} />
      <div>
        {missing.map((a) => (
          <div key={a}>
            <b>{NAME[a]} не найден.</b> Установите и войдите в аккаунт, затем перезапустите DuoCode: <code>{hints[a]}</code>
          </div>
        ))}
        {loggedOut.map((a) => (
          <div key={a} class="login-row">
            <span>
              <b>Не выполнен вход в {NAME[a]}.</b> Откроется окно входа, войдите в аккаунт и вернитесь сюда.
            </span>
            <button class="btn small" onClick={() => duo.login(a)}>
              Войти в {NAME[a]}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function NewChat({ settings, env, onCreated }) {
  const [project, setProject] = useState(settings.projects[0] || '');
  const [target, setTarget] = useState(store('target:new') || 'both');
  const [history, setHistory] = useState([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    duo.history().then(setHistory);
  }, []);
  useEffect(() => {
    if (!project && settings.projects[0]) setProject(settings.projects[0]);
  }, [settings.projects]);

  const pick = async () => {
    const dir = await duo.pickProject();
    if (dir) setProject(dir);
  };

  const send = async (text, agents, opts = {}) => {
    let cwd = project;
    if (!cwd) {
      cwd = await duo.pickProject();
      if (!cwd) return;
      setProject(cwd);
    }
    const room = await duo.createRoom({ cwd });
    await duo.send(room.id, { text, targets: agents, ...opts });
    store(`target:${room.id}`, target);
    onCreated(room.id);
  };

  const importSession = async (s) => {
    const room = await duo.importSession({ tool: s.tool, sessionId: s.id, cwd: s.cwd, title: s.title });
    onCreated(room.id);
  };

  const projects = [...new Set([project, ...settings.projects].filter(Boolean))];
  const list = showAll ? history : history.slice(0, 6);

  return (
    <section class="new-chat-view">
      <div class="drag top-drag" />
      <div class="new-inner">
        <div class="hero">
          <span class="hero-logo">
            <Avatar agent="claude" size={40} />
            <Avatar agent="codex" size={40} />
          </span>
          <h1>Над чем работаем?</h1>
          <p>Claude и Codex в одном чате: общий контекст, совместная работа и взаимные проверки.</p>
        </div>
        <EnvWarning env={env} />
        <div class="project-row">
          <Icon name="folder" size={15} />
          {projects.length ? (
            <label class="select project-select">
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                {projects.map((p) => (
                  <option value={p} key={p}>
                    {baseName(p)} — {p}
                  </option>
                ))}
              </select>
              <Icon name="down" size={13} />
            </label>
          ) : (
            <span class="muted">Папка проекта не выбрана</span>
          )}
          <button class="btn" onClick={pick}>
            Выбрать папку…
          </button>
        </div>
        <Composer
          onSend={send}
          target={target}
          setTarget={(t) => {
            setTarget(t);
            store('target:new', t);
          }}
          autoFocus
          placeholder="Опишите задачу. Например: «@claude спланируй, а Codex пусть проверит план»"
        />
        {history.length > 0 && (
          <div class="resume">
            <div class="section">Продолжить сессию из терминала</div>
            <div class="resume-list">
              {list.map((s) => (
                <button class="resume-item" key={s.tool + s.id} onClick={() => importSession(s)} title={s.cwd}>
                  <Avatar agent={s.tool} size={18} />
                  <span class="resume-title">{s.title}</span>
                  <span class="resume-meta">
                    {baseName(s.cwd)} · {fmtAgo(s.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
            {history.length > 6 && (
              <button class="link small" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Свернуть' : `Показать все (${history.length})`}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- Настройки ----------

function Settings({ settings, env, onClose, onSaved, update, onUpdate }) {
  const [version, setVersion] = useState('');
  useEffect(() => {
    duo.version().then(setVersion);
  }, []);
  const [claude, setClaude] = useState(settings.claudeCommand);
  const [codex, setCodex] = useState(settings.codexCommand);
  const save = async () => {
    await duo.setSettings({ claudeCommand: claude.trim() || 'claude', codexCommand: codex.trim() || 'codex' });
    onSaved();
    onClose();
  };
  const row = (agent, value, set) => (
    <div class="field">
      <label>
        <Avatar agent={agent} size={16} /> Команда {NAME[agent]}
      </label>
      <div class="field-row">
        <input value={value} onInput={(e) => set(e.target.value)} spellcheck={false} />
        {env && env[agent] && (
          <button class="btn small" onClick={() => duo.login(agent)}>
            {env[agent].loggedIn ? 'Сменить аккаунт' : 'Войти'}
          </button>
        )}
      </div>
      <div class="field-hint">
        {env && env[agent] ? (
          <>
            Найден: <code>{env[agent].path}</code>
            {env[agent].version ? ` · ${env[agent].version}` : ''}
            {env[agent].loggedIn === false && <span class="warn"> · вход не выполнен</span>}
          </>
        ) : (
          <span class="warn">Не найден. Укажите полный путь к файлу или установите {NAME[agent]}.</span>
        )}
      </div>
    </div>
  );
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal">
        <div class="modal-head">
          <h2>Настройки</h2>
          <button class="icon-btn" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {row('claude', claude, setClaude)}
        {row('codex', codex, setCodex)}
        <p class="field-hint">
          DuoCode запускает установленные у вас Claude Code и Codex и использует их вход и подписки. Данные чатов хранятся только на этом компьютере.
        </p>
        <div class="about">
          <span>DuoCode {version}</span>
          <span class="muted">
            {update.status === 'checking' && 'Проверяю обновления…'}
            {update.status === 'latest' && 'Установлена последняя версия'}
            {update.status === 'downloading' && `Загружается версия ${update.version}…`}
            {update.status === 'ready' && `Версия ${update.version} готова к установке`}
            {update.status === 'error' && `Не удалось проверить обновления: ${update.error}`}
            {update.status === 'dev' && 'Обновления работают только в установленной версии'}
          </span>
          {update.status === 'ready' ? (
            <button class="btn small primary" onClick={() => duo.installUpdate()}>
              Перезапустить
            </button>
          ) : (
            <button class="btn small" onClick={async () => onUpdate(await duo.checkUpdate())}>
              Проверить
            </button>
          )}
        </div>
        <div class="modal-actions">
          <button class="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button class="btn primary" onClick={save}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Приложение ----------

function App() {
  const [rooms, setRooms] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [room, setRoom] = useState(null);
  const [limits, setLimits] = useState({ claude: null, codex: null, today: null });
  const [refreshing, setRefreshing] = useState(false);
  const [settings, setSettings] = useState({ projects: [] });
  const [env, setEnv] = useState(null);
  const [codexModels, setCodexModels] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [update, setUpdate] = useState({ status: 'idle' });
  const currentRef = useRef(null);
  currentRef.current = currentId;

  const loadSettings = useCallback(() => {
    duo.getSettings().then(setSettings);
    duo.checkEnv().then(setEnv);
  }, []);

  useEffect(() => {
    duo.listRooms().then(setRooms);
    duo.limits().then(setLimits);
    duo.codexModels().then(setCodexModels);
    loadSettings();
    duo.getUpdate().then((u) => u && setUpdate({ ...u }));
    // после входа в окне консоли пользователь возвращается сюда — перепроверяем вход и лимиты
    let last = Date.now();
    const onFocus = () => {
      if (Date.now() - last < 5000) return;
      last = Date.now();
      duo.checkEnv().then(setEnv);
      duo.refreshLimits().then(setLimits);
    };
    window.addEventListener('focus', onFocus);
    const offs = [
      () => window.removeEventListener('focus', onFocus),
      duo.onRooms((list) => {
        setRooms(list);
        const cur = list.find((r) => r.id === currentRef.current);
        if (cur) setRoom((r) => (r && r.id === cur.id ? { ...r, ...cur } : r));
      }),
      duo.onMessages((roomId, msgs) => {
        if (roomId !== currentRef.current) return;
        setRoom((r) => {
          if (!r || r.id !== roomId) return r;
          const messages = r.messages.slice();
          for (const m of msgs) {
            const i = messages.findIndex((x) => x.id === m.id);
            if (i >= 0) messages[i] = m;
            else messages.push(m);
          }
          return { ...r, messages };
        });
      }),
      duo.onLimits(setLimits),
      duo.onUpdate((u) => setUpdate({ ...u })),
      duo.onOpenRoom((id) => open(id)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const open = async (id) => {
    setCurrentId(id);
    currentRef.current = id;
    setRoom(id ? await duo.getRoom(id) : null);
    if (id) store('lastRoom', id);
  };

  useEffect(() => {
    const last = store('lastRoom');
    if (last) duo.getRoom(last).then((r) => r && open(last));
  }, []);

  const refreshLimits = async () => {
    setRefreshing(true);
    try {
      setLimits(await duo.refreshLimits());
    } finally {
      setRefreshing(false);
    }
  };

  const removeRoom = async () => {
    if (!room || !confirm(`Удалить чат «${room.title}»? Сессии Claude и Codex останутся в их истории.`)) return;
    await duo.removeRoom(room.id);
    open(null);
  };

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        open(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div class={`app platform-${duo.platform}`}>
      <Sidebar
        rooms={rooms}
        currentId={currentId}
        onOpen={open}
        onNew={() => open(null)}
        limits={limits}
        onRefreshLimits={refreshLimits}
        refreshing={refreshing}
        env={env}
        update={update}
        onSettings={() => {
          loadSettings();
          setShowSettings(true);
        }}
      />
      <main class="main">
        {room ? (
          <RoomView key={room.id} room={room} codexModels={codexModels} onDelete={removeRoom} />
        ) : (
          <NewChat
            settings={settings}
            env={env}
            onCreated={(id) => {
              loadSettings();
              open(id);
            }}
          />
        )}
      </main>
      {showSettings && <Settings settings={settings} env={env} update={update} onUpdate={(u) => u && setUpdate({ ...u })} onClose={() => setShowSettings(false)} onSaved={loadSettings} />}
    </div>
  );
}

render(<App />, document.getElementById('root'));
