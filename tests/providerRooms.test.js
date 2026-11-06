const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Rooms } = require('../src/rooms');

function setup(t, custom = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-provider-'));
  const script = path.join(dir, 'claude-fixture.cjs');
  const command = process.platform === 'win32' ? path.join(dir, 'claude-fixture.cmd') : script;
  fs.writeFileSync(script, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--settings') + 1];
const settings = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
process.stdin.once('data', (input) => {
  const env = {...process.env, ...settings.env};
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'new-session',model:env.ANTHROPIC_MODEL || 'sonnet'}));
  console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'allowed'}}));
  const result = {args, url:env.ANTHROPIC_BASE_URL, hasKey:env.ANTHROPIC_AUTH_TOKEN === 'fixture-secret', oauth:env.CLAUDE_CODE_OAUTH_TOKEN, alias:env.ANTHROPIC_DEFAULT_HAIKU_MODEL, keyInArgs:args.some(x => x.includes('fixture-secret')), mode:fs.statSync(file).mode & 511, input:String(input)};
  console.log(JSON.stringify({type:'result',result:JSON.stringify(result)}));
  process.stdout.write('', () => process.exit(0));
});
`, { mode: 0o700 });
  if (process.platform === 'win32') fs.writeFileSync(command, `@"${process.execPath}" "${script}" %*\r\n`);
  const settings = {
    claudeCommand: command, general: {}, language: 'ru',
    providers: [{ id: 'glm', name: 'GLM', baseUrl: 'https://api.example.com/anthropic', apiKey: 'fixture-secret', authType: 'token', models: ['glm-test'], defaultModel: 'glm-test', supportsEffort: false }],
    newChat: custom ? { claudeProvider: 'glm' } : {},
  };
  const rooms = new Rooms({
    store: { loadAll: () => [], save() {}, flush() {} }, runDir: path.join(dir, 'run'),
    bridge: { command: process.execPath, script: 'bridge-fixture', port: 1, token: 'bridge-token' },
    codex: {}, getSettings: () => settings, checkpoints: { snapshot: async () => null },
    pickAgent: () => ({ agent: 'claude' }),
  });
  const id = rooms.create({ cwd: dir }).id;
  const room = rooms.rooms.get(id);
  t.after(() => {
    clearTimeout(rooms.flushTimer);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { rooms, room, settings, dir };
}

test('new chats inherit the chosen provider and allow a per-chat override', (t) => {
  const { rooms, room, dir } = setup(t, true);
  assert.equal(room.settings.claudeProvider, 'glm');
  const other = rooms.create({ cwd: dir, chosen: { claudeProvider: '', claudeModel: 'opus' } });
  assert.equal(other.settings.claudeProvider, '');
  assert.equal(other.settings.claudeModel, 'opus');
  const native = rooms.create({ cwd: dir, chosen: { claudeProvider: '' } });
  assert.equal(native.settings.claudeModel, '');
});

test('provider switching rejects active runs and clears stale model and effort', (t) => {
  const { rooms, room } = setup(t);
  room.settings.claudeModel = 'opus';
  room.settings.claudeEffort = 'max';
  rooms.updateSettings(room.id, { claudeProvider: 'glm' });
  assert.equal(room.settings.claudeModel, '');
  assert.equal(room.settings.claudeEffort, '');
  rooms.runs.set('active', { room, agent: 'claude', msg: {} });
  assert.throws(() => rooms.updateSettings(room.id, { claudeProvider: '' }), /заверш|останов/i);
  assert.equal(room.settings.claudeProvider, 'glm');
});

test('custom provider runs receive isolated settings and a fresh session with chat history', async (t) => {
  const { rooms, room } = setup(t);
  room.sessions.claude = 'old-native-session';
  room.messages.push({ id: 'old', role: 'agent', agent: 'claude', finalText: 'Earlier discussion', ts: 1 });
  rooms.updateSettings(room.id, { claudeProvider: 'glm' });
  let limits = 0;
  rooms.on('claude-ratelimit', () => limits++);
  const { msg, done } = rooms.runAgent(room, 'claude', { prompt: 'Continue' });
  const result = await done;
  assert.equal(result.error, null);
  const actual = JSON.parse(result.text);
  assert.equal(actual.url, 'https://api.example.com/anthropic');
  assert.equal(actual.hasKey, true);
  assert.equal(actual.oauth, '');
  assert.equal(actual.alias, 'glm-test');
  assert.equal(actual.keyInArgs, false);
  if (process.platform !== 'win32') assert.equal(actual.mode, 0o600);
  assert(!actual.args.includes('--resume'));
  assert(!actual.args.includes('--effort'));
  assert(actual.input.includes('Earlier discussion'));
  assert.equal(msg.providerName, 'GLM');
  assert.equal(msg.model, 'glm-test');
  assert.equal(room.sessions.claude, 'new-session');
  assert.equal(limits, 0);
  assert(!JSON.stringify(room).includes('fixture-secret'));
});

test('an edited endpoint invalidates the session on the next turn', async (t) => {
  const { rooms, room, settings } = setup(t, true);
  const first = await rooms.runAgent(room, 'claude', { prompt: 'First' }).done;
  assert.equal(first.error, null);
  settings.providers[0].baseUrl = 'https://other.example.com/api';
  const result = await rooms.runAgent(room, 'claude', { prompt: 'Second' }).done;
  const actual = JSON.parse(result.text);
  assert.equal(actual.url, 'https://other.example.com/api');
  assert(!actual.args.includes('--resume'));
});

test('a second turn on the same provider resumes its session', async (t) => {
  const { rooms, room } = setup(t, true);
  await rooms.runAgent(room, 'claude', { prompt: 'First' }).done;
  const result = await rooms.runAgent(room, 'claude', { prompt: 'Second' }).done;
  const actual = JSON.parse(result.text);
  assert.equal(actual.args[actual.args.indexOf('--resume') + 1], 'new-session');
});

test('missing provider keys fail visibly before the CLI starts', async (t) => {
  const { rooms, room, settings } = setup(t, true);
  settings.providers[0].apiKey = '';
  const result = await rooms.runAgent(room, 'claude', { prompt: 'Hello' }).done;
  assert.match(result.error, /ключ/i);
  assert.equal(room.sessions.claude, null);
});

test('subscription budgets ignore API runs while retaining native spending', (t) => {
  const { rooms, room } = setup(t, true);
  room.budget = 5;
  room.spent = { claude: 6 };
  assert.equal(rooms.overBudget(room, 'claude'), false);
  rooms.runs.set('api', { room, agent: 'claude', msg: { providerId: 'glm' } });
  rooms.addSpent('claude', 1);
  assert.equal(room.spent.claude, 6);
  rooms.runs.clear();
  rooms.updateSettings(room.id, { claudeProvider: '' });
  assert.equal(rooms.overBudget(room, 'claude'), true);
});

test('applying defaults continues after a busy chat and reports the skipped chat', async (t) => {
  const { applyChatDefaults } = require('../renderer/src/chatDefaults');
  const { rooms, room, dir } = setup(t);
  const busy = rooms.rooms.get(rooms.create({ cwd: dir, title: 'Busy chat' }).id);
  const last = rooms.rooms.get(rooms.create({ cwd: dir, title: 'Last chat' }).id);
  rooms.runs.set('active', { room: busy, agent: 'claude', msg: {} });
  const result = await applyChatDefaults([room, busy, last], { claudeProvider: 'glm' }, (id, patch) => rooms.updateSettings(id, patch));
  assert.equal(room.settings.claudeProvider, 'glm');
  assert.equal(last.settings.claudeProvider, 'glm');
  assert.equal(busy.settings.claudeProvider, '');
  assert.equal(result.applied, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, busy.id);
});
