// Журналы Claude Code (~/.claude/projects) и Codex (~/.codex/sessions): расход токенов за сегодня и по дням,
// запасной источник лимитов Codex и список сессий для «Продолжить из терминала».
//
// Журналы бывают огромными (сессия Codex со скриншотами — сотни мегабайт и больше), поэтому:
// - файл читается кусками по 4 МБ асинхронно, между кусками окно и агенты продолжают работать;
// - журналы только дописываются, поэтому запоминаем, докуда прочитан каждый файл, и дальше читаем
//   лишь дописанное (индекс хранится между запусками);
// - нужные строки ищем прямо в байтах и разбираем только их; гигантские строки (картинки) пропускаем.
const fs = require('fs');
const path = require('path');
const { claudeDir, codexDir } = require('./env');

const KEEP_DAYS = 15; // статистика показывает 14 дней
const CHUNK = 4 * 1024 * 1024;
const MAX_LINE = 32 * 1024 * 1024; // строка длиннее — не расход токенов (картинка и т. п.), пропускаем
const HEAD_BYTES = 256 * 1024;
const MAX_SESSIONS = 200;
const VERSION = 1;

const NL = 10;
const MARK = {
  claude: [Buffer.from('"usage"'), Buffer.from('"assistant"')],
  codex: [Buffer.from('"token_count"')],
};

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const startOfToday = () => new Date().setHours(0, 0, 0, 0);
const tick = () => new Promise((r) => setImmediate(r));

async function listFiles(dir, depth, out = []) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) await listFiles(p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        const st = await fs.promises.stat(p);
        out.push({ file: p, mtime: st.mtimeMs, size: st.size });
      } catch {}
    }
  }
  return out;
}

class Logs {
  constructor(indexFile) {
    this.indexFile = indexFile;
    this.state = null;
    this.scanning = null;
    this.heads = new Map(); // файл -> { size, session } для списка сессий
  }

  load() {
    if (this.state) return;
    try {
      const s = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (s.v === VERSION) this.state = s;
    } catch {}
    if (!this.state) this.state = { v: VERSION, files: {}, claude: {}, codex: {}, codexLimits: null };
  }

  // Дочитать всё новое. Одновременные вызовы ждут один и тот же проход.
  scan() {
    if (!this.scanning) {
      this.scanning = this.doScan().finally(() => {
        this.scanning = null;
      });
    }
    return this.scanning;
  }

  async doScan() {
    this.load();
    const s = this.state;
    const since = Date.now() - KEEP_DAYS * 86400000;
    const lists = {
      claude: await listFiles(path.join(claudeDir(), 'projects'), 1),
      codex: await listFiles(path.join(codexDir(), 'sessions'), 3),
    };
    const alive = new Set();
    for (const kind of ['claude', 'codex']) {
      for (const f of lists[kind]) {
        if (f.mtime < since) continue;
        alive.add(f.file);
        let st = s.files[f.file];
        // файл заменили или укоротили — читаем заново
        if (!st || f.size < st.offset) {
          st = s.files[f.file] = { kind, offset: 0, lastTotal: -1 };
          delete s.codex[f.file];
        }
        if (f.size > st.offset) await this.readNew(f.file, st, f.size);
      }
    }
    // старое и удалённое — из индекса вон
    for (const file of Object.keys(s.files)) if (!alive.has(file)) delete s.files[file];
    for (const file of Object.keys(s.codex)) if (!alive.has(file)) delete s.codex[file];
    const oldDay = dayKey(since);
    for (const [k, e] of Object.entries(s.claude)) if (e[0] < since) delete s.claude[k];
    for (const days of Object.values(s.codex)) for (const d of Object.keys(days)) if (d < oldDay) delete days[d];
    await fs.promises.mkdir(path.dirname(this.indexFile), { recursive: true }).catch(() => {});
    await fs.promises.writeFile(this.indexFile + '.tmp', JSON.stringify(s)).then(() => fs.promises.rename(this.indexFile + '.tmp', this.indexFile)).catch(() => {});
  }

  async readNew(file, st, size) {
    let fh;
    try {
      fh = await fs.promises.open(file, 'r');
    } catch {
      return;
    }
    const marks = MARK[st.kind];
    try {
      let pos = st.offset;
      let pending = [];
      let pendingLen = 0;
      let skipping = false; // внутри гигантской строки — ждём её конца
      while (pos < size) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        const chunk = buf.subarray(0, bytesRead);
        let start = 0;
        let nl;
        while ((nl = chunk.indexOf(NL, start)) >= 0) {
          if (skipping) skipping = false;
          else {
            let line = chunk.subarray(start, nl);
            if (pendingLen) {
              line = Buffer.concat([...pending, line]);
              pending = [];
              pendingLen = 0;
            }
            if (marks.every((m) => line.includes(m))) this.take(st, file, line);
          }
          start = nl + 1;
          st.offset = pos + start; // всё до конца этой строки учтено
        }
        if (start < chunk.length && !skipping) {
          const rest = chunk.subarray(start);
          pendingLen += rest.length;
          if (pendingLen > MAX_LINE) {
            pending = [];
            pendingLen = 0;
            skipping = true;
          } else pending.push(Buffer.from(rest));
        }
        pos += bytesRead;
        await tick();
      }
      // недописанную последнюю строку прочитаем в следующий раз целиком (offset стоит на её начале)
    } finally {
      await fh.close().catch(() => {});
    }
  }

  take(st, file, buf) {
    let e;
    try {
      e = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!e.timestamp) return;
    const ts = Date.parse(e.timestamp);
    if (!ts) return;
    if (st.kind === 'claude') {
      if (e.type !== 'assistant' || !e.message || !e.message.usage) return;
      // одно сообщение пишется строкой на каждый блок, а ответвления сессий копируют историю — считаем один раз
      const key = `${e.message.id}:${e.requestId}`;
      if (this.state.claude[key]) return;
      const u = e.message.usage;
      this.state.claude[key] = [ts, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0, e.sessionId || ''];
      return;
    }
    const p = e.payload || {};
    if (e.type !== 'event_msg' || p.type !== 'token_count') return;
    if (p.rate_limits && (!this.state.codexLimits || e.timestamp > this.state.codexLimits.ts)) this.state.codexLimits = { rl: p.rate_limits, ts: e.timestamp };
    if (!p.info) return;
    const total = p.info.total_token_usage && p.info.total_token_usage.total_tokens;
    if (total === st.lastTotal) return; // повторный снимок без нового запроса
    st.lastTotal = total;
    const u = p.info.last_token_usage || {};
    const days = (this.state.codex[file] = this.state.codex[file] || {});
    const d = (days[dayKey(ts)] = days[dayKey(ts)] || [0, 0, 0, 0]);
    d[0] += Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0));
    d[1] += u.output_tokens || 0;
    d[2] += u.cached_input_tokens || 0;
    d[3] += 1;
  }

  // ---------- Готовые ответы ----------

  async today() {
    await this.scan();
    const since = startOfToday();
    const today = dayKey(since);
    const c = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
    const sessions = new Set();
    for (const [ts, i, o, cr, cw, sid] of Object.values(this.state.claude)) {
      if (ts < since) continue;
      c.input += i;
      c.output += o;
      c.cacheRead += cr;
      c.cacheWrite += cw;
      c.messages += 1;
      if (sid) sessions.add(sid);
    }
    const x = { input: 0, output: 0, cacheRead: 0, messages: 0, sessions: 0 };
    for (const days of Object.values(this.state.codex)) {
      const d = days[today];
      if (!d) continue;
      x.input += d[0];
      x.output += d[1];
      x.cacheRead += d[2];
      x.messages += d[3];
      x.sessions += 1;
    }
    return {
      claude: { ...c, total: c.input + c.output + c.cacheRead + c.cacheWrite, sessions: sessions.size },
      codex: { ...x, cacheWrite: 0, total: x.input + x.output + x.cacheRead },
    };
  }

  // Токены по дням: [{ day, claude, codex }], старые дни первыми.
  async daily(days = 14) {
    await this.scan();
    const out = {};
    for (let i = 0; i < days; i++) out[dayKey(Date.now() - i * 86400000)] = { claude: 0, codex: 0 };
    for (const [ts, i, o, cr, cw] of Object.values(this.state.claude)) {
      const k = dayKey(ts);
      if (out[k]) out[k].claude += i + o + cr + cw;
    }
    for (const byDay of Object.values(this.state.codex)) {
      for (const [k, d] of Object.entries(byDay)) if (out[k]) out[k].codex += d[0] + d[1] + d[2];
    }
    return Object.entries(out)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, v]) => ({ day, ...v }));
  }

  // Последний снимок лимитов Codex из журналов — когда сам Codex их не отдал.
  async codexRateLimits() {
    await this.scan();
    return this.state.codexLimits;
  }

  // ---------- Сессии из терминала ----------

  async sessions() {
    const lists = await Promise.all([listFiles(path.join(claudeDir(), 'projects'), 1), listFiles(path.join(codexDir(), 'sessions'), 3)]);
    const out = [];
    for (const [kind, files] of [['claude', lists[0]], ['codex', lists[1]]]) {
      for (const f of files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS)) {
        let h = this.heads.get(f.file);
        // начало журнала не меняется, когда он длиннее прочитанного куска
        if (!h || (h.size < HEAD_BYTES && h.size !== f.size)) {
          h = { size: f.size, session: await readSession(kind, f.file) };
          this.heads.set(f.file, h);
        }
        if (h.session) out.push({ ...h.session, updatedAt: new Date(f.mtime).toISOString() });
      }
    }
    return out.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  }
}

async function readHead(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close().catch(() => {});
  }
}

function* jsonLines(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // обрезанная строка в конце куска
    }
  }
}

const clip = (text, n = 140) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function claudeUserText(entry) {
  if (entry.type !== 'user' || entry.isMeta || !entry.message) return null;
  const c = entry.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const part = c.find((p) => p && p.type === 'text' && p.text);
    text = part ? part.text : null;
  }
  if (!text || /^\s*<(command-|local-command|system-reminder)/.test(text)) return null;
  return text;
}

function codexUserText(e) {
  const p = e.payload || {};
  if (e.type === 'event_msg' && p.type === 'user_message' && p.message) return p.message;
  if (e.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
    const part = p.content.find((c) => c && (c.type === 'input_text' || c.type === 'text') && c.text);
    if (part && !/^\s*(<environment_context>|<user_instructions>|# AGENTS\.md)/.test(part.text)) return part.text;
  }
  return null;
}

async function readSession(kind, file) {
  let text;
  try {
    text = await readHead(file);
  } catch {
    return null;
  }
  if (kind === 'claude') {
    let cwd = null;
    let title = null;
    let summary = null;
    let startedAt = null;
    let id = path.basename(file, '.jsonl');
    for (const e of jsonLines(text)) {
      if (e.type === 'summary' && e.summary && !summary) summary = e.summary;
      if (e.type === 'custom-title' && e.customTitle) summary = e.customTitle;
      if (e.cwd && !cwd) cwd = e.cwd;
      if (e.sessionId) id = e.sessionId;
      if (e.timestamp && !startedAt) startedAt = e.timestamp;
      if (!title) title = claudeUserText(e);
      if (cwd && title && summary) break;
    }
    return title || summary ? { tool: 'claude', id, cwd, title: clip(summary || title), startedAt } : null;
  }
  let id = null;
  let cwd = null;
  let title = null;
  let startedAt = null;
  for (const e of jsonLines(text)) {
    if (e.type === 'session_meta' && e.payload) {
      id = e.payload.id || id;
      cwd = e.payload.cwd || cwd;
      startedAt = e.payload.timestamp || e.timestamp || startedAt;
    }
    if (!title) title = codexUserText(e);
    if (id && title) break;
  }
  if (!id) {
    const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m) id = m[1];
  }
  return id && title ? { tool: 'codex', id, cwd, title: clip(title), startedAt } : null;
}

module.exports = { Logs, dayKey };
