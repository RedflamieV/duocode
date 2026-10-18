import { useState, useEffect, useMemo } from 'preact/hooks';
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

function MemoryPanel({ cwd }) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [file, setFile] = useState('');
  const load = async () => {
    const r = await duo.memoryGet(cwd);
    setText(r.text);
    setSaved(r.text);
    setFile(r.file);
  };
  useEffect(() => {
    load();
    return duo.onMemory((dir) => dir === cwd && load());
  }, [cwd]);
  const dirty = text !== saved;
  return (
    <div class="memory-panel">
      <p class="muted small">
        Общая память проекта: её видят оба агента в каждом чате этого проекта, и оба могут её дополнять. Пишите сюда договорённости, команды, важные решения.
      </p>
      <textarea
        class="memory-text"
        value={text}
        placeholder={'# Память проекта\n\n- Тесты: npm test\n- Стиль: …'}
        onInput={(e) => setText(e.target.value)}
        spellcheck={false}
      />
      <div class="approval-actions">
        <button
          class="btn small primary"
          disabled={!dirty}
          onClick={async () => {
            await duo.memorySet(cwd, text);
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
          .duocode/memory.md
        </span>
      </div>
    </div>
  );
}

export function SidePanel({ room, folders, tab, setTab, onClose }) {
  const [folder, setFolder] = useState(room.cwd);
  useEffect(() => setFolder(room.cwd), [room.id]);
  return (
    <aside class="side-panel">
      <div class="side-head">
        <div class="tabs-row compact">
          {[
            ['changes', 'Изменения'],
            ['memory', 'Память'],
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
      <div class="side-body">{tab === 'changes' ? <GitPanel cwd={folder} key={folder} /> : <MemoryPanel cwd={room.cwd} />}</div>
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
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
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
