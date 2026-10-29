// GitHub CLI хранит учётные данные сам. В DuoCode попадают только профиль и метаданные репозиториев.
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { resolveCommand } = require('./env');

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      windowsHide: true, timeout: 30000, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
      ...options,
    }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!(err && err.killed) }));
  });
}

function repository(input) {
  const name = String(input || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/i, '');
  if (!/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(name) || ['.', '..'].includes(name.split('/')[1])) {
    throw new Error('Укажите репозиторий owner/repo или https://github.com/owner/repo');
  }
  return name;
}

class GitHub {
  constructor({ run: execute = run, resolve = resolveCommand } = {}) { this.run = execute; this.resolve = resolve; }

  async command(args, options) {
    const command = this.resolve('gh');
    if (!command) throw new Error('GitHub CLI не найден. Установите gh с cli.github.com и перезапустите DuoCode');
    const result = await this.run(command, args, options);
    if (result.code !== 0) throw new Error(result.timedOut ? 'GitHub не ответил вовремя. Проверьте соединение и повторите' : (result.stderr || result.stdout || 'Ошибка GitHub CLI').trim().slice(0, 2000));
    return result.stdout;
  }

  async api(endpoint) {
    return JSON.parse(await this.command(['api', '--hostname', 'github.com', endpoint]));
  }

  async status() {
    const installed = !!this.resolve('gh');
    const git = !!this.resolve('git');
    if (!installed) return { installed, git, authenticated: false };
    try {
      const user = await this.api('user');
      return { installed, git, authenticated: true, login: user.login, name: user.name || user.login };
    } catch (err) { return { installed, git, authenticated: false, error: err.message }; }
  }

  async repositories(page = 1) {
    if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error('Некорректная страница репозиториев');
    const data = await this.api(`user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=50&page=${page}`);
    return {
      repositories: data.map((r) => ({ fullName: r.full_name, name: r.name, description: r.description || '', private: !!r.private, url: r.html_url, defaultBranch: r.default_branch })),
      hasMore: data.length === 50,
    };
  }

  async clone(input, parent) {
    const fullName = repository(input);
    if (!this.resolve('git')) throw new Error('Git не найден. Установите Git и перезапустите DuoCode');
    if (typeof parent !== 'string' || !path.isAbsolute(parent)) throw new Error('Выберите папку для клонирования');
    const base = await fs.realpath(parent);
    if (!(await fs.stat(base)).isDirectory()) throw new Error('Выберите папку для клонирования');
    // Проверяем доступ до создания папки; URL всегда строим сами, без токенов и произвольных хостов.
    const info = await this.api(`repos/${fullName}`);
    const canonical = repository(info.full_name);
    const name = canonical.split('/')[1];
    const destination = path.join(base, name);
    try { await fs.mkdir(destination); }
    catch (err) {
      if (err.code === 'EEXIST') throw new Error(`Папка «${name}» уже существует. Выберите другую родительскую папку`);
      throw err;
    }
    try {
      await this.command(['repo', 'clone', `https://github.com/${canonical}.git`, destination], { timeout: 10 * 60 * 1000 });
      return { path: destination, name, fullName: canonical, url: `https://github.com/${canonical}` };
    } catch (err) {
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }
}

module.exports = { GitHub };
