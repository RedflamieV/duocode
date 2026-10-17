import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

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

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer');
  }
});

const cache = new Map();

export function renderMarkdown(text) {
  if (!text) return '';
  const hit = cache.get(text);
  if (hit) return hit;
  const html = DOMPurify.sanitize(marked.parse(text));
  if (cache.size > 400) cache.clear();
  cache.set(text, html);
  return html;
}
