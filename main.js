const { app, BrowserWindow, ipcMain, dialog, shell, Notification, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { fixPath, resolveCommand, isWin } = require('./src/env');
const { Store } = require('./src/store');
const { Rooms } = require('./src/rooms');
const { CodexServer } = require('./src/agents/codex');
const { getClaudeLimits } = require('./src/claudeLimits');
const { getCodexLimits, parseRateLimits } = require('./src/codexLimits');
const { allSessions, claudeToday, codexToday } = require('./src/history');
const { listCommands } = require('./src/commands');

fixPath();

if (!app.requestSingleInstanceLock()) app.quit();

// ---------- Настройки ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
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
const defaults = { projects: [], claudeCommand: 'claude', codexCommand: 'codex', refreshMinutes: 3, appearance: APPEARANCE };
let settings = { ...defaults };

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...defaults, ...saved, appearance: { ...APPEARANCE, ...(saved.appearance || {}) } };
  } catch {
    settings = { ...defaults };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

function rememberProject(dir) {
  settings.projects = [dir, ...settings.projects.filter((p) => p !== dir)].slice(0, 20);
  saveSettings();
}

// ---------- Мост для MCP-инструментов агентов ----------

function startBridge(rooms) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
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
        if (call.token !== token) out = { isError: true, text: 'Неверный токен DuoCode' };
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
let codex;
const limits = { claude: null, codex: null, today: null };

function sendLimits() {
  if (win && !win.isDestroyed()) win.webContents.send('limits', limits);
}

async function refreshClaudeLimits() {
  const res = await getClaudeLimits().catch((err) => ({ ok: false, error: err.message }));
  // если API недоступен, но Claude Code уже присылал лимиты — оставляем их
  if (!res.ok && limits.claude && limits.claude.ok && limits.claude.source === 'cli') return;
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

async function refreshAllLimits() {
  refreshToday();
  await Promise.all([refreshClaudeLimits(), refreshCodexLimits()]);
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
    ...overlay,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
  ipcMain.handle('rooms:create', (_e, opts) => {
    rememberProject(opts.cwd);
    return rooms.create(opts);
  });
  ipcMain.handle('rooms:import', (_e, s) => {
    if (s.cwd) rememberProject(s.cwd);
    return rooms.importSession(s);
  });
  ipcMain.handle('rooms:rename', (_e, id, title) => rooms.rename(id, title));
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
  ipcMain.handle('limits:refresh', () => refreshAllLimits().then(() => limits));
  ipcMain.handle('history:get', () => allSessions().slice(0, 60));

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

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    const restartCodex = patch.codexCommand && patch.codexCommand !== settings.codexCommand;
    settings = { ...settings, ...patch, appearance: { ...settings.appearance, ...(patch.appearance || {}) } };
    saveSettings();
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
    shell.openPath(path.isAbsolute(file) ? file : path.join(cwd || '', file));
  });
}

// ---------- Старт ----------

app.whenReady().then(async () => {
  loadSettings();
  const userData = app.getPath('userData');
  codex = new CodexServer(() => settings.codexCommand);
  const bridge = await startBridge(() => rooms);
  rooms = new Rooms({
    store: new Store(path.join(userData, 'rooms')),
    runDir: path.join(userData, 'run'),
    bridge,
    codex,
    getSettings: () => settings,
  });

  rooms.on('messages', (roomId, msgs) => win && !win.isDestroyed() && win.webContents.send('messages', roomId, msgs));
  rooms.on('rooms', (list) => win && !win.isDestroyed() && win.webContents.send('rooms', list));
  rooms.on('claude-ratelimit', onClaudeRateLimit);
  rooms.on('attention', (room, msg, part) => notify(`${room.title}: нужно подтверждение`, part.title, room.id));
  rooms.on('finished', (room, msg) => {
    if (msg.parentId) return;
    notify(`${msg.agent === 'claude' ? 'Claude' : 'Codex'} закончил`, room.title, room.id);
    refreshToday();
  });
  codex.on('ratelimits', onCodexRateLimit);

  bindIpc();
  nativeTheme.themeSource = THEMES[settings.appearance.theme] ? THEMES[settings.appearance.theme].base : 'system';
  createWindow();
  win.on('focus', () => isWin && win.flashFrame(false));

  refreshAllLimits();
  setupUpdater();
  ipcMain.handle('update:get', () => update);
  setInterval(refreshClaudeLimits, Math.max(1, settings.refreshMinutes) * 60 * 1000);
  setInterval(refreshCodexLimits, Math.max(1, settings.refreshMinutes) * 60 * 1000);
  setInterval(refreshToday, 2 * 60 * 1000);

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
});

app.on('before-quit', () => {
  if (rooms) rooms.shutdown();
  if (codex) codex.stop();
});

app.on('window-all-closed', () => app.quit());
