// Telegram-бот: уведомления, подтверждения и ответы на вопросы агентов с телефона.
// Работает через long polling (getUpdates), сервер не нужен. Принимает сообщения только из привязанного чата.
const { EventEmitter } = require('events');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

class Telegram extends EventEmitter {
  constructor() {
    super();
    this.token = null;
    this.chatId = null;
    this.offset = 0;
    this.loopId = 0;
    this.bot = null;
    this.rooms = new Map(); // message_id -> roomId (для ответов на сообщения бота)
    this.status = 'off';
  }

  configure({ token, chatId }) {
    const changed = token !== this.token;
    this.token = token || null;
    this.chatId = chatId || null;
    if (changed) this.restart();
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
      this.setStatus(this.chatId ? 'linked' : 'waiting');
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
        if (id === this.loopId) this.setStatus(this.chatId ? 'linked' : 'waiting');
      }
    }
  }

  async handle(u) {
    if (u.message) {
      const m = u.message;
      const chat = String(m.chat.id);
      if (!this.chatId) {
        if (/^\/start/.test(m.text || '')) {
          this.chatId = chat;
          this.emit('linked', chat);
          this.setStatus('linked');
          await this.api('sendMessage', { chat_id: chat, text: '✅ DuoCode подключён. Сюда будут приходить уведомления и запросы подтверждений. Чтобы написать агентам, ответьте (Reply) на сообщение нужного чата.' });
        }
        return;
      }
      if (chat !== this.chatId) return;
      const reply = m.reply_to_message && this.rooms.get(m.reply_to_message.message_id);
      if (reply && m.text) this.emit('reply', { roomId: reply, text: m.text });
      else if (m.text && !/^\/start/.test(m.text)) {
        await this.api('sendMessage', { chat_id: chat, text: 'Чтобы написать агентам, ответьте (Reply) на сообщение из нужного чата.' });
      }
      return;
    }
    if (u.callback_query) {
      const q = u.callback_query;
      if (String(q.message.chat.id) !== this.chatId) return;
      const [kind, roomId, partId, value] = (q.data || '').split('|');
      this.emit(kind === 'a' ? 'approval' : 'answer', { roomId, partId, value });
      await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'Готово' }).catch(() => {});
      const label = kind === 'a' ? (value === 'deny' ? '❌ Отклонено' : '✅ Разрешено') : `✅ Ответ: ${value}`;
      await this.api('editMessageReplyMarkup', { chat_id: this.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'x' }]] } }).catch(() => {});
    }
  }

  async send(html, { roomId, buttons } = {}) {
    if (!this.token || !this.chatId) return null;
    try {
      const msg = await this.api('sendMessage', {
        chat_id: this.chatId,
        text: clip(html, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
      });
      if (roomId) {
        this.rooms.set(msg.message_id, roomId);
        if (this.rooms.size > 500) this.rooms.delete(this.rooms.keys().next().value);
      }
      return msg;
    } catch (err) {
      this.emit('status', { status: 'error', error: err.message, bot: this.bot, chatId: this.chatId });
      return null;
    }
  }
}

module.exports = { Telegram, esc, clip };
