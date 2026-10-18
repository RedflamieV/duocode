// MCP-сервер «duo» (stdio). Его запускают сами Claude Code и Codex; он пересылает вызовы
// инструментов в DuoCode по локальному HTTP. Без зависимостей: запускается через
// ELECTRON_RUN_AS_NODE=1 тем же исполняемым файлом, что и приложение.
const http = require('http');
const readline = require('readline');

const PORT = Number(process.env.DUO_PORT);
const TOKEN = process.env.DUO_TOKEN;
const ROOM = process.env.DUO_ROOM;
const AGENT = process.env.DUO_AGENT; // кто нас запустил: claude | codex
const RUN = process.env.DUO_RUN || null;

const PEER = AGENT === 'claude' ? 'codex' : 'claude';
const PEER_NAME = PEER === 'codex' ? 'Codex (OpenAI)' : 'Claude Code (Anthropic)';

const tools = [
  {
    name: `ask_${PEER}`,
    description:
      `Delegate a task or ask for a second opinion from ${PEER_NAME}, another coding agent working in the same ` +
      `project and the same DuoCode chat. It can read, run and edit files in the project. Use it for code review, ` +
      `an independent check of your solution, parallel subtasks, or when the user asks you to involve ${PEER === 'codex' ? 'Codex' : 'Claude'}. ` +
      `Write a self-contained request: it does not see your private reasoning. Returns its final answer.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The full request for the other agent.' },
      },
      required: ['prompt'],
    },
  },
];

tools.push({
  name: 'remember',
  description:
    'Save a short durable note to the shared project memory that both agents (Claude and Codex) see in every chat of this project: ' +
    'conventions, architecture decisions, useful commands, gotchas, user preferences. Not for temporary state.',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string', description: 'One short fact or decision, in the user language.' } },
    required: ['note'],
  },
});

if (AGENT === 'claude') {
  tools.push({
    name: 'approve',
    description: 'Internal: asks the DuoCode user to approve a tool call.',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name'],
    },
  });
}

function callApp(tool, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ token: TOKEN, room: ROOM, agent: AGENT, run: RUN, tool, args });
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/call', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({ isError: true, text: 'DuoCode вернул некорректный ответ' }); }
        });
      },
    );
    req.on('error', (err) => resolve({ isError: true, text: 'DuoCode недоступен: ' + err.message }));
    req.end(body);
  });
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // уведомления нам не важны
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'duo', version: '2.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
  } else if (method === 'tools/call') {
    const res = await callApp(params.name, params.arguments || {});
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: res.text || '' }], isError: !!res.isError } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
});
rl.on('close', () => process.exit(0));

// Сторож: если DuoCode закрылся аварийно (снят из диспетчера задач, выключили питание), Windows не завершает
// запущенных им агентов. Мост живёт внутри агента, поэтому, не достучавшись до DuoCode дважды подряд,
// останавливает своего агента — чтобы тот не продолжал менять файлы без присмотра.
let misses = 0;
const watchdog = setInterval(() => {
  const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: '/alive', timeout: 3000 }, (res) => {
    res.resume();
    misses = 0;
  });
  req.on('timeout', () => req.destroy());
  req.on('error', (err) => {
    if (err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET') return;
    if (++misses < 2) return;
    clearInterval(watchdog);
    try {
      process.kill(process.ppid);
    } catch {}
    process.exit(0);
  });
  req.end();
}, 5000);
watchdog.unref();
