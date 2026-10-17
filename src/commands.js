// Команды «/» в поле ввода: встроенные команды DuoCode, свои команды и навыки Claude Code,
// сохранённые промпты Codex (~/.codex/prompts).
const fs = require('fs');
const path = require('path');
const { claudeDir, codexDir } = require('./env');

const BOTH = ['claude', 'codex'];

const BUILTIN = [
  { name: 'compact', description: 'Сжать контекст: агент кратко перескажет себе переписку и освободит место', agents: BOTH },
  { name: 'clear', description: 'Начать с чистого листа: агент забудет переписку этого чата', agents: BOTH },
  { name: 'review', description: 'Код-ревью незакоммиченных изменений. После команды можно написать, на что смотреть', agents: BOTH },
  { name: 'init', description: 'Изучить проект и создать файл с инструкциями для агента (CLAUDE.md или AGENTS.md)', agents: BOTH },
];

const REVIEW_PROMPT =
  'Сделай код-ревью текущих незакоммиченных изменений в проекте (посмотри git status и git diff). ' +
  'Найди ошибки, риски и места, которые стоит упростить. Ничего не меняй в файлах, только перечисли замечания по важности.';

const CODEX_INIT_PROMPT =
  'Изучи этот репозиторий и создай в его корне файл AGENTS.md — краткое руководство для агентов, которые будут работать с проектом: ' +
  'структура, как собрать, запустить и протестировать, стиль кода и соглашения. Пиши по делу, без воды.';

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  const body = m ? text.slice(m[0].length) : text;
  return { meta, body };
}

function describe(file) {
  try {
    const { meta, body } = frontmatter(fs.readFileSync(file, 'utf8'));
    const first = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
    return { name: meta.name, description: meta.description || first.slice(0, 120) };
  } catch {
    return { description: '' };
  }
}

function listMd(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listMd(p, prefix + e.name + ':'));
    else if (e.name.endsWith('.md')) out.push({ name: prefix + e.name.slice(0, -3), file: p });
  }
  return out;
}

function listSkills(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const file = path.join(dir, e.name, 'SKILL.md');
    if (e.isDirectory() && fs.existsSync(file)) out.push({ name: e.name, file });
  }
  return out;
}

function listCommands(cwd) {
  const seen = new Set(BUILTIN.map((c) => c.name));
  const out = BUILTIN.map((c) => ({ ...c, source: 'duocode' }));
  const add = (items, agents, source) => {
    for (const it of items) {
      const d = describe(it.file);
      const name = it.name;
      if (seen.has(`${source}:${name}`)) continue;
      seen.add(`${source}:${name}`);
      out.push({ name, description: d.description, agents, source });
    }
  };
  const claudeRoots = [cwd && path.join(cwd, '.claude'), claudeDir()].filter(Boolean);
  for (const root of claudeRoots) {
    add(listMd(path.join(root, 'commands')), ['claude'], 'claude');
    add(listSkills(path.join(root, 'skills')), ['claude'], 'claude');
  }
  add(listMd(path.join(codexDir(), 'prompts')), ['codex'], 'codex');
  return out;
}

// Промпт Codex из ~/.codex/prompts/<name>.md с подстановкой $ARGUMENTS и $1…$9.
function expandCodexPrompt(name, args) {
  const file = path.join(codexDir(), 'prompts', `${name.replace(/:/g, path.sep)}.md`);
  let text;
  try {
    text = frontmatter(fs.readFileSync(file, 'utf8')).body.trim();
  } catch {
    return null;
  }
  const words = args.split(/\s+/).filter(Boolean);
  return text.replace(/\$ARGUMENTS/g, args).replace(/\$([1-9])/g, (_, i) => words[i - 1] || '');
}

module.exports = { listCommands, expandCodexPrompt, REVIEW_PROMPT, CODEX_INIT_PROMPT };
