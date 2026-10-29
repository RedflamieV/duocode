// Общий каталог для окна Electron, настроек и палитры renderer.
const BUILTIN_THEMES = [
  { id: 'system', name: 'Как в системе', swatch: ['#141519', '#f4f4f2'] },
  { id: 'dark', name: 'Тёмная', base: 'dark', swatch: ['#141519', '#1d1f25'], symbolColor: '#c9ccd3' },
  { id: 'light', name: 'Светлая', base: 'light', swatch: ['#f4f4f2', '#ffffff'], symbolColor: '#3b3d42' },
  { id: 'midnight', name: 'Полночь', base: 'dark', swatch: ['#0d1117', '#161b22'], symbolColor: '#c9d1d9' },
  { id: 'graphite', name: 'Графит', base: 'dark', swatch: ['#1e1e1e', '#2a2a2b'], symbolColor: '#cccccc' },
  { id: 'sepia', name: 'Сепия', base: 'light', swatch: ['#f5efe3', '#fbf7ef'], symbolColor: '#3b3226' },
  { id: 'paper', name: 'Бумага', base: 'light', swatch: ['#ffffff', '#f7f7f7'], symbolColor: '#333333' },
];

function palette({ surfaces, lines, ink, accent, claude, codex, light }) {
  const warn = light ? '#94601c' : '#efc078';
  const danger = light ? '#b53f51' : '#fb98a3';
  return {
    bg: surfaces[0], sidebar: surfaces[1], panel: surfaces[2], 'panel-2': surfaces[3],
    hover: surfaces[4], 'code-bg': surfaces[5], border: lines[0], 'border-strong': lines[1],
    text: ink[0], muted: ink[1], faint: ink[2],
    claude, 'claude-soft': `${claude}1c`, codex, 'codex-soft': `${codex}1c`,
    warn, 'warn-soft': `${warn}1c`, danger, 'danger-soft': `${danger}1c`,
    primary: accent, 'primary-text': light ? '#ffffff' : surfaces[0],
    shadow: light ? '0 12px 36px #30244214' : '0 12px 36px #00000040',
    'theme-accent': accent, 'theme-glow': `${accent}26`,
  };
}

const ANIME_THEMES = [
  {
    id: 'last-train', name: 'Последний поезд к морю', base: 'light',
    description: 'Персиковый закат · лавандовые тени', effect: 'horizon',
    palette: palette({
      surfaces: ['#f6e9e8', '#eee1e5', '#fff8f4', '#f7efef', '#e9dce5', '#f1e5e8'],
      lines: ['#ddcbd4', '#c4a6b9'], ink: ['#3f314a', '#766077', '#806b80'],
      accent: '#825477', claude: '#b55e46', codex: '#3c7778', light: true,
    }),
  },
  {
    id: 'dream-jellies', name: 'Медузы во сне', base: 'dark',
    description: 'Ночной океан · бирюзовое свечение', effect: 'bubbles',
    palette: palette({
      surfaces: ['#0c1b30', '#0e2037', '#142a43', '#19324e', '#203e59', '#091626'],
      lines: ['#28445e', '#3e627c'], ink: ['#def5f7', '#9cbfcf', '#85a9be'],
      accent: '#88dfdf', claude: '#f1abc8', codex: '#70d4c6',
    }),
  },
  {
    id: 'witch-teahouse', name: 'Чайная маленькой ведьмы', base: 'light',
    description: 'Шалфей · сливочный чай · заклинания', effect: 'steam',
    palette: palette({
      surfaces: ['#f2efe2', '#e5e8d9', '#fffcf1', '#f0f0e3', '#dfe5d3', '#ebeade'],
      lines: ['#d2d6c0', '#aab698'], ink: ['#354b3c', '#62765d', '#6f7b60'],
      accent: '#4d7057', claude: '#a4653e', codex: '#42745e', light: true,
    }),
  },
  {
    id: 'moon-shrine', name: 'Лунное святилище', base: 'dark',
    description: 'Серебряная луна · индиго · тории', effect: 'fireflies',
    palette: palette({
      surfaces: ['#17162d', '#1c1935', '#25213e', '#2c2748', '#383053', '#111023'],
      lines: ['#3b3356', '#5c4d78'], ink: ['#f0eafa', '#bab0d1', '#a397bb'],
      accent: '#c2acf1', claude: '#edabac', codex: '#a8cfc8',
    }),
  },
  {
    id: 'summer-tape', name: 'Лето на старой кассете', base: 'light',
    description: 'Аниме 90-х · облака · морской бриз', effect: 'grain',
    palette: palette({
      surfaces: ['#edf3ed', '#e0eae5', '#fffcf2', '#edf2e9', '#dce8e2', '#e6ede7'],
      lines: ['#cbdcd3', '#a0beb4'], ink: ['#334d51', '#5e7878', '#6a7d7b'],
      accent: '#396f7a', claude: '#ae6446', codex: '#397a68', light: true,
    }),
  },
  {
    id: 'neon-rain', name: 'Неоновый дождь', base: 'dark',
    description: 'Ночные улицы · неон · мокрое стекло', effect: 'rain',
    palette: palette({
      surfaces: ['#191321', '#201728', '#2b1e34', '#34253f', '#432e4d', '#130e1c'],
      lines: ['#49324f', '#70466e'], ink: ['#f6e6f3', '#c6a6c2', '#b290b0'],
      accent: '#ef9bd2', claude: '#f4abbd', codex: '#77d8d2',
    }),
  },
  {
    id: 'cloud-post', name: 'Письма с облачного острова', base: 'light',
    description: 'Небесная почта · открытки · латунь', effect: 'clouds',
    palette: palette({
      surfaces: ['#eaf2f6', '#dfeaf0', '#fffdf5', '#edf3f6', '#dce8ef', '#e4edf2'],
      lines: ['#c7d9e2', '#9db8c9'], ink: ['#324d61', '#5c788b', '#6b7e8d'],
      accent: '#466e8b', claude: '#a36a3e', codex: '#3f7e79', light: true,
    }),
  },
  {
    id: 'winter-cafe', name: 'Полночь в зимнем кафе', base: 'dark',
    description: 'Черничная ночь · янтарный свет · снег', effect: 'snow',
    palette: palette({
      surfaces: ['#1a2032', '#202639', '#2b3042', '#33394d', '#40465a', '#141a2a'],
      lines: ['#42485d', '#636a80'], ink: ['#f4ecdf', '#c5bba9', '#b0aa9e'],
      accent: '#e9bd85', claude: '#e8b09d', codex: '#a5c9bd',
    }),
  },
].map((theme) => ({
  ...theme, scene: theme.id, swatch: [theme.palette.bg, theme.palette.panel],
  symbolColor: theme.palette.text,
}));

const THEMES = [...BUILTIN_THEMES, ...ANIME_THEMES];
const byId = new Map(THEMES.map((theme) => [theme.id, theme]));

module.exports = { BUILTIN_THEMES, ANIME_THEMES, THEMES, getTheme: (id) => byId.get(id) };
