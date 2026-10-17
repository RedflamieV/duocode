const { spawn } = require('child_process');
const crypto = require('crypto');

function clip(text, n = 4000) {
  const t = String(text == null ? '' : text);
  return t.length > n ? t.slice(0, n) + `\n… (ещё ${t.length - n} симв.)` : t;
}

// Упрощённый diff для правок Claude: старые строки с «-», новые с «+».
function simpleDiff(oldStr = '', newStr = '') {
  const minus = oldStr ? oldStr.split('\n').map((l) => '-' + l) : [];
  const plus = newStr ? newStr.split('\n').map((l) => '+' + l) : [];
  return clip([...minus, ...plus].join('\n'), 20000);
}

// Останавливает процесс вместе с дочерними (на Windows .cmd-обёртки запускают node отдельно).
function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32' && proc.pid) {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  } else {
    try {
      proc.kill();
    } catch {}
  }
}

const uid = (prefix = '') => prefix + crypto.randomBytes(6).toString('hex');

module.exports = { clip, simpleDiff, killTree, uid };
