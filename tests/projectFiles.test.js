const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'duo-files-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'пример.js'), 'const привет = "мир";\n');
  await fs.writeFile(path.join(base, 'secret.txt'), 'outside');
  const { FileAccess } = require('../src/projectFiles');
  return { base, root, access: new FileAccess(() => [root]) };
}

test('browse and preview non-ASCII files with bounded parent navigation', async (t) => {
  const { root, access } = await fixture(t);
  const listing = await access.list(root);
  assert.equal(listing.parent, null);
  assert.deepEqual(listing.entries.map((x) => [x.name, x.directory]), [['src', true]]);
  const nested = await access.list(path.join(root, 'src'));
  assert.equal(nested.parent, root);
  const result = await access.read(root, 'src/пример.js');
  assert.equal(result.kind, 'text');
  assert.equal(result.text, 'const привет = "мир";\n');
});

test('reject traversal, sibling prefixes and symlinks outside allowed roots', async (t) => {
  const { base, root, access } = await fixture(t);
  await fs.symlink(path.join(base, 'secret.txt'), path.join(root, 'escape.txt'));
  const sibling = root + '-other';
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'secret.txt'), 'outside');
  for (const file of ['../secret.txt', 'escape.txt', path.join(sibling, 'secret.txt')]) {
    await assert.rejects(() => access.read(root, file), /вне|доступ/i);
  }
  assert(!(await access.list(root)).entries.some((x) => x.name === 'escape.txt'));
});

test('large text is truncated and binary content is downloadable without text rendering', async (t) => {
  const { root, access } = await fixture(t);
  await fs.writeFile(path.join(root, 'big.txt'), 'я'.repeat(200000));
  const big = await access.read(root, 'big.txt');
  assert.equal(big.kind, 'text');
  assert.equal(big.truncated, true);
  assert(big.text.length < 200000);
  await fs.writeFile(path.join(root, 'archive.zip'), Buffer.from([80, 75, 0, 255, 0]));
  const binary = await access.read(root, 'archive.zip');
  assert.equal(binary.kind, 'binary');
  assert.equal(binary.text, undefined);
});

test('HTML and SVG are returned as inert source text', async (t) => {
  const { root, access } = await fixture(t);
  await fs.writeFile(path.join(root, 'index.html'), '<script>alert(1)</script>');
  await fs.writeFile(path.join(root, 'image.svg'), '<svg onload="alert(1)"/>');
  assert.equal((await access.read(root, 'index.html')).kind, 'text');
  assert.equal((await access.read(root, 'image.svg')).kind, 'text');
});
