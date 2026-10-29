import { BUILTIN_THEMES, ANIME_THEMES, getTheme } from '../../src/themes.js';
import { Icon } from './icons.jsx';

const sceneUrl = (id) => `../assets/themes/${id}.svg`;

export function ThemePicker({ value, onChange }) {
  return (
    <div class="field theme-picker">
      <label id="theme-label">Тема</label>
      <div class="themes" role="group" aria-labelledby="theme-label">
        {BUILTIN_THEMES.map((theme) => (
          <button type="button" key={theme.id} class={`theme-card ${value === theme.id ? 'active' : ''}`}
            aria-pressed={value === theme.id} onClick={() => onChange(theme.id)}>
            <span class="theme-swatch" aria-hidden="true"
              style={{ background: `linear-gradient(135deg, ${theme.swatch[0]} 50%, ${theme.swatch[1]} 50%)` }}>
              <i class="claude" /><i class="codex" />
            </span>
            {theme.name}
          </button>
        ))}
      </div>
      <div class="theme-collection-heading">
        <span id="anime-theme-label"><Icon name="sparkles" size={15} /> Аниме-коллекция</span>
        <small>8 маленьких миров</small>
      </div>
      <div class="themes anime-themes" role="group" aria-labelledby="anime-theme-label">
        {ANIME_THEMES.map((theme) => (
          <button type="button" key={theme.id}
            class={`theme-card anime-theme-card ${value === theme.id ? 'active' : ''}`}
            aria-pressed={value === theme.id} onClick={() => onChange(theme.id)}
            style={{ '--card-accent': theme.palette.primary, '--card-bg': theme.palette.panel,
              '--card-ink': theme.palette.text, '--card-muted': theme.palette.muted }}>
            <span class="anime-theme-art" aria-hidden="true">
              <img src={sceneUrl(theme.id)} alt="" loading="lazy" />
              <span class="theme-mode">{theme.base === 'light' ? 'Светлая' : 'Тёмная'}</span>
              {value === theme.id && <span class="theme-selected"><Icon name="check" size={14} /></span>}
            </span>
            <span class="theme-caption">
              <b>{theme.name}</b>
              <small>{theme.description}</small>
              <span class="theme-palette" aria-hidden="true">
                {[theme.palette.bg, theme.palette['border-strong'], theme.palette.primary,
                  theme.palette.claude, theme.palette.codex].map((color) => <i key={color} style={{ background: color }} />)}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div class="field-hint">Иллюстрации работают без интернета. Эффекты следуют настройке «Анимации».</div>
    </div>
  );
}

// Только декорации: не участвуют в сетке, фокусе и обработке указателя.
export function ThemeBackdrop({ theme: id }) {
  const theme = getTheme(id);
  if (!theme?.scene) return null;
  return (
    <div key={id} class={`theme-atmosphere effect-${theme.effect}`} aria-hidden="true">
      <img class="theme-landscape" src={sceneUrl(theme.scene)} alt="" />
      <div class="theme-veil" />
      <div class="theme-particles">
        {Array.from({ length: theme.effect === 'rain' ? 18 : 12 }, (_, i) => (
          <i key={i} style={{ '--i': i, '--x': `${(i * 37 + 9) % 100}%`, '--y': `${(i * 23 + 17) % 100}%`,
            '--delay': `${-i * 1.7}s`, '--duration': `${12 + i % 5 * 3}s` }} />
        ))}
      </div>
    </div>
  );
}
