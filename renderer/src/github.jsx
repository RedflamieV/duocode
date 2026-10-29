import { useState, useEffect, useRef } from 'preact/hooks';
import { Icon } from './icons.jsx';

const duo = window.duo;
const errorText = (err) => err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function GitHubPanel({ onImported }) {
  const [status, setStatus] = useState(null);
  const [repos, setRepos] = useState([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState('');
  const [repository, setRepository] = useState('');
  const [parent, setParent] = useState('');
  const [busy, setBusyState] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const checking = useRef(false);
  const account = useRef(null);
  const alive = useRef(true);
  const operation = useRef('');
  const setBusy = (value) => { operation.current = value; setBusyState(value); };

  const loadRepos = async (next = 1) => {
    setBusy('repos');
    setError('');
    try {
      const result = await duo.github.repositories(next);
      if (!alive.current) return;
      setRepos((old) => next === 1 ? result.repositories : [...old, ...result.repositories.filter((r) => !old.some((x) => x.fullName === r.fullName))]);
      setPage(next);
      setHasMore(result.hasMore);
    } catch (err) { if (alive.current) setError(errorText(err)); }
    finally { if (alive.current) setBusy(''); }
  };
  const check = async () => {
    if (checking.current || operation.current) return;
    checking.current = true;
    setBusy('status');
    setError('');
    try {
      const result = await duo.github.status();
      if (!alive.current) return;
      setStatus(result);
      if (account.current !== result.login) { setRepos([]); setRepository(''); setPage(0); setHasMore(false); }
      account.current = result.login;
      if (result.authenticated) { setNote(''); await loadRepos(); }
    } catch (err) { if (alive.current) setError(errorText(err)); }
    finally { checking.current = false; if (alive.current) setBusy(''); }
  };
  useEffect(() => {
    check();
    const focus = () => !checking.current && !operation.current && check();
    window.addEventListener('focus', focus);
    return () => { alive.current = false; window.removeEventListener('focus', focus); };
  }, []);
  const login = async () => {
    setError('');
    try {
      await duo.github.login();
      setNote('Завершите вход в открывшейся консоли и браузере, затем нажмите «Проверить вход».');
    } catch (err) { setError(errorText(err)); }
  };
  const clone = async () => {
    if (operation.current) return;
    setBusy('clone');
    setError('');
    setNote('');
    try {
      const project = await duo.github.clone(repository.trim(), parent.trim());
      if (!alive.current) return;
      setNote(`Проект «${project.name}» добавлен. Выберите его в боковой панели и начните чат.`);
      setRepository('');
      onImported && onImported(project);
    } catch (err) { if (alive.current) setError(errorText(err)); }
    finally { if (alive.current) setBusy(''); }
  };
  const matches = repos.filter((r) => `${r.fullName} ${r.description}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div class="github-panel">
      <p class="field-hint">Подключите GitHub, выберите репозиторий и скачайте его в папку компьютера. Он появится среди проектов DuoCode и будет доступен в Telegram.</p>
      {!status && <p class="muted" role="status">Проверка GitHub CLI…</p>}
      {status && <div class="github-account">
        <Icon name="branch" size={20} />
        <span>{status.authenticated ? <><b>@{status.login}</b><small>GitHub подключён через gh</small></> : <><b>{status.installed ? 'Войдите в GitHub' : 'Нужен GitHub CLI'}</b><small>{status.installed ? 'Учётные данные хранит gh' : 'Установите gh и перезапустите DuoCode'}</small></>}</span>
        {status.installed && <button class="btn small" disabled={!!busy} onClick={login}>{status.authenticated ? 'Сменить аккаунт' : 'Подключить GitHub'}</button>}
        <button class="btn small" disabled={!!busy} onClick={check}>Проверить вход</button>
      </div>}
      {status && !status.installed && <div class="remote-box pad">
        <p><a href="https://cli.github.com/" target="_blank" rel="noreferrer">Установить GitHub CLI</a></p>
        {duo.platform === 'win32' && <code>winget install --id GitHub.cli -e</code>}
        {duo.platform === 'darwin' && <code>brew install gh</code>}
      </div>}
      {status && !status.git && <p class="error-box">Для клонирования нужен <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">Git</a>. После установки перезапустите DuoCode.</p>}
      {status && status.installed && !status.authenticated && status.error && <div class="field-hint github-cli-error">{status.error}</div>}
      {status && status.authenticated && <>
        <div class="field">
          <label>Репозитории GitHub</label>
          <input class="text-input" type="search" placeholder="Поиск среди загруженных репозиториев" value={query} onInput={(e) => setQuery(e.target.value)} />
          <div class="github-repos" aria-label="Репозитории GitHub">
            {!matches.length && <div class="muted pad">{busy === 'repos' ? 'Загрузка…' : repos.length ? 'Ничего не найдено. Можно указать ссылку ниже.' : 'Нет доступных репозиториев. Можно указать ссылку ниже.'}</div>}
            {matches.map((r) => <button key={r.fullName} class={`github-repo ${repository === r.fullName ? 'active' : ''}`} disabled={!!busy} onClick={() => setRepository(r.fullName)} aria-pressed={repository === r.fullName}>
              <Icon name="branch" size={15} /><span><b>{r.fullName}</b>{r.description && <small>{r.description}</small>}</span><small>{r.private ? 'Приватный' : 'Публичный'}</small>
            </button>)}
          </div>
          {hasMore && <button class="btn small" disabled={!!busy} onClick={() => loadRepos(page + 1)}>Загрузить ещё</button>}
        </div>
        <div class="field">
          <label>Репозиторий или ссылка</label>
          <input class="text-input" value={repository} disabled={busy === 'clone'} onInput={(e) => setRepository(e.target.value)} placeholder="owner/repo или https://github.com/owner/repo" />
        </div>
        <div class="field">
          <label>Куда клонировать</label>
          <div class="github-destination">
            <input class="text-input" value={parent} disabled={busy === 'clone'} onInput={(e) => setParent(e.target.value)} placeholder="Родительская папка на компьютере" />
            <button class="btn" disabled={!!busy} onClick={async () => {
              try { const picked = await duo.pickProject(); if (picked) setParent(picked); }
              catch (err) { setError(errorText(err)); }
            }}><Icon name="folder" size={15} />Выбрать…</button>
          </div>
          <div class="field-hint">Внутри появится новая папка с именем репозитория. В ней будут работать агенты; изменения можно коммитить и отправлять через панель «Изменения».</div>
        </div>
        <button class="btn primary" disabled={!!busy || !status.git || !repository.trim() || !parent.trim()} onClick={clone}>
          <Icon name="plus" size={15} />{busy === 'clone' ? 'Клонирование…' : 'Клонировать и добавить проект'}
        </button>
      </>}
      {busy === 'clone' && <p class="field-hint" role="status">Клонирование может занять несколько минут. Не закрывайте DuoCode.</p>}
      {error && <div class="error-box" role="alert">{error}</div>}
      {note && <p class="field-hint" role="status">{note}</p>}
    </div>
  );
}

export function GitHubModal({ onClose, onImported }) {
  return <div class="modal-back"><div class="modal settings-modal">
    <div class="modal-head"><h2>Проект из GitHub</h2><button class="icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="x" size={16} /></button></div>
    <GitHubPanel onImported={(project) => { onImported(project); onClose(); }} />
  </div></div>;
}
