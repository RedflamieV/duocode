import { createContext } from 'preact';

// Настройки внешнего вида, которые нужны глубоко в дереве (сообщения, поле ввода).
export const DEFAULT_PREFS = {
  theme: 'system',
  fontSize: 14,
  chatWidth: 'normal',
  density: 'comfortable',
  codeFont: 'auto',
  steps: 'detailed',
  expandThinking: false,
  sendKey: 'enter',
  showCost: true,
  motion: 'full', // анимации: full — яркие, subtle — спокойные, off — выключены
};

export const PrefsContext = createContext(DEFAULT_PREFS);

const WIDTHS = { narrow: '720px', normal: '860px', wide: '1100px', full: '100%' };
const CODE_FONTS = {
  auto: null,
  cascadia: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  consolas: 'Consolas, "Courier New", monospace',
  jetbrains: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  fira: '"Fira Code", "Cascadia Code", Consolas, monospace',
};

export function applyPrefs(p) {
  const root = document.documentElement;
  // при смене темы цвета плавно перетекают
  if (root.dataset.theme && root.dataset.theme !== p.theme && p.motion !== 'off') {
    root.classList.add('theme-switching');
    clearTimeout(applyPrefs.themeTimer);
    applyPrefs.themeTimer = setTimeout(() => root.classList.remove('theme-switching'), 450);
  }
  root.dataset.theme = p.theme;
  // «яркие» анимации смягчаются, если в системе включено «уменьшить движение»
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.dataset.motion = p.motion === 'full' && reduce ? 'subtle' : p.motion || 'full';
  root.dataset.density = p.density;
  root.style.setProperty('--font-size', `${p.fontSize}px`);
  root.style.setProperty('--chat-width', WIDTHS[p.chatWidth] || WIDTHS.normal);
  if (CODE_FONTS[p.codeFont]) root.style.setProperty('--mono', CODE_FONTS[p.codeFont]);
  else root.style.removeProperty('--mono');
}
