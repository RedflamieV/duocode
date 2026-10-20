// Память, которую видят оба агента.
// Память проекта — .duocode/memory.md в папке проекта: договорённости, команды, решения по этому проекту.
// Глобальная память — memory.md в папке данных DuoCode: о пользователе и его привычках, для всех проектов.
const fs = require('fs');
const path = require('path');

const GLOBAL = '*global*'; // вместо папки проекта — значит «глобальная память»
let globalDir = null;

function setGlobalDir(dir) {
  globalDir = dir;
}

const file = (cwd) => (cwd === GLOBAL ? path.join(globalDir || '.', 'memory.md') : path.join(cwd, '.duocode', 'memory.md'));

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
  const head = cwd === GLOBAL ? '# Глобальная память (для всех проектов)\n\n' : '# Память проекта\n\n';
  write(cwd, (cur.trim() ? cur.replace(/\s*$/, '\n') : head) + line + '\n');
}

// Блок для агента: глобальная память и память проекта.
function block(cwd) {
  const g = globalDir ? read(GLOBAL).trim() : '';
  const p = read(cwd).trim();
  return [g && `<duocode_global_memory>\n${g}\n</duocode_global_memory>`, p && `<duocode_memory>\n${p}\n</duocode_memory>`].filter(Boolean).join('\n\n');
}

module.exports = { read, write, append, block, file, setGlobalDir, GLOBAL };
