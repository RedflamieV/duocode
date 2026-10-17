// Общая память проекта: .duocode/memory.md в папке проекта. Её видят оба агента, и оба могут её дополнять.
const fs = require('fs');
const path = require('path');

const file = (cwd) => path.join(cwd, '.duocode', 'memory.md');

function read(cwd) {
  try {
    return fs.readFileSync(file(cwd), 'utf8');
  } catch {
    return '';
  }
}

function write(cwd, text) {
  fs.mkdirSync(path.dirname(file(cwd)), { recursive: true });
  fs.writeFileSync(file(cwd), text);
}

function append(cwd, note, who) {
  const day = new Date().toISOString().slice(0, 10);
  const cur = read(cwd);
  const line = `- ${note.trim().replace(/\n+/g, ' ')} _(${who}, ${day})_`;
  write(cwd, (cur.trim() ? cur.replace(/\s*$/, '\n') : '# Память проекта\n\n') + line + '\n');
}

function block(cwd) {
  const text = read(cwd).trim();
  return text ? `<duocode_memory>\n${text}\n</duocode_memory>` : '';
}

module.exports = { read, write, append, block, file };
