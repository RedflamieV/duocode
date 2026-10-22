import './shim.js';
import { render } from 'preact';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { Icon, Avatar } from '../src/icons.jsx';
import { AgentMessage, UserMessage, SystemMessage, DuelCard, NAME, peerOf } from '../src/messages.jsx';
import { PrefsContext, DEFAULT_PREFS } from '../src/prefs.js';
import { TitleInput } from '../src/titleinput.jsx';
import { Lightbox } from '../src/attachments.jsx';

const duo = window.duo;
const tg = window.Telegram && window.Telegram.WebApp;
const baseName = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');
const haptic = (kind = 'light') => tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(kind);

// На телефоне шаги агентов свёрнуты, а время и стоимость не нужны.
const PREFS = { ...DEFAULT_PREFS, steps: 'grouped', showCost: false };

const MODES = [
  { id: 'ask', name: 'Спрашивать' },
  { id: 'edits', name: 'Авто-правки' },
  { id: 'auto', name: 'Авто' },
  { id: 'full', name: 'Полный доступ' },
];

const TARGETS = [
  { id: 'claude', name: 'Claude', agents: ['claude'] },
  { id: 'codex', name: 'Codex', agents: ['codex'] },
  { id: 'both', name: 'Оба', agents: ['claude', 'codex'] },
  { id: 'auto', name: 'Авто', agents: ['auto'] },
];

// Цвета берём из темы Telegram, чтобы приложение выглядело родным.
function applyTheme() {
  if (!tg) return;
  const t = tg.themeParams || {};
  const root = document.documentElement;
  root.dataset.theme = tg.colorScheme === 'dark' ? 'dark' : 'light';
  const set = (v, c) => c && root.style.setProperty(v, c);
  set('--bg', t.bg_color);
  set('--sidebar', t.secondary_bg_color);
  set('--panel', t.section_bg_color || t.bg_color);
  set('--panel-2', t.secondary_bg_color);
  set('--text', t.text_color);
  set('--muted', t.hint_color);
  set('--faint', t.hint_color);
  set('--primary', t.button_color);
  set('--primary-text', t.button_text_color);
  // остальное выводим из светлоты темы, чтобы не зависеть от системной темы телефона
  const dark = tg.colorScheme === 'dark';
  const tone = dark ? '255,255,255' : '0,0,0';
  set('--border', `rgba(${tone},${dark ? 0.09 : 0.1})`);
  set('--border-strong', `rgba(${tone},${dark ? 0.16 : 0.18})`);
  set('--hover', `rgba(${tone},${dark ? 0.07 : 0.05})`);
  set('--code-bg', `rgba(${tone},${dark ? 0.05 : 0.04})`);
  set('--shadow', dark ? '0 8px 24px rgba(0,0,0,0.4)' : '0 8px 24px rgba(0,0,0,0.1)');
  root.style.colorScheme = dark ? 'dark' : 'light';
}

function fmtAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'сейчас';
  if (s < 3600) return `${Math.floor(s / 60)} мин`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч`;
  return new Date(ts).toLocaleDateString();
}

function fmtUntil(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return '';
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d} д ${h} ч` : h ? `${h} ч ${m % 60} мин` : `${m % 60} мин`;
}

// ---------- Главная ----------

function Limits({ limits }) {
  return (
    <div class="m-limits">
      {['claude', 'codex'].map((a) => {
        const d = limits[a];
        return (
          <div class="m-limit" key={a}>
            <div class="m-limit-head">
              <Avatar agent={a} size={16} />
              <b>{NAME[a]}</b>
            </div>
            {!d && <span class="muted small">…</span>}
            {d && !d.ok && <span class="muted small">{d.error}</span>}
            {d &&
              d.ok &&
              d.windows.slice(0, 2).map((w) => {
                const pct = Math.max(0, Math.min(100, Math.round(w.percent)));
                return (
                  <div class="m-limit-row" key={w.label}>
                    <span>{w.label}</span>
                    <span class="bar">
                      <i class={`${a} ${pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : ''}`} style={{ width: pct + '%' }} />
                    </span>
                    <b>{pct}%</b>
                    <small>{fmtUntil(w.resetsAt)}</small>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

function Home({ rooms, limits, onOpen, onNew, projects = [] }) {
  const nameOf = (r) => {
    const p = projects.find((x) => x.id === r.projectId);
    return p ? p.name : baseName(r.cwd);
  };
  return (
    <div class="m-screen">
      <Limits limits={limits} />
      <button class="m-new" onClick={onNew}>
        <Icon name="plus" size={18} />
        Новый чат
      </button>
      <div class="m-list">
        {rooms.length === 0 && <div class="muted pad">Чатов пока нет</div>}
        {rooms.map((r) => (
          <button key={r.id} class="m-room" onClick={() => onOpen(r.id)}>
            <span class="m-room-main">
              <b>{r.title}</b>
              <small>
                <Icon name="folder" size={12} /> {nameOf(r)}
              </small>
            </span>
            <span class="room-side">
              {r.waiting && <span class="waiting" title="Ждёт вашего подтверждения" />}
              {r.running.claude && <i class="pulse claude" />}
              {r.running.codex && <i class="pulse codex" />}
              {!r.running.claude && !r.running.codex && !r.waiting && <span class="room-time">{fmtAgo(r.updatedAt)}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function NewChat({ onCreated }) {
  const [projects, setProjects] = useState(null);
  useEffect(() => {
    duo.projects().then(setProjects);
  }, []);
  const create = async (projectId) => {
    haptic();
    const room = await duo.createRoom({ projectId });
    onCreated(room.id);
  };
  return (
    <div class="m-screen">
      <div class="section pad">Проект</div>
      <div class="m-list">
        {!projects && <div class="muted pad">Загрузка…</div>}
        {projects && projects.length === 0 && <div class="muted pad">Сначала создайте проект в DuoCode на компьютере.</div>}
        {(projects || []).map((p) => (
          <button key={p.id} class="m-room" onClick={() => create(p.id)}>
            <span class="m-room-main">
              <b>{p.name}</b>
              <small>{p.folders.length > 1 ? `${p.folders.length} папки: ${p.folders.map(baseName).join(', ')}` : p.folders[0]}</small>
            </span>
            <Icon name="right" size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- Чат ----------

function Composer({ room, onLocal }) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState(() => {
    try {
      return localStorage.getItem(`target:${room.id}`) || 'both';
    } catch {
      return 'both';
    }
  });
  const [plan, setPlan] = useState(false);
  const ref = useRef();
  const agents = TARGETS.find((t) => t.id === target).agents;
  const running = room.running && (room.running.claude || room.running.codex);
  const steering = !plan && agents.some((a) => room.running && room.running[a]);

  useEffect(() => {
    const ta = ref.current;
    // высоту по тексту даёт CSS field-sizing; ручной подгон — только где его нет (старые WebView)
    if (CSS.supports('field-sizing', 'content')) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }, [text]);

  const pick = (t) => {
    setTarget(t);
    try {
      localStorage.setItem(`target:${room.id}`, t);
    } catch {}
  };

  const send = async () => {
    if (!text.trim()) return;
    haptic('medium');
    const payload = { text: text.trim(), targets: agents, plan };
    setText('');
    setPlan(false);
    // показываем сообщение сразу, настоящее придёт с компьютера и заменит его
    if (!steering) onLocal({ id: `local-${Date.now()}`, role: 'user', text: payload.text, targets: agents.filter((a) => a !== 'auto'), plan, ts: Date.now(), queued: [], local: true });
    try {
      await duo.send(room.id, payload);
    } catch (err) {
      if (tg) tg.showAlert(`Не отправилось: ${err.message}`);
      else alert(`Не отправилось: ${err.message}`);
      setText(payload.text);
    }
  };

  return (
    <div class="m-composer">
      {room.paused && (
        <div class="paused-bar">
          <span>⏸ На паузе — контекст и очередь сохранены</span>
          <button class="btn small primary" onClick={() => duo.resume(room.id)}>
            ▶ Продолжить
          </button>
        </div>
      )}
      {steering && !room.paused && <div class="m-hint">Агент работает — сообщение допишется в его работу</div>}
      <div class="m-input">
        <textarea ref={ref} rows={1} value={text} placeholder="Задача для агентов…" onInput={(e) => setText(e.target.value)} />
        {running && !text.trim() && (
          <button class="pause-btn" onClick={() => duo.pause(room.id)} title="Пауза: прервать шаг, контекст сохранить">
            <Icon name="pause" size={18} />
          </button>
        )}
        {running && !text.trim() ? (
          <button class="stop-btn" onClick={() => duo.stop(room.id)} title="Остановить">
            <Icon name="stop" size={18} />
          </button>
        ) : (
          <button class="send-btn" onClick={send} disabled={!text.trim()}>
            <Icon name={steering ? 'plus' : 'up'} size={18} />
          </button>
        )}
      </div>
      <div class="m-bar">
        <div class="segmented">
          {TARGETS.map((t) => (
            <button key={t.id} class={`seg ${target === t.id ? 'active' : ''}`} onClick={() => pick(t.id)}>
              {t.agents.filter((a) => a !== 'auto').map((a) => (
                <i class={`dot ${a}`} key={a} />
              ))}
              {t.name}
            </button>
          ))}
        </div>
        <button class={`toggle ${plan ? 'on' : ''}`} onClick={() => setPlan(!plan)}>
          <Icon name="todo" size={14} />
          План
        </button>
      </div>
    </div>
  );
}

function Room({ room, onLocal }) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(null); // новое название, пока сервер не подтвердил
  useEffect(() => setTitle(null), [room.title]);
  const byId = useMemo(() => new Map(room.messages.map((m) => [m.id, m])), [room.messages]);
  const top = room.messages.filter((m) => !m.parentId);
  const scroll = useRef();
  const inner = useRef();
  const stick = useRef(true);
  useEffect(() => {
    const el = scroll.current;
    const ro = new ResizeObserver(() => stick.current && (el.scrollTop = el.scrollHeight));
    ro.observe(inner.current);
    el.scrollTop = el.scrollHeight;
    return () => ro.disconnect();
  }, []);
  const review = (msg) =>
    duo.send(room.id, {
      text: `Проверь последний ответ ${NAME[msg.agent]} выше: найди ошибки и слабые места, предложи улучшения. Если всё хорошо — так и скажи.`,
      targets: [peerOf(msg.agent)],
    });
  return (
    <div class="m-room-view">
      <div class="m-room-head">
        <div class="m-room-title">
          {renaming ? (
            <TitleInput
              class="m-title-input"
              value={title || room.title}
              onSave={(t) => {
                setTitle(t);
                duo.renameRoom(room.id, t);
              }}
              onDone={() => setRenaming(false)}
            />
          ) : (
            <span class="m-title-row" onClick={() => setRenaming(true)}>
              <b>{title || room.title}</b>
              <Icon name="edit" size={12} />
            </span>
          )}
          <small>
            <Icon name="folder" size={12} /> {baseName(room.cwd)}
          </small>
        </div>
        <label class="select">
          <select value={room.settings.mode} onChange={(e) => duo.setRoomSettings(room.id, { mode: e.target.value })}>
            {MODES.map((m) => (
              <option value={m.id} key={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <Icon name="down" size={13} />
        </label>
      </div>
      <div
        class="m-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div class="thread" ref={inner}>
          {top.length === 0 && <div class="thread-empty">Напишите задачу — Claude и Codex сделают её на вашем компьютере.</div>}
          {top.map((m) =>
            m.role === 'user' ? (
              <UserMessage msg={m} key={m.id} roomId={room.id} room={room} />
            ) : m.role === 'system' ? (
              <SystemMessage msg={m} key={m.id} />
            ) : m.role === 'duel' ? (
              <DuelCard card={m} room={room} key={m.id} />
            ) : (
              <AgentMessage msg={m} room={room} byId={byId} key={m.id} onReview={review} />
            ),
          )}
        </div>
      </div>
      <Composer room={room} onLocal={onLocal} />
    </div>
  );
}

// ---------- Приложение ----------

function App() {
  const [screen, setScreen] = useState('home');
  const [rooms, setRooms] = useState([]);
  const [room, setRoom] = useState(null);
  const [limits, setLimits] = useState({});
  const [status, setStatus] = useState('connecting');
  const [error, setError] = useState(null);
  const [projects, setProjects] = useState([]);
  const current = useRef(null);

  const openRoom = async (id) => {
    current.current = id;
    setRoom(await duo.getRoom(id));
    setScreen('room');
  };

  useEffect(() => {
    applyTheme();
    if (tg) tg.onEvent('themeChanged', applyTheme);
    Promise.all([duo.listRooms(), duo.limits(), duo.projects()])
      .then(([r, l, p]) => {
        setRooms(r);
        setProjects(p || []);
        setLimits(l || {});
        setStatus('online');
        duo.connect();
      })
      .catch((err) => setError(err.message));
    const start = new URLSearchParams(location.search).get('room');
    if (start && start.startsWith('room-')) openRoom(start);
    const offs = [
      duo.onRooms((list) => {
        setRooms(list);
        const cur = list.find((r) => r.id === current.current);
        if (cur) setRoom((r) => (r && r.id === cur.id ? { ...r, ...cur } : r));
      }),
      duo.onMessages((roomId, msgs) => {
        if (roomId !== current.current) return;
        setRoom((r) => {
          if (!r || r.id !== roomId) return r;
          const messages = msgs.some((m) => m.role === 'user') ? r.messages.filter((m) => !m.local) : r.messages.slice();
          for (const m of msgs) {
            const i = messages.findIndex((x) => x.id === m.id);
            if (i >= 0) messages[i] = m;
            else messages.push(m);
          }
          return { ...r, messages };
        });
      }),
      duo.onLimits(setLimits),
      duo.onStatus(setStatus),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  // Свежее состояние после каждого действия, опрос — если поток обновлений молчит,
  // и переподключение, когда приложение снова на экране.
  const sync = async () => {
    const id = current.current;
    const [list, r] = await Promise.all([duo.listRooms(), id ? duo.getRoom(id) : null]).catch(() => [null, null]);
    if (list) setRooms(list);
    if (r && current.current === r.id) setRoom(r);
  };
  useEffect(() => {
    const off = duo.onChanged(() => {
      sync();
      setTimeout(sync, 1500);
    });
    const poll = setInterval(() => !duo.live() && sync(), 3000);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      duo.connect();
      sync();
    };
    document.addEventListener('visibilitychange', onVisible);
    if (tg) tg.onEvent('activated', onVisible);
    return () => {
      off();
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // кнопка «Назад» в шапке Telegram
  useEffect(() => {
    if (!tg) return;
    const back = () => {
      current.current = null;
      setScreen('home');
    };
    if (screen === 'home') tg.BackButton.hide();
    else tg.BackButton.show();
    tg.BackButton.onClick(back);
    return () => tg.BackButton.offClick(back);
  }, [screen]);

  if (error) {
    return (
      <div class="m-error">
        <Icon name="alert" size={28} />
        <b>Нет доступа к DuoCode</b>
        <p>{/401|доступ/i.test(error) ? 'Это приложение открывается только из чата с вашим ботом и только с вашего аккаунта.' : `Компьютер не отвечает: ${error}. Проверьте, что DuoCode запущен.`}</p>
      </div>
    );
  }

  return (
    <PrefsContext.Provider value={PREFS}>
      <div class="m-app">
        <Lightbox />
        {status === 'offline' && <div class="m-offline">Нет связи с компьютером — переподключаюсь…</div>}
        {screen === 'home' && <Home rooms={[...rooms.filter((r) => r.pinned && !r.archived), ...rooms.filter((r) => !r.pinned && !r.archived)]} limits={limits} projects={projects} onOpen={openRoom} onNew={() => setScreen('new')} />}
        {screen === 'new' && <NewChat onCreated={openRoom} />}
        {screen === 'room' && room && <Room room={room} key={room.id} onLocal={(m) => setRoom((r) => (r ? { ...r, messages: [...r.messages, m] } : r))} />}
      </div>
    </PrefsContext.Provider>
  );
}

render(<App />, document.getElementById('root'));
