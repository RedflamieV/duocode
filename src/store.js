// Хранение чатов: по JSON-файлу на чат в папке данных приложения.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.timers = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  loadAll() {
    const rooms = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        rooms.push(JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')));
      } catch {
        // повреждённый файл пропускаем
      }
    }
    return rooms;
  }

  save(room, immediate = false) {
    clearTimeout(this.timers.get(room.id));
    const write = () => {
      this.timers.delete(room.id);
      const tmp = this.file(room.id) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(room));
      fs.renameSync(tmp, this.file(room.id));
    };
    if (immediate) write();
    else this.timers.set(room.id, setTimeout(write, 600));
  }

  remove(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    try {
      fs.unlinkSync(this.file(id));
    } catch {}
  }

  flush(rooms) {
    for (const id of [...this.timers.keys()]) {
      const room = rooms.get(id);
      if (room) this.save(room, true);
    }
  }
}

module.exports = { Store };
