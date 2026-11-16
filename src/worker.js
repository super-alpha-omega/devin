'use strict';
// Self-healing trading worker: every failure is classified, logged and recovered automatically.
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Halt, RequestCancelled, ExternalAccountBusy, isTemporary, isAuthError, temporaryRead, safeError, describe } = require('./errors');
const { Portfolio } = require('./portfolio');
const { PortfolioStore } = require('./store');
const { RateLimitedGateway } = require('./gateway');
const { BybitHTTP } = require('./bybitClient');
const { InstanceLock, saveJson } = require('./appSupport');

const backoff = (n, base, cap) => Math.min(cap, base * 2 ** Math.max(0, n - 1));

function recordFailure(dataDir, error) {
  const frames = String(error && error.stack || '').split('\n').slice(1, 13).map((l) => l.trim().replace(/\(.*[\\/]/, '(')).filter(Boolean);
  try { saveJson(path.join(dataDir, 'last_failure.json'), { at: Date.now() / 1000, type: error && error.name, code: error && error.status_code, frames }); } catch (e) { /* ignore */ }
}

function accountLock(mode, key) {
  const digest = crypto.createHash('sha256').update(mode + ':' + key).digest('hex').slice(0, 32);
  const parent = path.join(process.env.LOCALAPPDATA || require('os').homedir(), 'BybitPortfolioLocks');
  return new InstanceLock(path.join(parent, digest + '.lock'), 'Этот API-ключ уже используется другим окном бота на компьютере.');
}

async function runWorker(ctl, { mode, key, secret, config, dataDir, httpFactory = null, sleep, lockFactory = accountLock }) {
  const emit = (k, v) => ctl.emit(k, v);
  const stopped = () => ctl.stopEvent.isSet();
  let initFailures = 0; let lock = null;
  while (!stopped()) {
    try { lock = lockFactory(mode, key); break; } catch (exc) {
      initFailures++; emit('fault', exc.message);
      if (initFailures === 1 || initFailures % 20 === 0) emit('log', exc.message + ' Повторная попытка автоматически.');
      await sleep(backoff(initFailures, 5000, 60000));
    }
  }
  let session = null, journal = null, engine = null;
  try {
    // Outer self-healing loop: rebuilds the whole engine after repeated unknown failures.
    initFailures = 0;
    while (!stopped()) {
      session = httpFactory ? httpFactory({ demo: mode === 'DEMO', apiKey: key, apiSecret: secret }) : new BybitHTTP({ demo: mode === 'DEMO', apiKey: key, apiSecret: secret, timeout: 12 });
      const gateway = new RateLimitedGateway(session, stopped);
      if (!journal) journal = new PortfolioStore(dataDir, mode, (t) => emit('log', t));
      engine = new Portfolio(gateway, config, journal, emit, { cancelled: stopped });
      ctl.engine = engine;
      const identity = crypto.createHash('sha256').update(key).digest('hex');
      // 1. Initialisation with unlimited automatic retries.
      let lastInit = '';
      while (!stopped()) {
        try { await engine.initialize(identity); emit('fault', ''); break; } catch (exc) {
          if (exc instanceof RequestCancelled && stopped()) break;
          initFailures++; const reason = describe(exc); const delay = backoff(initFailures, isAuthError(exc) ? 30000 : 5000, 300000);
          emit('fault', 'Подключение: ' + reason + ' — повтор через ' + Math.round(delay / 1000) + ' с');
          if (reason !== lastInit || initFailures % 10 === 0) emit('log', 'Подключение/сверка не удались: ' + reason + '. Автоматический повтор через ' + Math.round(delay / 1000) + ' с.');
          lastInit = reason; engine.publish(); emit('heartbeat', Date.now() / 1000);
          await sleep(delay);
        }
      }
      if (stopped()) break;
      initFailures = 0;
      emit('ready', mode);
      if (ctl.wantTrading() && !engine.state.halt) {
        try { await engine.arm(); } catch (exc) { if (!(exc instanceof RequestCancelled)) emit('log', 'Включение входов отложено: ' + describe(exc)); }
      }
      // 2. Main loop.
      let lastError = ''; let unknownStreak = 0; let tempStreak = 0; let recoveryAttempts = 0; let nextRecovery = 0;
      while (!stopped()) {
        for (const command of ctl.drainCommands()) {
          try {
            if (command === 'arm') { if (engine.state.halt) await engine.review(); await engine.arm(); recoveryAttempts = 0; }
            else if (command === 'pause') { engine.entries_enabled = false; engine.state.resume_armed = false; engine.persist(); engine.log('Новые входы остановлены пользователем. TP/SL и сверка продолжаются.'); engine.publish(); }
            else if (command === 'close') await engine.closeOwned();
            else if (command === 'review') await engine.review();
          } catch (exc) { if (exc instanceof RequestCancelled && stopped()) break; emit('log', 'Команда ' + command + ': ' + describe(exc)); }
        }
        if (stopped()) break;
        // Automatic recovery from a safety pause: fresh reconciliation, then re-arm.
        if (engine.state.halt && config.auto_recovery_enabled && ctl.wantTrading() && Date.now() >= nextRecovery) {
          recoveryAttempts++;
          const base = engine.state.halt_kind === 'auth' ? 300000 : engine.state.halt_kind === 'daily' ? 600000 : 30000;
          nextRecovery = Date.now() + backoff(recoveryAttempts, base, 900000);
          try {
            await engine.review(); await engine.arm();
            emit('log', 'АВТОВОССТАНОВЛЕНИЕ: сверка пройдена, поиск сделок снова включён.'); recoveryAttempts = 0; lastError = '';
          } catch (exc) {
            if (exc instanceof RequestCancelled && stopped()) break;
            const reason = describe(exc);
            if (exc instanceof Halt && !isTemporary(exc)) engine.state.halt = engine.state.halt || reason;
            if (recoveryAttempts <= 3 || recoveryAttempts % 10 === 0) emit('log', 'Автовосстановление отложено (' + reason + '); следующая попытка через ' + Math.round((nextRecovery - Date.now()) / 1000) + ' с.');
            engine.persist(); engine.publish();
          }
        }
        try {
          await engine.step();
          emit('heartbeat', Date.now() / 1000); lastError = ''; unknownStreak = 0; tempStreak = 0;
        } catch (exc) {
          if (exc instanceof RequestCancelled) { if (stopped()) break; continue; }
          if (temporaryRead(exc) || isTemporary(exc)) {
            tempStreak++; engine.entries_enabled = false; engine.last_prices = engine.last_manage = engine.last_foreign_check = 0; engine.publish();
            const delay = backoff(tempStreak, 3000, 60000);
            if (lastError !== 'temporary') emit('log', 'Временный сбой связи с биржей (' + safeError(exc) + '). Автоматический повтор; неизвестные заявки не повторяются.');
            lastError = 'temporary'; emit('heartbeat', Date.now() / 1000); await sleep(delay); continue;
          }
          if (isAuthError(exc)) { engine.pause('Биржа отклонила авторизацию/права ключа: ' + safeError(exc), 'auth'); lastError = 'auth'; await sleep(5000); continue; }
          if (exc instanceof Halt) { if (exc.message !== lastError) engine.pause(exc.message); lastError = exc.message; await sleep(1000); continue; }
          unknownStreak++; recordFailure(dataDir, exc);
          const reason = 'Ошибка API/данных: ' + safeError(exc);
          if (reason !== lastError) engine.pause(reason + '. Автоматическое восстановление.');
          lastError = reason;
          if (unknownStreak >= 20) { emit('log', 'Повторяющиеся ошибки: полный перезапуск торгового ядра (журнал и позиции сохраняются).'); break; }
          await sleep(backoff(unknownStreak, 1000, 30000)); continue;
        }
        await sleep(100);
      }
      if (stopped()) break;
      try { engine.shutdown(false); } catch (e) { /* ignore */ }
      if (session && session.close) session.close();
      await sleep(5000);
    }
  } catch (exc) {
    recordFailure(dataDir, exc);
    emit('log', 'Непредвиденная ошибка торгового цикла: ' + safeError(exc) + '. Процесс будет перезапущен автоматически.');
    throw exc;
  } finally {
    for (const action of [() => engine && engine.shutdown(!ctl.preserveResume), () => journal && journal.close(), () => session && session.close && session.close(), () => lock && lock.close()]) {
      try { action(); } catch (exc) { emit('log', 'Ошибка завершения: ' + safeError(exc)); }
    }
    ctl.engine = null; emit('done', null);
  }
}

module.exports = { runWorker, accountLock, recordFailure, backoff };
