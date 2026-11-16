'use strict';
// Private loopback panel (127.0.0.1 only, session cookie, Origin check). Same API as the original.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Halt, ValueError, safeError } = require('./errors');

const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function makeServer(controller, { token }) {
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8', extra = {}) => {
      const raw = type.startsWith('application/json') ? Buffer.from(JSON.stringify(body)) : body;
      res.writeHead(code, { 'Content-Type': type, 'Content-Length': raw.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'", ...extra });
      res.end(raw);
    };
    try {
      if (req.headers.host !== server.hostPort) return send(403, { error: 'Неверный адрес панели' });
      const url = new URL(req.url, 'http://' + server.hostPort);
      const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === 'bybit_session');
      const authorized = !!cookie && eq(cookie[1] || '', token);
      if (req.method === 'GET') {
        if (url.pathname === '/enter') {
          if (!eq(url.searchParams.get('token') || '', token)) return send(403, { error: 'Откройте панель через START.bat' });
          res.writeHead(303, { Location: '/', 'Set-Cookie': `bybit_session=${token}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store', 'Content-Length': 0 }); return res.end();
        }
        if (!authorized) return send(403, { error: 'Откройте панель через ярлык бота или START.bat' });
        if (url.pathname === '/') return send(200, fs.readFileSync(path.join(controller.base, 'public', 'desktop_panel.html')), 'text/html; charset=utf-8');
        if (url.pathname === '/api/status') return send(200, { ok: true, ...controller.snapshot() });
        return send(404, { error: 'Не найдено' });
      }
      if (req.method !== 'POST') return send(405, { error: 'Метод не поддерживается' });
      if (!authorized) return send(403, { error: 'Нет доступа к панели' });
      if (req.headers.origin !== 'http://' + server.hostPort) return send(403, { error: 'Неверный источник команды' });
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size <= 16384) chunks.push(c); });
      req.on('end', () => {
        try {
          if (size < 1 || size > 16384) throw new ValueError('Недопустимый размер команды');
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValueError('Команда должна быть объектом');
          if (url.pathname === '/api/start') controller.start(body);
          else if (url.pathname === '/api/stop') controller.stop();
          else if (url.pathname === '/api/settings') controller.settings(body);
          else return send(404, { error: 'Неизвестная команда' });
          return send(200, { ok: true, ...controller.snapshot() });
        } catch (exc) {
          if (exc instanceof ValueError || exc instanceof Halt || exc instanceof SyntaxError) return send(400, { error: exc.message });
          return send(500, { error: 'Команда не выполнена: ' + safeError(exc) });
        }
      });
      req.on('error', () => {});
    } catch (exc) { try { send(500, { error: 'Ошибка чтения панели: ' + safeError(exc) }); } catch (e) { /* socket gone */ } }
  });
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (e) { /* ignore */ } });
  return server;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onError); server.hostPort = '127.0.0.1:' + server.address().port; resolve(server.address().port); };
    server.once('error', onError); server.once('listening', onOk); server.listen(port, '127.0.0.1');
  });
}

module.exports = { makeServer, listen };
