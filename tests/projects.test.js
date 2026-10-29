const { test } = require('node:test');
const assert = require('node:assert/strict');
const projects = require('../src/projects');

test('manual order survives serialization and keeps project data', () => {
  const settings = { workspaces: [{ id: 'a', name: 'A', folders: ['/a'] }, { id: 'b', name: 'B', folders: ['/b'] }] };
  projects.reorder(settings, ['b', 'chats', 'a']);
  const saved = JSON.parse(JSON.stringify(settings));
  assert.deepEqual(saved.projectOrder, ['b', 'chats', 'a']);
  assert.deepEqual(projects.list(saved).map((p) => p.name), ['B', 'A']);
  assert.deepEqual(projects.get(saved, 'a').folders, ['/a']);
});

test('partial reordering preserves unlisted projects without duplicates', () => {
  const settings = { workspaces: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], projectOrder: ['a', 'chats', 'b', 'c'] };
  projects.reorder(settings, ['c', 'c', 'a']);
  assert.deepEqual(settings.projectOrder, ['c', 'a', 'chats', 'b']);
  assert.deepEqual(projects.list(settings).map((p) => p.id), ['c', 'a', 'b']);
  projects.remove(settings, 'a');
  assert(!settings.projectOrder.includes('a'));
});

test('invalid ordering cannot corrupt settings', () => {
  const settings = { workspaces: [{ id: 'a' }] };
  assert.throws(() => projects.reorder(settings, 'a'));
  assert.deepEqual(projects.list(settings), [{ id: 'a' }]);
});
