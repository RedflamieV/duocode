import { useState, useEffect, useRef } from 'preact/hooks';
import { Icon } from '../src/icons.jsx';
import { imageUrl } from '../src/attachments.jsx';

const duo = window.duo;
const size = (n) => n < 1024 ? `${n} Б` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`;

export function FileBrowser({ request, onClose }) {
  const [roots, setRoots] = useState([]);
  const [listing, setListing] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const load = async (action) => {
    const id = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await action();
      if (id !== generation.current) return;
      if (result.entries) { setListing(result); setFile(null); }
      else setFile(result);
    } catch (err) { if (id === generation.current) setError(err.message); }
    finally { if (id === generation.current) setBusy(false); }
  };
  const browse = (dir) => load(() => duo.listFiles(dir));
  const open = (cwd, path) => load(() => duo.readFile(cwd, path));
  useEffect(() => {
    if (request.file) open(request.cwd || '', request.file);
    else if (request.roomId) {
      load(async () => {
        const folders = await duo.fileRoots(request.roomId);
        setRoots(folders);
        if (!folders.length) throw new Error('У чата нет папки');
        return duo.listFiles(folders[0].path);
      });
    }
    const key = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => { generation.current++; window.removeEventListener('keydown', key); };
  }, []);

  return (
    <div class="m-files-back">
      <section class="m-files" role="dialog" aria-modal="true" aria-label="Файлы компьютера">
        <div class="modal-head">
          <h2>Файлы компьютера</h2>
          <button class="icon-btn" onClick={onClose} aria-label="Закрыть файлы"><Icon name="x" size={18} /></button>
        </div>
        {roots.length > 1 && <div class="m-file-roots">{roots.map((root) => (
          <button key={root.path} class="btn small" disabled={busy} onClick={() => browse(root.path)}><Icon name="folder" size={13} />{root.name}</button>
        ))}</div>}
        <div class="m-file-toolbar">
          {file ? <>
            <button class="btn small" disabled={busy} onClick={() => listing ? setFile(null) : browse(file.path.replace(/[\\/][^\\/]+$/, ''))}><Icon name="left" size={14} />К папке</button>
            <span class="spacer" />
            <button class="btn small" disabled={busy} onClick={async () => {
              try { await duo.downloadFile(file); }
              catch (err) { setError(err.message); }
            }}><Icon name="down" size={14} />Скачать</button>
          </> : listing && <button class="btn small" disabled={busy || !listing.parent} onClick={() => browse(listing.parent)}><Icon name="up" size={14} />Выше</button>}
        </div>
        <div class="m-file-path">{file ? file.path : listing ? listing.path : 'Папка проекта'}</div>
        {file && <div class="field-hint m-file-meta">{file.name} · {size(file.size)}</div>}
        {busy && <div class="muted pad" role="status">Загрузка с компьютера…</div>}
        {error && <div class="error-box" role="alert">{error}</div>}
        <div class="m-file-content">
          {!busy && file && <>
            {file.kind === 'text' && <pre class="m-file-text">{file.text || '(пустой файл)'}</pre>}
            {file.kind === 'image' && <img class="m-file-image zoomable" src={imageUrl(file.path)} alt={file.name} />}
            {file.kind === 'binary' && <p class="muted pad">Для этого формата нет предпросмотра. Скачайте файл, чтобы открыть его на телефоне.</p>}
            {file.truncated && <p class="field-hint pad">Показано начало большого файла. Полную версию можно скачать.</p>}
          </>}
          {!busy && !file && listing && <>
            {!listing.entries.length && <div class="muted pad">Папка пуста</div>}
            {listing.entries.map((entry) => <button key={entry.path} class="m-file-row" onClick={() => entry.directory ? browse(entry.path) : open('', entry.path)}>
              <Icon name={entry.directory ? 'folder' : 'read'} size={17} /><span>{entry.name}</span><Icon name="right" size={13} />
            </button>)}
            {listing.truncated && <p class="field-hint pad">Показаны первые 2000 элементов папки.</p>}
          </>}
        </div>
      </section>
    </div>
  );
}
