// Общие пути и запуск внешних CLI (claude, codex) на всех ОС.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const isWin = process.platform === 'win32';

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function codexDir() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function userShell() {
  if (isWin) return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

// Приложения, запущенные из Finder/дока или до установки CLI, видят неполный PATH.
// Добавляем PATH из login-shell и стандартные папки установки claude и codex.
function fixPath() {
  const home = os.homedir();
  let extra;
  if (isWin) {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    extra = [
      path.join(home, '.local', 'bin'),
      path.join(local, 'Programs', 'codex'),
      path.join(local, 'Programs', 'claude'),
      path.join(roaming, 'npm'),
    ];
  } else {
    try {
      const out = execFileSync(userShell(), ['-ilc', 'printf "__DUO__%s__DUO__" "$PATH"'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/__DUO__(.*)__DUO__/);
      if (m && m[1]) process.env.PATH = m[1];
    } catch {
      // оставляем PATH как есть
    }
    extra = [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  }
  const parts = (process.env.PATH || '').split(path.delimiter);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  process.env.PATH = parts.join(path.delimiter);
}

// Ищем исполняемый файл в PATH. На Windows предпочитаем .exe, потом обёртки npm (.cmd).
function resolveCommand(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const exts = isWin ? ['.exe', '.cmd', '.bat', '.com', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir.replace(/"/g, ''), cmd + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

// spawn с поддержкой .cmd-обёрток npm на Windows (их нельзя запустить без cmd.exe).
function spawnTool(cmd, args, opts = {}) {
  const resolved = resolveCommand(cmd);
  if (!resolved) {
    const err = new Error(`Не найдена команда «${cmd}»`);
    err.code = 'ENOENT';
    throw err;
  }
  if (isWin && /\.(cmd|bat)$/i.test(resolved)) {
    const quote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    const line = [quote(resolved), ...args.map(quote)].join(' ');
    return spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      ...opts,
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }
  return spawn(resolved, args, { ...opts, windowsHide: true });
}

// npm-установка Codex — это Node-обёртка (bin/codex.js), которая запускает настоящий codex(.exe).
// Запускаем бинарник напрямую: иначе Codex умирает вместе с node.exe, когда что-то (например, агент,
// останавливающий свой dev-сервер через «taskkill /IM node.exe /F») завершает все процессы Node.
const TRIPLE = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

function nativeCodex(resolved) {
  const triple = TRIPLE[`${process.platform}-${process.arch}`];
  if (!resolved || !triple || /\.exe$/i.test(resolved)) return null;
  const roots = new Set();
  const add = (root) => {
    if (!root || !fs.existsSync(root)) return;
    roots.add(root);
    try {
      roots.add(fs.realpathSync(root));
    } catch {}
  };
  try {
    // ссылка npm на bin/codex.js (macOS, Linux)
    const real = fs.realpathSync(resolved);
    if (/[\\/]bin[\\/]codex\.js$/.test(real)) add(path.dirname(path.dirname(real)));
  } catch {}
  // обёртка npm на Windows (codex.cmd) лежит рядом с node_modules
  add(path.join(path.dirname(resolved), 'node_modules', '@openai', 'codex'));
  const pkg = `codex-${process.platform}-${process.arch}`;
  const exe = isWin ? 'codex.exe' : 'codex';
  for (const root of roots) {
    const vendors = [path.join(root, 'node_modules', '@openai', pkg, 'vendor'), path.join(path.dirname(root), pkg, 'vendor'), path.join(root, 'vendor')];
    for (const v of vendors) {
      const bin = path.join(v, triple, 'bin', exe);
      if (fs.existsSync(bin)) return { bin, root };
    }
  }
  return null;
}

function spawnCodex(cmd, args, opts = {}) {
  const native = nativeCodex(resolveCommand(cmd));
  if (!native) return spawnTool(cmd, args, opts);
  // те же переменные, что ставит обёртка: по ним Codex подсказывает, как себя обновлять
  const env = { ...(opts.env || process.env), CODEX_MANAGED_PACKAGE_ROOT: native.root, CODEX_MANAGED_BY_NPM: '1' };
  return spawn(native.bin, args, { ...opts, env, windowsHide: true });
}

module.exports = { isWin, claudeDir, codexDir, userShell, fixPath, resolveCommand, spawnTool, spawnCodex, nativeCodex };
