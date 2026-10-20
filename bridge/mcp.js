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
    'Save a short durable note that both agents (Claude and Codex) will see in later chats. ' +
    'scope "project" (default): this project only — conventions, architecture decisions, useful commands, gotchas. ' +
    'scope "global": every project — facts about the user and preferences that are not tied to this project ' +
    '(how they like answers, their OS and tools, general habits). Not for temporary state.',
  inputSchema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'One short fact or decision, in the user language.' },
      scope: { type: 'string', enum: ['project', 'global'], description: 'Where to save it. Default: project.' },
    },
    required: ['note'],
  },
});

// Вопрос пользователю с вариантами ответа (у Claude есть свой AskUserQuestion, у Codex вне режима плана — нет).
if (AGENT === 'codex') {
  tools.push({
    name: 'ask_user',
    description:
      'Ask the user a question in the DuoCode chat and wait for the answer. The user picks one of the options with a click ' +
      '(or several, if multiSelect) or types their own answer. Use it when you need a decision from the user instead of asking in plain text ' +
      'and stopping. Give 2-5 short, distinct options.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in the user language.' },
        options: {
          type: 'array',
          items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] },
        },
        multiSelect: { type: 'boolean', description: 'Allow choosing several options.' },
      },
      required: ['question', 'options'],
    },
  });
}

// Встроенный браузер DuoCode: пользователь видит его вживую во вкладке «Браузер» боковой панели.
if (process.env.DUO_BROWSER === '1') {
  const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
  tools.push(
    {
      name: 'browser_open',
      description:
        "Open a URL in DuoCode's built-in browser, which the user watches live in the app's side panel. Use it to check web pages and the app " +
        'you are building (for example http://localhost:3000). Returns the page text and numbered interactive elements.',
      inputSchema: obj({ url: { type: 'string', description: 'http(s) address; "localhost:3000" works too.' } }, ['url']),
    },
    { name: 'browser_read', description: 'Read the current page of the built-in browser: title, URL, scroll position, numbered interactive elements and visible text.', inputSchema: obj() },
    {
      name: 'browser_click',
      description: 'Click in the built-in browser: an element by its number from browser_open/browser_read (preferred), or a point x, y in CSS pixels of the viewport.',
      inputSchema: obj({ index: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }),
    },
    {
      name: 'browser_type',
      description: 'Type text in the built-in browser. Optionally click the element with this number first, then press Enter (submit) or another key (Tab, Escape, Backspace, Up, Down, PageDown).',
      inputSchema: obj({ text: { type: 'string' }, index: { type: 'number' }, submit: { type: 'boolean' }, key: { type: 'string' } }),
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the page in the built-in browser.',
      inputSchema: obj({ direction: { type: 'string', enum: ['down', 'up'] }, amount: { type: 'number', description: 'Pixels, default 600.' } }),
    },
    { name: 'browser_screenshot', description: 'Take a screenshot of the visible part of the page in the built-in browser. The image is also shown to the user in the chat.', inputSchema: obj() },
    { name: 'browser_back', description: 'Go back in the built-in browser history.', inputSchema: obj() },
  );
}

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
    const content = [];
    if (res.image) content.push({ type: 'image', data: res.image.data, mimeType: res.image.mimeType });
    if (res.text || !content.length) content.push({ type: 'text', text: res.text || '' });
    send({ jsonrpc: '2.0', id, result: { content, isError: !!res.isError } });
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
