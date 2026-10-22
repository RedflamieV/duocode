// Telegram-бот: уведомления, подтверждения и ответы на вопросы агентов с телефона.
// Работает через long polling (getUpdates), сервер не нужен.
// Безопасность: бот слушается только одного аккаунта — по Telegram ID из настроек, и только в личном чате.
// Всё остальное игнорируется, а о попытках чужих аккаунтов DuoCode сообщает владельцу.
const fs = require('fs');
const { EventEmitter } = require('events');
const { esc, plain } = require('./tgformat');

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const LIMIT = 4096;
// Сообщения старше этого пришли, пока DuoCode был выключен или компьютер спал (Telegram хранит их до суток).
// Такие задачи не запускаем сами — иначе после включения всё накопленное налетело бы разом.
const STALE_SEC = 120;
const OFFLINE = /fetch failed|TypeError|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|ENETDOWN|socket|network|timeout|aborted/i;

class Telegram extends EventEmitter {
  constructor() {
    super();
    this.token = null;
    this.userId = null; // единственный аккаунт, которому бот подчиняется (в личке chat.id совпадает с ним)
    this.offset = 0;
    this.loopId = 0;
    this.bot = null;
    this.rooms = new Map(); // message_id -> roomId (для ответов на сообщения бота)
    this.appUrl = null; // адрес мини-приложения, когда туннель поднят
    this.base = process.env.DUO_TELEGRAM_API || 'https://api.telegram.org'; // подмена — только для тестов
    this.status = 'off';
    this.backlog = []; // задачи, присланные, пока DuoCode был недоступен
    this.outbox = []; // уведомления, не ушедшие из-за пропавшего интернета
    this.backlogTimer = null;
    this.roomsFile = null;
  }

  // Связь «сообщение бота → чат» переживает перезапуск: ответ (Reply) на старое уведомление
  // после включения компьютера уйдёт в тот же чат, а не в выбранный сейчас.
  persistRooms(file) {
    this.roomsFile = file;
    try {
      this.rooms = new Map(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {}
  }

  rememberRoom(messageId, roomId) {
    this.rooms.set(messageId, roomId);
    if (this.rooms.size > 500) this.rooms.delete(this.rooms.keys().next().value);
    if (!this.roomsFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      fs.promises.writeFile(this.roomsFile, JSON.stringify([...this.rooms])).catch(() => {});
    }, 2000);
  }

  configure({ token, userId }) {
    const id = /^\d{4,15}$/.test(String(userId || '').trim()) ? String(userId).trim() : null;
    const changed = token !== this.token || id !== this.userId;
    this.token = token || null;
    this.userId = id;
    if (changed) this.restart();
  }

  get chatId() {
    return this.userId;
  }

  // Сообщение с HTML-разметкой. Если обрезка порвала бы теги или Telegram не принял разметку,
  // отправляем тот же текст без оформления — лучше без выделения, чем потерять ответ.
  async rich(method, html, params) {
    const text = plain(html);
    if (html.length <= LIMIT) {
      try {
        return await this.api(method, { ...params, text: html, parse_mode: 'HTML' });
      } catch (err) {
        if (!/parse entities|can't find end|unsupported start tag|message is too long/i.test(err.message)) throw err;
      }
    }
    return this.api(method, { ...params, text: clip(text, LIMIT) });
  }

  async api(method, params = {}) {
    const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 70000 : 20000),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.description || `Telegram: ${method} не удался`);
    return json.result;
  }

  setStatus(status, error = null) {
    this.status = status;
    this.emit('status', { status, error, bot: this.bot, chatId: this.chatId });
  }

  async restart() {
    const id = ++this.loopId;
    this.bot = null;
    if (!this.token) return this.setStatus('off');
    try {
      const me = await this.api('getMe');
      this.bot = me.username;
      if (this.userId) {
        await this.api('setMyCommands', {
          scope: { type: 'chat', chat_id: Number(this.userId) },
          commands: [
            { command: 'chats', description: 'Выбрать чат' },
            { command: 'new', description: 'Новый чат в проекте' },
            { command: 'to', description: 'Кому писать: Claude, Codex, оба, авто' },
            { command: 'plan', description: 'Задача в режиме «сначала план»' },
            { command: 'pause', description: 'Пауза — продолжить можно потом' },
            { command: 'resume', description: 'Продолжить после паузы' },
            { command: 'stop', description: 'Остановить агентов' },
            { command: 'rename', description: 'Переименовать чат' },
            { command: 'limits', description: 'Лимиты' },
            { command: 'app', description: 'Мини-приложение' },
            { command: 'help', description: 'Как пользоваться' },
          ],
        }).catch(() => {});
      }
      this.setStatus(this.userId ? 'linked' : 'needId');
      // бот (пере)подключился — кнопка мини-приложения должна вести на текущий адрес
      if (this.userId && this.appUrl !== undefined && !this.appApplied) this.setApp(this.appUrl);
    } catch (err) {
      // например, DuoCode запустился вместе с Windows раньше, чем появился интернет, — пробуем снова
      this.setStatus('error', `${err.message}. Повтор через 20 секунд…`);
      setTimeout(() => id === this.loopId && this.restart(), 20000);
      return;
    }
    while (id === this.loopId) {
      try {
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        if (this.status === 'error') this.setStatus(this.userId ? 'linked' : 'needId');
        if (this.outbox.length) this.flushOutbox();
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch(() => {});
        }
      } catch (err) {
        if (id !== this.loopId) return;
        this.setStatus('error', err.message);
        await new Promise((r) => setTimeout(r, 15000));
        if (id === this.loopId) this.setStatus(this.userId ? 'linked' : 'needId');
      }
    }
  }

  // Сообщение или нажатие кнопки от владельца: его ID и только личный чат с ботом.
  isOwner(from, chat) {
    return !!this.userId && from && String(from.id) === this.userId && chat && chat.type === 'private' && String(chat.id) === this.userId;
  }

  async stranger(from, chat, what) {
    if (!chat) return;
    if (chat.type !== 'private') {
      // ботом пытаются пользоваться в группе — уходим оттуда
      await this.api('leaveChat', { chat_id: chat.id }).catch(() => {});
    }
    const who = from ? `${from.first_name || ''} ${from.last_name || ''}`.trim() + (from.username ? ` (@${from.username})` : '') : 'неизвестный';
    // чтобы чужой аккаунт не мог засыпать владельца уведомлениями: о каждом — не чаще раза в полчаса,
    // и не больше десяти уведомлений в час всего
    const now = Date.now();
    if (!this.noticed) this.noticed = new Map();
    const key = String(from ? from.id : chat.id);
    const recent = [...this.noticed.values()].filter((t) => now - t < 3600000).length;
    if (now - (this.noticed.get(key) || 0) < 30 * 60000 || recent >= 10) return;
    this.noticed.set(key, now);
    if (this.noticed.size > 500) this.noticed.delete(this.noticed.keys().next().value);
    this.emit('intrusion', { id: from && from.id, who, what });
    if (this.userId) {
      await this.api('sendMessage', {
        chat_id: this.userId,
        text: `⚠️ Чужой аккаунт пытался управлять ботом и был проигнорирован.\nКто: ${who}, ID ${from ? from.id : '?'}\nЧто: ${what}`,
      }).catch(() => {});
    }
  }

  async handle(u) {
    if (u.message) {
      const m = u.message;
      if (!this.userId) {
        // ID ещё не задан: подсказываем владельцу его ID и больше ничего не делаем
        if (m.chat.type === 'private' && /^\/start/.test(m.text || '')) {
          await this.api('sendMessage', {
            chat_id: m.chat.id,
            text: `Ваш Telegram ID: ${m.from.id}\n\nВпишите его в DuoCode → Настройки → Telegram → «Ваш Telegram ID». Пока ID не указан, бот никого не слушается.`,
          });
        }
        return;
      }
      if (!this.isOwner(m.from, m.chat)) return this.stranger(m.from, m.chat, `сообщение «${clip(m.text || '(не текст)', 80)}»`);
      const text = m.text || m.caption || '';
      const replyRoom = m.reply_to_message && this.rooms.get(m.reply_to_message.message_id);
      // фото и документы — вложения к задаче
      const photo = m.photo && m.photo.length ? m.photo[m.photo.length - 1] : null;
      const file = photo ? { id: photo.file_id, name: `photo-${m.message_id}.jpg` } : m.document ? { id: m.document.file_id, name: m.document.file_name || `file-${m.message_id}` } : null;
      const cmd = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text);
      if (Date.now() / 1000 - m.date > STALE_SEC) {
        // пришло, пока DuoCode был выключен: копим и спрашиваем владельца одним сообщением
        this.backlog.push(cmd && !file ? { command: cmd[1].toLowerCase(), date: m.date } : { text, file, roomId: replyRoom || null, date: m.date });
        clearTimeout(this.backlogTimer);
        this.backlogTimer = setTimeout(() => {
          const items = this.backlog;
          this.backlog = [];
          if (items.length) this.emit('backlog', items);
        }, 2000);
        return;
      }
      if (cmd && !file) {
        this.emit('command', { name: cmd[1].toLowerCase(), args: cmd[2].trim() });
        return;
      }
      if (text || file) this.emit('text', { text, file, roomId: replyRoom || null });
      return;
    }
    if (u.callback_query) {
      const q = u.callback_query;
      if (!q.message || !this.isOwner(q.from, q.message.chat)) {
        await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'Нет доступа' }).catch(() => {});
        return this.stranger(q.from, q.message && q.message.chat, 'нажатие кнопки');
      }
      const [kind, a, b, c] = (q.data || '').split('|');
      if (kind === 'a' || kind === 'q') {
        // слушатель ставит ok = false, если агент уже не ждёт ответа (например, DuoCode перезапускался)
        const res = { ok: false };
        this.emit(kind === 'a' ? 'approval' : 'answer', { roomId: a, partId: b, value: c, res });
        await this.api('answerCallbackQuery', { callback_query_id: q.id, text: res.ok ? 'Готово' : 'Запрос устарел: агент уже не ждёт ответа' }).catch(() => {});
        const label = !res.ok ? '⌛ Устарело' : kind === 'a' ? (c === 'deny' ? '❌ Отклонено' : '✅ Разрешено') : '✅ Ответ отправлен';
        await this.api('editMessageReplyMarkup', { chat_id: this.userId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'x' }]] } }).catch(() => {});
        return;
      }
      await this.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
      if (kind === 'c') this.emit('button', { action: a, value: b, messageId: q.message.message_id });
    }
  }

  // ---------- Помощники для режима «управление в чате» ----------

  say(html, buttons) {
    if (!this.token || !this.userId) return Promise.resolve(null);
    return this.rich('sendMessage', html, {
      chat_id: this.userId,
      disable_web_page_preview: true,
      reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
    }).catch(() => null);
  }

  edit(messageId, html, buttons) {
    return this.rich('editMessageText', html, {
      chat_id: this.userId,
      message_id: messageId,
      disable_web_page_preview: true,
      reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
    }).catch(() => null);
  }

  remove(messageId) {
    return this.api('deleteMessage', { chat_id: this.userId, message_id: messageId }).catch(() => null);
  }

  typing() {
    return this.api('sendChatAction', { chat_id: this.userId, action: 'typing' }).catch(() => null);
  }

  // Скачивает присланный файл и возвращает его байты.
  async download(fileId) {
    const f = await this.api('getFile', { file_id: fileId });
    const res = await fetch(`${this.base}/file/bot${this.token}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Кнопка «DuoCode» слева от поля ввода в чате с ботом открывает мини-приложение.
  // Кнопка «DuoCode» у поля ввода в чате с ботом. После перезапуска туннеля адрес новый — если Telegram
  // в этот момент недоступен, повторяем, пока не получится (иначе кнопка вела бы на мёртвый адрес).
  async setApp(url) {
    this.appUrl = url || null;
    this.appApplied = false;
    clearTimeout(this.appTimer);
    if (!this.token || !this.userId) return;
    const menu = url ? { type: 'web_app', text: 'DuoCode', web_app: { url } } : { type: 'default' };
    try {
      await this.api('setChatMenuButton', { chat_id: Number(this.userId), menu_button: menu });
      if (this.appUrl === (url || null)) this.appApplied = true;
    } catch {
      this.appTimer = setTimeout(() => this.appUrl === (url || null) && this.setApp(url), 30000);
    }
  }

  appButton(roomId) {
    if (!this.appUrl) return null;
    return { text: '📱 Открыть чат', web_app: { url: roomId ? `${this.appUrl}/?room=${encodeURIComponent(roomId)}` : this.appUrl } };
  }

  sendApp(text) {
    return this.api('sendMessage', { chat_id: this.userId, text, reply_markup: { inline_keyboard: [[{ text: '📱 Открыть DuoCode', web_app: { url: this.appUrl } }]] } }).catch(() => {});
  }

  async send(html, { roomId, buttons } = {}) {
    if (!this.token || !this.userId) return null;
    try {
      const msg = await this.rich('sendMessage', html, {
        chat_id: this.userId,
        disable_web_page_preview: true,
        reply_markup: (() => {
          const rows = buttons ? [...buttons] : [];
          const app = this.appButton(roomId);
          if (app) rows.push([app]);
          return rows.length ? { inline_keyboard: rows } : undefined;
        })(),
      });
      if (roomId) this.rememberRoom(msg.message_id, roomId);
      return msg;
    } catch (err) {
      // нет интернета — уведомление не теряем: отправим, как только связь с Telegram вернётся
      if (OFFLINE.test(`${err.name} ${err.message} ${err.cause && err.cause.code}`)) {
        this.outbox.push({ html, roomId, buttons, at: Date.now() });
        if (this.outbox.length > 30) this.outbox.shift();
        return null;
      }
      const hint = /chat not found|bot can't initiate|blocked/i.test(err.message) ? 'Откройте своего бота в Telegram и нажмите «Старт».' : err.message;
      this.emit('status', { status: 'error', error: hint, bot: this.bot, chatId: this.userId });
      return null;
    }
  }

  // Связь вернулась: досылаем то, что не ушло (старше 6 часов — уже неактуально), с пометкой о задержке.
  async flushOutbox() {
    const items = this.outbox.splice(0).filter((m) => Date.now() - m.at < 6 * 3600 * 1000);
    for (const m of items) {
      const min = Math.round((Date.now() - m.at) / 60000);
      await this.send(`${m.html}\n\n<i>⏱ ${min ? `${min} мин назад` : 'только что'}, пока не было интернета</i>`, { roomId: m.roomId, buttons: m.buttons });
    }
  }
}

module.exports = { Telegram, esc, clip };
