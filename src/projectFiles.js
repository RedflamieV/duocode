// Доступ к файлам компьютера из Telegram: только внутри уже открытых проектов и папок чатов.
const fs = require('fs/promises');
const path = require('path');

const PREVIEW_BYTES = 256 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

class FileAccess {
  constructor(getRoots) { this.getRoots = getRoots; }

  async roots() {
    const roots = await Promise.all(this.getRoots().filter(Boolean).map((p) => fs.realpath(p).catch(() => null)));
    return [...new Set(roots.filter(Boolean))];
  }

  async resolve(cwd, file = '') {
    if (typeof cwd !== 'string' || typeof file !== 'string' || (!cwd && !path.isAbsolute(file))) throw new Error('Укажите путь к файлу проекта');
    const full = await fs.realpath(path.resolve(cwd || '.', file));
    if (!(await this.roots()).some((root) => inside(root, full))) throw new Error('Нет доступа: путь вне папок проектов');
    return full;
  }

  async list(dir) {
    const full = await this.resolve(dir);
    const roots = await this.roots();
    const parent = path.dirname(full);
    const items = await fs.readdir(full, { withFileTypes: true });
    const entries = [];
    // Ссылки проверяем отдельно: ссылка внутри проекта не даёт доступ к файлам снаружи.
    for (const item of items) {
      if (item.name === '.git' || entries.length >= 2000) continue;
      let target = path.join(full, item.name);
      let directory = item.isDirectory();
      if (item.isSymbolicLink()) {
        try {
          target = await this.resolve(full, item.name);
          directory = (await fs.stat(target)).isDirectory();
        } catch { continue; }
      } else if (!item.isDirectory() && !item.isFile()) continue;
      entries.push({ name: item.name, path: target, directory });
    }
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return { path: full, parent: roots.includes(full) || !roots.some((root) => inside(root, parent)) ? null : parent, entries, truncated: items.length > 2000 };
  }

  async read(cwd, file) {
    const full = await this.resolve(cwd, file);
    const handle = await fs.open(full, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('Это папка. Откройте её в списке файлов');
      const info = { path: full, name: path.basename(full), size: stat.size };
      if (IMAGE.test(full)) return { ...info, kind: 'image' };
      const buffer = Buffer.alloc(Math.min(stat.size, PREVIEW_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      const truncated = stat.size > bytesRead;
      let text;
      try {
        if (bytes.includes(0)) throw new Error('binary');
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated });
      } catch { return { ...info, kind: 'binary' }; }
      return { ...info, kind: 'text', text, truncated };
    } finally { await handle.close(); }
  }
}

module.exports = { FileAccess };
