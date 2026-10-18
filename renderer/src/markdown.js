import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { imageUrl } from './attachments.jsx';

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').split(/\s/)[0];
      let html;
      try {
        html = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : escape(text);
      } catch {
        html = escape(text);
      }
      return `<div class="codeblock"><div class="codeblock-head"><span>${escape(language || 'code')}</span><button class="copy-code" type="button">Копировать</button></div><pre><code class="hljs">${html}</code></pre></div>`;
    },
  },
});

// Картинка из ответа агента: ссылку из интернета оставляем, путь на диске (абсолютный или от папки
// проекта) превращаем в адрес, по которому её покажет окно DuoCode или мини-приложение.
let base = '';
function localImage(src) {
  if (!src || /^(https?:|data:|blob:)/i.test(src)) return null;
  let p = src.replace(/^file:\/\/\/?/i, '');
  try {
    p = decodeURI(p);
  } catch {}
  if (/^[a-zA-Z]:[\\/]/.test(p)) return p; // C:\...
  if (/^file:/i.test(src) || p.startsWith('/')) return src.startsWith('file:') && !/^[a-zA-Z]:/.test(p) ? '/' + p.replace(/^\/+/, '') : p;
  if (!base) return null;
  const sep = base.includes('\\') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sep + p.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep);
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer');
  }
  if (node.tagName === 'IMG') {
    // адрес собран нами (см. ниже), поэтому ставим его уже после проверки DOMPurify
    if (node.__localSrc) node.setAttribute('src', node.__localSrc);
    node.setAttribute('loading', 'lazy');
  }
});

// Путь вроде C:\... или file:... DOMPurify отбросила бы как неизвестную схему — запоминаем
// готовый адрес до проверки и ставим его после.
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (node.tagName !== 'IMG' || data.attrName !== 'src') return;
  const local = localImage(data.attrValue);
  if (local) node.__localSrc = imageUrl(local);
});

const cache = new Map();

// cwd — папка проекта: от неё считаются относительные пути картинок в ответе
export function renderMarkdown(text, cwd = '') {
  if (!text) return '';
  const key = cwd + '\0' + text;
  const hit = cache.get(key);
  if (hit) return hit;
  base = cwd;
  const html = DOMPurify.sanitize(marked.parse(text));
  base = '';
  if (cache.size > 400) cache.clear();
  cache.set(key, html);
  return html;
}
