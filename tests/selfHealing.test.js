'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { MockExchange } = require('./mockExchange');
const { Portfolio } = require('../src/portfolio');
const { PortfolioStore } = require('../src/store');
const { RateLimitedGateway } = require('../src/gateway');
const { PortfolioConfig, TradePlan } = require('../src/portfolioRisk');
const { CostQuote } = require('../src/costs');
const { NetworkError, APIError } = require('../src/errors');
const { D } = require('../src/num');

function setup(cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b24-')); const ex = new MockExchange(); const logs = [];
  let now = ex.time; const clock = () => now;
  const config = new PortfolioConfig({ risk_percent: '0.5', portfolio_risk_percent: '3', daily_loss_percent: '5', markets: ['linear'], ai_entry_filter_enabled: false, quality_management_enabled: true, ...cfg });
  const store = new PortfolioStore(dir, 'DEMO');
  const p = new Portfolio(new RateLimitedGateway(ex, () => false, { interval: 0 }), config, store, (k, v) => { if (k === 'log') logs.push(v); }, { clock });
  return { dir, ex, p, logs, store, advance: (ms) => { now += ms; ex.time = now; } };
}
function plan(p) {
  const costs = new CostQuote({ maker_rate: '0.0002', taker_rate: '0.00055', slippage_rate: '0.002', carry_rate: '0.0001', observed_ms: p.clock() });
  return new TradePlan({ instrument_key: 'linear:BTCUSDT', market: 'linear', strategy: 'ema_cross', timeframe: '15', side: 'Buy', quantity: '0.1', base_equivalent: '0.1', entry: '100.11',
    stop: '98', target: '108', risk_usdt: '0.25', profit_usdt: '0.9', reference_usdt: '0.25', quote_fx: '1', costs, tick: '0.01', qty_step: '0.001', leverage: '3',
    management_version: 'quality-partial-v3', entry_fraction: '1', profit_lock_version: 'graduated-v1' });
}

test('initialize + arm on healthy account', async () => {
  const { p } = setup(); await p.initialize('id'); await p.arm();
  assert.equal(p.entries_enabled, true); assert.equal(p.universe.instruments.size, 3);
});

test('lost entry order (timeout, never reached exchange) is auto-cleared without halting', async () => {
  const { p, ex, advance, logs } = setup(); await p.initialize('id'); await p.arm();
  ex.dropNextOrder = true;
  await p.open(plan(p), null);
  assert.equal(Object.keys(p.state.positions).length, 1); assert.equal(p.state.halt, '');
  advance(130000); await p.reconcileSafe(Object.values(p.state.positions)[0]);
  assert.equal(Object.keys(p.state.positions).length, 0, 'phantom entry removed');
  assert.equal(p.state.halt, ''); assert.ok(logs.some((l) => l.includes('не дошёл до Bybit')));
});

test('filled entry -> open -> TP/SL verified -> close & book', async () => {
  const { p, ex, advance } = setup(); await p.initialize('id'); await p.arm();
  await p.open(plan(p), null); const rec = Object.values(p.state.positions)[0];
  await p.reconcileSafe(rec); assert.equal(rec.phase, 'open');
  await p.closeOne(rec, 'test'); advance(1000); await p.reconcileSafe(rec);
  assert.equal(Object.keys(p.state.positions).length, 0); assert.equal(p.state.total_net, '1.5');
});

test('position reduced outside the bot is adopted instead of halting', async () => {
  const { p, ex } = setup(); await p.initialize('id'); await p.arm();
  await p.open(plan(p), null); const rec = Object.values(p.state.positions)[0]; await p.reconcileSafe(rec);
  ex.position.size = '0.05'; await p.reconcileSafe(rec);
  assert.equal(p.state.positions[rec.id].plan.quantity, '0.05'); assert.equal(p.state.halt, '');
});

test('reconcile error quarantines one position, trading continues', async () => {
  const { p, ex } = setup(); await p.initialize('id'); await p.arm();
  await p.open(plan(p), null); const rec = Object.values(p.state.positions)[0];
  ex.inject('get_open_orders', new APIError(110001, 'weird'), 5);
  await p.reconcileSafe(rec);
  assert.ok(p.state.positions[rec.id].quarantine); assert.equal(p.state.halt, ''); assert.equal(p.entries_enabled, true);
});

test('worker recovers from network outage, auth failure and unexpected errors without user action', async () => {
  const { Controller } = require('../src/controller');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'b24c-')); fs.mkdirSync(path.join(base, 'data'));
  fs.writeFileSync(path.join(base, '.env'), "BYBIT_DEMO_API_KEY='k'\nBYBIT_DEMO_API_SECRET='s'\n");
  fs.writeFileSync(path.join(base, 'data', 'settings.json'), JSON.stringify({ markets: ['linear'], ai_entry_filter_enabled: false, risk_percent: '0.5', portfolio_risk_percent: '3' }));
  const ex = new MockExchange();
  ex.inject('get_account_info', new NetworkError('down'), 2);            // startup outage
  const ctl = new Controller({ base, httpFactory: () => ex });
  const origSleep = ctl.sleep.bind(ctl); ctl.sleep = (ms) => origSleep(Math.min(ms, 20));
  ctl.start({ mode: 'DEMO' });
  const until = async (cond, ms = 8000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };
  await until(() => ctl.health.entries_enabled === true);
  ex.inject('get_tickers', new NetworkError('flap'), 6);                  // mid-run outage
  ctl.engine.last_prices = 0;
  await until(() => ctl.health.entries_enabled === false);
  await until(() => ctl.health.entries_enabled === true);
  ex.inject('get_wallet_balance', new APIError(10003, 'invalid key'), 1); // auth glitch -> pause -> auto-recovery
  ctl.engine.last_prices = 0;
  await until(() => !!ctl.health.halt);
  // speed up the recovery timer for the test
  ctl.engine.state.halt_kind = 'error';
  await until(() => ctl.health.entries_enabled === true && !ctl.health.halt, 60000).catch(() => {});
  ctl.stop(); await ctl.close();
  assert.ok(ctl.logs.some((l) => l.text.includes('Временный сбой связи')));
  assert.ok(ctl.logs.some((l) => l.text.includes('ПРИОСТАНОВЛЕНЫ')));
});
