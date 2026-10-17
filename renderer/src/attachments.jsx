import { Icon } from './icons.jsx';

export const fileUrl = (p) => 'file:///' + encodeURI(p.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23');

export function Attachments({ items, onRemove }) {
  if (!items.length) return null;
  return (
    <div class="attachments">
      {items.map((a, i) => (
        <span class={`attachment ${a.image ? 'image' : ''}`} key={a.path} title={a.path}>
          {a.image ? <img src={fileUrl(a.path)} alt="" /> : <Icon name="read" size={14} />}
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
