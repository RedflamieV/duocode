// Удалённое управление DuoCode из мини-приложения Telegram.
// Локальный HTTP-сервер отдаёт интерфейс и API, а туннель Cloudflare делает его доступным по HTTPS.
// Каждый запрос подписан Telegram (initData) — проверяем подпись токеном бота и ID владельца.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// ---------- Проверка подписи Telegram ----------

function checkInitData(initData, botToken, ownerId, maxAgeSec = 86400) {
  if (!initData || !botToken || !ownerId) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = Date.now() / 1000 - Number(params.get('auth_date') || 0);
  if (!(age < maxAgeSec)) return null;
  let user;
  try {
    user = JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
  return String(user.id) === String(ownerId) ? user : null;
}

// ---------- Сервер ----------

class RemoteServer extends EventEmitter {
  constructor({ root, getAuth, api }) {
    super();
    this.root = root; // папка renderer
    this.getAuth = getAuth; // () => { token, userId }
    this.api = api; // { method: async (...args) => result }
    this.clients = new Set();
    this.port = null;
  }

  // Постоянный порт 47821 удобен для своего туннеля; если занят — любой свободный.
  start(preferred = 47821) {
    if (this.server) return Promise.resolve(this.port);
    this.server = http.createServer((req, res) => this.route(req, res).catch((err) => this.json(res, 500, { error: err.message })));
    return new Promise((resolve) => {
      const listen = (port) => {
        this.server.once('error', (err) => (err.code === 'EADDRINUSE' && port ? listen(0) : resolve(null)));
        this.server.listen(port, '127.0.0.1', () => {
          this.port = this.server.address().port;
          resolve(this.port);
        });
      };
      listen(preferred);
    });
  }

  stop() {
    for (const c of this.clients) c.end();
    this.clients.clear();
    if (this.server) this.server.close();
    this.server = null;
  }

  json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  file(res, name, type) {
    try {
      const data = fs.readFileSync(path.join(this.root, name));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  }

  auth(initData) {
    const { token, userId } = this.getAuth();
    return checkInitData(initData, token, userId);
  }

  async route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // сам интерфейс публичный: в нём нет данных, данные отдаёт только API после проверки подписи
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return this.file(res, 'remote.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/remote.js') return this.file(res, 'dist/remote.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/styles.css') return this.file(res, 'styles.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/remote.css') return this.file(res, 'remote.css', 'text/css; charset=utf-8');

    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (!this.auth(url.searchParams.get('auth'))) return this.json(res, 401, { error: 'Нет доступа' });
      // no-transform запрещает Cloudflare и прокси сжимать поток (а значит, копить его в буфере),
      // а 2 КБ пробелов в начале «проталкивают» буферы, которые ждут первых килобайт
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform',
        'Content-Encoding': 'identity',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`:${' '.repeat(2048)}\nretry: 3000\n\nevent: hello\ndata: {}\n\n`);
      this.clients.add(res);
      // именованный ping, чтобы приложение видело, что поток жив
      const ping = setInterval(() => res.write(`event: ping\ndata: ${Date.now()}\n\n`), 10000);
      req.on('close', () => {
        clearInterval(ping);
        this.clients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/rpc') {
      if (!this.auth(req.headers['x-telegram-init-data'])) return this.json(res, 401, { error: 'Нет доступа' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2e6) return this.json(res, 413, { error: 'Слишком большой запрос' });
      }
      const { method, args = [] } = JSON.parse(body || '{}');
      const fn = Object.prototype.hasOwnProperty.call(this.api, method) && this.api[method];
      if (!fn) return this.json(res, 404, { error: `Неизвестный метод ${method}` });
      const result = await fn(...args);
      return this.json(res, 200, { result: result === undefined ? null : result });
    }
    res.writeHead(404).end();
  }

  broadcast(event, data) {
    if (!this.clients.size) return;
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(line);
  }
}

// ---------- Туннель Cloudflare (без аккаунта) ----------

const ASSET = {
  'win32-x64': 'cloudflared-windows-amd64.exe',
  'win32-arm64': 'cloudflared-windows-amd64.exe',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
};

class Tunnel extends EventEmitter {
  constructor(binDir) {
    super();
    this.binDir = binDir;
    this.proc = null;
    this.url = null;
    this.wanted = false;
  }

  binPath() {
    return path.join(this.binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  }

  async ensureBinary() {
    const bin = this.binPath();
    if (fs.existsSync(bin)) return bin;
    const asset = ASSET[`${process.platform}-${process.arch}`];
    if (!asset) throw new Error('Туннель не поддерживается на этой системе');
    fs.mkdirSync(this.binDir, { recursive: true });
    this.emit('status', { state: 'downloading', progress: 0 });
    const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`);
    if (!res.ok) throw new Error(`Не удалось скачать cloudflared: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const tmp = path.join(this.binDir, asset + '.part');
    const out = fs.createWriteStream(tmp);
    let got = 0;
    let last = 0;
    for await (const chunk of res.body) {
      out.write(chunk);
      got += chunk.length;
      if (total && Date.now() - last > 300) {
        last = Date.now();
        this.emit('status', { state: 'downloading', progress: Math.round((got / total) * 100) });
      }
    }
    await new Promise((r) => out.end(r));
    if (asset.endsWith('.tgz')) {
      await new Promise((resolve, reject) => {
        const t = spawn('tar', ['-xzf', tmp, '-C', this.binDir]);
        t.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Не удалось распаковать cloudflared'))));
      });
      fs.rmSync(tmp, { force: true });
    } else {
      fs.renameSync(tmp, bin);
    }
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  // provider: cloudflare | localhostrun | custom (адрес задаёт пользователь, туннель он поднимает сам)
  async start(port, provider = 'cloudflare', customUrl = '') {
    this.wanted = true;
    if (this.proc && this.provider === provider) return;
    if (this.proc) this.stop();
    this.wanted = true;
    this.provider = provider;
    if (provider === 'custom') {
      const url = customUrl.trim().replace(/\/+$/, '');
      if (!/^https:\/\//.test(url)) return this.emit('status', { state: 'error', error: 'Укажите адрес, начинающийся с https://' });
      this.url = url;
      return this.emit('status', { state: 'ready', url });
    }
    let proc;
    let pattern;
    if (provider === 'localhostrun') {
      // SSH-туннель localhost.run: ssh есть в Windows 10/11, macOS и Linux, скачивать ничего не нужно
      this.emit('status', { state: 'starting' });
      pattern = /https:\/\/[a-z0-9-]+\.(lhr\.life|localhost\.run)/;
      proc = spawn(
        'ssh',
        ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run'],
        { windowsHide: true },
      );
    } else {
      let bin;
      try {
        bin = await this.ensureBinary();
      } catch (err) {
        this.emit('status', { state: 'error', error: err.message });
        return;
      }
      if (!this.wanted) return;
      this.emit('status', { state: 'starting' });
      pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
      proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { windowsHide: true });
    }
    this.proc = proc;
    let log = '';
    const onData = (chunk) => {
      log = (log + chunk.toString()).slice(-4000);
      const m = pattern.exec(log);
      if (m && m[0] !== this.url) {
        this.url = m[0];
        // адрес выдан, но DNS у Cloudflare доходит до него за несколько секунд
        setTimeout(() => this.proc === proc && this.emit('status', { state: 'ready', url: this.url }), 4000);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => this.emit('status', { state: 'error', error: err.message }));
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.url = null;
      if (!this.wanted) return this.emit('status', { state: 'off' });
      const reason = (log.match(/(ERR|failed)[^\n]*/g) || []).pop() || 'туннель остановился';
      this.emit('status', { state: 'error', error: `${reason}. Перезапуск через 15 секунд…` });
      setTimeout(() => this.wanted && this.start(port, provider, customUrl), 15000);
    });
  }

  stop() {
    this.wanted = false;
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      this.url = null;
      try {
        p.kill();
      } catch {}
    }
    this.emit('status', { state: 'off' });
  }
}

module.exports = { RemoteServer, Tunnel, checkInitData };
