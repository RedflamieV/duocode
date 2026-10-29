const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RemoteServer } = require('../src/remote');

test('file download requires authentication and uses inert attachment headers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duo-download-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'пример.html');
  await fs.writeFile(file, '<script>alert(1)</script>');
  const server = new RemoteServer({ root, getAuth: () => ({ token: 'fixture-token', userId: '123' }), api: {}, resolveFile: (p) => p === file ? file : null });
  await server.start(0);
  t.after(() => server.stop());
  const address = `http://127.0.0.1:${server.port}/api/file?path=${encodeURIComponent(file)}`;
  assert.equal((await fetch(address)).status, 401);
  const pass = server.issuePass();
  const response = await fetch(`${address}&pass=${encodeURIComponent(pass)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await response.text(), '<script>alert(1)</script>');
  const denied = await fetch(`http://127.0.0.1:${server.port}/api/file?path=outside&pass=${encodeURIComponent(pass)}`);
  assert.equal(denied.status, 403);
});
