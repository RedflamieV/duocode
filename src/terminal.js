// Терминал боковой панели: команды и долгие процессы (dev-сервер, сборка, тесты) в папке проекта.
// Без эмуляции TTY: вывод идёт как есть, полноэкранные программы (vim, htop) здесь не работают.
// Процессы видят и пользователь (вкладка «Терминал»), и агенты (инструменты terminal_*).
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { killTree, uid } = require('./agents/util');
const { isWin, userShell } = require('./env');

const MAX = 200000; // сколько вывода держим на процесс
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]/g, '');

class Terminals extends EventEmitter {
  constructor() {
    super();
    this.items = new Map();
    this.pending = new Map(); // id -> накопленный вывод для окна (отправляем пачками)
    this.timer = null;
  }

  start({ command, cwd, by = 'user', roomId = null }) {
    command = String(command || '').trim();
    if (!command) throw new Error('Пустая команда');
    const env = { ...process.env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1', PYTHONUNBUFFERED: '1' };
    // Windows: UTF-8 в консоли, иначе кириллица в выводе превращается в кракозябры
    const proc = isWin
      ? spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`], { cwd, env, windowsVerbatimArguments: true, windowsHide: true })
      : spawn(userShell() || '/bin/sh', ['-c', command], { cwd, env, detached: false });
    const t = { id: uid('t'), command, cwd, by, roomId, status: 'running', code: null, startedAt: Date.now(), output: '', proc };
    this.items.set(t.id, t);
    const add = (chunk) => {
      const text = chunk.toString('utf8');
      t.output = (t.output + text).slice(-MAX);
      this.pending.set(t.id, (this.pending.get(t.id) || '') + text);
      if (!this.timer) this.timer = setTimeout(() => this.flush(), 60);
    };
    proc.stdout.on('data', add);
    proc.stderr.on('data', add);
    proc.on('error', (err) => add(`\n${err.message}\n`));
    proc.on('close', (code) => {
      t.status = 'exited';
      t.code = code;
      t.proc = null;
      add(`\n[процесс завершился${code != null ? ` с кодом ${code}` : ''}]\n`);
      this.emit('list', this.list());
    });
    this.emit('list', this.list());
    return this.summary(t);
  }

  flush() {
    this.timer = null;
    for (const [id, data] of this.pending) this.emit('data', id, data);
    this.pending.clear();
  }

  summary(t) {
    return { id: t.id, command: t.command, cwd: t.cwd, by: t.by, roomId: t.roomId, status: t.status, code: t.code, startedAt: t.startedAt };
  }

  list() {
    return [...this.items.values()].map((t) => this.summary(t));
  }

  output(id) {
    const t = this.items.get(id);
    return t ? t.output : '';
  }

  // Хвост вывода для агента: без цветовых кодов, перерисовки строк (\r) схлопнуты.
  tail(id, lines = 60) {
    const t = this.items.get(id);
    if (!t) throw new Error(`Процесс ${id} не найден`);
    const text = strip(t.output)
      .split('\n')
      .map((l) => l.split('\r').filter(Boolean).pop() || '')
      .slice(-Math.min(Math.max(Number(lines) || 60, 5), 400))
      .join('\n');
    return text;
  }

  write(id, text) {
    const t = this.items.get(id);
    if (!t || !t.proc) throw new Error('Процесс уже завершился');
    t.proc.stdin.write(String(text).replace(/\n?$/, '\n'));
  }

  stop(id) {
    const t = this.items.get(id);
    if (t && t.proc) killTree(t.proc);
  }

  remove(id) {
    this.stop(id);
    this.items.delete(id);
    this.emit('list', this.list());
  }

  stopAll() {
    for (const t of this.items.values()) if (t.proc) killTree(t.proc);
  }
}

module.exports = { Terminals, strip };
