// Проекты: название и одна или несколько папок. Первая папка — основная (в ней запускаются агенты),
// остальные агенты тоже видят и могут менять. Хранятся в settings.workspaces.
const path = require('path');
const crypto = require('crypto');

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
const newId = () => 'prj-' + crypto.randomBytes(5).toString('hex');

// Старые версии хранили только список недавних папок — превращаем каждую в проект.
function migrate(settings) {
  if (Array.isArray(settings.workspaces)) return false;
  settings.workspaces = (settings.projects || []).map((dir) => ({
    id: newId(),
    name: path.basename(dir) || dir,
    folders: [dir],
    createdAt: Date.now(),
  }));
  return true;
}

function list(settings) {
  return settings.workspaces || [];
}

function get(settings, id) {
  return list(settings).find((p) => p.id === id) || null;
}

// Проект, где эта папка основная; если такого нет — создаём.
function forFolder(settings, dir) {
  const d = norm(dir);
  const found = list(settings).find((p) => p.folders[0] && norm(p.folders[0]) === d);
  if (found) return { project: found, created: false };
  const project = { id: newId(), name: path.basename(d) || d, folders: [d], createdAt: Date.now() };
  settings.workspaces = [project, ...list(settings)];
  return { project, created: true };
}

function save(settings, input) {
  const folders = [...new Set((input.folders || []).filter(Boolean).map(norm))];
  if (!folders.length) throw new Error('В проекте должна быть хотя бы одна папка');
  const name = String(input.name || '').trim() || path.basename(folders[0]);
  const all = list(settings);
  const i = all.findIndex((p) => p.id === input.id);
  const prev = i >= 0 ? all[i] : { id: newId(), createdAt: Date.now() };
  // инструкции проекта для агентов (Настройки проекта)
  const instructions = input.instructions !== undefined ? String(input.instructions || '').trim() : prev.instructions || '';
  const project = { ...prev, name, folders, instructions };
  settings.workspaces = i >= 0 ? all.map((p, j) => (j === i ? project : p)) : [project, ...all];
  return project;
}

function remove(settings, id) {
  settings.workspaces = list(settings).filter((p) => p.id !== id);
}

// Папки, с которыми работает чат: основная папка чата + остальные папки его проекта.
function roomFolders(settings, room) {
  const project = room.projectId && get(settings, room.projectId);
  const main = norm(room.cwd);
  const extra = project ? project.folders.map(norm).filter((f) => f !== main) : [];
  return { main, extra, project };
}

module.exports = { migrate, list, get, forFolder, save, remove, roomFolders, norm };
