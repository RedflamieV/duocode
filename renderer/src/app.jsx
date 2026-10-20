import { render } from 'preact';
import { useState, useEffect, useRef, useMemo, useCallback, useContext } from 'preact/hooks';
import { PrefsContext, DEFAULT_PREFS, applyPrefs } from './prefs.js';
import { Icon, Avatar } from './icons.jsx';
import { Attachments, Lightbox } from './attachments.jsx';
import { AgentMessage, UserMessage, SystemMessage, DuelCard, NAME, peerOf, EFFORT_NAME } from './messages.jsx';
import { TitleInput } from './titleinput.jsx';
import { SidePanel, StatsModal } from './panels.jsx';

const duo = window.duo;
const baseName = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');

const MODES = [
  { id: 'ask', name: 'Спрашивать', hint: 'Агенты спрашивают разрешение на команды и правки' },
  { id: 'edits', name: 'Авто-правки', hint: 'Правки файлов без вопросов, команды — с подтверждением' },
  {
    id: 'auto',
    name: 'Авто',
    hint: 'Как авто-режим в терминале: Claude сам оценивает риск и спрашивает только о рискованном, Codex работает в песочнице и просит разрешение, только когда нужно выйти за неё',
  },
  { id: 'full', name: 'Полный доступ', hint: 'Всё без вопросов и без песочницы. Только для проектов, которым вы доверяете' },
];

const CLAUDE_MODELS = [
  { id: '', name: 'По умолчанию', description: 'Модель из настроек Claude Code' },
  { id: 'opus', name: 'Opus', description: 'Самая сильная, для сложных задач' },
  { id: 'sonnet', name: 'Sonnet', description: 'Быстрая и сильная, на каждый день' },
  { id: 'haiku', name: 'Haiku', description: 'Самая быстрая и экономная' },
];

const DELEGATION = [
  { id: 'auto', name: 'Сам решает', hint: 'Агент сам подключает напарника, когда это реально помогает' },
  { id: 'ask', name: 'Спрашивать меня', hint: 'Перед каждым вызовом напарника — подтверждение' },
  { id: 'off', name: 'Запрещено', hint: 'Агенты работают только поодиночке — экономия лимитов' },
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
  { id: 'auto', name: 'Авто', agents: ['auto'] },
];

const IMG = /\.(png|jpe?g|gif|webp|bmp)$/i;

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
            <div class="limit-reset">
              {fmtUntil(w.resetsAt)}
              {w.runsOutAt && (
                <span class="runs-out" title="Если расходовать так же, как с начала окна, лимит закончится раньше сброса">
                  {' · кончится ~'}
                  {new Date(w.runsOutAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
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

function Sidebar({ rooms, projects = [], currentId, onOpen, onNew, onNewIn, onEditProject, onDeleteRoom, limits, onRefreshLimits, refreshing, onSettings, onStats, env, update }) {
  const [renaming, setRenaming] = useState(null); // id чата, который переименовывают
  const [ctx, setCtx] = useState(null); // контекстное меню чата: { id, x, y }
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, [ctx]);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return JSON.parse(store('collapsed') || '{}');
    } catch {
      return {};
    }
  });
  const toggle = (key) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    store('collapsed', JSON.stringify(next));
  };
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(() => duo.searchRooms(q).then(setFound), 200);
    return () => clearTimeout(t);
  }, [q]);
  const [showArchive, setShowArchive] = useState(false);
  const archivedCount = rooms.filter((r) => r.archived).length;
  const groups = useMemo(() => {
    // группы: закреплённые, проекты (в порядке последней активности), проекты без чатов, архив (по кнопке)
    const needle = q.toLowerCase();
    const byId = new Map(projects.map((p) => [p.id, p]));
    const map = new Map();
    const pinned = { key: 'pinned', special: 'pin', name: 'Закреплённые', folders: [], rooms: [] };
    const archive = { key: 'archive', special: 'archive', name: 'Архив', folders: [], rooms: [] };
    map.set('pinned', pinned);
    for (const r of rooms) {
      if (r.archived || r.pinned) {
        const p = r.projectId && byId.get(r.projectId);
        const name = p ? p.name : baseName(r.cwd);
        if (needle && !r.title.toLowerCase().includes(needle) && !(name || '').toLowerCase().includes(needle)) continue;
        if (r.archived) archive.rooms.push(r);
        else pinned.rooms.push(r);
        continue;
      }
      const p = r.projectId && byId.get(r.projectId);
      const key = p ? p.id : `dir:${r.cwd || ''}`;
      const name = p ? p.name : baseName(r.cwd) || 'Без проекта';
      if (needle && !r.title.toLowerCase().includes(needle) && !name.toLowerCase().includes(needle)) continue;
      if (!map.has(key)) map.set(key, { key, project: p || null, name, folders: p ? p.folders : [r.cwd], rooms: [] });
      map.get(key).rooms.push(r);
    }
    if (!needle) for (const p of projects) if (!map.has(p.id)) map.set(p.id, { key: p.id, project: p, name: p.name, folders: p.folders, rooms: [] });
    if (!pinned.rooms.length) map.delete('pinned');
    if ((showArchive || needle) && archive.rooms.length) map.set('archive', archive);
    return [...map.values()];
  }, [rooms, projects, q, showArchive]);

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
        {groups.length === 0 && !found.length && <div class="rooms-empty">{rooms.length ? 'Ничего не найдено' : 'Проектов и чатов пока нет'}</div>}
        {found.length > 0 && (
          <div class="group">
            <div class="group-title">
              <Icon name="search" size={13} />
              В сообщениях
            </div>
            {found.slice(0, 20).map((f, i) => (
              <button key={i} class="found" onClick={() => onOpen(f.roomId, f.msgId)}>
                <span class="found-room">
                  {f.roomTitle} · {f.who}
                </span>
                <span class="found-snippet">{f.snippet}</span>
              </button>
            ))}
          </div>
        )}
        {groups.map((g) => (
          <div class="group" key={g.key}>
            <div class="group-title project-title" title={g.folders.join('\n')}>
              <button class="group-toggle" onClick={() => toggle(g.key)}>
                <Icon name={collapsed[g.key] ? 'right' : 'down'} size={12} />
                <Icon name={g.special || 'folder'} size={13} />
                <span class="group-name">{g.name}</span>
                {g.folders.length > 1 && <span class="group-count">{g.folders.length}</span>}
              </button>
              {g.project && (
                <span class="group-actions">
                  <button class="icon-btn tiny" title="Новый чат в проекте" onClick={() => onNewIn(g.project.id)}>
                    <Icon name="plus" size={13} />
                  </button>
                  <button class="icon-btn tiny" title="Изменить проект: название и папки" onClick={() => onEditProject(g.project)}>
                    <Icon name="settings" size={13} />
                  </button>
                </span>
              )}
            </div>
            {!collapsed[g.key] && g.rooms.length === 0 && g.project && (
              <button class="room empty-room" onClick={() => onNewIn(g.project.id)}>
                <Icon name="plus" size={13} /> Начать чат
              </button>
            )}
            {!collapsed[g.key] && g.rooms.map((r) =>
              renaming === r.id ? (
                <div key={r.id} class={`room editing ${r.id === currentId ? 'active' : ''}`}>
                  <TitleInput class="room-input" value={r.title} onSave={(t) => duo.renameRoom(r.id, t)} onDone={() => setRenaming(null)} />
                </div>
              ) : (
              <button
                key={r.id}
                class={`room ${r.id === currentId ? 'active' : ''}`}
                onClick={() => onOpen(r.id)}
                onDblClick={() => setRenaming(r.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtx({ id: r.id, x: e.clientX, y: e.clientY });
                }}
                title="Двойной щелчок — переименовать, правая кнопка — меню"
              >
                <span class="room-title">{r.title}</span>
                <span
                  class="room-edit"
                  title="Переименовать"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenaming(r.id);
                  }}
                >
                  <Icon name="edit" size={12} />
                </span>
                <span class="room-side">
                  {r.waiting && <span class="waiting" title="Ждёт вашего подтверждения" />}
                  {r.running.claude && <i class="pulse claude" title="Claude работает" />}
                  {r.running.codex && <i class="pulse codex" title="Codex работает" />}
                  {!r.running.claude && !r.running.codex && !r.waiting && <span class="room-time">{fmtAgo(r.updatedAt)}</span>}
                </span>
              </button>
              ),
            )}
          </div>
        ))}
        {archivedCount > 0 && !q && (
          <button class="archive-toggle" onClick={() => setShowArchive(!showArchive)}>
            <Icon name="archive" size={13} /> {showArchive ? 'Скрыть архив' : `Архив · ${archivedCount}`}
          </button>
        )}
      </nav>
      {ctx && (
        <div class="menu context-menu" style={{ left: ctx.x, top: ctx.y, right: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setRenaming(ctx.id); setCtx(null); }}>
            <Icon name="edit" size={14} /> Переименовать
          </button>
          {(() => {
            const r = rooms.find((x) => x.id === ctx.id);
            if (!r) return null;
            return (
              <>
                {!r.archived && (
                  <button onClick={() => { duo.markRoom(r.id, { pinned: !r.pinned }); setCtx(null); }}>
                    <Icon name="pin" size={14} /> {r.pinned ? 'Открепить' : 'Закрепить наверху'}
                  </button>
                )}
                <button onClick={() => { duo.markRoom(r.id, { archived: !r.archived }); setCtx(null); }}>
                  <Icon name="archive" size={14} /> {r.archived ? 'Вернуть из архива' : 'В архив'}
                </button>
              </>
            );
          })()}
          <button class="danger" onClick={() => { onDeleteRoom(ctx.id); setCtx(null); }}>
            <Icon name="trash" size={14} /> Удалить чат
          </button>
        </div>
      )}
      <button class="new-project" onClick={() => onEditProject({ name: '', folders: [] })}>
        <Icon name="folder" size={14} /> Новый проект
      </button>
      <Limits limits={limits} onRefresh={onRefreshLimits} refreshing={refreshing} env={env} />
      <UpdateBanner update={update} />
      <div class="sidebar-foot">
        <button class="settings-btn" onClick={onSettings}>
          <Icon name="settings" size={15} />
          Настройки
        </button>
        <button class="settings-btn" onClick={onStats}>
          <Icon name="chart" size={15} />
          Статистика
        </button>
      </div>
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

// Меню команд «/»: встроенные команды DuoCode, свои команды и навыки Claude, промпты Codex.
function CommandMenu({ items, active, agents, onPick }) {
  const ref = useRef();
  useEffect(() => {
    const el = ref.current && ref.current.querySelector('.cmd-item.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div class="cmd-menu" ref={ref}>
      {items.map((c, i) => {
        const ok = c.agents.some((a) => agents.includes(a));
        return (
          <button key={c.source + c.name} class={`cmd-item ${i === active ? 'active' : ''} ${ok ? '' : 'dim'}`} onMouseDown={(e) => { e.preventDefault(); onPick(c); }}>
            <code>/{c.name}</code>
            <span class="cmd-desc">{c.description}</span>
            <span class="cmd-agents" title={ok ? '' : 'Не поддерживается выбранным агентом'}>
              {c.agents.map((a) => (
                <i class={`dot ${a}`} key={a} />
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// @файл: поиск по файлам проекта.
function FileMenu({ items, active, onPick }) {
  return (
    <div class="cmd-menu">
      {items.length === 0 && <div class="cmd-item dim">Ничего не найдено</div>}
      {items.map((f, i) => (
        <button key={f.path} class={`cmd-item ${i === active ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); onPick(f); }}>
          <Icon name="read" size={13} />
          <span class="cmd-desc file-path">{f.path}</span>
        </button>
      ))}
    </div>
  );
}

// #чат: ссылка на другой чат — агент получит выдержку из него.
function ChatMenu({ items, active, onPick }) {
  return (
    <div class="cmd-menu">
      <div class="cmd-item dim">Сослаться на чат — агент получит его последние сообщения</div>
      {items.length === 0 && <div class="cmd-item dim">Ничего не найдено</div>}
      {items.map((r, i) => (
        <button key={r.id} class={`cmd-item ${i === active ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); onPick(r); }}>
          <Icon name="chat" size={13} />
          <span class="cmd-name">{r.title}</span>
          <span class="cmd-desc">{fmtAgo(r.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}

function Composer({ onSend, onStop, running, busy = [], target, setTarget, autoFocus, placeholder, commands = [], cwd = null, pipelines = [], focusTick = 0, roomId = null }) {
  const [links, setLinks] = useState([]); // чаты, на которые ссылается сообщение
  const [chatList, setChatList] = useState(null);
  const [chatIndex, setChatIndex] = useState(0);
  const [chatHidden, setChatHidden] = useState(false);
  const [duel, setDuel] = useState(false);
  const [pipeline, setPipeline] = useState(null);
  const [pipeMenu, setPipeMenu] = useState(false);
  const [fileItems, setFileItems] = useState([]);
  const [fileIndex, setFileIndex] = useState(0);
  const prefs = useContext(PrefsContext);
  const [text, setText] = useState('');
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdHidden, setCmdHidden] = useState(false);
  const [files, setFiles] = useState([]);
  const [plan, setPlan] = useState(false);
  const [drag, setDrag] = useState(false);
  const ref = useRef();

  useEffect(() => {
    // не перехватываем фокус у другого поля (например, переименования чата в списке)
    const busy = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (autoFocus && ref.current && !busy) ref.current.focus();
  }, [autoFocus, focusTick]);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    // высоту по тексту даёт CSS field-sizing; ручной подгон — только где его нет (старые WebView)
    if (CSS.supports('field-sizing', 'content')) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 260) + 'px';
  }, [text]);

  const mention = parseMention(text, target);
  const effective = mention.target;
  const agents = TARGETS.find((t) => t.id === effective).agents;
  const steering = !plan && agents.some((a) => busy.includes(a));
  const canSend = mention.text.trim() || files.length;

  // @запрос перед курсором (кроме @claude/@codex в самом начале)
  const caret = ref.current ? ref.current.selectionStart : text.length;
  const atMatch = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  const atQuery = atMatch && !(atMatch.index === 0 && /^(c|cl|cla|clau|claud|claude|co|cod|code|codex|о|об|оба|к|кл|ко|both)$/i.test(atMatch[2])) ? atMatch[2] : null;
  useEffect(() => {
    if (atQuery === null || !cwd) return setFileItems([]);
    let alive = true;
    const t = setTimeout(() => duo.searchFiles(cwd, atQuery).then((r) => alive && setFileItems(r.slice(0, 12))), 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [atQuery, cwd]);
  const showFiles = atQuery !== null && !!cwd;
  // #запрос перед курсором — выбор чата для ссылки
  const hashMatch = !showFiles && /(^|\s)#([^\s#]*)$/.exec(text.slice(0, caret));
  const hashQuery = hashMatch && !chatHidden ? hashMatch[2] : null;
  useEffect(() => {
    if (hashQuery !== null) duo.listRooms().then(setChatList);
  }, [hashQuery !== null]);
  const chatItems =
    hashQuery !== null && chatList
      ? chatList.filter((r) => r.id !== roomId && !links.some((l) => l.id === r.id) && r.title.toLowerCase().includes(hashQuery.toLowerCase())).slice(0, 10)
      : [];
  const showChats = hashQuery !== null && !!chatList;
  const pickChat = (r) => {
    const before = text.slice(0, caret).replace(/#([^\s#]*)$/, '');
    setText(before + text.slice(caret));
    setLinks((l) => [...l, { id: r.id, title: r.title }]);
    setChatIndex(0);
    if (ref.current) ref.current.focus();
  };
  const pickFile = (f) => {
    const before = text.slice(0, caret).replace(/@([^\s@]*)$/, '');
    setText(before + text.slice(caret));
    addFiles([{ path: f.abs, name: f.path, image: IMG.test(f.path), size: 0 }]);
    setFileIndex(0);
    if (ref.current) ref.current.focus();
  };

  const cmdQuery = /^\/([\w:.-]*)$/.exec(mention.text.trimStart());
  const cmdItems = cmdQuery && !cmdHidden ? commands.filter((c) => c.name.toLowerCase().includes(cmdQuery[1].toLowerCase())).slice(0, 12) : [];
  const pickCommand = (c) => {
    const prefix = text.slice(0, text.length - mention.text.trimStart().length);
    setText(`${prefix}/${c.name} `);
    setCmdIndex(0);
    if (ref.current) ref.current.focus();
  };

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
    const opts = { attachments: files, plan };
    if (links.length) opts.links = links.map((l) => l.id);
    if (pipeline) opts.pipeline = pipeline;
    else if (duel && effective === 'both') opts.duel = true;
    onSend(mention.text, agents, opts);
    setText('');
    setFiles([]);
    setLinks([]);
    setPlan(false);
    setPipeline(null);
  };

  const hint = pipeline
    ? `Сценарий «${pipeline.name}»: напишите задачу`
    : duel && effective === 'both'
      ? 'Оба решают в своих копиях проекта — потом выберете лучший вариант'
      : effective === 'auto'
        ? 'Задачу возьмёт агент, у которого больше свободного лимита'
        : steering
    ? `${agents.filter((a) => busy.includes(a)).map((a) => NAME[a]).join(' и ')} сейчас работает — сообщение допишется в его работу`
    : plan
      ? 'Сначала план: агент изучит задачу и предложит план, вы его утвердите'
      : prefs.sendKey === 'ctrl'
        ? 'Ctrl+Enter — отправить · / — команды · # — другой чат'
        : 'Enter — отправить · Shift+Enter — новая строка · / — команды · # — другой чат';

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
      {showFiles && <FileMenu items={fileItems} active={Math.min(fileIndex, Math.max(0, fileItems.length - 1))} onPick={pickFile} />}
      {showChats && <ChatMenu items={chatItems} active={Math.min(chatIndex, Math.max(0, chatItems.length - 1))} onPick={pickChat} />}
      {links.length > 0 && (
        <div class="links">
          {links.map((l, i) => (
            <span class="link-chip" key={l.id} title="Агент получит последние сообщения этого чата">
              <Icon name="chat" size={12} /> {l.title}
              <button class="attachment-x" onClick={() => setLinks(links.filter((_, j) => j !== i))} title="Убрать">
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {!showFiles && !showChats && cmdItems.length > 0 && <CommandMenu items={cmdItems} active={Math.min(cmdIndex, cmdItems.length - 1)} agents={agents} onPick={pickCommand} />}
      <Attachments items={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder || 'Напишите задачу… (@claude или @codex — кому адресовать)'}
        onInput={(e) => {
          setText(e.target.value);
          setCmdHidden(false);
          setCmdIndex(0);
          setChatHidden(false);
        }}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (showChats) {
            if (chatItems.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setChatIndex((chatIndex + (e.key === 'ArrowDown' ? 1 : chatItems.length - 1)) % chatItems.length);
              return;
            }
            if (chatItems.length && (e.key === 'Enter' || e.key === 'Tab')) {
              e.preventDefault();
              pickChat(chatItems[Math.min(chatIndex, chatItems.length - 1)]);
              return;
            }
            if (e.key === 'Escape') {
              setChatHidden(true);
              return;
            }
          }
          if (showFiles && fileItems.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setFileIndex((fileIndex + (e.key === 'ArrowDown' ? 1 : fileItems.length - 1)) % fileItems.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              pickFile(fileItems[Math.min(fileIndex, fileItems.length - 1)]);
              return;
            }
          }
          if (cmdItems.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setCmdIndex((cmdIndex + (e.key === 'ArrowDown' ? 1 : cmdItems.length - 1)) % cmdItems.length);
              return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && cmdItems[cmdIndex] && `/${cmdItems[cmdIndex].name}` !== mention.text.trim())) {
              e.preventDefault();
              pickCommand(cmdItems[Math.min(cmdIndex, cmdItems.length - 1)]);
              return;
            }
            if (e.key === 'Escape') {
              setCmdHidden(true);
              return;
            }
          }
          if (e.key !== 'Enter' || e.isComposing) return;
          const send = prefs.sendKey === 'ctrl' ? e.ctrlKey || e.metaKey : !e.shiftKey;
          if (send) {
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
        {effective === 'both' && !pipeline && (
          <button class={`toggle ${duel ? 'on' : ''}`} onClick={() => setDuel(!duel)} title="Раздельно: каждый агент решает задачу в своей копии проекта, потом вы сравниваете и применяете лучший вариант">
            <Icon name="swap" size={14} />
            Раздельно
          </button>
        )}
        {!pipeline && (
          <button class={`toggle ${plan ? 'on' : ''}`} onClick={() => setPlan(!plan)} title="Сначала план: агент ничего не меняет, а предлагает план на утверждение">
            <Icon name="todo" size={14} />
            План
          </button>
        )}
        <div class="menu-wrap">
          <button class={`toggle ${pipeline ? 'on' : ''}`} onClick={() => (pipeline ? setPipeline(null) : setPipeMenu(!pipeMenu))} title="Сценарий: агенты выполняют шаги по очереди">
            <Icon name="flow" size={14} />
            {pipeline ? pipeline.name : 'Сценарий'}
            {pipeline && <Icon name="x" size={12} />}
          </button>
          {pipeMenu && (
            <div class="menu up-menu" onMouseLeave={() => setPipeMenu(false)}>
              <div class="menu-section">Сценарии</div>
              {pipelines.map((p) => (
                <button key={p.id} class="menu-option" onClick={() => { setPipeline(p); setPipeMenu(false); }}>
                  <span>
                    <b>{p.name}</b>
                    <small>{p.steps.map((s) => NAME[s.agent]).join(' → ')}</small>
                  </span>
                </button>
              ))}
              <div class="menu-sep" />
              <small class="menu-note">Свои сценарии — в настройках.</small>
            </div>
          )}
        </div>
        {/* подсказка сжимается с многоточием, а кнопки всегда вместе справа и не уезжают на новую строку */}
        <span class="composer-end">
          <span class={`composer-hint ${steering ? 'steering' : ''}`} title={hint}>
            {hint}
          </span>
          {running && (
            <button class="stop-btn" onClick={onStop} title="Остановить всех агентов в этом чате">
              <Icon name="stop" size={16} />
            </button>
          )}
          <button class="send-btn" onClick={submit} disabled={!canSend} title={steering ? 'Дописать в текущую работу' : 'Отправить'}>
            <Icon name={steering ? 'plus' : 'up'} size={16} />
          </button>
        </span>
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
function fmtK(n) {
  if (!n) return '0';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.0', '')}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
}

// Кольцо заполненности контекста.
function Ring({ pct, size = 16 }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const cls = pct >= 85 ? 'danger' : pct >= 65 ? 'warn' : '';
  return (
    <svg class={`ring ${cls}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} class="ring-bg" />
      <circle cx={size / 2} cy={size / 2} r={r} class="ring-fg" stroke-dasharray={`${(c * Math.min(pct, 100)) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

function AgentChip({ agent, model, effort, models, efforts, onChange, context, onCommand }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const modelName = (models.find((m) => m.id === model) || models[0]).name;
  const pct = context && context.used && context.window ? Math.min(100, Math.round((context.used / context.window) * 100)) : null;
  return (
    <div class="menu-wrap" ref={ref}>
      <button class={`agent-chip ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} title={`Модель и уровень размышлений ${NAME[agent]}`}>
        <Avatar agent={agent} size={16} />
        <span>{model ? modelName : NAME[agent]}</span>
        <span class="chip-effort">{effort ? EFFORT_NAME[effort] || effort : 'авто'}</span>
        {pct != null && (
          <span class="chip-context" title={`Контекст ${NAME[agent]} заполнен на ${pct}%`}>
            <Ring pct={pct} size={14} />
            {pct}%
          </span>
        )}
        <Icon name="down" size={13} />
      </button>
      {open && (
        <div class="menu agent-menu">
          {onCommand && (
          <>
          <div class="menu-section">Контекст</div>
          <div class="context-box">
            {pct != null ? (
              <>
                <div class="context-line">
                  <Ring pct={pct} size={30} />
                  <div>
                    <b>{pct}% занято</b>
                    <small>
                      {fmtK(context.used)} из {fmtK(context.window)} токенов
                      {context.threshold ? ` · автосжатие около ${Math.round((context.threshold / context.window) * 100)}%` : ''}
                    </small>
                  </div>
                </div>
              </>
            ) : (
              <small class="muted">Появится после первого ответа {NAME[agent]} в этом чате.</small>
            )}
            <div class="context-actions">
              <button class="btn small" onClick={() => { setOpen(false); onCommand('/compact'); }} title="Агент перескажет себе переписку коротко и освободит место">
                Сжать
              </button>
              <button class="btn small ghost" onClick={() => { setOpen(false); onCommand('/clear'); }} title="Агент забудет переписку этого чата">
                Начать заново
              </button>
            </div>
          </div>
          </>
          )}
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

const errText = (err) => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const pct1 = (n) => `${Math.round((n || 0) * 10) / 10}%`;

// Бюджет чата: сколько каждый агент может потратить здесь от своего недельного лимита.
function BudgetModal({ room, onClose }) {
  const [value, setValue] = useState(room.budget ? String(room.budget) : '');
  const spent = room.spent || {};
  const save = async (v) => {
    await duo.setBudget(room.id, v);
    onClose();
  };
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal small-modal">
        <div class="modal-head">
          <h2>Бюджет чата</h2>
          <button class="icon-btn" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <p class="muted small">
          Сколько недельного лимита каждый агент может потратить в этом чате. При 80% DuoCode предупредит, при 100% остановит агента и не будет отдавать ему новые задачи
          этого чата. Считается приблизительно: по росту недельного лимита, пока агент работает здесь.
        </p>
        <div class="budget-spent">
          {['claude', 'codex'].map((a) => (
            <div key={a}>
              <Avatar agent={a} size={16} /> {NAME[a]}: потрачено ≈<b>{pct1(spent[a])}</b>
              {room.budget ? ` из ${pct1(room.budget)}` : ''}
            </div>
          ))}
        </div>
        <div class="field">
          <label>Бюджет, % недельного лимита каждого агента</label>
          <input class="text-input" type="number" min="0.5" max="100" step="0.5" value={value} placeholder="Без ограничения" onInput={(e) => setValue(e.target.value)} autoFocus />
        </div>
        <div class="modal-actions">
          {room.budget && (
            <button class="btn ghost" onClick={() => save(null)}>
              Без ограничения
            </button>
          )}
          <span class="spacer" />
          <button class="btn primary" disabled={!(Number(value) > 0)} onClick={() => save(Number(value))}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

// Своя ветка чата: сколько изменено, перенести в проект, закончить ветку.
function BranchChip({ room }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    duo.branch.status(room.id).then(setSt);
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
      setOpen(false);
    } catch (err) {
      alert(errText(err));
    }
    setBusy(false);
  };
  const n = st ? st.files.length : null;
  return (
    <div class="menu-wrap" ref={ref}>
      <button class={`project-chip branch-chip ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} title="Чат работает в своей ветке — отдельной копии проекта">
        <Icon name="branch" size={13} />
        {room.branch.replace(/^duocode\//, '')}
      </button>
      {open && (
        <div class="menu wide-menu branch-menu">
          <div class="menu-section">Ветка {room.branch}</div>
          <div class="branch-files">
            {n === null ? 'Считаю изменения…' : n === 0 ? 'Изменений относительно проекта пока нет.' : `Изменено ${n} ${n === 1 ? 'файл' : n < 5 ? 'файла' : 'файлов'}:`}
            {n > 0 && (
              <ul>
                {st.files.slice(0, 12).map((f) => (
                  <li key={f.path}>
                    <b class={`st st-${f.status[0]}`}>{f.status[0]}</b> {f.path}
                  </li>
                ))}
                {n > 12 && <li class="muted">…и ещё {n - 12}</li>}
              </ul>
            )}
          </div>
          <button disabled={busy || !n} onClick={() => run(() => duo.branch.apply(room.id))}>
            <Icon name="check" size={14} /> Перенести изменения в проект
          </button>
          <button onClick={() => { setOpen(false); duo.openProject(room.workdir); }}>
            <Icon name="external" size={14} /> Открыть папку ветки
          </button>
          <div class="menu-sep" />
          <button
            class="danger"
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (n && confirm(`Перенести ${n} изм. в проект перед закрытием ветки?\n\nОК — перенести и закрыть, Отмена — выбрать другое.`)) return duo.branch.end(room.id, { apply: true });
                if (!confirm(n ? 'Закрыть ветку без переноса? Её изменения пропадут.' : 'Закрыть ветку? Чат продолжит работать в основной папке.')) return;
                return duo.branch.end(room.id, { apply: false });
              })
            }
          >
            <Icon name="x" size={14} /> Закончить ветку…
          </button>
        </div>
      )}
    </div>
  );
}

function RoomHeader({ room, codexModels, onDelete, panel, setPanel, project, onEditProject }) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  useEffect(() => setEditing(false), [room.id]);
  const s = room.settings;
  const set = (patch) => duo.setRoomSettings(room.id, patch);
  const mode = MODES.find((m) => m.id === s.mode) || MODES[0];
  const ctx = room.context || {};
  const delegation = s.delegation || 'auto';

  return (
    <header class="room-header drag">
      <div class="room-heading no-drag">
        {editing ? (
          <TitleInput value={room.title} onSave={(t) => duo.renameRoom(room.id, t)} onDone={() => setEditing(false)} />
        ) : (
          <>
            <h1 onDblClick={() => setEditing(true)} title="Дважды щёлкните, чтобы переименовать">
              {room.title}
            </h1>
            <button class="icon-btn tiny title-edit" title="Переименовать" onClick={() => setEditing(true)}>
              <Icon name="edit" size={13} />
            </button>
          </>
        )}
        <button
          class="project-chip"
          onClick={() => (project ? onEditProject(project) : duo.openProject(room.cwd))}
          title={project ? `Проект «${project.name}»:\n${project.folders.join('\n')}\n\nНажмите, чтобы изменить` : room.cwd}
        >
          <Icon name="folder" size={13} />
          {project ? project.name : baseName(room.cwd)}
          {project && project.folders.length > 1 && <small> · {project.folders.length} папки</small>}
        </button>
        {room.branch && <BranchChip room={room} />}
        {room.budget && (
          <button
            class={`project-chip budget-chip ${['claude', 'codex'].some((a) => room.spent && room.spent[a] >= room.budget) ? 'over' : ''}`}
            onClick={() => setBudgetOpen(true)}
            title="Бюджет чата: сколько недельного лимита каждый агент может потратить здесь"
          >
            ≈{pct1(Math.max((room.spent && room.spent.claude) || 0, (room.spent && room.spent.codex) || 0))} / {pct1(room.budget)}
          </button>
        )}
        {budgetOpen && <BudgetModal room={room} onClose={() => setBudgetOpen(false)} />}
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
          context={ctx.claude}
          onCommand={(text) => duo.send(room.id, { text, targets: ['claude'] })}
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
          context={ctx.codex}
          onCommand={(text) => duo.send(room.id, { text, targets: ['codex'] })}
        />
        <button class={`icon-btn ${panel ? 'active' : ''}`} onClick={() => setPanel(panel ? '' : 'changes')} title="Панель: изменения в git и память проекта">
          <Icon name="panel" size={16} />
        </button>
        <div class="menu-wrap">
          <button class="icon-btn" onClick={() => setMenu(!menu)} title="Ещё">
            <Icon name="more" size={16} />
          </button>
          {menu && (
            <div class="menu wide-menu" onMouseLeave={() => setMenu(false)}>
              <div class="menu-section">Вызов другого агента</div>
              {DELEGATION.map((d) => (
                <button key={d.id} class={`menu-option ${delegation === d.id ? 'selected' : ''}`} onClick={() => set({ delegation: d.id })}>
                  <span class="radio" />
                  <span>
                    <b>{d.name}</b>
                    <small>{d.hint}</small>
                  </span>
                </button>
              ))}
              <div class="menu-sep" />
              <button onClick={() => { setMenu(false); setEditing(true); }}>
                <Icon name="edit" size={14} /> Переименовать
              </button>
              <button onClick={() => { setMenu(false); setBudgetOpen(true); }}>
                <Icon name="chart" size={14} /> Бюджет чата{room.budget ? ` · ${pct1(room.budget)}` : '…'}
              </button>
              {!room.branch && (
                <button
                  onClick={async () => {
                    setMenu(false);
                    try {
                      await duo.branch.start(room.id);
                    } catch (err) {
                      alert(errText(err));
                    }
                  }}
                  title="Агенты этого чата будут менять отдельную копию проекта на своей git-ветке"
                >
                  <Icon name="branch" size={14} /> Работать в своей ветке
                </button>
              )}
              <button onClick={() => { setMenu(false); duo.openProject(room.cwd); }}>
                <Icon name="external" size={14} /> Открыть папку проекта
              </button>
              <button onClick={() => { setMenu(false); setPanel('memory'); }}>
                <Icon name="memory" size={14} /> Память проекта
              </button>
              <button onClick={() => { setMenu(false); duo.exportRoom(room.id); }}>
                <Icon name="external" size={14} /> Экспорт в Markdown
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

function RoomView({ room, codexModels, onDelete, pipelines, focusTick, highlight, project, onEditProject }) {
  const [panel, setPanelState] = useState(() => store('panel') || '');
  const setPanel = (p) => {
    setPanelState(p);
    store('panel', p);
  };  // агент взялся за встроенный браузер — показываем его
  useEffect(() => duo.onBrowserShow((id) => id === room.id && setPanel('browser')), [room.id]);
  // агент запустил процесс в терминале — показываем
  useEffect(() => duo.onTerminalShow((id) => id === room.id && setPanel('terminal')), [room.id]);

  const [target, setTargetState] = useState(() => store(`target:${room.id}`) || 'both');
  const setTarget = (t) => {
    setTargetState(t);
    store(`target:${room.id}`, t);
  };
  const byId = useMemo(() => new Map(room.messages.map((m) => [m.id, m])), [room.messages]);
  const [commands, setCommands] = useState([]);
  useEffect(() => {
    duo.commands(room.cwd).then(setCommands);
  }, [room.cwd]);
  const top = room.messages.filter((m) => !m.parentId);
  const running = room.running && (room.running.claude || room.running.codex);
  const [scrollRef, innerRef, onScroll, stickNow] = useStickyScroll();
  useEffect(() => {
    if (!highlight) return;
    const el = document.querySelector(`[data-msg="${highlight}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
    }
  }, [highlight]);

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
      <RoomHeader room={room} codexModels={codexModels} onDelete={onDelete} panel={panel} setPanel={setPanel} project={project} onEditProject={onEditProject} />
      <div class="room-body">
      <div class="room-main">
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
              <div data-msg={m.id} key={m.id}>
                <UserMessage msg={m} roomId={room.id} room={room} />
              </div>
            ) : m.role === 'system' ? (
              <SystemMessage msg={m} key={m.id} />
            ) : m.role === 'duel' ? (
              <DuelCard card={m} room={room} key={m.id} />
            ) : (
              <div data-msg={m.id} key={m.id}>
                <AgentMessage msg={m} room={room} byId={byId} onReview={review} />
              </div>
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
          commands={commands}
          cwd={room.workdir || room.cwd}
          roomId={room.id}
          pipelines={pipelines}
          focusTick={focusTick}
        />
      </div>
      </div>
      {panel && (
        <SidePanel
          room={room}
          folders={[room.workdir || room.cwd, ...(project ? project.folders.filter((f) => f !== room.cwd) : [])]}
          tab={panel}
          setTab={setPanel}
          onClose={() => setPanel('')}
        />
      )}
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

// Окно проекта: название и папки. Первая папка — основная, в ней запускаются агенты.
export function ProjectEditor({ project, onClose, onSaved }) {
  const [name, setName] = useState(project.name || '');
  const [folders, setFolders] = useState(project.folders || []);
  const [instructions, setInstructions] = useState(project.instructions || '');
  const [error, setError] = useState('');
  const add = async () => {
    const picked = await duo.pickFolders();
    const next = [...folders, ...picked.filter((p) => !folders.includes(p))];
    setFolders(next);
    if (!name && next[0]) setName(baseName(next[0]));
  };
  const move = (i) => setFolders([folders[i], ...folders.filter((_, j) => j !== i)]);
  const save = async () => {
    try {
      const p = await duo.saveProject({ id: project.id, name, folders, instructions });
      onSaved && onSaved(p);
      onClose();
    } catch (err) {
      setError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal">
        <div class="modal-head">
          <h2>{project.id ? 'Проект' : 'Новый проект'}</h2>
          <button class="icon-btn" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div class="field">
          <label>Название</label>
          <input class="text-input" value={name} placeholder="Например, Магазин" onInput={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div class="field">
          <label>Папки</label>
          {folders.length === 0 && <div class="field-hint">Добавьте одну или несколько папок — например, фронтенд и бэкенд, которые лежат в разных местах.</div>}
          <ul class="folder-list">
            {folders.map((f, i) => (
              <li key={f}>
                <Icon name="folder" size={14} />
                <span class="folder-path" title={f}>
                  <b>{baseName(f)}</b>
                  <small>{f}</small>
                </span>
                {i === 0 ? (
                  <span class="tag" title="Агенты запускаются в этой папке">основная</span>
                ) : (
                  <button class="link small" onClick={() => move(i)} title="Агенты будут запускаться в этой папке">
                    сделать основной
                  </button>
                )}
                <button class="icon-btn tiny" title="Убрать из проекта (файлы не удаляются)" onClick={() => setFolders(folders.filter((_, j) => j !== i))}>
                  <Icon name="x" size={13} />
                </button>
              </li>
            ))}
          </ul>
          <button class="btn small" onClick={add}>
            <Icon name="plus" size={14} /> Добавить папки…
          </button>
          <div class="field-hint">
            Агенты работают в основной папке и видят остальные: читают, правят, запускают команды. Откат правок, поиск @файлов и панель Git охватывают все папки. Сменить основную папку —
            значит для новых чатов; старые чаты продолжат работать там, где начинали.
          </div>
        </div>
        <div class="field">
          <label>Инструкции для агентов в этом проекте</label>
          <textarea
            class="instr-text"
            rows={4}
            value={instructions}
            onInput={(e) => setInstructions(e.target.value)}
            placeholder={'Например:\n— стек: React + Express, тесты — npm test\n— не трогай папку legacy/'}
          />
          <div class="field-hint">Добавляются к общим инструкциям из Настроек → Агенты, только в чатах этого проекта.</div>
        </div>
        {error && <div class="error-box">{error}</div>}
        <div class="modal-actions">
          {project.id && (
            <button
              class="btn ghost danger-text"
              onClick={async () => {
                if (!confirm(`Убрать проект «${project.name}» из списка? Папки и файлы не удаляются, чаты останутся.`)) return;
                await duo.removeProject(project.id);
                onClose();
              }}
            >
              Убрать проект
            </button>
          )}
          <span class="spacer" />
          <button class="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button class="btn primary" disabled={!folders.length} onClick={save}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

function NewChat({ settings, env, onCreated, focusTick, initialProject, onEditProject }) {
  const workspaces = settings.workspaces || [];
  const [projectId, setProjectId] = useState(initialProject || (workspaces[0] && workspaces[0].id) || '');
  const current = workspaces.find((p) => p.id === projectId) || null;
  const project = current ? current.folders[0] : '';
  const [target, setTarget] = useState(store('target:new') || 'both');
  const [history, setHistory] = useState([]);
  const [showAll, setShowAll] = useState(false);
  const [commands, setCommands] = useState([]);
  useEffect(() => {
    duo.commands(project || null).then(setCommands);
  }, [project]);
  // модели нового чата: по умолчанию — из Настроек → Агенты, здесь можно поменять только для этого чата
  const nc = settings.newChat || {};
  const [models, setModels] = useState({ claudeModel: nc.claudeModel || '', claudeEffort: nc.claudeEffort || '', codexModel: nc.codexModel || '', codexEffort: nc.codexEffort || '' });
  const [codexModels, setCodexModels] = useState([]);
  useEffect(() => {
    duo.codexModels().then((m) => setCodexModels(m || [])).catch(() => {});
  }, []);
  const setModel = (patch) => setModels((m) => ({ ...m, ...patch }));
  const [ownBranch, setOwnBranch] = useState(false);

  useEffect(() => {
    duo.history().then(setHistory);
  }, []);
  useEffect(() => {
    if (initialProject) setProjectId(initialProject);
  }, [initialProject]);
  useEffect(() => {
    if (!current && workspaces[0]) setProjectId(workspaces[0].id);
  }, [workspaces.length]);

  const send = async (text, agents, opts = {}) => {
    if (!current) return onEditProject({ name: '', folders: [] }, (p) => setProjectId(p.id));
    // название сразу из задачи — по нему же называется своя ветка чата
    const title = text.trim().split('\n')[0].slice(0, 60) || undefined;
    const room = await duo.createRoom({ projectId: current.id, settings: models, title: ownBranch ? title : undefined });
    if (ownBranch) await duo.branch.start(room.id).catch((err) => alert(errText(err)));
    store(`target:${room.id}`, target);
    // сначала открываем чат, потом отправляем — долгий сценарий не должен держать на этом экране
    onCreated(room.id);
    await duo.send(room.id, { text, targets: agents, ...opts });
  };

  const importSession = async (s) => {
    const room = await duo.importSession({ tool: s.tool, sessionId: s.id, cwd: s.cwd, title: s.title });
    onCreated(room.id);
  };

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
          {workspaces.length ? (
            <label class="select project-select">
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {workspaces.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name} — {p.folders.length > 1 ? `${p.folders.length} папки` : p.folders[0]}
                  </option>
                ))}
              </select>
              <Icon name="down" size={13} />
            </label>
          ) : (
            <span class="muted">Проектов пока нет</span>
          )}
          {current && (
            <button class="btn" onClick={() => onEditProject(current)} title="Название и папки проекта">
              Изменить
            </button>
          )}
          <button class="btn" onClick={() => onEditProject({ name: '', folders: [] }, (p) => setProjectId(p.id))}>
            Новый проект…
          </button>
        </div>
        {current && current.folders.length > 1 && (
          <div class="project-folders">
            {current.folders.map((f, i) => (
              <span key={f} class="folder-chip" title={f}>
                <Icon name="folder" size={12} /> {baseName(f)}
                {i === 0 && <small> · основная</small>}
              </span>
            ))}
          </div>
        )}
        <div class="new-models">
          <label class="branch-toggle" title="Агенты этого чата будут менять отдельную копию проекта на своей git-ветке, а в основную папку изменения попадут, когда вы их перенесёте">
            <input type="checkbox" checked={ownBranch} onChange={(e) => setOwnBranch(e.target.checked)} />
            <Icon name="branch" size={13} /> Своя ветка
          </label>
          <span class="muted">Модели:</span>
          <AgentChip
            agent="claude"
            model={models.claudeModel}
            effort={models.claudeEffort}
            models={CLAUDE_MODELS}
            efforts={CLAUDE_EFFORTS}
            onChange={(p) => setModel('model' in p ? { claudeModel: p.model } : { claudeEffort: p.effort })}
          />
          <AgentChip
            agent="codex"
            model={models.codexModel}
            effort={models.codexEffort}
            models={[{ id: '', name: 'По умолчанию', description: 'Модель из настроек Codex' }, ...codexModels.map((m) => ({ id: m.id, name: m.name, description: m.isDefault ? 'модель по умолчанию' : '' }))]}
            efforts={codexEfforts(codexModels, models.codexModel)}
            onChange={(p) => {
              if ('model' in p) {
                const ok = codexEfforts(codexModels, p.model).some((e) => e.id === models.codexEffort);
                setModel({ codexModel: p.model, ...(ok ? {} : { codexEffort: '' }) });
              } else setModel({ codexEffort: p.effort });
            }}
          />
        </div>
        <Composer
          onSend={send}
          target={target}
          setTarget={(t) => {
            setTarget(t);
            store('target:new', t);
          }}
          autoFocus
          commands={commands}
          cwd={project || null}
          pipelines={settings.pipelines || []}
          focusTick={focusTick}
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

const THEMES = [
  { id: 'system', name: 'Как в системе', swatch: ['#141519', '#f4f4f2'] },
  { id: 'dark', name: 'Тёмная', swatch: ['#141519', '#1d1f25'] },
  { id: 'light', name: 'Светлая', swatch: ['#f4f4f2', '#ffffff'] },
  { id: 'midnight', name: 'Полночь', swatch: ['#0d1117', '#161b22'] },
  { id: 'graphite', name: 'Графит', swatch: ['#1e1e1e', '#2a2a2b'] },
  { id: 'sepia', name: 'Сепия', swatch: ['#f5efe3', '#fbf7ef'] },
  { id: 'paper', name: 'Бумага', swatch: ['#ffffff', '#f7f7f7'] },
];

function Segmented({ value, options, onChange }) {
  return (
    <div class="segmented wide">
      {options.map((o) => (
        <button key={String(o.id)} class={`seg ${value === o.id ? 'active' : ''}`} onClick={() => onChange(o.id)}>
          {o.name}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label, hint }) {
  return (
    <label class="switch-row">
      <span>
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span class="switch" />
    </label>
  );
}

function AppearanceTab({ prefs }) {
  const set = (patch) => duo.setSettings({ appearance: patch });
  return (
    <div class="tab-body">
      <div class="field">
        <label>Тема</label>
        <div class="themes">
          {THEMES.map((t) => (
            <button key={t.id} class={`theme-card ${prefs.theme === t.id ? 'active' : ''}`} onClick={() => set({ theme: t.id })}>
              <span class="theme-swatch" style={{ background: `linear-gradient(135deg, ${t.swatch[0]} 50%, ${t.swatch[1]} 50%)` }}>
                <i class="claude" />
                <i class="codex" />
              </span>
              {t.name}
            </button>
          ))}
        </div>
      </div>
      <div class="field">
        <label>Размер текста</label>
        <Segmented value={prefs.fontSize} onChange={(v) => set({ fontSize: v })} options={[{ id: 13, name: 'Мелкий' }, { id: 14, name: 'Обычный' }, { id: 15, name: 'Крупный' }, { id: 16, name: 'Очень крупный' }]} />
      </div>
      <div class="field">
        <label>Ширина чата</label>
        <Segmented value={prefs.chatWidth} onChange={(v) => set({ chatWidth: v })} options={[{ id: 'narrow', name: 'Узкая' }, { id: 'normal', name: 'Обычная' }, { id: 'wide', name: 'Широкая' }, { id: 'full', name: 'Во всё окно' }]} />
      </div>
      <div class="field">
        <label>Анимации</label>
        <Segmented value={prefs.motion || 'full'} onChange={(v) => set({ motion: v })} options={[{ id: 'full', name: 'Яркие' }, { id: 'subtle', name: 'Спокойные' }, { id: 'off', name: 'Выключены' }]} />
        <div class="field-hint">Появление сообщений, «дыхание» работающего агента, всплывающие меню и окна, плавная смена темы.</div>
      </div>
      <div class="field">
        <label>Плотность</label>
        <Segmented value={prefs.density} onChange={(v) => set({ density: v })} options={[{ id: 'comfortable', name: 'Просторно' }, { id: 'compact', name: 'Компактно' }]} />
      </div>
      <div class="field">
        <label>Шаги агентов</label>
        <Segmented value={prefs.steps} onChange={(v) => set({ steps: v })} options={[{ id: 'detailed', name: 'Каждый шаг' }, { id: 'grouped', name: 'Свёрнуто в группу' }]} />
        <div class="field-hint">«Свёрнуто» прячет команды, чтение и правки в одну строку «N шагов» — видно только ответы и то, что требует вашего внимания.</div>
      </div>
      <div class="field">
        <label>Шрифт кода</label>
        <Segmented
          value={prefs.codeFont}
          onChange={(v) => set({ codeFont: v })}
          options={[{ id: 'auto', name: 'Авто' }, { id: 'cascadia', name: 'Cascadia' }, { id: 'consolas', name: 'Consolas' }, { id: 'jetbrains', name: 'JetBrains Mono' }, { id: 'fira', name: 'Fira Code' }]}
        />
      </div>
      <div class="field">
        <label>Отправка сообщения</label>
        <Segmented value={prefs.sendKey} onChange={(v) => set({ sendKey: v })} options={[{ id: 'enter', name: 'Enter' }, { id: 'ctrl', name: 'Ctrl+Enter' }]} />
      </div>
      <Switch checked={prefs.expandThinking} onChange={(v) => set({ expandThinking: v })} label="Показывать размышления развёрнутыми" hint="Иначе они свёрнуты в одну строку, открываются по клику" />
      <Switch checked={prefs.showCost} onChange={(v) => set({ showCost: v })} label="Показывать время и стоимость под ответами" />
    </div>
  );
}

function AgentsTab({ settings, env, onSaved }) {
  const [claude, setClaude] = useState(settings.claudeCommand);
  const [codex, setCodex] = useState(settings.codexCommand);
  const dirty = claude !== settings.claudeCommand || codex !== settings.codexCommand;
  const save = async () => {
    await duo.setSettings({ claudeCommand: claude.trim() || 'claude', codexCommand: codex.trim() || 'codex' });
    onSaved();
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
  const nc = settings.newChat || {};
  const [instr, setInstr] = useState(settings.instructions || '');
  const instrDirty = instr.trim() !== (settings.instructions || '').trim();
  const saveInstr = () => duo.setSettings({ instructions: instr.trim() }).then(onSaved);
  const [codexModels, setCodexModels] = useState([]);
  useEffect(() => {
    duo.codexModels().then((m) => setCodexModels(m || [])).catch(() => {});
  }, []);
  const effortName = (id) => (EFFORT_NAME[id] ? EFFORT_NAME[id][0].toUpperCase() + EFFORT_NAME[id].slice(1) : id);
  // модель и уровень размышлений, с которыми открывается новый чат
  const modelRow = (agent) => {
    const models = agent === 'claude' ? CLAUDE_MODELS.slice(1) : codexModels.map((m) => ({ id: m.id, name: m.name }));
    const efforts = agent === 'claude' ? CLAUDE_EFFORTS : codexEfforts(codexModels, nc.codexModel);
    const model = nc[`${agent}Model`] || '';
    const effort = nc[`${agent}Effort`] || '';
    return (
      <div class="auto-row">
        <span class="auto-agent">
          <Avatar agent={agent} size={16} /> {NAME[agent]}
        </span>
        <Select
          value={model}
          options={[{ id: '', name: `По умолчанию (из настроек ${NAME[agent]})` }, ...models]}
          title="Модель"
          onChange={(v) => {
            const ok = agent === 'claude' || !effort || codexEfforts(codexModels, v).some((e) => e.id === effort);
            setNew({ [`${agent}Model`]: v, ...(ok ? {} : { [`${agent}Effort`]: '' }) });
          }}
        />
        <Select value={effort} options={[{ id: '', name: 'Размышления по умолчанию' }, ...efforts.map((e) => ({ id: e.id, name: effortName(e.id) }))]} title="Уровень размышлений" onChange={(v) => setNew({ [`${agent}Effort`]: v })} />
      </div>
    );
  };
  const mode = nc.mode || 'ask';
  const delegation = nc.delegation || 'auto';
  const setNew = (patch) => duo.setSettings({ newChat: patch }).then(onSaved);
  const [applied, setApplied] = useState(false);
  const applyAll = async () => {
    const models = { claudeModel: nc.claudeModel || '', claudeEffort: nc.claudeEffort || '', codexModel: nc.codexModel || '', codexEffort: nc.codexEffort || '' };
    for (const r of await duo.listRooms()) await duo.setRoomSettings(r.id, { mode, delegation, ...models });
    setApplied(true);
    setTimeout(() => setApplied(false), 2000);
  };
  return (
    <div class="tab-body">
      <div class="field">
        <label>Режим разрешений в новых чатах</label>
        <Segmented value={mode} onChange={(v) => setNew({ mode: v })} options={MODES} />
        <div class="field-hint">{MODES.find((m) => m.id === mode).hint}</div>
      </div>
      <div class="field">
        <label>Вызов напарника в новых чатах</label>
        <Segmented value={delegation} onChange={(v) => setNew({ delegation: v })} options={DELEGATION} />
        <div class="field-hint">
          {DELEGATION.find((d) => d.id === delegation).hint}.
        </div>
      </div>
      <div class="field">
        <label>Модели в новых чатах</label>
        {modelRow('claude')}
        {modelRow('codex')}
        <div class="field-hint">
          С этими моделью и уровнем размышлений открывается каждый новый чат. Всё, что выше, в открытом чате меняется в его шапке.{' '}
          <button class="link" onClick={applyAll}>
            {applied ? 'Применено ко всем чатам' : 'Применить эти настройки ко всем чатам'}
          </button>
        </div>
      </div>
      <div class="field">
        <label>Бюджет новых чатов</label>
        <div class="field-row">
          <input
            class="text-input budget-input"
            type="number"
            min="0"
            max="100"
            step="0.5"
            value={nc.budget || ''}
            placeholder="Без ограничения"
            onChange={(e) => setNew({ budget: Number(e.target.value) > 0 ? Number(e.target.value) : null })}
          />
          <span class="muted small">% недельного лимита каждого агента</span>
        </div>
        <div class="field-hint">Сколько агент может потратить в одном чате: при 80% DuoCode предупредит, при 100% остановит. У открытого чата бюджет меняется в меню «⋯».</div>
      </div>
      <div class="field">
        <label>Язык ответов</label>
        <Segmented
          value={settings.language || 'ru'}
          onChange={(v) => duo.setSettings({ language: v }).then(onSaved)}
          options={[
            { id: 'ru', name: 'Русский' },
            { id: 'auto', name: 'Как я пишу' },
            { id: 'en', name: 'English' },
          ]}
        />
        <div class="field-hint">Агенты отвечают на этом языке, даже если вокруг английский код и вывод команд. Код, команды и пути остаются как есть.</div>
      </div>
      <div class="field">
        <label>Свои инструкции для агентов</label>
        <textarea
          class="instr-text"
          rows={5}
          value={instr}
          onInput={(e) => setInstr(e.target.value)}
          placeholder={'Например:\n— объясняй простыми словами, без воды\n— перед большими правками сначала покажи план\n— комментарии в коде пиши на русском'}
        />
        <div class="field-hint">
          Действуют для Claude и Codex во всех чатах. Свои инструкции есть и у каждого проекта — в его настройках (значок у названия проекта в списке).
        </div>
        {instrDirty && (
          <div class="modal-actions">
            <button class="btn ghost" onClick={() => setInstr(settings.instructions || '')}>
              Отменить
            </button>
            <button class="btn primary" onClick={saveInstr}>
              Сохранить инструкции
            </button>
          </div>
        )}
      </div>
      {row('claude', claude, setClaude)}
      {row('codex', codex, setCodex)}
      <p class="field-hint">
        DuoCode запускает установленные у вас Claude Code и Codex и использует их вход и подписки. Данные чатов хранятся только на этом компьютере.
      </p>
      {dirty && (
        <div class="modal-actions">
          <button class="btn primary" onClick={save}>
            Сохранить
          </button>
        </div>
      )}
    </div>
  );
}

function TelegramTab({ settings, onSaved }) {
  const t = settings.telegram || {};
  const [token, setToken] = useState(t.token || '');
  const [userId, setUserId] = useState(t.userId || t.suggestedId || '');
  const idOk = /^\d{4,15}$/.test(userId);
  const [remote, setRemote] = useState({ state: 'off' });
  useEffect(() => {
    duo.remoteStatus().then(setRemote);
    return duo.onRemote(setRemote);
  }, []);
  const [customUrl, setCustomUrl] = useState(t.customUrl || '');
  const REMOTE = {
    off: 'Выключено',
    downloading: `Скачиваю туннель Cloudflare${remote.progress ? ` — ${remote.progress}%` : '…'}`,
    starting: 'Поднимаю туннель…',
    ready: `Работает: ${remote.url}. В чате с ботом есть кнопка «DuoCode» (или отправьте /app). Если на телефоне не открывается — смените туннель.`,
    error: `Ошибка: ${remote.error}`,
  };
  const [status, setStatus] = useState(null);
  useEffect(() => {
    duo.telegramStatus().then(setStatus);
    return duo.onTelegram((s) => {
      setStatus(s);
      if (s.status === 'linked') onSaved();
    });
  }, []);
  const save = (patch) => duo.setSettings({ telegram: patch }).then(onSaved);
  const st = status && status.status;
  return (
    <div class="tab-body">
      <p class="field-hint">
        Бот присылает уведомления, когда агент закончил, просит разрешение или задаёт вопрос. Разрешать и отвечать можно прямо в Telegram, а ответ (Reply) на сообщение бота уходит в нужный чат.
      </p>
      <ol class="steps-help">
        <li>
          В Telegram откройте <b>@BotFather</b>, отправьте <code>/newbot</code> и придумайте имя — он пришлёт токен.
        </li>
        <li>Вставьте токен сюда и нажмите «Подключить».</li>
        <li>Откройте своего бота и нажмите «Старт» — он ответит вашим Telegram ID. Впишите его ниже и сохраните.</li>
      </ol>
      <div class="field">
        <label>Токен бота</label>
        <div class="field-row">
          <input type="password" value={token} placeholder="123456789:AA…" onInput={(e) => setToken(e.target.value.trim())} spellcheck={false} />
          <button class="btn small primary" onClick={() => save({ token })} disabled={token === (t.token || '')}>
            Подключить
          </button>
          {t.token && (
            <button class="btn small ghost" onClick={() => { setToken(''); save({ token: '' }); }}>
              Отключить
            </button>
          )}
        </div>
        <div class="field-hint">
          {!t.token && 'Не подключено.'}
          {t.token && st === 'needId' && (
            <span class="warn">
              Бот @{status.bot} найден. Нажмите у него «Старт» — он пришлёт ваш ID — и впишите его ниже.
            </span>
          )}
          {t.token && st === 'linked' && <span>Подключено{status.bot ? ` к @${status.bot}` : ''}. </span>}
          {t.token && st === 'error' && <span class="warn">Ошибка: {status.error}</span>}
          {t.token && st === 'linked' && (
            <button class="link small" onClick={() => duo.telegramTest()}>
              Отправить тестовое сообщение
            </button>
          )}
        </div>
      </div>
      <div class="field">
        <label>Ваш Telegram ID</label>
        <div class="field-row">
          <input value={userId} placeholder="например, 123456789" inputMode="numeric" onInput={(e) => setUserId(e.target.value.replace(/\D/g, ''))} spellcheck={false} />
          <button class="btn small primary" disabled={!idOk || userId === (t.userId || '')} onClick={() => save({ userId })}>
            Сохранить
          </button>
        </div>
        <div class="field-hint">
          Бот подчиняется только этому аккаунту и только в личном чате. Сообщения и кнопки от любых других аккаунтов игнорируются, а вам приходит предупреждение.
          {t.suggestedId && !t.userId && <span class="warn"> Подставлен чат, привязанный раньше, — проверьте, что это ваш ID, и сохраните.</span>}
          {t.token && !t.userId && !t.suggestedId && <span class="warn"> Пока ID не указан, бот никого не слушается.</span>}
        </div>
      </div>
      <div class="remote-box chat-control">
        <b>Управление прямо в чате с ботом</b>
        <p class="field-hint">
          Работает всегда, без туннелей: <code>/chats</code> — выбрать чат, <code>/new</code> — новый, дальше просто пишите задачу (можно прислать скриншот). <code>/to</code> — кому писать,{' '}
          <code>/plan</code>, <code>/stop</code>, <code>/limits</code>, <code>/help</code>. Ход работы агента виден в одном обновляющемся сообщении.
        </p>
      </div>
      <div class="remote-box">
        <Switch
          checked={!!t.remote}
          onChange={(v) => save({ remote: v })}
          label="Мини-приложение: управление DuoCode с телефона"
          hint="Полноценный интерфейс прямо в Telegram: чаты, задачи агентам, подтверждения, лимиты"
        />
        {t.remote && (
          <>
            <div class="field">
              <label>Туннель</label>
              <Segmented
                value={t.tunnel || 'cloudflare'}
                onChange={(v) => save({ tunnel: v })}
                options={[
                  { id: 'cloudflare', name: 'Cloudflare' },
                  { id: 'localhostrun', name: 'localhost.run' },
                  { id: 'custom', name: 'Свой адрес' },
                ]}
              />
              <div class="field-hint">
                {(t.tunnel || 'cloudflare') === 'cloudflare' && 'Бесплатный туннель Cloudflare. В России Cloudflare часто ограничен провайдерами — если приложение не открывается, попробуйте localhost.run или VPN на телефоне.'}
                {t.tunnel === 'localhostrun' && 'Бесплатный SSH-туннель localhost.run: использует встроенный в Windows ssh, ничего не скачивает. Адрес вида *.lhr.life.'}
                {' '}Сервис туннеля технически видит то, что идёт через мини-приложение (переписку чатов). Управлять компьютером без вашего Telegram он не может — каждый запрос подписан Telegram.
                Не пользуетесь мини-приложением — выключите его: бот в чате работает и без туннеля.
                {t.tunnel === 'custom' && (
                  <>
                    Поднимите свой туннель (ngrok, Tuna, Tailscale Funnel и т. п.) на <code>http://127.0.0.1:{remote.port || 47821}</code> и вставьте его https-адрес:
                    <div class="field-row" style={{ marginTop: '6px' }}>
                      <input value={customUrl} placeholder="https://…" onInput={(e) => setCustomUrl(e.target.value.trim())} spellcheck={false} />
                      <button class="btn small primary" disabled={customUrl === (t.customUrl || '')} onClick={() => save({ customUrl })}>
                        Сохранить
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            <div class={`field-hint ${remote.state === 'error' ? 'warn' : ''}`}>
              {!t.userId ? <span class="warn">Сначала укажите свой Telegram ID.</span> : REMOTE[remote.state] || remote.state}
            </div>
          </>
        )}
        <p class="field-hint">
          Мини-приложению нужен туннель от интернета до компьютера. Каким бы он ни был, каждый запрос проверяется по подписи Telegram и вашему ID — без них данные не отдаются. Компьютер с
          DuoCode должен быть включён.
        </p>
      </div>
      <Switch checked={t.notifyFinish !== false} onChange={(v) => save({ notifyFinish: v })} label="Агент закончил работу" hint="С кратким ответом. Ответьте на сообщение, чтобы продолжить чат" />
      <Switch checked={t.notifyApprovals !== false} onChange={(v) => save({ notifyApprovals: v })} label="Подтверждения, планы и вопросы" hint="С кнопками «Разрешить», «Отклонить» и вариантами ответа" />
      <Switch checked={t.notifyLimits !== false} onChange={(v) => save({ notifyLimits: v })} label="Лимиты" hint="Почти исчерпан, кончится раньше сброса, снова доступен" />
      <p class="field-hint">Токен хранится только на этом компьютере, в файле настроек DuoCode.</p>
    </div>
  );
}

function PipelinesTab({ settings, onSaved }) {
  const [list, setList] = useState(settings.pipelines || []);
  const [edit, setEdit] = useState(null);
  const save = async (next) => {
    setList(next);
    await duo.setSettings({ pipelines: next });
    onSaved();
  };
  if (edit) {
    const upd = (patch) => setEdit({ ...edit, ...patch });
    const step = (i, patch) => upd({ steps: edit.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
    return (
      <div class="tab-body">
        <div class="field">
          <label>Название</label>
          <input class="text-input" value={edit.name} onInput={(e) => upd({ name: e.target.value })} />
        </div>
        {edit.steps.map((s, i) => (
          <div class="pipe-step" key={i}>
            <div class="pipe-step-head">
              <b>Шаг {i + 1}</b>
              <div class="segmented">
                {['claude', 'codex'].map((a) => (
                  <button key={a} class={`seg ${s.agent === a ? 'active' : ''}`} onClick={() => step(i, { agent: a })}>
                    <i class={`dot ${a}`} />
                    {NAME[a]}
                  </button>
                ))}
              </div>
              <button class="icon-btn" title="Удалить шаг" onClick={() => upd({ steps: edit.steps.filter((_, j) => j !== i) })} disabled={edit.steps.length < 2}>
                <Icon name="trash" size={14} />
              </button>
            </div>
            <textarea rows={3} value={s.prompt} onInput={(e) => step(i, { prompt: e.target.value })} placeholder="Инструкция для шага. {task} — ваша задача" />
          </div>
        ))}
        <button class="btn small" onClick={() => upd({ steps: [...edit.steps, { agent: 'codex', prompt: '' }] })}>
          <Icon name="plus" size={14} /> Добавить шаг
        </button>
        <p class="field-hint">В инструкциях {'{task}'} заменяется на текст, который вы напишете. Каждый агент видит ответы предыдущих шагов в общем чате.</p>
        <div class="modal-actions">
          <button class="btn ghost" onClick={() => setEdit(null)}>
            Отмена
          </button>
          <button
            class="btn primary"
            disabled={!edit.name.trim() || !edit.steps.length}
            onClick={async () => {
              const exists = list.some((p) => p.id === edit.id);
              await save(exists ? list.map((p) => (p.id === edit.id ? edit : p)) : [...list, edit]);
              setEdit(null);
            }}
          >
            Сохранить
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class="tab-body">
      <p class="field-hint">Сценарий — цепочка шагов: агенты выполняют их по очереди, каждый видит результат предыдущих. Выбирается кнопкой «Сценарий» у поля ввода.</p>
      <ul class="pipe-list">
        {list.map((p) => (
          <li key={p.id}>
            <span>
              <b>{p.name}</b>
              <small>{p.steps.map((s) => NAME[s.agent]).join(' → ')}</small>
            </span>
            <button class="btn small" onClick={() => setEdit(JSON.parse(JSON.stringify(p)))}>
              Изменить
            </button>
            <button class="icon-btn" title="Удалить" onClick={() => confirm(`Удалить сценарий «${p.name}»?`) && save(list.filter((x) => x.id !== p.id))}>
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <button class="btn small" onClick={() => setEdit({ id: 'p' + Date.now(), name: 'Новый сценарий', steps: [{ agent: 'claude', prompt: '{task}' }, { agent: 'codex', prompt: '' }] })}>
        <Icon name="plus" size={14} /> Новый сценарий
      </button>
    </div>
  );
}

// ---------- Расписание ----------

const WEEK = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const TARGET_LABEL = { claude: 'Claude', codex: 'Codex', both: 'Claude и Codex', auto: 'Авто' };

function describeSchedule(s) {
  if (s.when === 'interval') {
    const m = Number(s.every) || 60;
    return m % 60 === 0 ? `каждые ${m / 60} ч` : `каждые ${m} мин`;
  }
  const days = s.days && s.days.length && s.days.length < 7 ? s.days : null;
  const d = !days ? 'каждый день' : days.join(',') === '1,2,3,4,5' ? 'по будням' : days.map((x) => WEEK[x - 1]).join(', ');
  return `${d} в ${s.time || '09:00'}`;
}

function ScheduleEditor({ item, projects, onClose }) {
  const [s, setS] = useState({ name: '', projectId: (projects[0] && projects[0].id) || '', prompt: '', target: 'claude', when: 'days', time: '09:00', days: [1, 2, 3, 4, 5], every: 60, telegram: true, enabled: true, ...item });
  const set = (patch) => setS((x) => ({ ...x, ...patch }));
  const unit = s.every % 60 === 0 ? 'h' : 'm';
  const save = async () => {
    await duo.schedules.save({ ...s, name: s.name.trim() || s.prompt.trim().split('\n')[0].slice(0, 40) });
    onClose();
  };
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal">
        <div class="modal-head">
          <h2>{item.id ? 'Задача по расписанию' : 'Новая задача по расписанию'}</h2>
          <button class="icon-btn" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div class="field">
          <label>Что сделать</label>
          <textarea class="instr-text" rows={4} value={s.prompt} onInput={(e) => set({ prompt: e.target.value })} placeholder={'Например: прогони тесты и коротко напиши, что упало и почему'} autoFocus />
        </div>
        <div class="field">
          <label>Название</label>
          <input class="text-input" value={s.name} onInput={(e) => set({ name: e.target.value })} placeholder="Например, Утренние тесты" />
        </div>
        <div class="field">
          <label>Проект</label>
          <Select value={s.projectId} options={projects.map((p) => ({ id: p.id, name: p.name }))} onChange={(v) => set({ projectId: v })} />
        </div>
        <div class="field">
          <label>Кто делает</label>
          <Segmented value={s.target} onChange={(v) => set({ target: v })} options={['claude', 'codex', 'both', 'auto'].map((id) => ({ id, name: TARGET_LABEL[id] }))} />
        </div>
        <div class="field">
          <label>Когда</label>
          <Segmented value={s.when} onChange={(v) => set({ when: v })} options={[{ id: 'days', name: 'По дням' }, { id: 'interval', name: 'С интервалом' }]} />
          {s.when === 'days' ? (
            <div class="field-row sched-row">
              <div class="week">
                {WEEK.map((d, i) => (
                  <button
                    key={d}
                    class={`seg ${s.days.includes(i + 1) ? 'active' : ''}`}
                    onClick={() => set({ days: s.days.includes(i + 1) ? s.days.filter((x) => x !== i + 1) : [...s.days, i + 1].sort() })}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <span class="muted small">в</span>
              <input class="text-input time-input" type="time" value={s.time} onInput={(e) => set({ time: e.target.value })} />
            </div>
          ) : (
            <div class="field-row sched-row">
              <span class="muted small">каждые</span>
              <input
                class="text-input time-input"
                type="number"
                min="1"
                value={unit === 'h' ? s.every / 60 : s.every}
                onInput={(e) => set({ every: Math.max(5, (Number(e.target.value) || 1) * (unit === 'h' ? 60 : 1)) })}
              />
              <Select value={unit} options={[{ id: 'm', name: 'минут' }, { id: 'h', name: 'часов' }]} onChange={(v) => set({ every: v === 'h' ? Math.max(60, Math.round(s.every / 60) * 60) : Math.max(5, s.every) })} />
            </div>
          )}
        </div>
        <Switch checked={s.telegram} onChange={(v) => set({ telegram: v })} label="Присылать итог в Telegram" hint="Даже если уведомления о завершении в Telegram выключены" />
        <div class="field-hint">Задача работает, пока DuoCode запущен (можно свёрнутым в трей). Все запуски копятся в одном чате «⏰ …» этого проекта.</div>
        <div class="modal-actions">
          <span class="spacer" />
          <button class="btn ghost" onClick={onClose}>
            Отмена
          </button>
          <button class="btn primary" disabled={!s.prompt.trim() || !s.projectId || (s.when === 'days' && !s.days.length)} onClick={save}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

function SchedulesTab({ settings }) {
  const list = settings.schedules || [];
  const projects = settings.workspaces || [];
  const [editing, setEditing] = useState(null);
  const [ran, setRan] = useState(null);
  return (
    <div class="tab-body">
      <p class="field-hint">
        Агенты сами выполняют задачу в нужное время: «каждое утро прогоняй тесты», «раз в час проверяй, не упал ли сайт». Итог — в чате, уведомлением и в Telegram.
      </p>
      {list.length === 0 && <div class="muted small pad">Задач пока нет.</div>}
      <div class="sched-list">
        {list.map((s) => {
          const p = projects.find((x) => x.id === s.projectId);
          return (
            <div class={`sched-item ${s.enabled ? '' : 'off'}`} key={s.id}>
              <input type="checkbox" class="sched-toggle" checked={s.enabled} title={s.enabled ? 'Выключить' : 'Включить'} onChange={(e) => duo.schedules.save({ ...s, enabled: e.target.checked })} />
              <div class="sched-main" onClick={() => setEditing(s)}>
                <b>{s.name || 'Без названия'}</b>
                <small>
                  {describeSchedule(s)} · {TARGET_LABEL[s.target] || s.target} · {p ? p.name : 'проект удалён'}
                  {s.lastRun ? ` · последний запуск ${new Date(s.lastRun).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
                </small>
              </div>
              <button
                class="btn small"
                onClick={async () => {
                  await duo.schedules.run(s.id);
                  setRan(s.id);
                  setTimeout(() => setRan(null), 2000);
                }}
                title="Запустить сейчас"
              >
                {ran === s.id ? 'Запущено' : <Icon name="play" size={12} />}
              </button>
              <button class="icon-btn tiny" title="Удалить" onClick={() => confirm(`Удалить задачу «${s.name}»?`) && duo.schedules.remove(s.id)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <button class="btn" disabled={!projects.length} onClick={() => setEditing({})}>
        <Icon name="plus" size={14} /> Новая задача
      </button>
      {editing && <ScheduleEditor item={editing} projects={projects} onClose={() => setEditing(null)} />}
    </div>
  );
}

function GeneralTab({ settings, onSaved }) {
  const g = settings.general || {};
  const set = (patch) => duo.setSettings({ general: patch }).then(onSaved);
  const key = duo.platform === 'darwin' ? '⌘⇧Space' : 'Ctrl+Shift+Space';
  return (
    <div class="tab-body">
      <Switch checked={!!g.closeToTray} onChange={(v) => set({ closeToTray: v })} label="Сворачивать в трей при закрытии окна" hint="Агенты продолжают работать в фоне. Выйти — через значок в трее" />
      <Switch checked={g.hotkey !== false} onChange={(v) => set({ hotkey: v })} label={`Горячая клавиша ${key}`} hint="Показывает DuoCode из любого приложения и ставит курсор в поле ввода" />
      <Switch
        checked={g.desktopNotify !== false}
        onChange={(v) => set({ desktopNotify: v })}
        label="Уведомления на рабочем столе"
        hint="Когда окно DuoCode не активно: агент закончил или упал с ошибкой, ждёт подтверждения или задаёт вопрос. Нажмите на уведомление — откроется нужный чат"
      />
      <Switch checked={g.notifyLimits !== false} onChange={(v) => set({ notifyLimits: v })} label="Уведомления о лимитах" hint="Почти исчерпан, кончится раньше сброса, снова доступен" />
      <Switch
        checked={g.browser !== false}
        onChange={(v) => set({ browser: v })}
        label="Встроенный браузер для агентов"
        hint="Claude и Codex открывают страницы во вкладке «Браузер» боковой панели, а вы смотрите вживую. Отдельный браузер: ваших входов и паролей в нём нет"
      />
    </div>
  );
}

function AboutTab({ update, onUpdate }) {
  const [version, setVersion] = useState('');
  useEffect(() => {
    duo.version().then(setVersion);
  }, []);
  return (
    <div class="tab-body">
      <div class="about">
        <span class="logo">
          <i class="claude" />
          <i class="codex" />
        </span>
        <span>
          <b>DuoCode {version}</b>
          <small class="muted">
            {update.status === 'checking' && 'Проверяю обновления…'}
            {update.status === 'latest' && 'Установлена последняя версия'}
            {update.status === 'downloading' && `Загружается версия ${update.version}…`}
            {update.status === 'ready' && `Версия ${update.version} готова к установке`}
            {update.status === 'error' && `Не удалось проверить обновления: ${update.error}`}
            {update.status === 'dev' && 'Обновления работают только в установленной версии'}
            {update.status === 'idle' && 'Обновления проверяются автоматически'}
          </small>
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
      <p class="field-hint">
        Новые версии скачиваются в фоне и ставятся тихо: при нажатии «Перезапустить» или когда вы закрываете DuoCode. Код и релизы:{' '}
        <a href="https://github.com/RedflamieV/duocode" target="_blank" rel="noreferrer">
          github.com/RedflamieV/duocode
        </a>
      </p>
    </div>
  );
}

function Settings({ settings, env, onClose, onSaved, update, onUpdate }) {
  const [tab, setTab] = useState('look');
  const prefs = { ...DEFAULT_PREFS, ...(settings.appearance || {}) };
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal settings-modal">
        <div class="modal-head">
          <h2>Настройки</h2>
          <button class="icon-btn" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div class="tabs-row">
          {[
            ['look', 'Внешний вид'],
            ['agents', 'Агенты'],
            ['pipelines', 'Сценарии'],
            ['schedules', 'Расписание'],
            ['telegram', 'Telegram'],
            ['general', 'Общие'],
            ['about', 'О программе'],
          ].map(([id, name]) => (
            <button key={id} class={`tab-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {name}
            </button>
          ))}
        </div>
        {tab === 'look' && <AppearanceTab prefs={prefs} />}
        {tab === 'agents' && <AgentsTab settings={settings} env={env} onSaved={onSaved} />}
        {tab === 'pipelines' && <PipelinesTab settings={settings} onSaved={onSaved} />}
        {tab === 'telegram' && <TelegramTab settings={settings} onSaved={onSaved} />}
        {tab === 'general' && <GeneralTab settings={settings} onSaved={onSaved} />}
        {tab === 'schedules' && <SchedulesTab settings={settings} />}
        {tab === 'about' && <AboutTab update={update} onUpdate={onUpdate} />}
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
  const [showStats, setShowStats] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const [focusTick, setFocusTick] = useState(0);
  const [newIn, setNewIn] = useState(null);
  const [editing, setEditing] = useState(null); // { project, after }
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
      duo.limits().then(setLimits);
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
      duo.onSettings((st) => setSettings(st)),
      duo.onOpenRoom((id) => open(id)),
      // чат переписан (правка прошлого сообщения) — перечитываем его целиком
      duo.onRoomReset((id) => id === currentRef.current && duo.getRoom(id).then((r) => r && setRoom(r))),
      (() => {
        const onLink = (e) => open(e.detail);
        window.addEventListener('duo:open-room', onLink);
        return () => window.removeEventListener('duo:open-room', onLink);
      })(),
      duo.onNewChat(() => open(null)),
      duo.onFocusComposer(() => setFocusTick((t) => t + 1)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const open = async (id, msgId = null) => {
    setHighlight(msgId);
    setCurrentId(id);
    currentRef.current = id;
    setRoom(id ? await duo.getRoom(id) : null);
    if (id) store('lastRoom', id);
  };

  const prefs = useMemo(() => ({ ...DEFAULT_PREFS, ...(settings.appearance || {}) }), [settings.appearance]);
  useEffect(() => applyPrefs(prefs), [prefs]);

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

  const removeRoom = async (id = room && room.id) => {
    const r = rooms.find((x) => x.id === id);
    if (!r || !confirm(`Удалить чат «${r.title}»? Сессии Claude и Codex останутся в их истории.${r.branch ? `\n\nСвоя ветка чата «${r.branch}» и её не перенесённые изменения будут удалены.` : ''}`)) return;
    await duo.removeRoom(id);
    if (id === currentId) open(null);
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
    <PrefsContext.Provider value={prefs}>
    <Lightbox />
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
        onStats={() => setShowStats(true)}
        projects={settings.workspaces || []}
        onNewIn={(id) => {
          setNewIn(id);
          open(null);
          setFocusTick((t) => t + 1);
        }}
        onEditProject={(project) => setEditing({ project })}
        onDeleteRoom={removeRoom}
        onSettings={() => {
          loadSettings();
          setShowSettings(true);
        }}
      />
      <main class="main">
        {room ? (
          <RoomView
            key={room.id}
            room={room}
            codexModels={codexModels}
            onDelete={removeRoom}
            pipelines={settings.pipelines || []}
            focusTick={focusTick}
            highlight={highlight}
            project={(settings.workspaces || []).find((p) => p.id === room.projectId) || null}
            onEditProject={(project) => setEditing({ project })}
          />
        ) : (
          <NewChat
            focusTick={focusTick}
            initialProject={newIn}
            onEditProject={(project, after) => setEditing({ project, after })}
            settings={settings}
            env={env}
            onCreated={(id) => {
              loadSettings();
              open(id);
            }}
          />
        )}
      </main>
      {editing && (
        <ProjectEditor
          project={editing.project}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            loadSettings();
            if (editing.after) editing.after(p);
            else if (!editing.project.id) setNewIn(p.id);
          }}
        />
      )}
      {showStats && <StatsModal onClose={() => setShowStats(false)} onOpenRoom={(id) => open(id)} />}
      {showSettings && <Settings settings={settings} env={env} update={update} onUpdate={(u) => u && setUpdate({ ...u })} onClose={() => setShowSettings(false)} onSaved={loadSettings} />}
    </div>
    </PrefsContext.Provider>
  );
}

render(<App />, document.getElementById('root'));
