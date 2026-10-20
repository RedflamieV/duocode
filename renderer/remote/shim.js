// В мини-приложении нет Electron: тот же API, что у окна DuoCode (window.duo), работает по HTTP,
// а живые обновления приходят через Server-Sent Events. Каждый запрос несёт подпись Telegram.
const tg = window.Telegram && window.Telegram.WebApp;
const initData = (tg && tg.initData) || '';

// пропуск для адресов (поток обновлений, картинки) — вместо подписи Telegram, см. src/remote.js
let pass = '';
let passAt = 0;
async function session() {
  pass = await rawRpc('session');
  passAt = Date.now();
  return pass;
}
let ready = session().catch(() => {});

async function rpc(method, ...args) {
  await ready;
  return rawRpc(method, ...args);
}

async function rawRpc(method, ...args) {
  const res = await fetch('api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
    body: JSON.stringify({ method, args }),
  });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json.result;
}

// картинки с компьютера (вложения, скриншоты агентов) — через API, по пропуску
window.duoImageUrl = (p) => `api/image?path=${encodeURIComponent(p)}&pass=${encodeURIComponent(pass)}`;

const listeners = { rooms: new Set(), messages: new Set(), limits: new Set(), status: new Set(), changed: new Set() };
let source = null;
let lastEvent = 0;

// Действия, после которых интерфейсу стоит сразу забрать свежее состояние, не дожидаясь потока.
const MUTATING = new Set(['send', 'stop', 'approve', 'planAction', 'revert', 'duelApply', 'setRoomSettings', 'createRoom', 'renameRoom', 'resend', 'editMessage']);
async function act(method, ...args) {
  const result = await rpc(method, ...args);
  if (MUTATING.has(method)) listeners.changed.forEach((cb) => cb(method));
  return result;
}

async function connect() {
  if (source) source.close();
  // пропуск мог истечь или DuoCode перезапустили (тогда старые пропуски недействительны) — берём свежий
  if (!pass || Date.now() - passAt > 6 * 3600 * 1000 || connect.failed) {
    ready = session().catch(() => {});
    await ready;
    connect.failed = false;
  }
  source = new EventSource(`api/events?pass=${encodeURIComponent(pass)}`);
  for (const ev of ['hello', 'ping']) source.addEventListener(ev, () => (lastEvent = Date.now()));
  for (const ev of ['rooms', 'messages', 'limits']) {
    source.addEventListener(ev, (e) => {
      lastEvent = Date.now();
      const data = JSON.parse(e.data);
      for (const cb of listeners[ev]) ev === 'messages' ? cb(data.roomId, data.msgs) : cb(data);
    });
  }
  // чат переписан на компьютере (правка прошлого сообщения) — перечитать
  source.addEventListener('reset', () => listeners.changed.forEach((cb) => cb('reset')));
  source.onopen = () => listeners.status.forEach((cb) => cb('online'));
  source.onerror = () => {
    connect.failed = true;
    listeners.status.forEach((cb) => cb('offline'));
    // на 401 (пропуск устарел, DuoCode перезапущен) EventSource сдаётся сам — переподключаемся со свежим пропуском
    const dead = source;
    if (dead.readyState === 2) setTimeout(() => source === dead && connect(), 3000);
  };
}

const on = (ev) => (cb) => {
  listeners[ev].add(cb);
  return () => listeners[ev].delete(cb);
};

window.duo = {
  listRooms: () => rpc('listRooms'),
  getRoom: (id) => rpc('getRoom', id),
  createRoom: (opts) => act('createRoom', opts),
  setRoomSettings: (id, patch) => act('setRoomSettings', id, patch),
  renameRoom: (id, title) => act('renameRoom', id, title),
  resend: (id, msgId) => act('resend', id, msgId),
  editMessage: (id, msgId, text, opts) => act('editMessage', id, msgId, text, opts),
  send: (id, payload) => act('send', id, payload),
  stop: (id) => act('stop', id),
  approve: (id, approvalId, decision, extra) => act('approve', id, approvalId, decision, extra),
  planAction: (id, msgId, action, feedback) => act('planAction', id, msgId, action, feedback),
  revert: (id, msgId, redo) => act('revert', id, msgId, redo),
  checkpointDiff: (id, msgId, file) => rpc('checkpointDiff', id, msgId, file),
  duelApply: (id, duelId, choice) => act('duelApply', id, duelId, choice),
  limits: () => rpc('limits'),
  projects: () => rpc('projects'),
  openFile: () => {},
  copy: (text) => navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {}),
  onRooms: on('rooms'),
  onMessages: on('messages'),
  onLimits: on('limits'),
  onStatus: on('status'),
  onChanged: on('changed'),
  // поток считаем живым, если что-то приходило за последние 25 секунд
  live: () => !!source && source.readyState === 1 && Date.now() - lastEvent < 25000,
  connect,
  platform: 'telegram',
};

if (tg) {
  tg.ready();
  tg.expand();
}
