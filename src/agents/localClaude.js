const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { claudeOptions } = require('../providers');

let server;

async function residency(config, load) {
  if (!load) {
    if (server) {
      const { child, closed } = server;
      child.kill();
      await closed;
    }
    return;
  }
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const key = randomUUID();
  const url = 'http://127.0.0.1:' + port;
  const child = spawn('llama-server', ['--host', '127.0.0.1', '--port', String(port), '--model', config.model,
    '--alias', 'duocode-local', '--api-key', key, '--jinja'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const state = { key, url, child, model: config.model, ready: false };
  server = state;
  let detail = '';
  child.stderr.on('data', data => { detail = (detail + data).slice(-1500); });
  child.on('error', err => { detail = err.message; });
  state.closed = new Promise(resolve => child.once('close', () => {
    if (server === state) server = null;
    resolve();
  }));
  const deadline = Date.now() + 180000;
  while (server === state && Date.now() < deadline) {
    try {
      const res = await fetch(url + '/v1/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(1500) });
      if (res.ok && (await res.json()).data.some(m => m.id === 'duocode-local')) { state.ready = true; return; }
    } catch {}
    await delay(250);
  }
  child.kill();
  await state.closed;
  throw new Error('Не удалось запустить llama-server: ' + (detail || 'истекло время загрузки'));
}

function connection(config) {
  const gguf = config.engine === 'llama.cpp';
  if (gguf && (!server?.ready || server.model !== config.model)) throw new Error('Локальный llama-server недоступен. Проверьте настройки модели.');
  const model = gguf ? 'duocode-local' : config.model;
  const profile = { id: 'duocode-local', name: gguf ? 'llama.cpp' : 'Ollama', baseUrl: gguf ? server.url : 'http://127.0.0.1:11434',
    authType: 'token', apiKey: gguf ? server.key : 'ollama', models: [model], defaultModel: model };
  return claudeOptions({ providers: [profile] }, { claudeProvider: profile.id });
}

module.exports = { connection, residency };
