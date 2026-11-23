const { spawn } = require('child_process');
const { EventEmitter, once } = require('events');
const { randomUUID } = require('crypto');
const readline = require('readline');
const path = require('path');

const workers = new Map();

async function residency(model, load) {
  const existing = workers.get(model);
  if (!load) {
    if (existing) {
      const closed = once(existing.child, 'close');
      existing.child.kill();
      await closed;
    }
    return;
  }
  if (existing) return existing.ready;
  const script = path.join(__dirname, 'llama_worker.py').replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
  const child = spawn(process.env.DUOCODE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-u', script, model], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const jobs = new Map();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => { rejectReady(new Error('Истекло время загрузки GGUF')); child.kill(); }, 180000);
  const worker = { child, jobs, ready };
  workers.set(model, worker);
  let detail = '';
  child.stderr.on('data', data => { detail = (detail + data).slice(-1500); });
  function fail(error) {
    clearTimeout(timer);
    if (workers.get(model) === worker) workers.delete(model);
    rejectReady(error);
    for (const job of jobs.values()) job.emit('done', { error: error.message });
    jobs.clear();
  }
  child.on('error', fail);
  child.stdin.on('error', error => { fail(error); child.kill(); });
  child.on('close', () => fail(new Error(detail.trim() || 'Процесс llama.cpp завершился.')));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let result;
    try { result = JSON.parse(line); } catch { return; }
    if (result.ready) { clearTimeout(timer); resolveReady(); return; }
    const job = jobs.get(result.id);
    if (!job) return;
    if (result.token) {
      job.text += result.token;
      job.emit('draft', job.text);
    } else {
      jobs.delete(result.id);
      if (job.text) job.emit('part', { id: 'answer', kind: 'text', text: job.text });
      job.emit('done', { text: job.text, error: result.error, stopped: result.stopped });
    }
  });
  return ready;
}

function run(config, messages) {
  const handle = new EventEmitter();
  handle.text = '';
  const id = randomUUID();
  let stopped = false;
  let worker;
  const send = record => worker.child.stdin.write(JSON.stringify({ id, ...record }) + '\n');
  handle.stop = () => { stopped = true; if (worker?.jobs.has(id)) send({ stop: true }); };
  queueMicrotask(async () => {
    try {
      await residency(config.model, true);
      if (stopped) return handle.emit('done', { stopped: true });
      worker = workers.get(config.model);
      worker.jobs.set(id, handle);
      send({ messages, temperature: config.temperature });
    } catch (error) { handle.emit('done', { error: error.message }); }
  });
  return handle;
}

module.exports = { residency, run };
