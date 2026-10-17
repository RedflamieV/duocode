// Работа с git: снимки проекта для отката правок, панель изменений, отдельные копии проекта для «дуэли».
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const AUTHOR = {
  GIT_AUTHOR_NAME: 'DuoCode',
  GIT_AUTHOR_EMAIL: 'duocode@localhost',
  GIT_COMMITTER_NAME: 'DuoCode',
  GIT_COMMITTER_EMAIL: 'duocode@localhost',
};

function git(args, { cwd, env, input, buffer = false, timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...env }, maxBuffer: 256 * 1024 * 1024, timeout, windowsHide: true, encoding: buffer ? 'buffer' : 'utf8' },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr: String(stderr || ''), missing: err && err.code === 'ENOENT' });
      },
    );
    if (input != null) child.stdin.end(input);
  });
}

async function hasGit() {
  const r = await git(['--version']);
  return r.code === 0;
}

async function isRepo(cwd) {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

// Очередь на папку: git не любит параллельные операции с одним индексом.
const locks = new Map();
function serial(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

const EXCLUDE = ['.git/', '.duocode/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', 'dist/', 'build/', 'target/', '.next/', '.duocode/worktrees/', '*.log'];

// ---------- Снимки для отката (отдельный «теневой» репозиторий, проект не трогаем) ----------

class Checkpoints {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.available = null;
  }

  async ready() {
    if (this.available === null) this.available = await hasGit();
    return this.available;
  }

  async repo(cwd) {
    const dir = path.join(this.baseDir, crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16));
    if (!fs.existsSync(path.join(dir, 'HEAD'))) {
      fs.mkdirSync(dir, { recursive: true });
      await git(['init', '--bare', '-q', dir]);
      await git(['--git-dir', dir, 'config', 'gc.auto', '0']);
      await git(['--git-dir', dir, 'config', 'core.autocrlf', 'false']);
      await git(['--git-dir', dir, 'config', 'core.quotepath', 'false']);
      fs.mkdirSync(path.join(dir, 'info'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'info', 'exclude'), EXCLUDE.join('\n') + '\n');
    }
    return ['--git-dir', dir, '--work-tree', cwd];
  }

  // Возвращает id дерева с текущим состоянием файлов проекта.
  snapshot(cwd) {
    return serial(cwd, async () => {
      if (!(await this.ready()) || !cwd || !fs.existsSync(cwd)) return null;
      const g = await this.repo(cwd);
      const add = await git([...g, 'add', '-A', '--ignore-errors', '.'], { cwd });
      if (add.code !== 0 && !/warning/i.test(add.stderr)) return null;
      const tree = await git([...g, 'write-tree'], { cwd });
      return tree.code === 0 ? tree.stdout.trim() : null;
    });
  }

  async changes(cwd, before, after) {
    if (!before || !after || before === after) return [];
    const g = await this.repo(cwd);
    const r = await git([...g, 'diff-tree', '-r', '--no-renames', '--name-status', before, after], { cwd });
    if (r.code !== 0) return [];
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [status, ...rest] = l.split('\t');
        return { status, path: rest.join('\t') };
      });
  }

  async diff(cwd, before, after, file) {
    const g = await this.repo(cwd);
    const r = await git([...g, 'diff', before, after, '--', file], { cwd });
    return r.stdout || '';
  }

  // Приводит файлы к состоянию из снимка: есть в снимке — восстанавливаем, нет — удаляем.
  restore(cwd, tree, files) {
    return serial(cwd, async () => {
      const g = await this.repo(cwd);
      const index = path.join(os.tmpdir(), `duocode-restore-${process.pid}-${Date.now()}`);
      const env = { GIT_INDEX_FILE: index };
      try {
        await git([...g, 'read-tree', tree], { cwd, env });
        const ls = await git([...g, 'ls-tree', '-r', '--name-only', tree], { cwd });
        const inTree = new Set(ls.stdout.split('\n').filter(Boolean));
        const keep = files.filter((f) => inTree.has(f));
        const drop = files.filter((f) => !inTree.has(f));
        for (let i = 0; i < keep.length; i += 100) {
          await git([...g, 'checkout-index', '-f', '--', ...keep.slice(i, i + 100)], { cwd, env });
        }
        for (const f of drop) fs.rmSync(path.join(cwd, f), { force: true });
        return { restored: keep.length, removed: drop.length };
      } finally {
        fs.rmSync(index, { force: true });
      }
    });
  }
}

// ---------- Панель Git (настоящий репозиторий проекта) ----------

async function status(cwd) {
  const root = await isRepo(cwd);
  if (!root) return { repo: false, git: await hasGit() };
  const [br, st, ahead] = await Promise.all([
    git(['branch', '--show-current'], { cwd }),
    git(['status', '--porcelain=v1', '-uall'], { cwd }),
    git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], { cwd }),
  ]);
  const files = st.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const code = l.slice(0, 2);
      let p = l.slice(3);
      if (p.includes(' -> ')) p = p.split(' -> ').pop();
      p = p.replace(/^"|"$/g, '');
      const kind = code === '??' ? 'new' : code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : 'modified';
      return { path: p, code, kind };
    });
  let behind = 0;
  let aheadN = 0;
  if (ahead.code === 0) [behind, aheadN] = ahead.stdout.trim().split(/\s+/).map(Number);
  return { repo: true, root, branch: br.stdout.trim() || '(без ветки)', files, ahead: aheadN, behind, upstream: ahead.code === 0 };
}

async function fileDiff(cwd, file, kind) {
  if (kind === 'new') {
    const r = await git(['diff', '--no-index', '--', os.platform() === 'win32' ? 'NUL' : '/dev/null', file], { cwd });
    return r.stdout;
  }
  const r = await git(['diff', 'HEAD', '--', file], { cwd });
  if (r.code !== 0) return (await git(['diff', '--', file], { cwd })).stdout;
  return r.stdout;
}

async function revertFile(cwd, file, kind) {
  if (kind === 'new') {
    fs.rmSync(path.join(cwd, file), { force: true });
    return true;
  }
  const r = await git(['checkout', 'HEAD', '--', file], { cwd });
  return r.code === 0;
}

async function commitAll(cwd, message) {
  await git(['add', '-A'], { cwd });
  const r = await git(['commit', '-m', message], { cwd });
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

async function push(cwd) {
  const r = await git(['push'], { cwd, timeout: 180000 });
  if (r.code !== 0 && /no upstream|set-upstream/i.test(r.stderr)) {
    const br = (await git(['branch', '--show-current'], { cwd })).stdout.trim();
    const r2 = await git(['push', '-u', 'origin', br], { cwd, timeout: 180000 });
    return { ok: r2.code === 0, output: (r2.stdout + r2.stderr).trim() };
  }
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

async function init(cwd) {
  const r = await git(['init'], { cwd });
  return r.code === 0;
}

async function stagedDiffStat(cwd) {
  await git(['add', '-A', '--dry-run'], { cwd });
  const r = await git(['diff', 'HEAD', '--stat'], { cwd });
  const d = await git(['diff', 'HEAD'], { cwd });
  return { stat: r.stdout, diff: d.stdout.slice(0, 12000) };
}

// ---------- Отдельные копии проекта для «дуэли» ----------

// Коммит со всем текущим состоянием (включая незакоммиченное и новые файлы), не трогая индекс и ветки.
async function snapshotCommit(cwd) {
  const index = path.join(os.tmpdir(), `duocode-duel-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index, ...AUTHOR };
  try {
    const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd });
    if (head.code === 0) await git(['read-tree', 'HEAD'], { cwd, env });
    await git(['add', '-A'], { cwd, env });
    const tree = (await git(['write-tree'], { cwd, env })).stdout.trim();
    const args = ['commit-tree', tree, '-m', 'DuoCode: исходное состояние для сравнения'];
    if (head.code === 0) args.push('-p', head.stdout.trim());
    const c = await git(args, { cwd, env });
    return c.code === 0 ? c.stdout.trim() : null;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

async function addWorktree(cwd, dir, commit) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await git(['worktree', 'add', '--detach', dir, commit], { cwd });
  return r.code === 0;
}

// Изменения в копии относительно исходного коммита: список файлов и патч.
async function worktreeChanges(dir, base) {
  const index = path.join(os.tmpdir(), `duocode-wt-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(['read-tree', base], { cwd: dir, env });
    await git(['add', '-A'], { cwd: dir, env });
    const names = await git(['diff', '--cached', '--no-renames', '--name-status', base], { cwd: dir, env });
    const patch = await git(['diff', '--cached', '--binary', '--no-renames', base], { cwd: dir, env });
    const text = await git(['diff', '--cached', '--no-renames', base], { cwd: dir, env });
    const files = names.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [s, ...rest] = l.split('\t');
        return { status: s, path: rest.join('\t') };
      });
    return { files, patch: patch.stdout, diff: text.stdout };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

async function applyPatch(cwd, patchFile) {
  const r = await git(['apply', '--whitespace=nowarn', patchFile], { cwd });
  return { ok: r.code === 0, output: r.stderr.trim() };
}

async function removeWorktree(cwd, dir) {
  await git(['worktree', 'remove', '--force', dir], { cwd });
  await git(['worktree', 'prune'], { cwd });
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  git,
  hasGit,
  isRepo,
  Checkpoints,
  status,
  fileDiff,
  revertFile,
  commitAll,
  push,
  init,
  stagedDiffStat,
  snapshotCommit,
  addWorktree,
  worktreeChanges,
  applyPatch,
  removeWorktree,
};
