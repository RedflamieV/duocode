// Лимиты Codex: спрашиваем у `codex app-server` (account/rateLimits/read),
// а если не вышло — берём последний снимок rate_limits из логов сессий.
const { latestCodexRateLimits } = require('./history');

function windowLabel(mins, fallback) {
  if (!mins) return fallback;
  if (mins <= 24 * 60) return `${Math.round(mins / 60)}ч`;
  const days = Math.round(mins / (24 * 60));
  return days === 7 ? 'Неделя' : `${days}д`;
}

// resetsAt приходит в unix-секундах; на всякий случай понимаем и миллисекунды.
function toIso(ts) {
  if (ts == null) return null;
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

function snapshotWindows(snap, prefix = '') {
  const out = [];
  if (!snap) return out;
  const p = snap.primary;
  const s = snap.secondary;
  if (p) out.push({ label: prefix + windowLabel(p.windowDurationMins, '5ч'), percent: p.usedPercent, resetsAt: toIso(p.resetsAt) });
  if (s) out.push({ label: prefix + windowLabel(s.windowDurationMins, 'Неделя'), percent: s.usedPercent, resetsAt: toIso(s.resetsAt) });
  return out;
}

function parseRateLimits(result) {
  const main = result.rateLimits;
  const windows = snapshotWindows(main);
  const byId = result.rateLimitsByLimitId || {};
  for (const [id, snap] of Object.entries(byId)) {
    if (!snap || (main && snap.limitId === main.limitId) || id === 'codex') continue;
    windows.push(...snapshotWindows(snap, (snap.limitName || id) + ' · '));
  }
  let credits = null;
  if (main && main.credits && main.credits.hasCredits) {
    credits = main.credits.unlimited ? 'безлимит' : main.credits.balance;
  }
  return { windows, plan: (main && main.planType) || null, credits };
}

// server — общий CodexServer приложения (тот же процесс, что ведёт чаты).
async function getCodexLimits(server) {
  try {
    const result = await server.request('account/rateLimits/read');
    return { ok: true, source: 'live', ...parseRateLimits(result), fetchedAt: Date.now() };
  } catch (err) {
    const fromLogs = latestCodexRateLimits();
    if (fromLogs) {
      return { ok: true, source: 'logs', ...fromLogs, note: 'из последней сессии', fetchedAt: Date.now() };
    }
    return { ok: false, error: 'Не удалось получить лимиты Codex: ' + err.message };
  }
}

module.exports = { getCodexLimits, parseRateLimits, windowLabel, toIso };
