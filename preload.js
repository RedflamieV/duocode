const { contextBridge, ipcRenderer, clipboard, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('duo', {
  listRooms: () => ipcRenderer.invoke('rooms:list'),
  getRoom: (id) => ipcRenderer.invoke('rooms:get', id),
  createRoom: (opts) => ipcRenderer.invoke('rooms:create', opts),
  importSession: (s) => ipcRenderer.invoke('rooms:import', s),
  renameRoom: (id, title) => ipcRenderer.invoke('rooms:rename', id, title),
  setRoomSettings: (id, patch) => ipcRenderer.invoke('rooms:settings', id, patch),
  removeRoom: (id) => ipcRenderer.invoke('rooms:remove', id),
  send: (id, payload) => ipcRenderer.invoke('rooms:send', id, payload),
  stop: (id) => ipcRenderer.invoke('rooms:stop', id),
  approve: (id, approvalId, decision, extra) => ipcRenderer.invoke('rooms:approve', id, approvalId, decision, extra),
  planAction: (id, msgId, action, feedback) => ipcRenderer.invoke('rooms:plan', id, msgId, action, feedback),
  pickAttachments: () => ipcRenderer.invoke('attach:pick'),
  saveAttachment: (name, bytes) => ipcRenderer.invoke('attach:save', name, bytes),
  describeFiles: (paths) => ipcRenderer.invoke('attach:describe', paths),
  pathForFile: (file) => webUtils.getPathForFile(file),

  limits: () => ipcRenderer.invoke('limits:get'),
  refreshLimits: () => ipcRenderer.invoke('limits:refresh'),
  history: () => ipcRenderer.invoke('history:get'),
  codexModels: () => ipcRenderer.invoke('codex:models'),
  checkEnv: () => ipcRenderer.invoke('env:check'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickProject: () => ipcRenderer.invoke('project:pick'),
  openProject: (dir) => ipcRenderer.invoke('project:open', dir),
  openFile: (cwd, file) => ipcRenderer.invoke('file:open', cwd, file),
  copy: (text) => clipboard.writeText(text),
  login: (agent) => ipcRenderer.invoke('auth:login', agent),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  version: () => ipcRenderer.invoke('app:version'),

  onMessages: on('messages'),
  onRooms: on('rooms'),
  onLimits: on('limits'),
  onOpenRoom: on('open-room'),
  onUpdate: on('update'),
  platform: process.platform,
});
