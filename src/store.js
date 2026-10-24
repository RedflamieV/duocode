// Хранение чатов: по JSON-файлу на чат в папке данных приложения.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.timers = new Map();
    this.gens = new Map(); // id чата -> номер последней начатой записи
    this.inflight = new Set(); // чаты, чья фоновая запись ещё идёт
    fs.mkdirSync(dir, { recursive: true });
    // недописанные временные файлы от прошлого запуска
    for (const name of fs.readdirSync(dir)) if (name.endsWith('.tmp')) fs.rm(path.join(dir, name), { force: true }, () => {});
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

  // Обычное сохранение — отложенное и в фоне: запись большого чата на диск не должна подвешивать окно и агентов.
  // immediate — сразу и синхронно (создание чата, выход из приложения).
  save(room, immediate = false) {
    clearTimeout(this.timers.get(room.id));
    this.timers.delete(room.id);
    if (immediate) return this.write(room, true);
    this.timers.set(room.id, setTimeout(() => {
      this.timers.delete(room.id);
      this.write(room, false);
    }, 600));
  }

  // Каждая запись — во временный файл со своим номером; переименовываем, только если за это время
  // не начали запись новее (иначе старая версия чата затёрла бы свежую).
  write(room, sync) {
    const gen = (this.gens.get(room.id) || 0) + 1;
    this.gens.set(room.id, gen);
    const file = this.file(room.id);
    const tmp = `${file}.${gen}.tmp`;
    const data = JSON.stringify(room);
    if (sync) {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
      return;
    }
    this.inflight.add(room.id);
    fs.promises
      .writeFile(tmp, data)
      .then(() => (this.gens.get(room.id) === gen ? fs.promises.rename(tmp, file) : fs.promises.unlink(tmp)))
      .catch(() => fs.promises.unlink(tmp).catch(() => {}))
      .finally(() => this.gens.get(room.id) === gen && this.inflight.delete(room.id));
  }

  remove(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.gens.set(id, (this.gens.get(id) || 0) + 1); // начатая фоновая запись не воскресит удалённый чат
    try {
      fs.unlinkSync(this.file(id));
    } catch {}
  }

  flush(rooms) {
    // и отложенные, и те, что сейчас пишутся в фоне: при выходе ждать их некому
    for (const id of new Set([...this.timers.keys(), ...this.inflight])) {
      const room = rooms.get(id);
      if (room) this.save(room, true);
    }
  }
}

module.exports = { Store };
