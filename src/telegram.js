// Telegram-бот: уведомления, подтверждения и ответы на вопросы агентов с телефона.
// Работает через long polling (getUpdates), сервер не нужен.
// Безопасность: бот слушается только одного аккаунта — по Telegram ID из настроек, и только в личном чате.
// Всё остальное игнорируется, а о попытках чужих аккаунтов DuoCode сообщает владельцу.
const { EventEmitter } = require('events');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

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
    this.status = 'off';
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

  async api(method, params = {}) {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
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
      this.setStatus(this.userId ? 'linked' : 'needId');
    } catch (err) {
      return this.setStatus('error', err.message);
    }
    while (id === this.loopId) {
      try {
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
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
      if (/^\/app/.test(m.text || '')) {
        if (this.appUrl) await this.sendApp('📱 Управление DuoCode на компьютере:');
        else await this.api('sendMessage', { chat_id: this.userId, text: 'Мини-приложение выключено. Включите его в DuoCode → Настройки → Telegram.' });
        return;
      }
      if (/^\/start/.test(m.text || '')) {
        await this.api('sendMessage', { chat_id: this.userId, text: '✅ DuoCode подключён. Сюда будут приходить уведомления и запросы подтверждений. Чтобы написать агентам, ответьте (Reply) на сообщение нужного чата.' });
        return;
      }
      const reply = m.reply_to_message && this.rooms.get(m.reply_to_message.message_id);
      if (reply && m.text) this.emit('reply', { roomId: reply, text: m.text });
      else if (m.text && !/^\/start/.test(m.text)) {
        await this.api('sendMessage', { chat_id: chat, text: 'Чтобы написать агентам, ответьте (Reply) на сообщение из нужного чата.' });
      }
      return;
    }
    if (u.callback_query) {
      const q = u.callback_query;
      if (!q.message || !this.isOwner(q.from, q.message.chat)) {
        await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'Нет доступа' }).catch(() => {});
        return this.stranger(q.from, q.message && q.message.chat, 'нажатие кнопки');
      }
      const [kind, roomId, partId, value] = (q.data || '').split('|');
      this.emit(kind === 'a' ? 'approval' : 'answer', { roomId, partId, value });
      await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'Готово' }).catch(() => {});
      const label = kind === 'a' ? (value === 'deny' ? '❌ Отклонено' : '✅ Разрешено') : `✅ Ответ: ${value}`;
      await this.api('editMessageReplyMarkup', { chat_id: this.userId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'x' }]] } }).catch(() => {});
    }
  }

  // Кнопка «DuoCode» слева от поля ввода в чате с ботом открывает мини-приложение.
  async setApp(url) {
    this.appUrl = url || null;
    if (!this.token || !this.userId) return;
    const menu = url ? { type: 'web_app', text: 'DuoCode', web_app: { url } } : { type: 'default' };
    await this.api('setChatMenuButton', { chat_id: Number(this.userId), menu_button: menu }).catch(() => {});
    await this.api('setMyCommands', { commands: [{ command: 'app', description: 'Открыть DuoCode' }], scope: { type: 'chat', chat_id: Number(this.userId) } }).catch(() => {});
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
      const msg = await this.api('sendMessage', {
        chat_id: this.userId,
        text: clip(html, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: (() => {
          const rows = buttons ? [...buttons] : [];
          const app = this.appButton(roomId);
          if (app) rows.push([app]);
          return rows.length ? { inline_keyboard: rows } : undefined;
        })(),
      });
      if (roomId) {
        this.rooms.set(msg.message_id, roomId);
        if (this.rooms.size > 500) this.rooms.delete(this.rooms.keys().next().value);
      }
      return msg;
    } catch (err) {
      const hint = /chat not found|bot can't initiate|blocked/i.test(err.message) ? 'Откройте своего бота в Telegram и нажмите «Старт».' : err.message;
      this.emit('status', { status: 'error', error: hint, bot: this.bot, chatId: this.userId });
      return null;
    }
  }
}

module.exports = { Telegram, esc, clip };
