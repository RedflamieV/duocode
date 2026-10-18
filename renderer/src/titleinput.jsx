import { useState, useRef } from 'preact/hooks';

// Поле для переименования чата: Enter или уход фокуса — сохранить, Escape — отменить.
export function TitleInput({ value, onSave, onDone, class: cls = 'title-input' }) {
  const [text, setText] = useState(value);
  const cancelled = useRef(false);
  const commit = () => {
    const t = text.trim();
    if (!cancelled.current && t && t !== value) onSave(t);
    onDone();
  };
  return (
    <input
      class={cls}
      value={text}
      maxLength={80}
      autoFocus
      spellcheck={false}
      onFocus={(e) => e.target.select()}
      onInput={(e) => setText(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.target.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          e.target.blur();
        }
      }}
    />
  );
}
