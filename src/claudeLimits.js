// Лимиты подписки Claude (тот же источник, что и /usage в Claude Code).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { claudeDir } = require('./env');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function readCredentials() {
  const file = path.join(claudeDir(), '.credentials.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // нет файла — на macOS токен лежит в связке ключей
  }
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return JSON.parse(raw.trim());
    } catch {
      // нет записи
    }
  }
  return null;
}

function scopedLabel(l) {
  const model = l.scope && l.scope.model && (l.scope.model.display_name || l.scope.model.name);
  return 'Неделя · ' + (model || 'модель');
}

function parseUsage(json) {
  const windows = [];
  if (Array.isArray(json.limits) && json.limits.length) {
    for (const l of json.limits) {
      if (l == null || l.percent == null) continue;
      let label;
      if (l.kind === 'session') label = 'Сессия (5ч)';
      else if (l.kind === 'weekly_all') label = 'Неделя';
      else if (l.kind === 'weekly_scoped') label = scopedLabel(l);
      else label = l.kind || 'Лимит';
      windows.push({ label, percent: Number(l.percent), resetsAt: l.resets_at || null });
    }
  } else {
    const legacy = [
      ['five_hour', 'Сессия (5ч)'],
      ['seven_day', 'Неделя'],
      ['seven_day_opus', 'Неделя · Opus'],
      ['seven_day_sonnet', 'Неделя · Sonnet'],
    ];
    for (const [key, label] of legacy) {
      const w = json[key];
      if (w && w.utilization != null) {
        windows.push({ label, percent: Number(w.utilization), resetsAt: w.resets_at || null });
      }
    }
  }
  let extra = null;
  const e = json.extra_usage;
  if (e && e.is_enabled) {
    extra = {
      used: e.used_credits,
      limit: e.monthly_limit,
      percent: e.utilization != null ? Number(e.utilization) : null,
    };
  }
  return { windows, extra };
}

async function getClaudeLimits() {
  const creds = readCredentials();
  const oauth = creds && creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    return { ok: false, error: 'Не выполнен вход в Claude.' };
  }
  const plan = oauth.subscriptionType || null;
  // Токен обновляет сам Claude Code; мы его не трогаем, чтобы не сломать его вход.
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) {
    return { ok: false, plan, error: 'Токен Claude истёк — откройте вкладку Claude, он обновится сам.' };
  }
  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { ok: false, plan, error: 'Нет связи с api.anthropic.com: ' + err.message };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, plan, error: 'Токен Claude недействителен — откройте вкладку Claude, он обновится сам.' };
  }
  if (!res.ok) return { ok: false, plan, error: `Claude API ответил ${res.status}` };
  const json = await res.json();
  return { ok: true, plan, ...parseUsage(json), fetchedAt: Date.now() };
}

module.exports = { getClaudeLimits, parseUsage };
