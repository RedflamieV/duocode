const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const repo = { full_name: 'octocat/demo', name: 'demo', description: 'Example', private: true, html_url: 'https://github.com/octocat/demo', default_branch: 'main' };
const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

function client(run, resolve = () => '/fixture/gh') {
  const { GitHub } = require('../src/github');
  return new GitHub({ run, resolve });
}

test('missing gh and signed-out accounts return actionable status', async () => {
  const missing = await client(() => { throw new Error('must not spawn'); }, () => null).status();
  assert.equal(missing.installed, false);
  const signedOut = await client(async () => ({ code: 1, stdout: '', stderr: 'To get started, run gh auth login' })).status();
  assert.equal(signedOut.installed, true);
  assert.equal(signedOut.authenticated, false);
  assert.match(signedOut.error, /gh auth login/);
});

test('account and private repositories are normalized without exposing credentials', async () => {
  const gh = client(async (_cmd, args) => {
    const endpoint = args.at(-1);
    if (endpoint === 'user') return ok({ login: 'octocat', name: 'Octocat', id: 1 });
    if (endpoint.includes('user/repos?') && endpoint.includes('page=2')) return ok([repo]);
    throw new Error('Unexpected endpoint');
  });
  const status = await gh.status();
  assert.equal(status.login, 'octocat');
  assert.equal(status.authenticated, true);
  const result = await gh.repositories(2);
  assert.equal(result.repositories[0].fullName, 'octocat/demo');
  assert.equal(result.repositories[0].private, true);
  assert.equal(result.hasMore, false);
});

test('clone creates a local project directory and refuses occupied destinations', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'duo-clone-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const gh = client(async (_cmd, args) => {
    if (args[0] === 'api') return ok(repo);
    if (args[0] === 'repo' && args[1] === 'clone' && args[2] === 'https://github.com/octocat/demo.git') {
      await fs.writeFile(path.join(args[3], 'README.md'), 'cloned');
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error('Unexpected CLI operation');
  });
  const result = await gh.clone('octocat/demo', parent);
  assert.equal(result.name, 'demo');
  assert.equal(await fs.readFile(path.join(result.path, 'README.md'), 'utf8'), 'cloned');
  await assert.rejects(() => gh.clone('octocat/demo', parent), /существует/);
  assert.equal(await fs.readFile(path.join(result.path, 'README.md'), 'utf8'), 'cloned');
});

test('failed cloning removes only its own new directory', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'duo-clone-fail-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await fs.writeFile(path.join(parent, 'keep.txt'), 'keep');
  const gh = client(async (_cmd, args) => args[0] === 'api' ? ok(repo) : { code: 1, stdout: '', stderr: 'Repository access denied' });
  await assert.rejects(() => gh.clone('octocat/demo', parent), /access denied/);
  assert.deepEqual(await fs.readdir(parent), ['keep.txt']);
});

test('malformed repository names never reach an external command', async () => {
  const gh = client(() => { throw new Error('External command must not run'); });
  for (const input of ['--help', '../escape', 'owner/..', 'https://evil.test/x/y', 'owner/repo;echo hello', 'owner/repo/extra']) {
    await assert.rejects(() => gh.clone(input, '/tmp'), /репозитор/i);
  }
});
