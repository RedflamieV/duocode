// Единая история сессий Claude Code и Codex + статистика токенов за сегодня.
// Всё читается из локальных логов: ~/.claude/projects и ~/.codex/sessions.
const fs = require('fs');
const path = require('path');
const { claudeDir, codexDir } = require('./env');

const HEAD_BYTES = 256 * 1024;
const MAX_SESSIONS = 200;

function readHead(file, bytes = HEAD_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function* jsonLines(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* обрезанная строка в конце чанка */ }
  }
}

function listFiles(dir, ext, depth) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...listFiles(p, ext, depth - 1));
    else if (e.isFile() && e.name.endsWith(ext)) {
      try { out.push({ file: p, mtime: fs.statSync(p).mtimeMs }); } catch {}
    }
  }
  return out;
}

function clip(text, n = 140) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ---------- Claude ----------

function claudeUserText(entry) {
  if (entry.type !== 'user' || entry.isMeta || !entry.message) return null;
  const c = entry.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    const part = c.find((p) => p && p.type === 'text' && p.text);
    text = part ? part.text : null;
  }
  if (!text) return null;
  if (/^\s*<(command-|local-command|system-reminder)/.test(text)) return null;
  return text;
}

function claudeSessions() {
  const files = listFiles(path.join(claudeDir(), 'projects'), '.jsonl', 1)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SESSIONS);
  const sessions = [];
  for (const { file, mtime } of files) {
    let cwd = null;
    let title = null;
    let summary = null;
    let startedAt = null;
    let id = path.basename(file, '.jsonl');
    try {
      for (const e of jsonLines(readHead(file))) {
        if (e.type === 'summary' && e.summary && !summary) summary = e.summary;
        if (e.type === 'custom-title' && e.customTitle) summary = e.customTitle;
        if (e.cwd && !cwd) cwd = e.cwd;
        if (e.sessionId) id = e.sessionId;
        if (e.timestamp && !startedAt) startedAt = e.timestamp;
        if (!title) title = claudeUserText(e);
        if (cwd && title && summary) break;
      }
    } catch { continue; }
    if (!title && !summary) continue;
    sessions.push({
      tool: 'claude',
      id,
      cwd,
      title: clip(summary || title),
      startedAt,
      updatedAt: new Date(mtime).toISOString(),
    });
  }
  return sessions;
}

// ---------- Codex ----------

function codexUserText(e) {
  const p = e.payload || {};
  if (e.type === 'event_msg' && p.type === 'user_message' && p.message) return p.message;
  if (e.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
    const part = p.content.find((c) => c && (c.type === 'input_text' || c.type === 'text') && c.text);
    if (part && !/^\s*(<environment_context>|<user_instructions>|# AGENTS\.md)/.test(part.text)) return part.text;
  }
  return null;
}

function codexSessions() {
  const files = listFiles(path.join(codexDir(), 'sessions'), '.jsonl', 3)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_SESSIONS);
  const sessions = [];
  for (const { file, mtime } of files) {
    let id = null;
    let cwd = null;
    let title = null;
    let startedAt = null;
    try {
      for (const e of jsonLines(readHead(file))) {
        if (e.type === 'session_meta' && e.payload) {
          id = e.payload.id || id;
          cwd = e.payload.cwd || cwd;
          startedAt = e.payload.timestamp || e.timestamp || startedAt;
        }
        if (!title) title = codexUserText(e);
        if (id && title) break;
      }
    } catch { continue; }
    if (!id) {
      const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m) id = m[1];
    }
    if (!id || !title) continue;
    sessions.push({
      tool: 'codex',
      id,
      cwd,
      title: clip(title),
      startedAt,
      updatedAt: new Date(mtime).toISOString(),
    });
  }
  return sessions;
}

function allSessions() {
  return [...claudeSessions(), ...codexSessions()].sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
}

// ---------- Статистика за сегодня ----------

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function todayFiles(dir, depth) {
  const since = startOfToday();
  return listFiles(dir, '.jsonl', depth).filter((f) => f.mtime >= since);
}

function claudeToday() {
  const since = startOfToday();
  const seen = new Set();
  const sessions = new Set();
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
  for (const { file } of todayFiles(path.join(claudeDir(), 'projects'), 1)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const e of jsonLines(text)) {
      if (e.type !== 'assistant' || !e.message || !e.message.usage) continue;
      if (!e.timestamp || Date.parse(e.timestamp) < since) continue;
      const key = `${e.message.id}:${e.requestId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const u = e.message.usage;
      t.input += u.input_tokens || 0;
      t.output += u.output_tokens || 0;
      t.cacheRead += u.cache_read_input_tokens || 0;
      t.cacheWrite += u.cache_creation_input_tokens || 0;
      t.messages += 1;
      if (e.sessionId) sessions.add(e.sessionId);
    }
  }
  return { ...t, total: t.input + t.output + t.cacheRead + t.cacheWrite, sessions: sessions.size };
}

function codexToday() {
  const since = startOfToday();
  const t = { input: 0, output: 0, cacheRead: 0, messages: 0, sessions: 0 };
  for (const { file } of todayFiles(path.join(codexDir(), 'sessions'), 3)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let lastTotal = -1;
    let active = false;
    for (const e of jsonLines(text)) {
      const p = e.payload || {};
      if (e.type !== 'event_msg' || p.type !== 'token_count' || !p.info) continue;
      if (!e.timestamp || Date.parse(e.timestamp) < since) continue;
      const total = p.info.total_token_usage && p.info.total_token_usage.total_tokens;
      if (total === lastTotal) continue; // повторный снимок без нового запроса
      lastTotal = total;
      const u = p.info.last_token_usage || {};
      t.input += Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0));
      t.cacheRead += u.cached_input_tokens || 0;
      t.output += u.output_tokens || 0;
      t.messages += 1;
      active = true;
    }
    if (active) t.sessions += 1;
  }
  return { ...t, cacheWrite: 0, total: t.input + t.output + t.cacheRead };
}

// ---------- Запасной источник лимитов Codex ----------

function logWindow(w, fallbackLabel, eventTs) {
  if (!w) return null;
  let resetsAt = null;
  if (w.resets_at != null) resetsAt = new Date(w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000).toISOString();
  else if (w.resets_in_seconds != null && eventTs) resetsAt = new Date(Date.parse(eventTs) + w.resets_in_seconds * 1000).toISOString();
  const mins = w.window_minutes;
  let label = fallbackLabel;
  if (mins) label = mins <= 1440 ? `${Math.round(mins / 60)}ч` : (Math.round(mins / 1440) === 7 ? 'Неделя' : `${Math.round(mins / 1440)}д`);
  return { label, percent: Math.round(w.used_percent), resetsAt };
}

function latestCodexRateLimits() {
  const files = listFiles(path.join(codexDir(), 'sessions'), '.jsonl', 3).sort((a, b) => b.mtime - a.mtime).slice(0, 5);
  for (const { file } of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let found = null;
    for (const e of jsonLines(text)) {
      const p = e.payload || {};
      if (e.type === 'event_msg' && p.type === 'token_count' && p.rate_limits) found = { rl: p.rate_limits, ts: e.timestamp };
    }
    if (found) {
      const windows = [logWindow(found.rl.primary, '5ч', found.ts), logWindow(found.rl.secondary, 'Неделя', found.ts)].filter(Boolean);
      if (windows.length) return { windows, plan: found.rl.plan_type || null, credits: null, asOf: found.ts };
    }
  }
  return null;
}

// ---------- Статистика по дням ----------

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Токены по дням за последние `days` дней: { 'YYYY-MM-DD': { claude, codex } }.
// Читает файлы асинхронно и по одному, чтобы не подвешивать окно.
async function dailyUsage(days = 14) {
  const since = Date.now() - days * 86400000;
  const out = {};
  for (let i = 0; i < days; i++) out[dayKey(Date.now() - i * 86400000)] = { claude: 0, codex: 0 };
  const add = (ts, agent, n) => {
    const k = dayKey(ts);
    if (out[k]) out[k][agent] += n;
  };

  const seen = new Set();
  for (const { file, mtime } of listFiles(path.join(claudeDir(), 'projects'), '.jsonl', 1)) {
    if (mtime < since) continue;
    let text;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const e of jsonLines(text)) {
      if (e.type !== 'assistant' || !e.message || !e.message.usage || !e.timestamp) continue;
      const ts = Date.parse(e.timestamp);
      if (ts < since) continue;
      const key = `${e.message.id}:${e.requestId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const u = e.message.usage;
      add(ts, 'claude', (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
    }
  }

  for (const { file, mtime } of listFiles(path.join(codexDir(), 'sessions'), '.jsonl', 3)) {
    if (mtime < since) continue;
    let text;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let lastTotal = -1;
    for (const e of jsonLines(text)) {
      const p = e.payload || {};
      if (e.type !== 'event_msg' || p.type !== 'token_count' || !p.info || !e.timestamp) continue;
      const ts = Date.parse(e.timestamp);
      if (ts < since) continue;
      const total = p.info.total_token_usage && p.info.total_token_usage.total_tokens;
      if (total === lastTotal) continue;
      lastTotal = total;
      add(ts, 'codex', (p.info.last_token_usage && p.info.last_token_usage.total_tokens) || 0);
    }
  }
  return Object.entries(out)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, v]) => ({ day, ...v }));
}

module.exports = { allSessions, claudeToday, codexToday, latestCodexRateLimits, dailyUsage };
