// Markdown агентов → HTML, который понимает Telegram (b, i, s, code, pre, a, blockquote).
// Заголовков, списков и таблиц в Telegram нет: заголовки становятся жирными, списки — строками
// с маркерами, таблицы — моноширинным блоком.
const { Lexer } = require('marked');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s) => esc(s).replace(/"/g, '&quot;');

function inline(tokens = []) {
  return tokens.map(inlineToken).join('');
}

function inlineToken(t) {
  switch (t.type) {
    case 'strong':
      return `<b>${inline(t.tokens)}</b>`;
    case 'em':
      return `<i>${inline(t.tokens)}</i>`;
    case 'del':
      return `<s>${inline(t.tokens)}</s>`;
    case 'codespan':
      return `<code>${esc(t.text)}</code>`;
    case 'br':
      return '\n';
    case 'link':
      return /^(https?|tg):/i.test(t.href) ? `<a href="${attr(t.href)}">${inline(t.tokens)}</a>` : inline(t.tokens);
    case 'image':
      return /^https?:/i.test(t.href) ? `<a href="${attr(t.href)}">${esc(t.text || 'картинка')}</a>` : esc(t.text);
    case 'text':
      return t.tokens ? inline(t.tokens) : esc(t.text);
    default:
      // escape, html и всё незнакомое — как обычный текст
      return esc(t.text != null ? t.text : t.raw);
  }
}

function table(t) {
  const cell = (c) => c.text.replace(/\s+/g, ' ').trim();
  const rows = [t.header.map(cell), ...t.rows.map((r) => r.map(cell))];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] || '').length)));
  const line = (r) => r.map((c, i) => (c || '').padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(rows[0]), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.slice(1).map(line)];
  return `<pre>${esc(out.join('\n'))}</pre>`;
}

function list(t, depth) {
  const pad = '   '.repeat(depth);
  return t.items
    .map((item, i) => {
      const mark = item.task ? (item.checked ? '☑' : '☐') : t.ordered ? `${(Number(t.start) || 1) + i}.` : depth ? '◦' : '•';
      const body = blocks(item.tokens, depth + 1).replace(/\n+$/, '');
      return `${pad}${mark} ${body}`;
    })
    .join('\n');
}

function blocks(tokens = [], depth = 0) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'heading':
        out.push(`<b>${inline(t.tokens)}</b>`);
        break;
      case 'paragraph':
        out.push(inline(t.tokens));
        break;
      case 'text':
        out.push(t.tokens ? inline(t.tokens) : esc(t.text));
        break;
      case 'code': {
        const lang = (t.lang || '').split(/\s/)[0].replace(/[^\w+#-]/g, '');
        out.push(lang ? `<pre><code class="language-${lang}">${esc(t.text)}</code></pre>` : `<pre>${esc(t.text)}</pre>`);
        break;
      }
      case 'blockquote':
        // внутри цитаты Telegram не принимает блоки кода — оставляем только текст
        out.push(`<blockquote>${unpre(blocks(t.tokens, depth))}</blockquote>`);
        break;
      case 'list':
        out.push(list(t, depth));
        break;
      case 'table':
        out.push(table(t));
        break;
      case 'hr':
        out.push('──────────');
        break;
      default:
        out.push(esc(t.raw));
    }
  }
  // вложенные списки идут сразу под пунктом, абзацы разделяет пустая строка
  return out.join(depth ? '\n' : '\n\n');
}

const unpre = (html) => html.replace(/<pre>(?:<code class="[^"]*">)?([\s\S]*?)(?:<\/code>)?<\/pre>/g, '$1');

function toTelegram(md) {
  try {
    return blocks(Lexer.lex(String(md || ''))).trim();
  } catch {
    return esc(md);
  }
}

// Markdown в цитате (например, кусок прошлого ответа): Telegram не пускает блоки кода внутрь цитаты.
function quote(md) {
  return `<blockquote>${unpre(toTelegram(md))}</blockquote>`;
}

// Видимый текст без тегов — запасной вариант, если Telegram не принял разметку.
function plain(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

module.exports = { toTelegram, quote, plain, esc };
