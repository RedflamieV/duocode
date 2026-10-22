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

// Ссылка агента на файл на компьютере: [README](C:\proj\README.md), [код](/c:/proj/src/a.ts:12),
// [патч](file:///…), [файл](src/app.js#L40). Номер строки отбрасываем, путь от папки проекта достраиваем.
function localLink(href) {
  if (!href || /^(https?|mailto|tel|data|blob|javascript|vbscript|tg):/i.test(href) || href.startsWith('#')) return null;
  let p = href.replace(/^file:\/\//i, ''); // file:///home/… → /home/…, file:///C:/… → /C:/…
  try {
    p = decodeURI(p);
  } catch {}
  p = p.replace(/#L?\d+(-L?\d+)?$/i, '').replace(/:(\d+)(:\d+)?$/, '');
  if (/^\/[a-zA-Z]:[\\/]/.test(p)) p = p.slice(1); // /C:/… → C:/…
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) return p;
  if (!base || !/[\\/.]/.test(p)) return null;
  const sep = base.includes('\\') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sep + p.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep);
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    if (node.__file) {
      // открывает DuoCode (см. attachments.jsx): программой по умолчанию, исполняемые — только в папке
      node.setAttribute('data-file', node.__file);
      node.setAttribute('href', '#');
      node.setAttribute('title', node.__file);
      node.classList.add('file-link');
    } else {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noreferrer');
    }
  }
  if (node.tagName === 'IMG') {
    // адрес собран нами (см. ниже), поэтому ставим его уже после проверки DOMPurify
    if (node.__localSrc) node.setAttribute('src', node.__localSrc);
    // Картинку из интернета сами не грузим: обманутый вредным файлом агент мог бы вписать в её адрес
    // секреты, и запрос унёс бы их на чужой сервер. Загрузка — только по нажатию.
    else if (/^https?:/i.test(node.getAttribute('src') || '')) {
      node.setAttribute('data-remote', node.getAttribute('src'));
      node.removeAttribute('src');
    }
    node.setAttribute('loading', 'lazy');
  }
});

// Всё, чем страница могла бы сама сходить в интернет без нажатия (стили с фоном, srcset, видео, аудио, формы),
// из ответов агентов убираем.
const PURIFY = {
  FORBID_TAGS: ['style', 'link', 'video', 'audio', 'source', 'track', 'picture', 'iframe', 'object', 'embed', 'form', 'input', 'svg', 'math'],
  FORBID_ATTR: ['style', 'srcset', 'poster', 'background', 'action', 'formaction', 'ping'],
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function remoteButtons(html) {
  return html.replace(/<img[^>]*?data-remote="([^"]*)"[^>]*>/g, (_m, src) => {
    const url = src.replace(/&amp;/g, '&');
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      return '';
    }
    return `<button type="button" class="remote-img" data-src="${esc(url)}" title="${esc(url)}">Загрузить картинку с ${esc(host)}</button>`;
  });
}

// Путь вроде C:\... или file:... DOMPurify отбросила бы как неизвестную схему — запоминаем
// готовый адрес до проверки и ставим его после.
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (node.tagName === 'A' && data.attrName === 'href') {
    const file = localLink(data.attrValue);
    if (file) node.__file = file;
    return;
  }
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
  const html = remoteButtons(DOMPurify.sanitize(marked.parse(text), PURIFY));
  base = '';
  if (cache.size > 400) cache.clear();
  cache.set(key, html);
  return html;
}
