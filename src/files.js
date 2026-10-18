// Поиск файлов проекта для @-упоминаний в поле ввода.
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.idea', '.vs', 'out', 'coverage', '.duocode']);
const MAX_FILES = 30000;
const cache = new Map(); // cwd -> { at, files }

function walk(root) {
  const files = [];
  const stack = [''];
  while (stack.length && files.length < MAX_FILES) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) files.push(p);
    }
  }
  return files;
}

function listFiles(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < 20000) return hit.files;
  const files = walk(cwd);
  cache.set(cwd, { at: Date.now(), files });
  return files;
}

// Чем раньше и «плотнее» совпадение в имени файла, тем выше.
function score(file, q) {
  const f = file.toLowerCase();
  const base = f.slice(f.lastIndexOf('/') + 1);
  if (base === q) return 0;
  if (base.startsWith(q)) return 1;
  if (base.includes(q)) return 2;
  if (f.includes(q)) return 3;
  let i = 0;
  for (const ch of f) if (ch === q[i]) i++;
  return i === q.length ? 4 : -1;
}

// dirs — папки проекта. Если их несколько, путь показываем с именем папки: «backend/src/app.ts».
function searchFiles(dirs, query) {
  const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
  if (!list.length) return [];
  const many = list.length > 1;
  const q = (query || '').toLowerCase().replace(/\\/g, '/');
  const files = list.flatMap((dir) => listFiles(dir).map((rel) => ({ rel, dir, path: many ? `${path.basename(dir)}/${rel}` : rel })));
  const pick = q
    ? files
        .map((f) => ({ f, s: score(f.path, q) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s || a.f.path.length - b.f.path.length)
        .map((x) => x.f)
    : files;
  return pick.slice(0, 30).map((f) => ({ path: f.path, abs: path.join(f.dir, f.rel) }));
}

module.exports = { searchFiles };
