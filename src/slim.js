// Облегчённый чат для мини-приложения: оно ходит через туннель, и полный чат на сотни сообщений
// с выводом команд и снимками для отката грузился бы десятки секунд.
const LONG = 3000; // столько символов вывода, диффа и т. п. хватает, чтобы понять, что произошло

const clipTail = (s) => (typeof s === 'string' && s.length > LONG ? '…\n' + s.slice(-LONG) : s);
const clipHead = (s) => (typeof s === 'string' && s.length > LONG ? s.slice(0, LONG) + '\n…' : s);

function slimPart(p) {
  const out = { ...p };
  if (out.output) out.output = clipTail(out.output); // у вывода команды важен конец
  for (const k of ['diff', 'content', 'input', 'result']) if (out[k]) out[k] = clipHead(out[k]);
  if (Array.isArray(out.files)) out.files = out.files.map((f) => (f && f.diff ? { ...f, diff: clipHead(f.diff) } : f));
  return out;
}

function slimMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const out = { ...m };
  if (Array.isArray(out.parts)) out.parts = out.parts.map(slimPart);
  // для кнопки «Откатить» нужен только список файлов; деревья снимков остаются на компьютере
  if (out.checkpoint) out.checkpoint = { files: out.checkpoint.files || [], reverted: !!out.checkpoint.reverted };
  delete out.pendingCheckpoint;
  return out;
}

// limit — сколько последних сообщений верхнего уровня отдать (ответы агентов друг другу идут с ними)
function slimRoom(room, limit = 40) {
  if (!room) return room;
  const all = room.messages || [];
  const top = all.filter((m) => !m.parentId);
  const keep = new Set(top.slice(-Math.max(10, Number(limit) || 40)).map((m) => m.id));
  // вложенные ходы (агент спросил другого) — вместе со своими родителями, на любую глубину
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of all) {
      if (m.parentId && keep.has(m.parentId) && !keep.has(m.id)) {
        keep.add(m.id);
        changed = true;
      }
    }
  }
  const { recap, memorySeen, ...rest } = room;
  return {
    ...rest,
    messages: all.filter((m) => keep.has(m.id)).map(slimMessage),
    older: top.length - top.filter((m) => keep.has(m.id)).length,
  };
}

module.exports = { slimRoom, slimMessage };
