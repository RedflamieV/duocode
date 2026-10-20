const { app, BrowserWindow, ipcMain, dialog, shell, Notification, nativeTheme, Tray, Menu, nativeImage, globalShortcut, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { fixPath, resolveCommand, isWin, spawnTool } = require('./src/env');
const { Store } = require('./src/store');
const { Rooms } = require('./src/rooms');
const { CodexServer } = require('./src/agents/codex');
const { getClaudeLimits } = require('./src/claudeLimits');
const { getCodexLimits, parseRateLimits } = require('./src/codexLimits');
const { allSessions, claudeToday, codexToday, dailyUsage } = require('./src/history');
const { listCommands } = require('./src/commands');
const gitx = require('./src/git');
const { searchFiles } = require('./src/files');
const projects = require('./src/projects');
const memory = require('./src/memory');
const { AgentBrowser } = require('./src/browser');
const { Telegram, esc, clip } = require('./src/telegram');
const { toTelegram, quote, plain } = require('./src/tgformat');
const { RemoteServer, Tunnel } = require('./src/remote');

fixPath();

if (!app.requestSingleInstanceLock()) app.quit();

// ---------- Настройки ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
app.whenReady().then(() => memory.setGlobalDir(app.getPath('userData')));
const APPEARANCE = {
  theme: 'system',
  fontSize: 14,
  chatWidth: 'normal',
  density: 'comfortable',
  codeFont: 'auto',
  steps: 'detailed',
  expandThinking: false,
  sendKey: 'enter',
  showCost: true,
};
const TELEGRAM = { token: '', userId: '', notifyFinish: true, notifyApprovals: true, notifyLimits: true, remote: false, tunnel: 'cloudflare', customUrl: '', activeRoom: '', target: 'both' };
const GENERAL = { closeToTray: false, hotkey: true, notifyLimits: true, browser: true };

const PIPELINES = [
  {
    id: 'plan-code-review',
    name: 'План → код → ревью',
    steps: [
      { agent: 'claude', prompt: 'Составь подробный пошаговый план решения задачи. Ничего не меняй в файлах — только план.\n\nЗадача: {task}' },
      { agent: 'codex', prompt: 'Реализуй план Claude из общего чата. Задача: {task}' },
      { agent: 'claude', prompt: 'Проверь, как Codex реализовал план: найди ошибки и недочёты и исправь критичные сам. В конце кратко перечисли, что исправил.' },
    ],
  },
  {
    id: 'code-review-fix',
    name: 'Код → ревью → исправления',
    steps: [
      { agent: 'codex', prompt: '{task}' },
      { agent: 'claude', prompt: 'Сделай код-ревью изменений, которые только что внёс Codex. Ничего не меняй сам — перечисли замечания по важности.' },
      { agent: 'codex', prompt: 'Исправь замечания Claude из его ревью.' },
    ],
  },
  {
    id: 'two-opinions',
    name: 'Два мнения → решение',
    steps: [
      { agent: 'claude', prompt: 'Предложи решение задачи, ничего не меняя в файлах: подход, плюсы и минусы.\n\nЗадача: {task}' },
      { agent: 'codex', prompt: 'Предложи своё решение той же задачи, ничего не меняя в файлах, и честно сравни его с вариантом Claude.\n\nЗадача: {task}' },
      { agent: 'claude', prompt: 'Сравни оба варианта, выбери лучший (или объедини) и реализуй его.' },
    ],
  },
];

const defaults = {
  projects: [],
  claudeCommand: 'claude',
  codexCommand: 'codex',
  refreshMinutes: 3,
  appearance: APPEARANCE,
  telegram: TELEGRAM,
  general: GENERAL,
  pipelines: PIPELINES,
};
let settings = { ...defaults };

// Расширения, которые Windows запускает как программы или скрипты: такие файлы только показываем в папке.
const RUNNABLE = /\.(exe|com|bat|cmd|msi|msp|scr|pif|lnk|url|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|jar|reg|application|appref-ms|gadget|msc|sh|command|app)$/i;

// Токен бота — секрет: на диске он лежит зашифрованным средствами системы (DPAPI в Windows, связка ключей в macOS).
function sealSecret(text) {
  if (!text || !safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(text).toString('base64');
}
function openSecret(sealed) {
  try {
    return sealed && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(sealed, 'base64')) : '';
  } catch {
    return '';
  }
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = {
      ...defaults,
      ...saved,
      appearance: { ...APPEARANCE, ...(saved.appearance || {}) },
      telegram: { ...TELEGRAM, ...(saved.telegram || {}) },
      general: { ...GENERAL, ...(saved.general || {}) },
    };
    // 2.4.0 привязывал первый чат, написавший /start. Теперь нужен явный ID владельца:
    // старый чат только подставляем в поле как подсказку, но не доверяем ему сами.
    if (settings.telegram.chatId && !settings.telegram.userId) settings.telegram.suggestedId = settings.telegram.chatId;
    delete settings.telegram.chatId;
    if (settings.telegram.tokenSealed) {
      settings.telegram.token = openSecret(settings.telegram.tokenSealed) || settings.telegram.token || '';
      delete settings.telegram.tokenSealed;
    }
    if (projects.migrate(settings)) saveSettings();
  } catch {
    settings = { ...defaults };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  // в памяти токен открытый, на диске — зашифрованный (если система умеет шифровать)
  const tokenSealed = sealSecret(settings.telegram && settings.telegram.token);
  const onDisk = tokenSealed ? { ...settings, telegram: { ...settings.telegram, token: '', tokenSealed } } : settings;
  fs.writeFileSync(settingsFile(), JSON.stringify(onDisk, null, 2));
}

function rememberProject(dir) {
  settings.projects = [dir, ...settings.projects.filter((p) => p !== dir)].slice(0, 20);
  const { project } = projects.forFolder(settings, dir);
  saveSettings();
  return project;
}

// Новый чат: в существующем проекте (projectId) или в папке (cwd), для которой проект заведётся сам.
function createRoom({ projectId, cwd, title, settings: chosen }) {
  let project = projectId && projects.get(settings, projectId);
  if (!project) project = rememberProject(cwd);
  else rememberProject(project.folders[0]);
  return rooms.create({ cwd: project.folders[0], projectId: project.id, title, chosen });
}

// Папки проекта, где эта папка основная (для поиска файлов и панели Git).
function foldersOf(cwd) {
  const p = projects.list(settings).find((x) => x.folders[0] && projects.norm(x.folders[0]) === projects.norm(cwd));
  return p ? p.folders : [cwd];
}

// ---------- Мост для MCP-инструментов агентов ----------

const sameSecret = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function startBridge(rooms) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    // мост в каждом агенте проверяет, жив ли DuoCode (см. bridge/mcp.js)
    if (req.method === 'GET' && req.url === '/alive') {
      res.writeHead(200).end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/call') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let out;
      try {
        const call = JSON.parse(body);
        if (!sameSecret(call.token, token)) out = { isError: true, text: 'Неверный токен DuoCode' };
        else out = await rooms().handleBridge(call);
      } catch (err) {
        out = { isError: true, text: 'Ошибка DuoCode: ' + err.message };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        token,
        command: process.execPath,
        script: path.join(__dirname, 'bridge', 'mcp.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
      });
    });
  });
}

// ---------- Лимиты ----------

let win;
let rooms;
let browser = null;
let codex;
let tray = null;
const tg = new Telegram();
let remote = null;
let tunnel = null;
let remoteStatus = { state: 'off' };
const limits = { claude: null, codex: null, today: null };

function windowMinutes(label) {
  const h = /(\d+)\s*ч/.exec(label);
  if (h) return Number(h[1]) * 60;
  const d = /(\d+)\s*д/.exec(label);
  if (d) return Number(d[1]) * 1440;
  return /Неделя/.test(label) ? 10080 : null;
}

// Прогноз: если расходовать так же, как с начала окна, когда лимит кончится (только если раньше сброса).
function addForecast(data) {
  if (!data || !data.ok) return;
  const now = Date.now();
  for (const w of data.windows) {
    w.runsOutAt = null;
    const mins = windowMinutes(w.label);
    const reset = Date.parse(w.resetsAt);
    if (!mins || !reset || w.percent < 3 || w.percent >= 100) continue;
    const len = mins * 60000;
    const elapsed = len - (reset - now);
    if (elapsed < len * 0.05 || elapsed <= 0) continue;
    const eta = now + ((100 - w.percent) * elapsed) / w.percent;
    if (eta < reset) w.runsOutAt = new Date(eta).toISOString();
  }
}

const alertState = new Map();

function limitAlerts(agent, data) {
  if (!data || !data.ok) return;
  const name = agent === 'claude' ? 'Claude' : 'Codex';
  for (const w of data.windows) {
    const key = `${agent}:${w.label}`;
    const st = alertState.get(key) || { level: 0, resetsAt: w.resetsAt, pct: w.percent, eta: false };
    const fresh = !alertState.has(key);
    if (w.resetsAt && st.resetsAt && Date.parse(w.resetsAt) - Date.parse(st.resetsAt) > 60000) {
      if (!fresh && st.pct >= 50) limitNotify(`Лимит ${name} обновился`, `«${w.label}» снова доступен: ${Math.round(w.percent)}%.`);
      Object.assign(st, { level: 0, eta: false, resetsAt: w.resetsAt });
    }
    const level = w.percent >= 95 ? 2 : w.percent >= 80 ? 1 : 0;
    if (level > st.level && !fresh) limitNotify(`Лимит ${name}: ${Math.round(w.percent)}%`, `«${w.label}» почти исчерпан. Сброс ${new Date(w.resetsAt).toLocaleString()}.`);
    if (w.runsOutAt && !st.eta && !fresh && level === 0) {
      limitNotify(`${name}: лимит может кончиться раньше сброса`, `При таком темпе «${w.label}» закончится около ${new Date(w.runsOutAt).toLocaleString()}.`);
      st.eta = true;
    }
    st.level = Math.max(st.level, level);
    st.pct = w.percent;
    alertState.set(key, st);
  }
}

function limitNotify(title, body) {
  if (settings.general.notifyLimits && Notification.isSupported()) new Notification({ title, body }).show();
  if (settings.telegram.notifyLimits) tg.send(`⚠️ <b>${esc(title)}</b>\n${esc(body)}`);
}

function sendLimits() {
  addForecast(limits.claude);
  addForecast(limits.codex);
  limitAlerts('claude', limits.claude);
  limitAlerts('codex', limits.codex);
  if (win && !win.isDestroyed()) win.webContents.send('limits', limits);
  if (remote) remote.broadcast('limits', limits);
}

// «Авто»: задачу берёт агент, у которого больше свободного лимита.
function pickAgent() {
  const load = (data) => (data && data.ok && data.windows.length ? Math.max(...data.windows.slice(0, 2).map((w) => w.percent)) : 50);
  const installed = (cmd) => !!resolveCommand(cmd);
  const c = installed(settings.claudeCommand) ? load(limits.claude) : 999;
  const x = installed(settings.codexCommand) ? load(limits.codex) : 999;
  const agent = x < c ? 'codex' : 'claude';
  const fmt = (v) => (v >= 999 ? 'не установлен' : `занято ${Math.round(v)}%`);
  return { agent, reason: `Авто → ${agent === 'claude' ? 'Claude' : 'Codex'}: у Claude ${fmt(c)}, у Codex ${fmt(x)}` };
}

async function refreshClaudeLimits(force = false) {
  const res = await getClaudeLimits({ force }).catch((err) => ({ ok: false, error: err.message }));
  // если API сейчас недоступен, но лимиты уже были (из API или из потока Claude Code) — оставляем их
  if (!res.ok && limits.claude && limits.claude.ok) return;
  limits.claude = res;
  sendLimits();
}

async function refreshCodexLimits() {
  limits.codex = await getCodexLimits(codex).catch((err) => ({ ok: false, error: err.message }));
  sendLimits();
}

function refreshToday() {
  try {
    limits.today = { claude: claudeToday(), codex: codexToday() };
  } catch {
    limits.today = null;
  }
  sendLimits();
}

async function refreshAllLimits(force = false) {
  refreshToday();
  await Promise.all([refreshClaudeLimits(force), refreshCodexLimits()]);
}

// Claude Code сообщает лимиты прямо в потоке событий — обновляем без запроса к API.
function onClaudeRateLimit(info) {
  const w = info && info.unifiedWindows;
  if (!w) return;
  const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
  const live = [];
  if (w.five_hour) live.push({ label: 'Сессия (5ч)', percent: w.five_hour.utilization * 100, resetsAt: iso(w.five_hour.resetsAt) });
  if (w.seven_day) live.push({ label: 'Неделя', percent: w.seven_day.utilization * 100, resetsAt: iso(w.seven_day.resetsAt) });
  const prev = limits.claude && limits.claude.ok ? limits.claude : { ok: true, windows: [], plan: limits.claude && limits.claude.plan };
  const windows = prev.windows.filter((x) => !live.some((l) => l.label === x.label));
  limits.claude = { ...prev, windows: [...live, ...windows], source: prev.source || 'cli', fetchedAt: Date.now() };
  sendLimits();
}

function onCodexRateLimit(snapshot) {
  if (!snapshot || !limits.codex || !limits.codex.ok) return refreshCodexLimits();
  const fresh = parseRateLimits({ rateLimits: snapshot, rateLimitsByLimitId: null });
  const windows = limits.codex.windows.map((w) => fresh.windows.find((f) => f.label === w.label) || w);
  for (const f of fresh.windows) if (!windows.some((w) => w.label === f.label)) windows.push(f);
  limits.codex = { ...limits.codex, windows, source: 'live', note: null, fetchedAt: Date.now() };
  sendLimits();
}

// ---------- Проверка установленных CLI ----------

function cliVersion(cmd) {
  return new Promise((resolve) => {
    const resolved = resolveCommand(cmd);
    if (!resolved) return resolve(null);
    const opts = { timeout: 15000, windowsHide: true, shell: isWin && /\.(cmd|bat)$/i.test(resolved) };
    execFile(resolved, ['--version'], opts, (err, stdout) => {
      resolve({ path: resolved, version: err ? null : String(stdout).trim().split('\n').pop() });
    });
  });
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function describeFile(p) {
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch {}
  return { path: p, name: path.basename(p), image: IMAGE_EXT.has(path.extname(p).toLowerCase()), size };
}

function cliRun(cmd, args) {
  return new Promise((resolve) => {
    const opts = { timeout: 20000, windowsHide: true, shell: isWin && /\.(cmd|bat)$/i.test(cmd) };
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// Вход выполняют сами CLI: открываем для них отдельное окно консоли.
function openLoginConsole(cmd, args) {
  const dir = path.join(app.getPath('userData'), 'run');
  fs.mkdirSync(dir, { recursive: true });
  const line = [`"${cmd}"`, ...args].join(' ');
  if (isWin) {
    const file = path.join(dir, 'login.cmd');
    fs.writeFileSync(
      file,
      ['@echo off', 'chcp 65001 >nul', 'title DuoCode: вход', line, 'echo.', 'echo Готово. Окно можно закрыть и вернуться в DuoCode.', 'pause >nul', ''].join('\r\n'),
    );
    shell.openPath(file);
  } else if (process.platform === 'darwin') {
    const file = path.join(dir, 'login.command');
    fs.writeFileSync(file, `#!/bin/bash\n${line}\necho\necho "Готово. Окно можно закрыть и вернуться в DuoCode."\n`, { mode: 0o755 });
    shell.openPath(file);
  } else {
    const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].map(resolveCommand).find(Boolean);
    if (term) require('child_process').spawn(term, ['-e', `bash -c '${line}; read -p "Enter — закрыть"'`], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ---------- Автообновление ----------

let updater = null;
const update = { status: 'idle', version: null, error: null };

function setUpdate(patch) {
  Object.assign(update, patch);
  if (win && !win.isDestroyed()) win.webContents.send('update', update);
}

function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch {
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', (info) => setUpdate({ status: 'downloading', version: info.version, error: null }));
  updater.on('update-not-available', () => setUpdate({ status: 'latest', error: null }));
  updater.on('update-downloaded', (info) => setUpdate({ status: 'ready', version: info.version }));
  updater.on('error', (err) => setUpdate({ status: 'error', error: err.message }));
  checkForUpdates();
  setInterval(checkForUpdates, 2 * 60 * 60 * 1000);
}

function checkForUpdates(manual = false) {
  if (!updater) return { status: 'dev' };
  if (manual) setUpdate({ status: 'checking', error: null });
  updater.checkForUpdates().catch((err) => setUpdate({ status: 'error', error: err.message }));
  return update;
}

// ---------- Сообщение коммита, статистика чатов ----------

function commitMessage(cwd) {
  return new Promise(async (resolve) => {
    const st = await gitx.status(cwd);
    const files = (st.files || []).map((f) => `${f.kind}: ${f.path}`).join('\n');
    const diff = (await gitx.git(['diff', 'HEAD'], { cwd })).stdout.slice(0, 15000);
    const fallback = `Обновление: ${st.files ? st.files.length : 0} файл(ов)`;
    let proc;
    try {
      proc = spawnTool(settings.claudeCommand, ['-p', '--model', 'haiku', '--output-format', 'text', '--tools', ''], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return resolve(fallback);
    }
    let out = '';
    const timer = setTimeout(() => proc.kill(), 60000);
    proc.stdout.on('data', (c) => (out += c));
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim().replace(/^```\w*\n?|```$/g, '').trim() || fallback);
    });
    proc.on('error', () => resolve(fallback));
    proc.stdin.end(
      'Напиши сообщение git-коммита для этих изменений: первая строка до 72 символов в повелительном наклонении, ' +
        'при необходимости пустая строка и краткий список. Язык — как в истории проекта, по умолчанию русский. ' +
        `Ответь только текстом сообщения.\n\nФайлы:\n${files}\n\nDiff:\n${diff}`,
    );
  });
}

function chatStats() {
  return rooms.list().map((r) => {
    const room = rooms.get(r.id);
    const s = { id: r.id, title: r.title, cwd: r.cwd, updatedAt: r.updatedAt, claude: 0, codex: 0, cost: 0 };
    for (const m of room.messages) {
      if (m.role !== 'agent') continue;
      s[m.agent]++;
      s.cost += m.cost || 0;
    }
    return s;
  });
}

// ---------- Трей и горячая клавиша ----------

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function setupTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', process.platform === 'win32' ? 'tray.png' : 'tray16.png'));
  tray = new Tray(icon);
  tray.setToolTip('DuoCode');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть DuoCode', click: showWindow },
      {
        label: 'Новый чат',
        click: () => {
          showWindow();
          win.webContents.send('new-chat');
        },
      },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow);
}

const HOTKEY = 'CommandOrControl+Shift+Space';

function applyGeneral() {
  globalShortcut.unregister(HOTKEY);
  if (settings.general.hotkey) {
    globalShortcut.register(HOTKEY, () => {
      if (win && win.isVisible() && win.isFocused()) win.hide();
      else {
        showWindow();
        win.webContents.send('focus-composer');
      }
    });
  }
}

// ---------- Telegram ----------

function setupTelegram() {
  tg.on('intrusion', ({ who, id, what }) => {
    if (Notification.isSupported()) new Notification({ title: 'DuoCode: чужой аккаунт написал вашему боту', body: `${who} (ID ${id}): ${what}. Проигнорировано.` }).show();
  });
  tg.on('status', (s) => win && !win.isDestroyed() && win.webContents.send('telegram', s));
  tg.on('approval', ({ roomId, partId, value, res }) => {
    res.ok = rooms.respondApproval(roomId, partId, value);
  });
  tg.on('answer', ({ roomId, partId, value, res }) => {
    const room = rooms.get(roomId);
    for (const m of (room && room.messages) || []) {
      const part = (m.parts || []).find((p) => p.id === partId);
      if (part && part.questions && part.questions[0]) {
        const q = part.questions[0];
        const opt = q.options[Number(value)];
        if (opt) res.ok = rooms.respondApproval(roomId, partId, 'allow', { [q.id]: [opt.label] });
      }
    }
  });
  tg.on('backlog', botBacklog);
  tg.persistRooms(path.join(app.getPath('userData'), 'telegram-rooms.json'));
  tg.on('command', (c) => botCommand(c).catch(() => {}));
  tg.on('text', (t) => botText(t).catch((err) => tg.say(`⚠️ ${esc(err.message)}`)));
  tg.on('button', (b) => botButton(b).catch(() => {}));
  tg.configure(settings.telegram);
}

// ---------- Управление прямо в чате с ботом (работает без туннеля) ----------

const TARGET_NAME = { claude: 'Claude', codex: 'Codex', both: 'Claude и Codex', auto: 'Авто (у кого больше лимита)' };
const followed = new Map(); // roomId -> время, до которого показываем ход работы в Telegram
const progress = new Map(); // id сообщения агента -> { tgId, text, at, timer }

function setBot(patch) {
  settings.telegram = { ...settings.telegram, ...patch };
  saveSettings();
}

function activeRoom() {
  const id = settings.telegram.activeRoom;
  return id && rooms.get(id) ? rooms.get(id) : null;
}

function targetButtons() {
  const t = settings.telegram.target || 'both';
  return [
    ['claude', 'codex', 'both', 'auto'].map((k) => ({
      text: `${t === k ? '● ' : ''}${{ claude: 'Claude', codex: 'Codex', both: 'Оба', auto: 'Авто' }[k]}`,
      callback_data: `c|to|${k}`,
    })),
  ];
}

const HELP =
  '<b>Как управлять DuoCode из Telegram</b>\n\n' +
  '• /chats — выбрать чат, /new — новый чат в проекте\n' +
  '• Дальше просто пишите задачу — она уйдёт агентам в выбранный чат. Можно прислать скриншот или файл.\n' +
  '• /to — кому писать: Claude, Codex, обоим или «авто»\n' +
  '• /plan задача — сначала план, потом выполнение\n' +
  '• /stop — остановить, /limits — лимиты\n' +
  '• /rename название — переименовать выбранный чат\n' +
  '• /compact, /clear, /review, /init — команды агентов\n\n' +
  'Ход работы показывается в одном сообщении, которое обновляется. Подтверждения и вопросы приходят с кнопками.';

async function botCommand({ name, args }) {
  const room = activeRoom();
  switch (name) {
    case 'start':
    case 'help':
      return tg.say(HELP + (room ? `\n\nСейчас выбран чат «${esc(room.title)}».` : '\n\nНачните с /chats или /new.'));
    case 'chats': {
      const list = rooms.list().slice(0, 10);
      if (!list.length) return tg.say('Чатов пока нет. Создайте: /new');
      return tg.say(
        '<b>Выберите чат</b>',
        list.map((r) => [{ text: `${r.id === settings.telegram.activeRoom ? '● ' : ''}${r.running.claude || r.running.codex ? '⏳ ' : ''}${clip(r.title, 48)}`, callback_data: `c|room|${r.id}` }]),
      );
    }
    case 'new': {
      const list = projects.list(settings);
      if (!list.length) return tg.say('Сначала создайте проект в DuoCode на компьютере.');
      return tg.say('<b>В каком проекте?</b>', list.slice(0, 12).map((p) => [{ text: `${p.name}${p.folders.length > 1 ? ` · ${p.folders.length} папки` : ''}`, callback_data: `c|proj|${p.id}` }]));
    }
    case 'to':
      return tg.say(`Сейчас пишете: <b>${TARGET_NAME[settings.telegram.target || 'both']}</b>`, targetButtons());
    case 'rename': {
      if (!room) return tg.say('Чат не выбран: /chats');
      if (!args) return tg.say(`Напишите новое название после команды: /rename Новое название\n\nСейчас: «${esc(room.title)}»`);
      const before = room.title;
      const r = rooms.rename(room.id, args);
      return tg.say(`✏️ «${esc(before)}» → «<b>${esc(r.title)}</b>»`);
    }
    case 'stop':
      if (!room) return tg.say('Чат не выбран: /chats');
      rooms.stop(room.id);
      return tg.say(`⏹ Остановлено в «${esc(room.title)}»`);
    case 'limits': {
      const line = (name, d) =>
        !d || !d.ok ? `<b>${name}</b>: ${esc((d && d.error) || 'нет данных')}` : `<b>${name}</b>\n` + d.windows.map((w) => `  ${esc(w.label)}: ${Math.round(w.percent)}% · сброс ${new Date(w.resetsAt).toLocaleString()}`).join('\n');
      return tg.say(`${line('Claude', limits.claude)}\n\n${line('Codex', limits.codex)}`);
    }
    case 'app':
      if (tg.appUrl) return tg.sendApp('📱 Мини-приложение DuoCode (если не открывается — у вашего провайдера может быть заблокирован туннель, пользуйтесь управлением прямо в этом чате):');
      return tg.say('Мини-приложение выключено. Всё можно делать прямо здесь — /help');
    case 'plan':
      if (!args) return tg.say('Напишите задачу после команды: /plan добавь авторизацию');
      return botText({ text: args, plan: true });
    default:
      // команды агентов (/compact, /review…) уходят в выбранный чат как есть
      return botText({ text: `/${name}${args ? ' ' + args : ''}` });
  }
}

async function botText({ text, file, roomId, plan = false }) {
  const room = roomId ? rooms.get(roomId) : activeRoom();
  if (!room) return tg.say('Сначала выберите чат: /chats — или создайте новый: /new');
  const attachments = [];
  if (file) {
    const bytes = await tg.download(file.id);
    const dir = path.join(app.getPath('userData'), 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${Date.now()}-${file.name.replace(/[^\w.\-а-яё]/gi, '_')}`);
    fs.writeFileSync(p, bytes);
    attachments.push(describeFile(p));
  }
  const t = settings.telegram.target || 'both';
  const targets = t === 'both' ? ['claude', 'codex'] : [t];
  followed.set(room.id, Date.now() + 6 * 3600 * 1000);
  if (roomId && roomId !== settings.telegram.activeRoom) setBot({ activeRoom: roomId });
  rooms.send(room.id, { text: text || 'Посмотри вложение.', targets, attachments, plan });
  tg.typing();
}

// Задачи, присланные в бот, пока DuoCode был выключен: не запускаем сами, а спрашиваем, что с ними делать.
let backlog = null; // { id, items }

function ago(date) {
  const min = Math.round((Date.now() / 1000 - date) / 60);
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} ч назад` : 'больше суток назад';
}

async function waitIdle(roomId) {
  const busy = () => {
    const r = rooms.get(roomId);
    return r && (r.running.claude || r.running.codex);
  };
  await new Promise((r) => setTimeout(r, 1500));
  while (busy()) await new Promise((r) => setTimeout(r, 2000));
}

function botBacklog(items) {
  const tasks = items.filter((i) => !i.command);
  const commands = items.filter((i) => i.command);
  const lines = ['🟢 <b>DuoCode снова на связи.</b>'];
  if (tasks.length) {
    backlog = { id: Date.now().toString(36), items: tasks };
    lines.push(`Пока компьютер был недоступен, пришло задач: ${tasks.length}. Я их не запускал, чтобы они не налетели разом.\n`);
    tasks.slice(-8).forEach((t, i) => {
      const room = t.roomId && rooms.get(t.roomId);
      const what = t.text ? esc(clip(t.text.replace(/\s+/g, ' '), 90)) : '📎 вложение';
      lines.push(`${tasks.length > 8 ? tasks.length - 8 + i + 1 : i + 1}. «${what}» · ${ago(t.date)}${room ? ` · ${esc(clip(room.title, 30))}` : ''}`);
    });
    if (tasks.length > 8) lines.push(`…и ещё ${tasks.length - 8} раньше`);
  }
  if (commands.length) lines.push(`\nКоманды из этого времени пропущены: ${[...new Set(commands.map((c) => '/' + c.command))].join(', ')}.`);
  const id = backlog && backlog.id;
  const buttons = tasks.length
    ? [
        [{ text: tasks.length > 1 ? '▶ Только последнюю' : '▶ Выполнить', callback_data: `c|backlog|last.${id}` }],
        ...(tasks.length > 1 ? [[{ text: `▶ Все ${tasks.length} по очереди`, callback_data: `c|backlog|all.${id}` }]] : []),
        [{ text: '✖ Не выполнять', callback_data: `c|backlog|skip.${id}` }],
      ]
    : null;
  tg.say(lines.join('\n'), buttons);
}

async function botButton({ action, value, messageId }) {
  if (action === 'backlog') {
    const [what, id] = value.split('.');
    if (!backlog || backlog.id !== id) return tg.edit(messageId, '⌛ Этот список уже неактуален.');
    const items = what === 'all' ? backlog.items : what === 'last' ? backlog.items.slice(-1) : [];
    backlog = null;
    if (!items.length) return tg.edit(messageId, '✖ Накопленные задачи не выполнялись.');
    await tg.edit(messageId, `▶ Запускаю: ${items.length === 1 ? '1 задачу' : `${items.length} ${items.length % 10 < 5 && (items.length < 10 || items.length > 20) ? 'задачи' : 'задач'} по очереди`}.`);
    for (const t of items) {
      const room = t.roomId ? rooms.get(t.roomId) : activeRoom();
      await botText(t);
      // следующую — только когда агенты закончили, иначе она дописалась бы в текущую работу
      if (room && items.length > 1) await waitIdle(room.id);
    }
    return;
  }
  if (action === 'room' || action === 'proj') {
    let room;
    if (action === 'proj') {
      if (!projects.get(settings, value)) return tg.say('Проект не найден');
      room = createRoom({ projectId: value });
    } else room = rooms.get(value);
    if (!room) return tg.say('Чат не найден');
    setBot({ activeRoom: room.id });
    followed.set(room.id, Date.now() + 6 * 3600 * 1000);
    const last = [...room.messages].reverse().find((m) => m.role === 'agent' && !m.parentId && m.finalText);
    const tail = last ? `\n\nПоследний ответ ${last.agent === 'claude' ? 'Claude' : 'Codex'}:\n${quote(clip(last.finalText, 600))}` : '';
    return tg.edit(messageId, `✅ Чат «<b>${esc(room.title)}</b>» (${esc(path.basename(room.cwd))}).\nПишите задачу — она уйдёт: <b>${TARGET_NAME[settings.telegram.target || 'both']}</b>.${tail}`, targetButtons());
  }
  if (action === 'to') {
    setBot({ target: value });
    return tg.edit(messageId, `Теперь пишете: <b>${TARGET_NAME[value]}</b>`, targetButtons());
  }
  if (action === 'stop') {
    rooms.stop(value);
    return tg.say('⏹ Остановлено');
  }
}

// Ход работы агента — одно сообщение, которое обновляется раз в несколько секунд.
function stepLine(p) {
  if (p.kind === 'thinking') return '💭 размышляет';
  if (p.kind === 'delegate') return `🔁 подключил ${p.to === 'claude' ? 'Claude' : 'Codex'}`;
  if (p.kind === 'approval') return p.status === 'pending' ? '🛡 ждёт подтверждения' : null;
  if (p.kind === 'question') return p.status === 'pending' ? '❓ ждёт ответа' : null;
  if (p.kind !== 'tool') return null;
  if (p.icon === 'terminal') return `▸ <code>${esc(clip((p.command || '').split('\n')[0], 80))}</code>`;
  return `▸ ${esc(p.title)}${p.subtitle ? `: ${esc(clip(p.subtitle, 60))}` : ''}`;
}

function trackProgress(roomId, msgs) {
  const until = followed.get(roomId);
  if (!until || until < Date.now() || !settings.telegram.token || !settings.telegram.userId) return;
  for (const m of msgs) {
    if (m.role !== 'agent' || m.parentId) continue;
    const who = m.agent === 'claude' ? 'Claude' : 'Codex';
    let st = progress.get(m.id);
    if (m.status !== 'running') {
      if (st) {
        clearTimeout(st.timer);
        progress.delete(m.id);
        if (st.tgId) tg.remove(st.tgId);
      }
      continue;
    }
    const steps = m.parts.map(stepLine).filter(Boolean).slice(-6);
    const secs = Math.round((Date.now() - m.ts) / 1000);
    const draft = m.draft && m.draftKind !== 'thinking' ? `\n\n<i>${esc(plain(toTelegram(m.draft.slice(-300))))}</i>` : '';
    const text = `⏳ <b>${who}</b> работает · ${secs < 60 ? secs + ' с' : Math.floor(secs / 60) + ' мин'}\n${steps.join('\n')}${draft}`;
    const buttons = [[{ text: '⏹ Остановить', callback_data: `c|stop|${roomId}` }]];
    if (!st) {
      st = { tgId: null, text: '', at: 0, timer: null };
      progress.set(m.id, st);
      tg.say(text, buttons).then((r) => {
        if (r && progress.get(m.id) === st) st.tgId = r.message_id;
        else if (r) tg.remove(r.message_id);
      });
      st.text = text;
      st.at = Date.now();
      continue;
    }
    st.next = text;
    if (!st.timer) {
      st.timer = setTimeout(() => {
        st.timer = null;
        if (!progress.has(m.id) || !st.tgId || st.next === st.text) return;
        st.text = st.next;
        tg.edit(st.tgId, st.text, buttons);
      }, 3500);
    }
  }
}

function telegramAttention(room, msg, part) {
  if (!settings.telegram.notifyApprovals) return;
  const who = msg.agent === 'claude' ? 'Claude' : 'Codex';
  const head = `<b>${esc(room.title)}</b> · ${who}\n`;
  if (part.kind === 'question') {
    const q = part.questions[0];
    const single = part.questions.length === 1 && !q.multiSelect && q.options.length;
    const text = `${head}❓ ${esc(q.question)}${single ? '' : '\n\n<i>Ответьте в приложении.</i>'}`;
    const buttons = single ? q.options.map((o, i) => [{ text: o.label.slice(0, 60), callback_data: `q|${room.id}|${part.id}|${i}` }]) : null;
    return tg.send(text, { roomId: room.id, buttons });
  }
  const isPlan = part.plan !== undefined;
  let body = esc(part.title);
  if (part.command) body += `\n<pre>${esc(clip(part.command, 1500))}</pre>`;
  else if (part.plan) body += `\n\n${toTelegram(clip(part.plan, 2500))}`;
  else if (part.subtitle) body += `\n<code>${esc(clip(part.subtitle, 500))}</code>`;
  const cb = (d) => `a|${room.id}|${part.id}|${d}`;
  const buttons = isPlan
    ? [[{ text: '✅ Выполнить план', callback_data: cb('allow') }, { text: '❌ Отклонить', callback_data: cb('deny') }]]
    : [
        [
          { text: '✅ Разрешить', callback_data: cb('allow') },
          { text: '♾ Всегда', callback_data: cb('allowSession') },
        ],
        [{ text: '❌ Отклонить', callback_data: cb('deny') }],
      ];
  tg.send(`${head}🛡 ${body}`, { roomId: room.id, buttons });
}

function telegramFinished(room, msg) {
  if (msg.parentId || msg.duelId) return;
  const isFollowed = (followed.get(room.id) || 0) > Date.now();
  if (!settings.telegram.notifyFinish && !isFollowed) return;
  const who = msg.agent === 'claude' ? 'Claude' : 'Codex';
  const icon = msg.status === 'error' ? '⚠️' : msg.status === 'stopped' ? '⏹' : '✅';
  const body = msg.error ? esc(`Ошибка: ${msg.error}`) : toTelegram(clip(msg.finalText || '', isFollowed ? 3500 : 1500));
  tg.send(`${icon} <b>${who}</b> · ${esc(room.title)}\n\n${body}`, { roomId: room.id });
}

// ---------- Мини-приложение Telegram ----------

// Картинка для мини-приложения: только изображения и только из папок проектов, вложений и копий
// для сравнения — чтобы по ссылке нельзя было вытащить с компьютера что-то ещё.
function remoteImage(p) {
  if (!p || !/\.(png|jpe?g|gif|webp|bmp)$/i.test(p) || !path.isAbsolute(p)) return null;
  let real;
  try {
    real = fs.realpathSync(p);
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  const userData = app.getPath('userData');
  const roots = [
    ...projects.list(settings).flatMap((w) => w.folders),
    ...rooms.list().map((r) => r.cwd),
    path.join(userData, 'attachments'),
    path.join(userData, 'worktrees'),
    path.join(userData, 'browser'),
  ];
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  return roots.some((root) => {
    let r;
    try {
      r = fs.realpathSync(root);
    } catch {
      return false;
    }
    const rel = path.relative(norm(r), norm(real));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  })
    ? real
    : null;
}

function setupRemote() {

  remote = new RemoteServer({
    root: path.join(__dirname, 'renderer'),
    getAuth: () => ({ token: settings.telegram.token, userId: settings.telegram.userId }),
    api: {
      listRooms: () => rooms.list(),
      getRoom: (id) => rooms.get(id),
      // новые чаты — только в проектах, которые вы уже открывали в DuoCode на компьютере
      createRoom: ({ projectId }) => (projects.get(settings, projectId) ? createRoom({ projectId }) : Promise.reject(new Error('Неизвестный проект'))),
      setRoomSettings: (id, patch) => rooms.updateSettings(id, patch),
      renameRoom: (id, title) => rooms.rename(id, title),
      resend: (id, msgId) => rooms.resend(id, msgId),
      editMessage: (id, msgId, text, opts) => rooms.editMessage(id, msgId, text, opts),
      send: (id, payload) => rooms.send(id, payload),
      stop: (id) => rooms.stop(id),
      approve: (id, approvalId, decision, extra) => rooms.respondApproval(id, approvalId, decision, extra),
      planAction: (id, msgId, action, feedback) => rooms.planAction(id, msgId, action, feedback),
      revert: (id, msgId, redo) => rooms.revert(id, msgId, redo),
      checkpointDiff: (id, msgId, file) => rooms.checkpointDiff(id, msgId, file),
      duelApply: (id, duelId, choice) => rooms.applyDuel(id, duelId, choice),
      limits: () => limits,
      projects: () => projects.list(settings),
    },
    resolveImage: remoteImage,
  });
  tunnel = new Tunnel(path.join(app.getPath('userData'), 'bin'));
  tunnel.on('status', (s) => {
    remoteStatus = s;
    if (win && !win.isDestroyed()) win.webContents.send('remote', s);
    if (s.state === 'ready') tg.setApp(s.url);
    else if (s.state === 'off') tg.setApp(null);
  });
  rooms.on('messages', (roomId, msgs) => remote.broadcast('messages', { roomId, msgs }));
  rooms.on('rooms', (list) => remote.broadcast('rooms', list));
  applyRemote();
}

async function applyRemote() {
  if (!remote) return;
  const t = settings.telegram;
  if (t.remote && t.token && t.userId) {
    const port = await remote.start();
    tunnel.start(port, t.tunnel || 'cloudflare', t.customUrl || '');
  } else {
    tunnel.stop();
  }
}

// ---------- Окно ----------

// Цвета фона тем — для окна и системных кнопок в заголовке (сами темы описаны в styles.css).
const THEMES = {
  dark: { base: 'dark', color: '#141519', symbolColor: '#c9ccd3' },
  light: { base: 'light', color: '#f4f4f2', symbolColor: '#3b3d42' },
  midnight: { base: 'dark', color: '#0d1117', symbolColor: '#c9d1d9' },
  graphite: { base: 'dark', color: '#1e1e1e', symbolColor: '#cccccc' },
  sepia: { base: 'light', color: '#f5efe3', symbolColor: '#3b3226' },
  paper: { base: 'light', color: '#ffffff', symbolColor: '#333333' },
};

function currentTheme() {
  const t = THEMES[settings.appearance.theme];
  if (t) return t;
  return nativeTheme.shouldUseDarkColors ? THEMES.dark : THEMES.light;
}

function applyTheme() {
  const t = THEMES[settings.appearance.theme];
  nativeTheme.themeSource = t ? t.base : 'system';
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(currentTheme().color);
    if (process.platform !== 'darwin') win.setTitleBarOverlay(themeColors());
  }
}

function themeColors() {
  const { color, symbolColor } = currentTheme();
  return { color, symbolColor };
}

function createWindow() {
  const overlay = process.platform === 'darwin' ? {} : { titleBarOverlay: { ...themeColors(), height: 48 } };
  win = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 860,
    minHeight: 560,
    title: 'DuoCode',
    backgroundColor: currentTheme().color,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    ...overlay,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.on('close', (e) => {
    if (settings.general.closeToTray && !app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  nativeTheme.on('updated', () => {
    if (process.platform !== 'darwin' && win && !win.isDestroyed()) win.setTitleBarOverlay(themeColors());
  });
}

function notify(title, body, roomId) {
  if (!win || win.isFocused() || !Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', () => {
    win.show();
    win.focus();
    win.webContents.send('open-room', roomId);
  });
  n.show();
  if (isWin) win.flashFrame(true);
}

// ---------- IPC ----------

function bindIpc() {
  ipcMain.handle('rooms:list', () => rooms.list());
  ipcMain.handle('rooms:get', (_e, id) => rooms.get(id));
  ipcMain.handle('rooms:create', (_e, opts) => createRoom(opts));
  ipcMain.handle('rooms:import', (_e, s) => {
    const project = s.cwd ? rememberProject(s.cwd) : null;
    return rooms.importSession({ ...s, projectId: project && project.id });
  });
  ipcMain.handle('rooms:rename', (_e, id, title) => rooms.rename(id, title));
  ipcMain.handle('rooms:resend', (_e, id, msgId) => rooms.resend(id, msgId));
  ipcMain.handle('rooms:edit', (_e, id, msgId, text, opts) => rooms.editMessage(id, msgId, text, opts));
  ipcMain.handle('rooms:settings', (_e, id, patch) => rooms.updateSettings(id, patch));
  ipcMain.handle('rooms:remove', (_e, id) => rooms.remove(id));
  ipcMain.handle('rooms:send', (_e, id, payload) => rooms.send(id, payload));
  ipcMain.handle('rooms:stop', (_e, id) => rooms.stop(id));
  ipcMain.handle('rooms:approve', (_e, id, approvalId, decision, extra) => rooms.respondApproval(id, approvalId, decision, extra));
  ipcMain.handle('rooms:plan', (_e, id, msgId, action, feedback) => rooms.planAction(id, msgId, action, feedback));

  // Вложения: выбранные файлы берём как есть, вставленные из буфера сохраняем к себе.
  ipcMain.handle('attach:pick', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return res.canceled ? [] : res.filePaths.map(describeFile);
  });
  ipcMain.handle('attach:save', (_e, name, bytes) => {
    const dir = path.join(app.getPath('userData'), 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const safe = (name || 'image.png').replace(/[^\w.\-а-яё ]/gi, '_');
    const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safe}`);
    fs.writeFileSync(file, Buffer.from(bytes));
    return describeFile(file);
  });
  ipcMain.handle('attach:describe', (_e, paths) => paths.filter((p) => fs.existsSync(p)).map(describeFile));

  ipcMain.handle('limits:get', () => limits);
  ipcMain.handle('limits:refresh', () => refreshAllLimits(true).then(() => limits));
  // сессии из терминала, кроме тех, что уже ведёт DuoCode, и временных копий проекта
  ipcMain.handle('history:get', () => {
    const own = new Set();
    for (const r of rooms.rooms.values()) for (const id of Object.values(r.sessions || {})) if (id) own.add(id);
    const worktrees = path.join(app.getPath('userData'), 'worktrees');
    return allSessions()
      .filter((s) => !own.has(s.id) && !(s.cwd || '').startsWith(worktrees) && !/^\s*(<duocode_|\[(Запрос от|Режим сравнения|Режим планирования))/.test(s.title))
      .slice(0, 60);
  });

  ipcMain.handle('codex:models', async () => {
    try {
      const r = await codex.request('model/list', {});
      return (r.data || [])
        .filter((m) => !m.hidden)
        .map((m) => ({
          id: m.model || m.id,
          name: m.displayName || m.model,
          isDefault: !!m.isDefault,
          defaultEffort: m.defaultReasoningEffort || null,
          efforts: (m.supportedReasoningEfforts || []).map((e) => ({ id: e.reasoningEffort, description: e.description })),
        }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('env:check', async () => {
    const [claude, codexCli] = await Promise.all([cliVersion(settings.claudeCommand), cliVersion(settings.codexCommand)]);
    const [claudeAuth, codexAuth] = await Promise.all([
      claude ? cliRun(claude.path, ['auth', 'status', '--json']) : null,
      codexCli ? cliRun(codexCli.path, ['login', 'status']) : null,
    ]);
    if (claude && claudeAuth) {
      try {
        claude.loggedIn = !!JSON.parse(claudeAuth.stdout).loggedIn;
      } catch {
        claude.loggedIn = claudeAuth.code === 0;
      }
    }
    if (codexCli && codexAuth) codexCli.loggedIn = codexAuth.code === 0 && !/not logged in/i.test(codexAuth.stdout + codexAuth.stderr);
    return { claude, codex: codexCli, platform: process.platform };
  });

  ipcMain.handle('auth:login', (_e, agent) => {
    const cmd = resolveCommand(agent === 'claude' ? settings.claudeCommand : settings.codexCommand);
    if (!cmd) return false;
    openLoginConsole(cmd, agent === 'claude' ? ['auth', 'login'] : ['login']);
    return true;
  });

  ipcMain.handle('update:install', () => {
    // тихая установка: без окон установщика, приложение само перезапустится
    if (updater) updater.quitAndInstall(true, true);
  });
  ipcMain.handle('update:check', () => checkForUpdates(true));
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('commands:list', (_e, cwd) => listCommands(cwd));
  ipcMain.handle('files:search', (_e, cwd, q) => searchFiles(foldersOf(cwd), q));

  // проекты
  ipcMain.handle('projects:save', (_e, input) => {
    const p = projects.save(settings, input);
    saveSettings();
    win.webContents.send('settings', settings);
    rooms.emitRooms();
    return p;
  });
  ipcMain.handle('projects:remove', (_e, id) => {
    projects.remove(settings, id);
    saveSettings();
    win.webContents.send('settings', settings);
    rooms.emitRooms();
  });
  ipcMain.handle('projects:pickFolders', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections', 'createDirectory'] });
    return res.canceled ? [] : res.filePaths;
  });

  // откат правок и дуэль
  ipcMain.handle('rooms:revert', (_e, id, msgId, redo) => rooms.revert(id, msgId, redo));
  ipcMain.handle('rooms:checkpointDiff', (_e, id, msgId, file) => rooms.checkpointDiff(id, msgId, file));
  ipcMain.handle('rooms:duelApply', (_e, id, duelId, choice) => rooms.applyDuel(id, duelId, choice));
  ipcMain.handle('rooms:search', (_e, q) => rooms.search(q));
  ipcMain.handle('rooms:export', async (_e, id) => {
    const room = rooms.get(id);
    if (!room) return false;
    const res = await dialog.showSaveDialog(win, {
      defaultPath: `${room.title.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60)}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return false;
    fs.writeFileSync(res.filePath, rooms.exportMarkdown(id));
    shell.showItemInFolder(res.filePath);
    return true;
  });

  // панель Git
  ipcMain.handle('git:status', (_e, cwd) => gitx.status(cwd));
  ipcMain.handle('git:diff', (_e, cwd, file, kind) => gitx.fileDiff(cwd, file, kind));
  ipcMain.handle('git:revert', (_e, cwd, file, kind) => gitx.revertFile(cwd, file, kind));
  ipcMain.handle('git:commit', (_e, cwd, message) => gitx.commitAll(cwd, message));
  ipcMain.handle('git:push', (_e, cwd) => gitx.push(cwd));
  ipcMain.handle('git:init', (_e, cwd) => gitx.init(cwd));
  ipcMain.handle('git:message', (_e, cwd) => commitMessage(cwd));

  // общая память проекта
  ipcMain.handle('memory:get', (_e, cwd) => ({ text: memory.read(cwd), file: memory.file(cwd) }));
  ipcMain.handle('memory:set', (_e, cwd, text) => memory.write(cwd, text));

  // статистика
  ipcMain.handle('stats:get', async () => ({ daily: await dailyUsage(14), chats: chatStats() }));

  // Telegram
  ipcMain.handle('telegram:status', () => ({ status: tg.status, bot: tg.bot, chatId: tg.chatId }));
  ipcMain.handle('telegram:test', () => tg.send('👋 Тестовое сообщение от DuoCode. Уведомления работают.'));
  ipcMain.handle('remote:status', () => ({ ...remoteStatus, port: remote && remote.port }));

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    const restartCodex = patch.codexCommand && patch.codexCommand !== settings.codexCommand;
    settings = {
      ...settings,
      ...patch,
      newChat: { ...settings.newChat, ...(patch.newChat || {}) },
      appearance: { ...settings.appearance, ...(patch.appearance || {}) },
      telegram: { ...settings.telegram, ...(patch.telegram || {}) },
      general: { ...settings.general, ...(patch.general || {}) },
    };
    saveSettings();
    if (patch.telegram) {
      if (patch.telegram.userId !== undefined) delete settings.telegram.suggestedId;
      saveSettings();
      tg.configure(settings.telegram);
      applyRemote();
    }
    if (patch.general) applyGeneral();
    if (patch.appearance) {
      applyTheme();
      if (win && !win.isDestroyed()) win.webContents.send('settings', settings);
    }
    if (restartCodex) codex.stop();
    return settings;
  });

  ipcMain.handle('project:pick', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });
  ipcMain.handle('project:open', (_e, dir) => dir && shell.openPath(dir));
  ipcMain.handle('file:open', (_e, cwd, file) => {
    if (!file) return;
    const full = path.isAbsolute(file) ? file : path.join(cwd || '', file);
    // файл мог создать агент: исполняемые и скрипты не запускаем, а показываем в папке
    if (RUNNABLE.test(full)) shell.showItemInFolder(full);
    else shell.openPath(full);
  });
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text || '')));
  ipcMain.handle('browser:bounds', (_e, rect) => browser && browser.setBounds(rect));
  ipcMain.handle('browser:state', () => (browser ? browser.state() : null));
  ipcMain.handle('browser:user', (_e, action, arg) => browser && browser.user(action, arg));
  ipcMain.handle('browser:external', (_e) => {
    const url = browser && browser.state().url;
    if (url && /^https?:/i.test(url)) shell.openExternal(url);
  });
}

// ---------- Старт ----------

app.whenReady().then(async () => {
  loadSettings();
  const userData = app.getPath('userData');
  codex = new CodexServer(() => settings.codexCommand);
  const bridge = await startBridge(() => rooms);
  // встроенный браузер для агентов (вкладка «Браузер» боковой панели)
  browser = new AgentBrowser({ getWindow: () => win, shotDir: path.join(userData, 'browser') });
  browser.on('state', (st) => win && !win.isDestroyed() && win.webContents.send('browser', st));
  browser.on('show', (roomId) => win && !win.isDestroyed() && win.webContents.send('browser-show', roomId));
  rooms = new Rooms({
    browser,
    store: new Store(path.join(userData, 'rooms')),
    runDir: path.join(userData, 'run'),
    bridge,
    codex,
    getSettings: () => settings,
    checkpoints: new gitx.Checkpoints(path.join(userData, 'checkpoints')),
    worktreeDir: path.join(userData, 'worktrees'),
    pickAgent,
  });

  // Ходы, упавшие из-за пропавшего интернета: раз в 15 секунд проверяем связь и, когда она вернулась, продолжаем.
  setInterval(async () => {
    if (!rooms.waitingForNetwork()) return;
    const ok = await Promise.any(
      ['https://api.anthropic.com', 'https://chatgpt.com'].map((u) => fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).then(() => true)),
    ).catch(() => false);
    if (ok) rooms.resumeAfterNetwork();
  }, 15000);

  // чаты из версий без проектов: привязываем к проекту их папки
  let migrated = false;
  for (const r of rooms.rooms.values()) {
    if (r.projectId || !r.cwd) continue;
    const { project, created } = projects.forFolder(settings, r.cwd);
    r.projectId = project.id;
    rooms.store.save(r);
    migrated = migrated || created;
  }
  if (migrated) saveSettings();

  rooms.on('messages', (roomId, msgs) => win && !win.isDestroyed() && win.webContents.send('messages', roomId, msgs));
  rooms.on('rooms', (list) => win && !win.isDestroyed() && win.webContents.send('rooms', list));
  rooms.on('claude-ratelimit', onClaudeRateLimit);
  rooms.on('attention', (room, msg, part) => {
    notify(`${room.title}: ${part.kind === 'question' ? 'вопрос агента' : 'нужно подтверждение'}`, part.title || (part.questions && part.questions[0] && part.questions[0].question) || '', room.id);
    telegramAttention(room, msg, part);
  });
  rooms.on('messages', (roomId, msgs) => trackProgress(roomId, msgs));
  rooms.on('reset', (id) => {
    if (win && !win.isDestroyed()) win.webContents.send('room-reset', id);
    if (remote) remote.broadcast('reset', { roomId: id });
  });
  rooms.on('memory', (cwd) => win && !win.isDestroyed() && win.webContents.send('memory', cwd));
  rooms.on('finished', (room, msg) => {
    if (msg.parentId) return;
    notify(`${msg.agent === 'claude' ? 'Claude' : 'Codex'} закончил`, room.title, room.id);
    telegramFinished(room, msg);
    refreshToday();
  });
  codex.on('ratelimits', onCodexRateLimit);

  bindIpc();
  nativeTheme.themeSource = THEMES[settings.appearance.theme] ? THEMES[settings.appearance.theme].base : 'system';
  createWindow();
  win.on('focus', () => isWin && win.flashFrame(false));

  refreshAllLimits();
  setupUpdater();
  setupTray();
  applyGeneral();
  setupTelegram();
  setupRemote();
  ipcMain.handle('update:get', () => update);
  setInterval(() => refreshClaudeLimits(), Math.max(3, settings.refreshMinutes) * 60 * 1000);
  setInterval(refreshCodexLimits, Math.max(1, settings.refreshMinutes) * 60 * 1000);
  setInterval(refreshToday, 2 * 60 * 1000);

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('before-quit', () => {
  app.isQuitting = true;
  if (tunnel) tunnel.stop();
  if (rooms) rooms.shutdown();
  if (codex) codex.stop();
});

app.on('window-all-closed', () => app.quit());
