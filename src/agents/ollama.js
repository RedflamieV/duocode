const { EventEmitter } = require('events');

const defaults = { enabled: false, model: '', temperature: 0.7 };

async function request(endpoint, body, signal = AbortSignal.timeout(120000)) {
  let response;
  try {
    response = await fetch('http://127.0.0.1:11434/api/' + endpoint, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('Ollama недоступна. Запустите Ollama на этом компьютере.');
  }
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || 'Ошибка Ollama ' + response.status);
  return data;
}

async function models() {
  const result = await request('tags', undefined, AbortSignal.timeout(5000));
  return result.models.map((model) => model.name);
}

function validate(value) {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.model !== 'string' ||
      (value.enabled && !value.model.trim()) || !Number.isFinite(value.temperature) ||
      value.temperature < 0 || value.temperature > 2) throw new Error('Проверьте модель и температуру локальной модели.');
  const engine = value.engine ?? 'ollama';
  if (!['ollama', 'llama.cpp'].includes(engine)) throw new Error('Неизвестный локальный движок');
  if (engine === 'llama.cpp' && value.enabled && !/\.gguf$/i.test(value.model.trim())) throw new Error('Выберите файл GGUF');
  const route = value.route ?? 'direct';
  if (!['claude', 'direct'].includes(route)) throw new Error('Неизвестный режим локального чата');
  return { engine, route, enabled: value.enabled, model: value.model.trim(), temperature: value.temperature };
}

function residency(model, load, signal) {
  return request('generate', { model, stream: false, keep_alive: load ? -1 : 0 }, signal);
}

function run(config, messages) {
  const handle = new EventEmitter();
  const controller = new AbortController();
  handle.stop = () => controller.abort();
  queueMicrotask(async () => {
    try {
      const data = await request('chat', { model: config.model, messages, stream: false,
        keep_alive: -1, options: { temperature: config.temperature } }, controller.signal);
      const text = data.message.content;
      handle.emit('part', { id: 'answer', kind: 'text', text });
      handle.emit('done', { text });
    } catch (err) {
      handle.emit('done', controller.signal.aborted ? { stopped: true } : { error: err.message });
    }
  });
  return handle;
}

module.exports = { defaults, validate, residency, models, run };
