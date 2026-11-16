'use strict';
// Panel + trading process. Started and watched by supervisor.js; can also run standalone.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Controller } = require('./controller');
const { makeServer, listen } = require('./panelServer');
const { InstanceLock, saveJson, loadJson } = require('./appSupport');
const { safeError } = require('./errors');

const BASE = path.resolve(__dirname, '..');
const DATA = path.join(BASE, 'data');

function sessionToken() {
  const file = path.join(DATA, '.panel_session.json'); const s = loadJson(file, null);
  if (s && /^[A-Za-z0-9_-]{32,128}$/.test(s.token || '') && Date.now() / 1000 - s.created < 30 * 86400) return s.token;
  const token = crypto.randomBytes(32).toString('base64url'); saveJson(file, { token, created: Date.now() / 1000 }); return token;
}

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  else if (process.platform === 'darwin') execFile('open', [url], () => {});
  else execFile('xdg-open', [url], () => {});
}

async function main() {
  const args = process.argv.slice(2); fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(path.join(BASE, 'logs'), { recursive: true });
  const noBrowser = args.includes('--no-browser') || process.env.BYBIT24_RESTART === '1';
  const portArg = args.find((a) => a.startsWith('--port=')); const preferred = portArg ? parseInt(portArg.split('=')[1], 10) : parseInt(process.env.BYBIT24_PORT || '63724', 10);
  let lock;
  try { lock = new InstanceLock(path.join(BASE, 'bot.lock')); } catch (exc) {
    const p = loadJson(path.join(DATA, 'panel.json'), null); if (p && p.url && !noBrowser) openBrowser(p.url);
    console.error('Бот уже запущен из этой папки; открыта существующая панель.'); process.exit(0);
  }
  const controller = new Controller({ base: BASE });
  const token = sessionToken(); const server = makeServer(controller, { token });
  let port;
  try { port = await listen(server, preferred); } catch (e) { port = await listen(server, 0); controller.emit('log', 'Порт ' + preferred + ' занят; панель открыта на порту ' + port + '.'); }
  const entry = `http://127.0.0.1:${port}/enter?token=${token}`;
  saveJson(path.join(DATA, 'panel.json'), { url: entry, pid: process.pid });
  console.log('Панель: ' + entry);
  if (!noBrowser) openBrowser(entry);
  controller.resumeSaved();
  const heartbeat = setInterval(() => { if (process.send) process.send({ type: 'heartbeat', at: Date.now() }); }, 5000);
  let closing = false;
  const shutdown = async (code = 0) => {
    if (closing) return; closing = true; clearInterval(heartbeat);
    try { await controller.close(); } catch (e) { /* ignore */ }
    server.close(); lock.close(); process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0));
  process.on('message', (m) => { if (m && m.type === 'shutdown') shutdown(0); });
  // Last line of defence: log, persist diagnostics and let the supervisor restart a clean process.
  const fatal = (kind) => (err) => {
    try { controller.emit('log', 'Критическая ошибка (' + kind + '): ' + safeError(err) + '. Автоматический перезапуск процесса; журнал сохранён.'); } catch (e) { /* ignore */ }
    try { fs.appendFileSync(path.join(BASE, 'logs', 'crash.log'), new Date().toISOString() + ' ' + kind + ' ' + (err && err.stack || err) + '\n'); } catch (e) { /* ignore */ }
    controller.preserveResume = true; setTimeout(() => process.exit(70), 500).unref(); shutdown(70);
  };
  process.on('uncaughtException', fatal('uncaughtException'));
  process.on('unhandledRejection', fatal('unhandledRejection'));
}

main().catch((exc) => {
  try { fs.mkdirSync(path.join(BASE, 'logs'), { recursive: true }); fs.writeFileSync(path.join(BASE, 'logs', 'startup_error.txt'), 'Панель не запустилась: ' + safeError(exc) + '\n' + (exc && exc.stack)); } catch (e) { /* ignore */ }
  console.error('Панель не запустилась: ' + safeError(exc)); process.exit(1);
});
