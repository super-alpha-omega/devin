'use strict';
// Supervisor: keeps the bot process alive. Restarts it after crashes or freezes with growing delays.
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const LOG = path.join(BASE, 'logs', 'supervisor.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const log = (text) => { const line = new Date().toISOString() + ' ' + text; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* ignore */ } };

let child = null, lastBeat = Date.now(), restarts = 0, startedAt = 0, stopping = false, first = true;
const passArgs = process.argv.slice(2);

function start() {
  startedAt = Date.now(); lastBeat = Date.now();
  const env = { ...process.env, BYBIT24_RESTART: first ? '0' : '1' }; first = false;
  child = fork(path.join(BASE, 'src', 'main.js'), passArgs, { env, stdio: 'inherit' });
  log('Бот запущен (pid ' + child.pid + ').');
  child.on('message', (m) => {
    if (!m) return;
    if (m.type === 'heartbeat') lastBeat = Date.now();
    if (m.type === 'restart') { log('Запрошен перезапуск: ' + m.reason); kill(); }
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    if (code === 0 && !signal) { log('Бот завершился штатно.'); return process.exit(0); }
    if (Date.now() - startedAt > 600000) restarts = 0;
    restarts++;
    const delay = Math.min(60000, 2000 * 2 ** Math.min(5, restarts - 1));
    log(`Бот завершился (код ${code}, сигнал ${signal}). Автоматический перезапуск через ${delay / 1000} с (попытка ${restarts}).`);
    setTimeout(start, delay);
  });
}
function kill() {
  if (!child) return; const c = child;
  try { c.send({ type: 'shutdown' }); } catch (e) { /* ignore */ }
  setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* ignore */ } }, 30000).unref();
}
setInterval(() => {
  if (child && Date.now() - lastBeat > 90000) { log('Сторож: нет сигнала от бота ' + Math.round((Date.now() - lastBeat) / 1000) + ' с — принудительный перезапуск.'); lastBeat = Date.now(); try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
}, 10000);
const quit = () => { stopping = true; if (child) kill(); else process.exit(0); };
process.on('SIGINT', quit); process.on('SIGTERM', quit);
process.on('uncaughtException', (e) => log('Супервизор: ' + (e && e.stack || e)));
start();
