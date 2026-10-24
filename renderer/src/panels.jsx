import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { Icon, Avatar } from './icons.jsx';

const duo = window.duo;
const NAME = { claude: 'Claude', codex: 'Codex' };

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.0', '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.0', '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

export function DiffView({ diff }) {
  if (!diff) return <div class="muted small pad">Нет изменений для показа</div>;
  return (
    <pre class="diff-body panel-diff">
      {diff.split('\n').map((line, j) => {
        const c = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
        return (
          <div class={`dl ${c}`} key={j}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}

// ---------- Панель «Изменения» (git) ----------

const KIND = { modified: 'изменён', added: 'добавлен', new: 'новый', deleted: 'удалён' };

function GitPanel({ cwd }) {
  const [st, setSt] = useState(null);
  const [open, setOpen] = useState(null);
  const [diff, setDiff] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const load = async () => setSt(await duo.git.status(cwd));
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [cwd]);

  const show = async (f) => {
    if (open === f.path) return setOpen(null);
    setOpen(f.path);
    setDiff(await duo.git.diff(cwd, f.path, f.kind));
  };

  const act = async (label, fn) => {
    setBusy(label);
    setNote('');
    try {
      const r = await fn();
      if (r && r.output) setNote(r.output.split('\n').slice(-3).join('\n'));
    } finally {
      setBusy('');
      load();
    }
  };

  if (!st) return <div class="pad muted small">Загрузка…</div>;
  if (!st.repo) {
    return (
      <div class="pad">
        <p class="muted small">{st.git ? 'Эта папка — не git-репозиторий.' : 'Git не найден. Установите Git, чтобы видеть изменения и коммитить.'}</p>
        {st.git && (
          <button class="btn small" onClick={() => act('init', () => duo.git.init(cwd))}>
            Создать репозиторий
          </button>
        )}
      </div>
    );
  }

  return (
    <div class="git-panel">
      <div class="git-head">
        <span class="branch">
          <Icon name="swap" size={13} /> {st.branch}
        </span>
        {st.upstream && (st.ahead > 0 || st.behind > 0) && (
          <span class="muted small">
            {st.ahead > 0 && `↑${st.ahead}`} {st.behind > 0 && `↓${st.behind}`}
          </span>
        )}
        <button class="icon-btn" onClick={load} title="Обновить">
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {st.files.length === 0 ? (
        <div class="pad muted small">Нет незакоммиченных изменений.</div>
      ) : (
        <ul class="git-files">
          {st.files.map((f) => (
            <li key={f.path} class={open === f.path ? 'open' : ''}>
              <div class="git-file">
                <button class="git-name" onClick={() => show(f)} title={f.path}>
                  <span class={`git-kind ${f.kind}`}>{f.kind === 'new' ? 'N' : f.kind === 'deleted' ? 'D' : f.kind === 'added' ? 'A' : 'M'}</span>
                  <span class="git-path">
                    {f.path.split('/').pop()}
                    {f.path.includes('/') && <small> {f.path.slice(0, f.path.lastIndexOf('/'))}</small>}
                  </span>
                </button>
                <button
                  class="icon-btn"
                  title={`Откатить файл (${KIND[f.kind]})`}
                  onClick={() => confirm(`Откатить ${f.path}? Изменения в этом файле пропадут.`) && act('revert', () => duo.git.revert(cwd, f.path, f.kind))}
                >
                  <Icon name="undo" size={13} />
                </button>
              </div>
              {open === f.path && <DiffView diff={diff} />}
            </li>
          ))}
        </ul>
      )}
      {st.files.length > 0 && (
        <div class="commit-box">
          <textarea rows={3} placeholder="Сообщение коммита" value={message} onInput={(e) => setMessage(e.target.value)} />
          <div class="approval-actions">
            <button class="btn small" disabled={!!busy} onClick={() => act('msg', async () => setMessage(await duo.git.message(cwd)))}>
              {busy === 'msg' ? 'Пишу…' : 'Сгенерировать'}
            </button>
            <button
              class="btn small primary"
              disabled={!message.trim() || !!busy}
              onClick={() =>
                act('commit', async () => {
                  const r = await duo.git.commit(cwd, message.trim());
                  if (r.ok) setMessage('');
                  return r;
                })
              }
            >
              {busy === 'commit' ? 'Коммичу…' : `Закоммитить всё (${st.files.length})`}
            </button>
          </div>
        </div>
      )}
      {st.upstream !== undefined && (
        <div class="pad">
          <button class="btn small" disabled={!!busy} onClick={() => act('push', () => duo.git.push(cwd))}>
            {busy === 'push' ? 'Отправляю…' : 'Отправить (push)'}
          </button>
        </div>
      )}
      {note && <pre class="git-note">{note}</pre>}
    </div>
  );
}

// ---------- Панель «Память проекта» ----------

const GLOBAL = '*global*'; // так main.js понимает «глобальная память»

function MemoryPanel({ cwd }) {
  const [scope, setScope] = useState('project');
  const where = scope === 'global' ? GLOBAL : cwd;
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [file, setFile] = useState('');
  const load = async () => {
    const r = await duo.memoryGet(where);
    setText(r.text);
    setSaved(r.text);
    setFile(r.file);
  };
  useEffect(() => {
    load();
    return duo.onMemory((dir) => dir === where && load());
  }, [where]);
  const dirty = text !== saved;
  return (
    <div class="memory-panel">
      <div class="segmented wide">
        <button class={`seg ${scope === 'project' ? 'active' : ''}`} onClick={() => setScope('project')}>
          Проект
        </button>
        <button class={`seg ${scope === 'global' ? 'active' : ''}`} onClick={() => setScope('global')}>
          Глобальная
        </button>
      </div>
      <p class="muted small">
        {scope === 'project'
          ? 'Память проекта: её видят оба агента в каждом чате этого проекта, и оба могут её дополнять. Договорённости, команды, важные решения.'
          : 'Глобальная память: её видят оба агента во всех проектах. О вас и ваших привычках: как объяснять, ваша система и инструменты, общие правила.'}
      </p>
      <textarea
        class="memory-text"
        value={text}
        placeholder={scope === 'project' ? '# Память проекта\n\n- Тесты: npm test\n- Стиль: …' : '# Глобальная память\n\n- Windows 11, PowerShell\n- Объясняй простыми словами'}
        onInput={(e) => setText(e.target.value)}
        spellcheck={false}
      />
      <div class="approval-actions">
        <button
          class="btn small primary"
          disabled={!dirty}
          onClick={async () => {
            await duo.memorySet(where, text);
            setSaved(text);
          }}
        >
          Сохранить
        </button>
        {dirty && (
          <button class="btn small ghost" onClick={() => setText(saved)}>
            Отменить
          </button>
        )}
        <span class="muted small path-hint" title={file}>
          {scope === 'global' ? 'memory.md в папке DuoCode' : '.duocode/memory.md'}
        </span>
      </div>
    </div>
  );
}

// Встроенный браузер агентов. Сама страница — окно Electron (WebContentsView) поверх этого места:
// панель сообщает его координаты и прячет браузер, пока поверх открыто меню или окно.
const NAME_OF = { claude: 'Claude', codex: 'Codex' };
function BrowserPanel() {
  const [st, setSt] = useState({ url: '' });
  const [addr, setAddr] = useState('');
  const [editing, setEditing] = useState(false);
  const box = useRef();
  useEffect(() => {
    duo.browserState().then((s) => s && setSt(s));
    return duo.onBrowser(setSt);
  }, []);
  useEffect(() => {
    if (!editing) setAddr(st.url || '');
  }, [st.url, editing]);
  const show = !!(st.url || st.driver);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let last = '';
    const sync = () => {
      const covered = document.querySelector('.modal-back, .lightbox, .menu, .context-menu');
      const r = el.getBoundingClientRect();
      const rect = show && !covered && r.width > 20 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
      const key = JSON.stringify(rect);
      if (key !== last) {
        last = key;
        duo.browserBounds(rect);
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    const mo = new MutationObserver(sync);
    mo.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', sync);
    // пока панель выезжает, координаты меняются без изменения размеров
    const t = setInterval(sync, 120);
    const stop = setTimeout(() => clearInterval(t), 800);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', sync);
      clearInterval(t);
      clearTimeout(stop);
      duo.browserBounds(null);
    };
  }, [show]);
  const go = (e) => {
    e.preventDefault();
    setEditing(false);
    if (addr.trim()) duo.browserUser('open', addr.trim()).catch(() => {});
  };
  return (
    <div class="browser-panel">
      <form class="browser-bar" onSubmit={go}>
        <button type="button" class="icon-btn tiny" disabled={!st.canBack} onClick={() => duo.browserUser('back')} title="Назад">
          <Icon name="left" size={15} />
        </button>
        <button type="button" class="icon-btn tiny" disabled={!st.canForward} onClick={() => duo.browserUser('forward')} title="Вперёд">
          <Icon name="right" size={15} />
        </button>
        <button type="button" class="icon-btn tiny" disabled={!st.url} onClick={() => duo.browserUser(st.loading ? 'stop' : 'reload')} title={st.loading ? 'Остановить' : 'Обновить'}>
          <Icon name={st.loading ? 'x' : 'refresh'} size={14} />
        </button>
        <input
          class="browser-url"
          value={addr}
          placeholder="Адрес, например localhost:3000"
          spellcheck={false}
          onFocus={(e) => {
            setEditing(true);
            e.target.select();
          }}
          onBlur={() => setEditing(false)}
          onInput={(e) => setAddr(e.target.value)}
        />
        <button type="button" class="icon-btn tiny" disabled={!st.url} onClick={() => duo.browserExternal()} title="Открыть в системном браузере">
          <Icon name="external" size={14} />
        </button>
      </form>
      {st.driver && (
        <div class={`browser-driver ${st.driver}`}>
          <i />
          {NAME_OF[st.driver]} управляет браузером
        </div>
      )}
      {st.loading && <div class="browser-progress" />}
      <div class="browser-view" ref={box}>
        {!show && (
          <div class="browser-empty">
            <Icon name="globe" size={28} />
            <b>Браузер агентов</b>
            <p>
              Здесь Claude и Codex открывают страницы, кликают и прокручивают — вы видите это вживую. Попросите, например: «открой localhost:3000 и проверь форму входа». Или введите
              адрес сверху.
            </p>
            <small>Отдельный браузер: ваших входов на сайты и паролей в нём нет.</small>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Терминал ----------

// Цвета ANSI → кусочки текста с классами. Перерисовка строки (\r) оставляет последнее состояние строки.
const SGR_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
function ansiLines(raw, limit = 3000) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n').slice(-limit);
  let cls = [];
  return lines.map((line) => {
    line = line.split('\r').filter((x, i, a) => x || i === a.length - 1).pop() || '';
    const out = [];
    let last = 0;
    const re = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push({ text: line.slice(last, m.index), cls: cls.join(' ') });
      last = re.lastIndex;
      if (m[2] !== 'm') continue;
      const codes = (m[1] || '0').split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) cls = [];
        else if (c === 1) cls = [...cls.filter((x) => x !== 'b'), 'b'];
        else if (c === 2) cls = [...cls.filter((x) => x !== 'dim'), 'dim'];
        else if (c === 22) cls = cls.filter((x) => x !== 'b' && x !== 'dim');
        else if (c === 4) cls = [...cls, 'u'];
        else if (c >= 30 && c <= 37) cls = [...cls.filter((x) => !x.startsWith('fg-')), `fg-${SGR_COLORS[c - 30]}`];
        else if (c >= 90 && c <= 97) cls = [...cls.filter((x) => !x.startsWith('fg-')), `fg-${SGR_COLORS[c - 90]}`];
        else if (c === 39) cls = cls.filter((x) => !x.startsWith('fg-'));
        else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : 4; // 256 цветов и truecolor — пропускаем
      }
    }
    if (last < line.length) out.push({ text: line.slice(last), cls: cls.join(' ') });
    return out;
  });
}

const BY = { user: 'вы', claude: 'Claude', codex: 'Codex' };

function TerminalPanel({ cwd }) {
  const [list, setList] = useState([]);
  const [active, setActive] = useState(null);
  const [out, setOut] = useState('');
  const [cmd, setCmd] = useState('');
  const [stdin, setStdin] = useState('');
  const box = useRef();
  const stick = useRef(true);
  const activeRef = useRef(null);
  activeRef.current = active;
  useEffect(() => {
    duo.term.list().then((l) => {
      setList(l);
      if (l.length) setActive((a) => a || l[l.length - 1].id);
    });
    const offs = [
      duo.onTermList((l) => {
        setList(l);
        setActive((a) => (a && l.some((x) => x.id === a) ? a : l.length ? l[l.length - 1].id : null));
      }),
      duo.onTermData((id, data) => id === activeRef.current && setOut((o) => (o + data).slice(-200000))),
    ];
    return () => offs.forEach((f) => f());
  }, []);
  useEffect(() => {
    if (!active) return setOut('');
    stick.current = true;
    duo.term.output(active).then(setOut);
  }, [active]);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [out]);
  const lines = useMemo(() => ansiLines(out), [out]);
  const cur = list.find((x) => x.id === active);
  const run = async (e) => {
    e.preventDefault();
    if (!cmd.trim()) return;
    const t = await duo.term.start(cmd.trim(), cwd);
    setCmd('');
    setActive(t.id);
  };
  return (
    <div class="term-panel">
      {list.length > 0 && (
        <div class="term-tabs">
          {list.map((t) => (
            <button key={t.id} class={`term-tab ${t.id === active ? 'active' : ''}`} onClick={() => setActive(t.id)} title={`${t.command}\n${t.cwd}\nЗапустил: ${BY[t.by] || t.by}`}>
              <i class={`term-dot ${t.status === 'running' ? 'on' : t.code ? 'err' : ''}`} />
              <span>{t.command}</span>
              {t.by !== 'user' && <small>{BY[t.by]}</small>}
            </button>
          ))}
        </div>
      )}
      <div
        class="term-out"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!cur && (
          <div class="term-empty">
            Здесь видны процессы: dev-сервер, сборка, тесты. Запустите команду ниже — или агент запустит её сам, и вы увидите вывод вживую.
          </div>
        )}
        {cur &&
          lines.map((l, i) => (
            <div class="term-line" key={i}>
              {l.length ? l.map((s, j) => (s.cls ? <span class={s.cls} key={j}>{s.text}</span> : s.text)) : '\u00a0'}
            </div>
          ))}
      </div>
      {cur && (
        <div class="term-actions">
          <span class="muted small">
            {cur.status === 'running' ? 'работает' : `завершён${cur.code != null ? `, код ${cur.code}` : ''}`} · {cur.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}
          </span>
          {cur.status === 'running' ? (
            <button class="btn small" onClick={() => duo.term.stop(cur.id)}>
              <Icon name="stop" size={12} /> Стоп
            </button>
          ) : (
            <button class="btn small ghost" onClick={() => duo.term.remove(cur.id)}>
              Убрать
            </button>
          )}
        </div>
      )}
      {cur && cur.status === 'running' && (
        <form
          class="term-input"
          onSubmit={(e) => {
            e.preventDefault();
            duo.term.write(cur.id, stdin).catch(() => {});
            setStdin('');
          }}
        >
          <span>↳</span>
          <input value={stdin} placeholder="Ввод в процесс (Enter — отправить)" onInput={(e) => setStdin(e.target.value)} spellcheck={false} />
        </form>
      )}
      <form class="term-input new" onSubmit={run}>
        <span>$</span>
        <input value={cmd} placeholder="Новая команда, например npm run dev" onInput={(e) => setCmd(e.target.value)} spellcheck={false} />
      </form>
    </div>
  );
}

export function SidePanel({ room, folders, tab, setTab, onClose }) {
  const main = room.workdir || room.cwd;
  const [folder, setFolder] = useState(main);
  useEffect(() => setFolder(main), [room.id, main]);
  // ширину панели можно менять, потянув за левый край
  const [width, setWidth] = useState(() => Number(localStorage.getItem('duo:panel-width')) || 0);
  const startResize = (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = e.currentTarget.parentNode.getBoundingClientRect().width;
    const move = (ev) => setWidth(Math.max(320, Math.min(window.innerWidth - 520, w0 + (x0 - ev.clientX))));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      setWidth((w) => {
        try {
          localStorage.setItem('duo:panel-width', String(w));
        } catch {}
        return w;
      });
    };
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <aside class={`side-panel ${tab === 'browser' || tab === 'terminal' ? 'wide' : ''}`} style={width ? { width: `${width}px` } : undefined}>
      <div class="panel-resize" onMouseDown={startResize} title="Потяните, чтобы изменить ширину" />
      <div class="side-head">
        <div class="tabs-row compact">
          {[
            ['changes', 'Изменения'],
            ['memory', 'Память'],
            ['terminal', 'Терминал'],
            ['browser', 'Браузер'],
          ].map(([id, name]) => (
            <button key={id} class={`tab-btn ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
              {name}
            </button>
          ))}
        </div>
        <button class="icon-btn" onClick={onClose} title="Закрыть панель">
          <Icon name="x" size={15} />
        </button>
      </div>
      {tab === 'changes' && folders && folders.length > 1 && (
        <div class="folder-tabs">
          {folders.map((f) => (
            <button key={f} class={`chip-btn ${folder === f ? 'active' : ''}`} onClick={() => setFolder(f)} title={f}>
              <Icon name="folder" size={12} /> {f.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}
            </button>
          ))}
        </div>
      )}
      <div class="side-body">
        {tab === 'changes' ? (
          <GitPanel cwd={folder} key={folder} />
        ) : tab === 'browser' ? (
          <BrowserPanel />
        ) : tab === 'terminal' ? (
          <TerminalPanel cwd={room.workdir || room.cwd} />
        ) : (
          <MemoryPanel cwd={room.cwd} />
        )}
      </div>
    </aside>
  );
}

// ---------- Статистика ----------

// Столбцы по дням для одного агента. Шкала общая для обоих графиков, чтобы их можно было сравнивать.
function DayColumns({ agent, data, max }) {
  const [hover, setHover] = useState(null);
  const peak = data.reduce((m, d, i) => (d[agent] > (data[m] ? data[m][agent] : -1) ? i : m), 0);
  const ticks = [max, max / 2];
  return (
    <div class="day-chart">
      <div class="day-chart-title">
        <Avatar agent={agent} size={16} />
        <b>{NAME[agent]}</b>
        <span class="muted small">токенов за день</span>
      </div>
      <div class="day-plot">
        {ticks.map((t) => (
          <div class="grid-line" key={t} style={{ bottom: `${(t / max) * 100}%` }}>
            <span>{fmtTokens(t)}</span>
          </div>
        ))}
        <div class="day-cols">
          {data.map((d, i) => {
            const h = max ? (d[agent] / max) * 100 : 0;
            return (
              <div class="day-col" key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                {i === peak && d[agent] > 0 && <span class="col-label" style={{ bottom: `calc(${h}% + 4px)` }}>{fmtTokens(d[agent])}</span>}
                <i class={agent} style={{ height: `${Math.max(h, d[agent] ? 1.5 : 0)}%` }} />
                {hover === i && (
                  <div class="col-tip">
                    <b>{new Date(d.day).toLocaleDateString([], { day: 'numeric', month: 'short', weekday: 'short' })}</b>
                    <span>{d[agent].toLocaleString()} токенов</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div class="day-axis">
        {data.map((d, i) => (
          <span key={d.day}>{i % 2 === data.length % 2 ? '' : new Date(d.day).getDate()}</span>
        ))}
      </div>
    </div>
  );
}

export function StatsModal({ onClose, onOpenRoom }) {
  const [stats, setStats] = useState(null);
  const [table, setTable] = useState(false);
  useEffect(() => {
    duo.stats().then(setStats);
  }, []);
  const daily = (stats && stats.daily) || [];
  const max = useMemo(() => {
    const m = Math.max(1, ...daily.map((d) => Math.max(d.claude, d.codex)));
    const pow = Math.pow(10, Math.floor(Math.log10(m)));
    return Math.ceil(m / pow) * pow;
  }, [daily]);
  const total = (a) => daily.reduce((s, d) => s + d[a], 0);
  const today = daily[daily.length - 1] || { claude: 0, codex: 0 };
  const chats = ((stats && stats.chats) || []).filter((c) => c.claude + c.codex > 0).sort((a, b) => b.claude + b.codex - (a.claude + a.codex));

  return (
    <div class="modal-back">
      <div class="modal stats-modal">
        <div class="modal-head">
          <h2>Статистика</h2>
          <button class="icon-btn" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {!stats ? (
          <div class="pad muted">Считаю по локальным логам…</div>
        ) : (
          <div class="tab-body">
            <div class="stat-tiles">
              {['claude', 'codex'].map((a) => (
                <div class="stat-tile" key={a}>
                  <span class="muted small">
                    <Avatar agent={a} size={14} /> {NAME[a]}
                  </span>
                  <b>{fmtTokens(today[a])}</b>
                  <span class="muted small">сегодня · {fmtTokens(total(a))} за 14 дней</span>
                </div>
              ))}
            </div>
            <div class="chart-toolbar">
              <span class="section">Токены по дням, 14 дней</span>
              <button class="link small" onClick={() => setTable(!table)}>
                {table ? 'Графиком' : 'Таблицей'}
              </button>
            </div>
            {table ? (
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>День</th>
                    <th>Claude</th>
                    <th>Codex</th>
                  </tr>
                </thead>
                <tbody>
                  {[...daily].reverse().map((d) => (
                    <tr key={d.day}>
                      <td>{new Date(d.day).toLocaleDateString()}</td>
                      <td>{d.claude.toLocaleString()}</td>
                      <td>{d.codex.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div class="day-charts">
                <DayColumns agent="claude" data={daily} max={max} />
                <DayColumns agent="codex" data={daily} max={max} />
              </div>
            )}
            <div class="section stats-section">Чаты DuoCode</div>
            {chats.length === 0 ? (
              <div class="muted small">Пока пусто.</div>
            ) : (
              <table class="stats-table">
                <thead>
                  <tr>
                    <th>Чат</th>
                    <th>Ответов Claude</th>
                    <th>Ответов Codex</th>
                    <th title="Стоимость по ценам API, которую сообщает Claude Code. По подписке вы её не платите — это мера расхода лимита.">Claude, $ API</th>
                  </tr>
                </thead>
                <tbody>
                  {chats.slice(0, 30).map((c) => (
                    <tr
                      key={c.id}
                      class="clickable"
                      onClick={() => {
                        onOpenRoom(c.id);
                        onClose();
                      }}
                    >
                      <td>{c.title}</td>
                      <td>{c.claude}</td>
                      <td>{c.codex}</td>
                      <td>{c.cost ? c.cost.toFixed(2) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p class="field-hint">Токены считаются по локальным логам Claude Code и Codex, включая работу вне DuoCode. Кэшированные токены учитываются.</p>
          </div>
        )}
      </div>
    </div>
  );
}
