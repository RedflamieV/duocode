// Один занятый чат не должен прерывать применение настроек к остальным.
async function applyChatDefaults(rooms, patch, update) {
  let applied = 0;
  const failed = [];
  for (const room of rooms) {
    try { await update(room.id, patch); applied++; }
    catch (error) { failed.push({ id: room.id, title: room.title, error: String(error.message || error) }); }
  }
  return { applied, failed };
}

module.exports = { applyChatDefaults };
