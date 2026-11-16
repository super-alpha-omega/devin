'use strict';
// Panel controller: owns worker lifecycle, logs, settings and the watchdog. Opening the panel never trades.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { saveJson, loadJson, readEnv, writeEnv } = require('./appSupport');
const { PortfolioConfig, CONFIG_DEFAULTS } = require('./portfolioRisk');
const { buildDashboard, fundingStatus } = require('./strategyDashboard');
const { runWorker } = require('./worker');
const { safeError, ValueError } = require('./errors');

class Event { constructor() { this.flag = false; this.waiters = []; } set() { this.flag = true; this.waiters.splice(0).forEach((w) => w()); } clear() { this.flag = false; } isSet() { return this.flag; } }

class Controller {
  constructor({ base, httpFactory = null } = {}) {
    this.base = base; this.data = path.join(base, 'data'); fs.mkdirSync(this.data, { recursive: true }); fs.mkdirSync(path.join(base, 'logs'), { recursive: true });
    this.httpFactory = httpFactory; this.stopEvent = new Event(); this.commands = []; this.worker = null; this.engine = null;
    this.ready = false; this.mode = this.preferences().mode; this.health = {}; this.groups = []; this.summary = {}; this.logs = [];
    this.lastFault = ''; this.heartbeat = 0; this.started = 0; this.stopping = false; this.preserveResume = false; this.restarts = 0;
    this.logFile = path.join(base, 'logs', 'bot.log');
    this.watchdog = setInterval(() => this.checkWatchdog(), 15000); this.watchdog.unref();
  }
  emit(kind, value) {
    if (kind === 'log') {
      this.logs.push({ at: Date.now() / 1000, text: String(value) }); if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
      try {
        const st = fs.existsSync(this.logFile) ? fs.statSync(this.logFile).size : 0;
        if (st > 2000000) { try { fs.renameSync(this.logFile + '.1', this.logFile + '.2'); } catch (e) { /* none */ } try { fs.renameSync(this.logFile, this.logFile + '.1'); } catch (e) { /* none */ } }
        fs.appendFileSync(this.logFile, new Date().toISOString() + ' ' + value + '\n');
      } catch (e) { /* disk issues never stop trading */ }
    } else if (kind === 'ready') this.ready = true;
    else if (kind === 'health') this.health = value;
    else if (kind === 'heartbeat') this.heartbeat = value;
    else if (kind === 'groups') this.groups = value;
    else if (kind === 'summary') this.summary = value;
    else if (kind === 'fault') this.lastFault = value;
    else if (kind === 'done') this.ready = false;
  }
  running() { return !!this.worker; }
  drainCommands() { return this.commands.splice(0); }
  sleep(ms) { return new Promise((resolve) => { const t = setTimeout(done, ms); const self = this; function done() { clearTimeout(t); resolve(); } if (self.stopEvent.isSet()) done(); else self.stopEvent.waiters.push(done); }); }
  config() {
    const values = { ...CONFIG_DEFAULTS }; const saved = loadJson(path.join(this.data, 'settings.json'), {});
    if (saved && typeof saved === 'object') for (const [k, v] of Object.entries(saved)) if (k in CONFIG_DEFAULTS) values[k] = v;
    try { return new PortfolioConfig(values).validate(); } catch (e) { this.emit('log', 'Настройки повреждены (' + e.message + '); используются значения по умолчанию.'); return new PortfolioConfig({}).validate(); }
  }
  credentials(mode) {
    const prefix = mode === 'DEMO' ? 'BYBIT_DEMO' : 'BYBIT'; const values = readEnv(path.join(this.base, '.env'));
    return ['_API_KEY', '_API_SECRET'].map((s) => String(values[prefix + s] || process.env[prefix + s] || '').trim());
  }
  preferences() {
    const p = loadJson(path.join(this.data, 'preferences.json'), null);
    if (p && ['REAL', 'DEMO'].includes(p.mode) && typeof p.auto_resume === 'boolean') return p;
    return { mode: 'REAL', auto_resume: true };
  }
  launch() { const l = loadJson(path.join(this.data, 'launch.json'), null); return l && ['REAL', 'DEMO'].includes(l.mode) ? l : null; }
  wantTrading() { const l = this.launch(); return !!(l && l.enabled) && !fs.existsSync(path.join(this.data, 'manual_stop.json')); }
  settings(body) {
    if (this.running()) throw new ValueError('Сначала нажмите «Стоп» и дождитесь завершения процесса.');
    const supplied = body.config || {};
    if (typeof supplied !== 'object' || Object.keys(supplied).some((k) => !(k in CONFIG_DEFAULTS))) throw new ValueError('Неизвестные настройки');
    const config = new PortfolioConfig({ ...this.config().toJSON(), ...supplied }).validate();
    const mode = body.mode || 'REAL'; if (!['REAL', 'DEMO'].includes(mode)) throw new ValueError('Неизвестный режим');
    const key = body.key || '', secret = body.secret || '';
    if (typeof key !== 'string' || typeof secret !== 'string') throw new ValueError('Некорректные API-ключи');
    if (/[\r\n\0']/.test(key + secret)) throw new ValueError('Ключи должны занимать одну строку');
    if (!!key.trim() !== !!secret.trim()) throw new ValueError('Введите ключ и секрет вместе; оба пустых поля сохраняют прежние значения.');
    if (key.trim()) { const prefix = mode === 'DEMO' ? 'BYBIT_DEMO' : 'BYBIT'; writeEnv(path.join(this.base, '.env'), { [prefix + '_API_KEY']: key.trim(), [prefix + '_API_SECRET']: secret.trim() }); }
    saveJson(path.join(this.data, 'settings.json'), config.toJSON()); this.mode = mode;
    const enabled = body.auto_resume ?? true; if (typeof enabled !== 'boolean') throw new ValueError('Некорректный автозапуск');
    saveJson(path.join(this.data, 'preferences.json'), { mode, auto_resume: enabled });
    this.configureStartup(enabled);
    this.emit('log', 'Настройки сохранены. Торговля не запускалась.');
  }
  configureStartup(enabled) {
    if (process.platform !== 'win32') return;
    const node = process.execPath; const script = path.join(this.base, 'supervisor.js');
    const args = enabled ? ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'BybitPortfolio24JS', '/t', 'REG_SZ', '/d', `"${node}" "${script}" --no-browser`, '/f']
      : ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'BybitPortfolio24JS', '/f'];
    execFile('reg', args, { windowsHide: true }, () => {});
  }
  start(body = {}, resume = false) {
    if (this.running()) {
      if (this.stopping) throw new ValueError('Дождитесь подтверждённой остановки.');
      if (this.health.entries_enabled) return;
      if (this.mode === 'REAL' && body.confirm_real !== true && !resume) throw new ValueError('Подтвердите реальные сделки.');
      saveJson(path.join(this.data, 'launch.json'), { mode: this.mode, enabled: true }); try { fs.unlinkSync(path.join(this.data, 'manual_stop.json')); } catch (e) { /* none */ }
      this.commands.push('arm'); return;
    }
    const mode = body.mode || this.preferences().mode; if (!['REAL', 'DEMO'].includes(mode)) throw new ValueError('Неизвестный режим');
    if (!resume && mode === 'REAL' && body.confirm_real !== true) throw new ValueError('Подтвердите реальные сделки.');
    const config = this.config(); const [key, secret] = this.credentials(mode);
    if (!key || !secret) throw new ValueError('Сохраните API Key и API Secret для ' + mode + '.');
    if (resume && fs.existsSync(path.join(this.data, 'manual_stop.json'))) return;
    Object.assign(this, { mode, ready: false, stopping: false, health: {}, summary: {}, groups: [], lastFault: '', heartbeat: 0, started: Date.now() / 1000, commands: [], preserveResume: false });
    this.stopEvent = new Event();
    if (!resume) { saveJson(path.join(this.data, 'launch.json'), { mode, enabled: true }); try { fs.unlinkSync(path.join(this.data, 'manual_stop.json')); } catch (e) { /* none */ } }
    this.emit('log', mode + (resume ? ': автоматическое продолжение после перезапуска' : ': запуск') + ', сверка журнала и счёта. Входы включатся только после успешных проверок.');
    const stopEvent = this.stopEvent;
    this.worker = runWorker(this, { mode, key, secret, config, dataDir: this.data, httpFactory: this.httpFactory, sleep: (ms) => this.sleep(ms) })
      .catch((exc) => { this.emit('fault', 'Сбой торгового цикла: ' + safeError(exc)); })
      .finally(() => {
        this.worker = null; this.stopping = false;
        // Self-healing: an unexpected worker exit restarts it unless the user pressed Stop.
        if (!stopEvent.isSet() && this.wantTrading()) {
          this.restarts++; const delay = Math.min(60000, 5000 * this.restarts);
          this.emit('log', 'Торговый цикл завершился неожиданно; автоматический перезапуск через ' + delay / 1000 + ' с.');
          setTimeout(() => { if (!this.running() && this.wantTrading()) { try { this.start({ mode }, true); } catch (e) { this.emit('fault', e.message); } } }, delay);
        }
      });
  }
  checkWatchdog() {
    if (!this.running() || this.stopping || !this.ready) return;
    const age = this.heartbeat ? Date.now() / 1000 - this.heartbeat : Date.now() / 1000 - this.started;
    if (age > 300) {
      this.emit('log', 'Сторож: торговый цикл не отвечает ' + Math.round(age) + ' с — перезапуск процесса.');
      if (process.send) process.send({ type: 'restart', reason: 'trading loop stalled' }); else process.exit(3);
    }
  }
  stop() {
    this.stopEvent.set(); this.stopping = this.running(); this.health = { ...this.health, entries_enabled: false };
    saveJson(path.join(this.data, 'manual_stop.json'), { at: Date.now() / 1000, mode: this.mode });
    saveJson(path.join(this.data, 'launch.json'), { mode: this.mode, enabled: false });
    this.emit('log', 'СТОП: новые запросы блокируются; ждём текущий запрос и сохранение журнала. Позиции и ордера не отменяются.');
  }
  resumeSaved() {
    const launch = this.launch();
    if (!launch || !launch.enabled || fs.existsSync(path.join(this.data, 'manual_stop.json')) || !this.preferences().auto_resume) return;
    try { this.start({ mode: launch.mode }, true); } catch (exc) { this.emit('fault', 'Автопродолжение ожидает: ' + exc.message); setTimeout(() => this.resumeSaved(), 60000).unref(); }
  }
  snapshot() {
    const running = this.running(); const now = Date.now() / 1000; const h = { ...this.health };
    const age = this.heartbeat ? now - this.heartbeat : null; let state;
    if (!running) state = this.lastFault ? 'ОШИБКА ЗАПУСКА' : 'ОСТАНОВЛЕН';
    else if (this.stopping) state = 'ОСТАНОВКА — ожидаем завершения запроса';
    else if (!this.ready) state = 'ПОДКЛЮЧЕНИЕ И СВЕРКА (автоповтор)';
    else if (age !== null && age > 90) state = 'НЕТ ОТВЕТА ТОРГОВОГО ЦИКЛА — сторож перезапустит';
    else if (h.halt) state = 'ВХОДЫ ПРИОСТАНОВЛЕНЫ — АВТОВОССТАНОВЛЕНИЕ';
    else if (!h.entries_enabled) state = 'СВЕРКА / ВХОДЫ ВЫКЛЮЧЕНЫ';
    else if (h.training) state = 'РАБОТАЕТ — ОБУЧЕНИЕ ИИ';
    else state = 'РАБОТАЕТ — ПОИСК СДЕЛОК';
    if (!running) h.entries_enabled = false;
    const config = this.config().toJSON();
    return { running, stopping: running && this.stopping, ready: this.ready, state, mode: this.mode, fault: this.lastFault, heartbeat_age: age !== null ? Math.round(age * 10) / 10 : null,
      health: h, groups: this.groups, summary: this.summary, logs: this.logs.slice(-160), config, preferences: this.preferences(),
      keys_configured: { REAL: this.credentials('REAL').every(Boolean), DEMO: this.credentials('DEMO').every(Boolean) },
      funding_transfer: fundingStatus(this.data, this.mode, config.funding_transfer_enabled, true, running && this.ready),
      strategy_dashboard: buildDashboard(this.data, this.mode, config.markets), self_healing: { auto_recovery: config.auto_recovery_enabled, worker_restarts: this.restarts } };
  }
  async close() { this.preserveResume = true; this.stopEvent.set(); const w = this.worker; if (w) await Promise.race([w, new Promise((r) => setTimeout(r, 20000))]); clearInterval(this.watchdog); }
}

module.exports = { Controller, Event };
