// Встроенный браузер для агентов: показывается во вкладке «Браузер» боковой панели, агенты управляют им
// через инструменты browser_* (мост MCP), пользователь видит всё вживую.
// Отдельная сессия (persist:duo-browser): чужие куки и пароли из системного браузера ему недоступны.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { WebContentsView } = require('electron');

const KEYS = { enter: 'Enter', tab: 'Tab', escape: 'Escape', backspace: 'Backspace', up: 'Up', down: 'Down', left: 'Left', right: 'Right', pagedown: 'PageDown', pageup: 'PageUp' };

// Скрипт в странице: текст и пронумерованные элементы, с которыми можно что-то сделать.
const READ_PAGE = `(() => {
  const sel = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem], [contenteditable=""], [contenteditable=true], [onclick]';
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
  document.querySelectorAll('[data-duo-i]').forEach((el) => el.removeAttribute('data-duo-i'));
  const items = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el) || items.length >= 150) continue;
    const i = items.length + 1;
    el.setAttribute('data-duo-i', i);
    const tag = el.tagName.toLowerCase();
    const kind = el.getAttribute('role') || (tag === 'input' ? 'input:' + (el.type || 'text') : tag);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.getAttribute('href') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const r = el.getBoundingClientRect();
    const where = r.bottom < 0 || r.top > innerHeight ? ' (вне экрана)' : '';
    items.push('[' + i + '] ' + kind + ' «' + label + '»' + where);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  const pos = Math.round(scrollY) + '/' + Math.max(0, document.documentElement.scrollHeight - innerHeight);
  return { title: document.title, url: location.href, scroll: pos, text: text.slice(0, 6000), cut: text.length > 6000, items };
})()`;

class AgentBrowser extends EventEmitter {
  constructor({ getWindow, shotDir }) {
    super();
    this.getWindow = getWindow;
    this.shotDir = shotDir;
    this.view = null;
    this.bounds = null; // где панель показывает браузер; null — панель закрыта
    this.driver = null; // кто сейчас управляет: { agent, roomId, at }
  }

  ensure() {
    if (this.view) return this.view;
    const view = new WebContentsView({ webPreferences: { partition: 'persist:duo-browser', sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const wc = view.webContents;
    // новые окна открываем здесь же, только http(s)
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) wc.loadURL(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => !/^(https?|about):/i.test(url) && e.preventDefault());
    wc.session.on('will-download', (e) => e.preventDefault());
    wc.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-fail-load']) wc.on(ev, () => this.emitState());
    this.view = view;
    if (this.bounds) this.attach();
    return view;
  }

  state() {
    const wc = this.view && this.view.webContents;
    return {
      url: wc ? wc.getURL() : '',
      title: wc ? wc.getTitle() : '',
      loading: wc ? wc.isLoading() : false,
      canBack: wc ? wc.navigationHistory.canGoBack() : false,
      canForward: wc ? wc.navigationHistory.canGoForward() : false,
      driver: this.driver && Date.now() - this.driver.at < 8000 ? this.driver.agent : null,
    };
  }

  emitState() {
    this.emit('state', this.state());
  }

  attach() {
    const win = this.getWindow();
    if (!win || !this.view) return;
    win.contentView.addChildView(this.view);
    this.view.setBounds(this.bounds);
  }

  // Панель сообщает, где показывать браузер (или null — спрятать).
  setBounds(rect) {
    this.bounds = rect && rect.width > 20 && rect.height > 20 ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null;
    const win = this.getWindow();
    if (!this.view || !win) return;
    if (this.bounds) this.attach();
    else win.contentView.removeChildView(this.view);
  }

  // Агент начинает действие: показываем браузер пользователю и ждём, пока панель его разместит.
  async drive(agent, roomId) {
    this.ensure();
    this.driver = { agent, roomId, at: Date.now() };
    this.emitState();
    if (!this.bounds) {
      this.emit('show', roomId);
      for (let i = 0; i < 20 && !this.bounds; i++) await new Promise((r) => setTimeout(r, 100));
    }
    clearTimeout(this.driverTimer);
    this.driverTimer = setTimeout(() => this.emitState(), 8500);
  }

  async open(url) {
    let u = String(url || '').trim();
    if (!u) throw new Error('Не указан адрес');
    if (!/^[a-z]+:/i.test(u)) u = (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(u) ? 'http://' : 'https://') + u;
    if (!/^https?:/i.test(u)) throw new Error('Можно открывать только http(s) адреса');
    const wc = this.ensure().webContents;
    await Promise.race([wc.loadURL(u).catch((err) => { if (!/ERR_ABORTED/.test(err.message)) throw err; }), new Promise((r) => setTimeout(r, 20000))]);
    await this.settle();
    return this.read();
  }

  async settle(ms = 400) {
    const wc = this.view.webContents;
    for (let i = 0; i < 50 && wc.isLoading(); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, ms));
  }

  async read() {
    const wc = this.ensure().webContents;
    if (!wc.getURL()) return 'Браузер пуст: сначала откройте страницу (browser_open).';
    const p = await wc.executeJavaScript(READ_PAGE, true);
    return [
      `Страница: ${p.title || '(без заголовка)'} — ${p.url}`,
      `Прокрутка: ${p.scroll} px`,
      '',
      'Элементы (номер — для browser_click / browser_type):',
      p.items.length ? p.items.join('\n') : '(нет)',
      '',
      'Текст страницы:',
      p.text + (p.cut ? '\n…(обрезано)' : ''),
    ].join('\n');
  }

  async point(index) {
    const wc = this.view.webContents;
    const r = await wc.executeJavaScript(
      `(() => { const el = document.querySelector('[data-duo-i="${Number(index)}"]'); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
      true,
    );
    if (!r) throw new Error(`Элемент [${index}] не найден — сначала вызовите browser_read, номера меняются при каждом чтении`);
    await new Promise((res) => setTimeout(res, 150));
    return r;
  }

  async click({ index, x, y }) {
    const wc = this.ensure().webContents;
    const p = index != null ? await this.point(index) : { x: Number(x), y: Number(y) };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('Укажите номер элемента (index) или координаты x, y');
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 });
    await this.settle(600);
    return `Нажато ${index != null ? `[${index}]` : `(${Math.round(p.x)}, ${Math.round(p.y)})`}. Сейчас: ${wc.getTitle()} — ${wc.getURL()}`;
  }

  async type({ text = '', index, submit = false, key }) {
    const wc = this.ensure().webContents;
    if (index != null) await this.click({ index });
    if (text) await wc.insertText(String(text));
    const k = key ? KEYS[String(key).toLowerCase()] || key : submit ? 'Enter' : null;
    if (k) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: k });
      wc.sendInputEvent({ type: 'keyUp', keyCode: k });
    }
    await this.settle(k ? 700 : 200);
    return `Введено${text ? ` «${String(text).slice(0, 60)}»` : ''}${k ? `, нажата ${k}` : ''}. Сейчас: ${wc.getTitle()} — ${wc.getURL()}`;
  }

  async scroll({ direction = 'down', amount }) {
    const wc = this.ensure().webContents;
    const dy = (direction === 'up' ? -1 : 1) * (Number(amount) || 600);
    const pos = await wc.executeJavaScript(`(() => { window.scrollBy({ top: ${dy}, behavior: 'smooth' }); return new Promise((r) => setTimeout(() => r(Math.round(scrollY) + '/' + Math.max(0, document.documentElement.scrollHeight - innerHeight)), 450)); })()`, true);
    return `Прокручено ${direction === 'up' ? 'вверх' : 'вниз'} на ${Math.abs(dy)} px, позиция ${pos} px.`;
  }

  async back() {
    const wc = this.ensure().webContents;
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    await this.settle();
    return `Сейчас: ${wc.getTitle()} — ${wc.getURL()}`;
  }

  // Снимок видимой части страницы: файл для чата и уменьшенная копия для агента.
  async screenshot() {
    const wc = this.ensure().webContents;
    if (!wc.getURL()) throw new Error('Браузер пуст: сначала откройте страницу (browser_open).');
    let img = await wc.capturePage();
    if (img.isEmpty()) throw new Error('Не удалось снять страницу: откройте вкладку «Браузер» в DuoCode');
    const { width } = img.getSize();
    if (width > 1280) img = img.resize({ width: 1280 });
    fs.mkdirSync(this.shotDir, { recursive: true });
    const file = path.join(this.shotDir, `shot-${Date.now()}.png`);
    const png = img.toPNG();
    fs.writeFileSync(file, png);
    return { file, data: png.toString('base64'), mimeType: 'image/png' };
  }

  // Действия из панели (пользователь сам вводит адрес, жмёт «назад» и т. п.)
  async user(action, arg) {
    const wc = this.ensure().webContents;
    if (action === 'open') return this.open(arg).then(() => true);
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
    if (action === 'stop') wc.stop();
    return true;
  }
}

module.exports = { AgentBrowser };
