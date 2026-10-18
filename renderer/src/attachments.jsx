import { useState, useEffect } from 'preact/hooks';
import { Icon } from './icons.jsx';

export const fileUrl = (p) => 'file:///' + encodeURI(p.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23');
// В окне DuoCode картинки берутся прямо с диска, в мини-приложении — с компьютера через API (shim.js)
export const imageUrl = (p) => (window.duoImageUrl ? window.duoImageUrl(p) : fileUrl(p));
export const isImage = (p) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p || '');

// Полноэкранный просмотр: по щелчку на любую картинку в чате (вложения, ответы агентов, скриншоты).
export function Lightbox() {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    const onClick = (e) => {
      const img = e.target.closest && e.target.closest('.md img, .zoomable');
      if (!img || !img.src) return;
      e.preventDefault();
      e.stopPropagation();
      setSrc(img.src);
    };
    const onKey = (e) => e.key === 'Escape' && setSrc(null);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  if (!src) return null;
  return (
    <div class="lightbox" onClick={() => setSrc(null)}>
      <img src={src} alt="" />
      <button class="lightbox-x" title="Закрыть (Esc)">
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}

export function Attachments({ items, onRemove }) {
  if (!items.length) return null;
  // в отправленном сообщении картинки показываем целиком, в поле ввода — компактными значками
  if (!onRemove && items.some((a) => a.image)) {
    const photos = items.filter((a) => a.image);
    const files = items.filter((a) => !a.image);
    return (
      <>
        <div class={`photos ${photos.length === 1 ? 'single' : ''}`}>
          {photos.map((a) => (
            <img key={a.path} class="zoomable photo" src={imageUrl(a.path)} alt={a.name} title={a.name} loading="lazy" />
          ))}
        </div>
        {files.length > 0 && <Attachments items={files} />}
      </>
    );
  }
  return (
    <div class="attachments">
      {items.map((a, i) => (
        <span class={`attachment ${a.image ? 'image' : ''}`} key={a.path} title={a.path}>
          {a.image ? <img class="zoomable" src={imageUrl(a.path)} alt="" /> : <Icon name="read" size={14} />}
          <span class="attachment-name">{a.name}</span>
          {onRemove && (
            <button class="attachment-x" onClick={() => onRemove(i)} title="Убрать">
              <Icon name="x" size={12} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
