'use strict';
// Candle cache, candidate priority, margin leverage, position display and profit lock.
const { D, Decimal, number, roundStep } = require('./num');
const { Halt, AdmissionRefused } = require('./errors');

class ClosedCandles {
  constructor(capacity = 128, ttl = 15, clock = () => performance.now() / 1000) { this.capacity = capacity; this.ttl = ttl; this.clock = clock; this.data = new Map(); this.hits = 0; this.misses = 0; }
  get(key, count, wallMs) {
    const now = this.clock(); const value = this.data.get(key);
    if (value) {
      const [until, started, wall, requested, rows] = value;
      if (now < until && Math.abs((wallMs - wall) / 1000 - (now - started)) <= 2 && requested === count) {
        this.data.delete(key); this.data.set(key, value); this.hits++; return rows.slice(-count);
      }
      this.data.delete(key);
    }
    this.misses++; return null;
  }
  put(key, rows, count, serverMs, periodMs, wallMs) {
    if (!rows.length) return;
    const now = this.clock(); const until = now + Math.min(this.ttl, Math.max(0, ((Math.floor(serverMs / periodMs) + 1) * periodMs - serverMs) / 1000));
    this.data.delete(key); this.data.set(key, [until, now, wallMs, count, rows.map((r) => [...r])]);
    while (this.data.size > this.capacity) this.data.delete(this.data.keys().next().value);
  }
}

const rank = (plan, score = 0, quality = true) => [quality && plan.entry_fraction.eq(1) ? 1 : 0, D(score)];
const rankCmp = (a, b) => (a[0] - b[0]) || a[1].cmp(b[1]);
function ordered(queue, cursor, quality = true) {
  const rotate = (items) => { const n = items.length ? cursor % items.length : 0; return items.slice(n).concat(items.slice(0, n)); };
  if (!quality) return rotate(queue);
  return rotate(queue.filter((c) => c[3].entry_fraction.eq(1))).concat(rotate(queue.filter((c) => !c[3].entry_fraction.eq(1))));
}

async function prepareMargin(owner, plan, item) {
  if (!(plan.leverage.gte(2) && plan.leverage.lte(7))) throw new AdmissionRefused('Bybit margin supports selected leverage 2–7 only');
  if ([item.base, item.quote].some((c) => owner.debt(c).gt(0))) throw new AdmissionRefused('Existing currency debt prevents independent margin entry');
  const status = await owner.api.call('spot_margin_trade_get_status_and_leverage');
  if (String(status.spotMarginMode) !== '1') throw new AdmissionRefused('Margin must be activated by its owner');
  const actual = number(status.spotLeverage || '0', 'Native margin leverage');
  if (!actual.eq(plan.leverage)) {
    if (owner.activePlans().some((p) => p.market === 'margin') || (owner.wallet.coin || []).some((c) => owner.debt(c.coin).gt(0))) throw new AdmissionRefused('Shared margin leverage cannot change under existing positions or debt');
    await owner.api.call('spot_margin_trade_set_leverage', { leverage: plan.leverage.toString() });
    const proof = await owner.api.call('spot_margin_trade_get_status_and_leverage');
    if (String(proof.spotMarginMode) !== '1' || !number(proof.spotLeverage || '0', 'Confirmed margin leverage').eq(plan.leverage)) throw new Halt('Margin leverage change is not confirmed; no entry submitted');
  }
  return plan.leverage;
}

function entryAmounts(rec, plan) {
  const result = { entry_notional_usdt: null, entry_collateral_estimate_usdt: null, actual_entry: null };
  if (rec.phase !== 'open' || !rec.actual_entry) return result;
  const price = D(String(rec.actual_entry)); const base = plan.base_equivalent, fx = plan.quote_fx, lev = plan.leverage;
  if (![price, base, fx, lev].every((x) => x.isFinite() && x.gt(0))) return result;
  const notional = base.mul(price).mul(fx);
  return { entry_notional_usdt: notional.toString(), entry_collateral_estimate_usdt: notional.div(plan.market === 'spot' ? D(1) : lev).toString(), actual_entry: price.toString() };
}

function tighterStop(plan, remainder, currentPrice, currentStop, partialState) {
  if ((plan.profit_lock_version || 'none') !== 'graduated-v1' || plan.market !== 'linear' || partialState !== 'FILLED') return null;
  if (!(remainder.quantity.gt(0) && remainder.quantity.lt(plan.quantity))) return null;
  const achieved = plan.pnl(currentPrice).div(plan.risk_usdt);
  const floor = plan.risk_usdt.mul(achieved.gte(3) ? D(1) : achieved.gte('2.5') ? D('.5') : D(0));
  if (floor.lte(0)) return null;
  const sign = D(plan.side === 'Buy' ? 1 : -1); const c = plan.costs.execution_rate.plus(plan.costs.slippage_rate); const h = plan.costs.carry_rate;
  const target = plan.entry.mul(sign.plus(c).plus(h)).plus(floor.div(plan.quote_fx).plus(plan.costs.fixed_quote_reserve).div(remainder.base_equivalent)).div(sign.minus(c));
  const stop = roundStep(target, plan.tick, plan.side === 'Buy');
  if (sign.mul(stop.minus(currentStop)).lte(0) || sign.mul(D(currentPrice).minus(stop)).lte(plan.tick.mul(2))) return null;
  if (remainder.pnl(stop).lt(floor)) return null;
  return stop;
}

module.exports = { ClosedCandles, rank, rankCmp, ordered, prepareMargin, entryAmounts, tighterStop, Decimal };
