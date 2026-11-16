'use strict';
// All sizing, SL, TP, leverage bounds and breakeven decisions belong to BOT.
const { D, Decimal, number, roundStep, sumD, MIN_NET_RR } = require('./num');
const { ValueError } = require('./errors');
const { CostQuote } = require('./costs');
const { atr, NAMES, STRATEGY_GROUP, LEGACY_STRATEGY_GROUP, MARKET_ASSIGNMENT_VERSION } = require('./strategies');
const { TIMEFRAMES } = require('./marketUniverse');

const pget = (obj, key, def) => (obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : def);

const CONFIG_DEFAULTS = {
  risk_percent: '0.5', portfolio_risk_percent: '3', daily_loss_percent: '5', max_positions: 0, per_strategy_positions: 0,
  max_notional_percent: '100', slippage_percent: '0.10', entry_buffer_percent: '0.10', max_spread_percent: '0.50', breakeven_at_r: '1',
  markets: ['spot', 'margin', 'linear', 'inverse'], funding_transfer_enabled: false, market_specialization_enabled: true,
  ai_entry_filter_enabled: true, quality_management_enabled: false, performance_optimizations_enabled: false,
  // JS-version self-healing options
  auto_recovery_enabled: true, group_halt_cooldown_hours: '24',
};

class PortfolioConfig {
  constructor(values = {}) {
    for (const k of Object.keys(values)) if (!(k in CONFIG_DEFAULTS)) throw new ValueError('Неизвестные настройки: ' + k);
    Object.assign(this, JSON.parse(JSON.stringify(CONFIG_DEFAULTS)), values);
    this.markets = [...this.markets];
    Object.freeze(this);
  }
  validate() {
    for (const k of ['performance_optimizations_enabled', 'quality_management_enabled', 'ai_entry_filter_enabled', 'market_specialization_enabled', 'funding_transfer_enabled', 'auto_recovery_enabled']) {
      if (typeof this[k] !== 'boolean') throw new ValueError('Некорректный флаг ' + k);
    }
    for (const key of ['risk_percent', 'portfolio_risk_percent', 'daily_loss_percent', 'max_notional_percent']) {
      const v = number(this[key], key); if (!(v.gt(0) && v.lte(100))) throw new ValueError('Задайте положительный лимит до 100%: ' + key);
    }
    if (number(this.risk_percent, 'Риск').gt(number(this.portfolio_risk_percent, 'Общий риск'))) throw new ValueError('Общий риск не может быть меньше риска одной сделки');
    for (const key of ['max_positions', 'per_strategy_positions']) {
      const v = number(this[key], key); if (!v.isInteger() || v.lt(0) || v.gt(100)) throw new ValueError('Лимиты позиций: 0 = без ограничения, иначе от 1 до 100');
    }
    for (const key of ['slippage_percent', 'entry_buffer_percent', 'max_spread_percent']) {
      const v = number(this[key], key); if (!(v.gte(0) && v.lt(10))) throw new ValueError('Некорректный допуск ' + key);
    }
    if (number(this.breakeven_at_r, 'Безубыток').lte(0)) throw new ValueError('Порог безубытка должен быть положительным');
    const cd = number(this.group_halt_cooldown_hours, 'Пауза группы'); if (cd.lt(0) || cd.gt(720)) throw new ValueError('Пауза группы: 0–720 часов');
    if (!this.markets.length || !this.markets.every((m) => ['spot', 'margin', 'linear', 'inverse'].includes(m))) throw new ValueError('Некорректные рынки');
    return this;
  }
  toJSON() { return { ...this, markets: [...this.markets] }; }
}

const PLAN_DECIMALS = ['quantity', 'base_equivalent', 'entry', 'stop', 'target', 'risk_usdt', 'profit_usdt', 'reference_usdt', 'quote_fx', 'tick', 'qty_step', 'leverage', 'entry_fraction'];
const PLAN_FIELDS = ['instrument_key', 'market', 'strategy', 'timeframe', 'side', 'quantity', 'base_equivalent', 'entry', 'stop', 'target', 'risk_usdt',
  'profit_usdt', 'reference_usdt', 'quote_fx', 'costs', 'tick', 'qty_step', 'leverage', 'group_id', 'assignment_version', 'management_version', 'entry_fraction', 'profit_lock_version'];

class TradePlan {
  constructor(v) {
    Object.assign(this, { group_id: '', assignment_version: 'legacy-unbound', management_version: 'legacy', entry_fraction: D(1), profit_lock_version: 'none' }, v);
    for (const k of PLAN_DECIMALS) this[k] = D(this[k]);
    Object.freeze(this);
  }
  get loss() { return this.risk_usdt; }
  get profit() { return this.profit_usdt; }
  get reference_loss() { return this.reference_usdt; }
  get stop_loss() { return this.stop; }
  get take_profit() { return this.target; }
  pnl(exitPrice) {
    const x = number(exitPrice, 'Цена выхода'); const sign = D(this.side === 'Buy' ? 1 : -1);
    return this.base_equivalent.mul(sign).mul(x.minus(this.entry)).minus(this.costs.total(this.entry, x, this.base_equivalent)).mul(this.quote_fx);
  }
  with(changes) { const v = {}; for (const k of PLAN_FIELDS) v[k] = this[k]; return new TradePlan({ ...v, ...changes }); }
  export() {
    const out = {};
    for (const k of PLAN_FIELDS) { const v = this[k]; out[k] = k === 'costs' ? v.export() : v instanceof Decimal ? v.toString() : v; }
    return out;
  }
  static restore(data) {
    const v = {};
    for (const [k, x] of Object.entries(data)) v[k] = PLAN_DECIMALS.includes(k) ? number(x, k) : k === 'costs' ? CostQuote.restore(x) : x;
    return new TradePlan(v);
  }
}

function stopMultiplier(strategy) {
  if (['bollinger_reversion', 'rsi_reversal', 'stochastic_reversal', 'cci_reversal', 'williams_reversal', 'mfi_reversal'].includes(strategy)) return D('1.5');
  if (['donchian20', 'donchian55', 'bollinger_squeeze', 'keltner', 'volume_momentum'].includes(strategy)) return D('2.5');
  return D('2');
}
const rewardMultiple = () => MIN_NET_RR;

class BotRisk {
  constructor(config) { this.config = config.validate(); }
  build(item, market, strategy, tf, side, candles, ticker, equity, reference, quoteFx, costs, leverage, availableUsdt = null, entryFraction = 1) {
    const cfg = this.config;
    if (!(strategy in NAMES) || !TIMEFRAMES.includes(String(tf))) throw new ValueError('Неизвестная стратегия или интервал');
    if (!['Buy', 'Sell'].includes(side)) throw new ValueError('Неизвестное направление');
    if (!cfg.markets.includes(market) || (item.category === 'spot' && !['spot', 'margin'].includes(market)) || (item.category !== 'spot' && market !== item.category)) throw new ValueError('Рынок не соответствует инструменту или отключён');
    if (market === 'spot' && side !== 'Buy') throw new ValueError('Спот без займа не открывает SHORT');
    equity = number(equity, 'Equity'); const fx = number(quoteFx, 'FX'); const lev = number(leverage, 'Плечо');
    if (Decimal.min(equity, fx).lte(0)) throw new ValueError('Нет положительного equity/FX');
    if (market !== 'spot' && !(lev.gte(cfg.quality_management_enabled ? 1 : 3) && lev.lte(7))) throw new ValueError('Плечо вне разрешённого диапазона');
    const fraction = number(entryFraction, 'Entry fraction');
    if (!(fraction.eq('.5') || fraction.eq(1)) || (!cfg.quality_management_enabled && !fraction.eq(1))) throw new ValueError('Invalid signal entry fraction');
    costs.validate();
    const ask = number(ticker.ask1Price || '0', 'ask1Price'); const bid = number(ticker.bid1Price || '0', 'bid1Price');
    if (Decimal.min(ask, bid).lte(0) || ask.lt(bid)) throw new ValueError('Нет допустимых Bid/Ask');
    if (ask.minus(bid).mul(100).div(ask.plus(bid).div(2)).gt(number(cfg.max_spread_percent, 'Спред'))) throw new ValueError('Слишком широкий спред');
    const sign = D(side === 'Buy' ? 1 : -1);
    const tick = number(item.raw.priceFilter.tickSize, 'Шаг цены');
    const quote = side === 'Buy' ? ask : bid;
    const entry = roundStep(quote.mul(sign.mul(number(cfg.entry_buffer_percent, 'Буфер')).div(100).plus(1)), tick, side === 'Sell');
    const mult = cfg.quality_management_enabled ? Decimal.max(D(2), D(String(stopMultiplier(strategy)))) : D(String(stopMultiplier(strategy)));
    const distance = D(String(atr(candles))).mul(mult);
    if (market !== 'spot' && distance.div(entry).gte(D('.75').div(lev))) throw new ValueError('SL слишком далёк относительно плеча; риск ликвидации до SL');
    const stop = roundStep(entry.minus(sign.mul(distance)), tick, side === 'Buy');
    if (Decimal.min(entry, stop).lte(0) || sign.mul(entry.minus(stop)).lte(0)) throw new ValueError('SL не представим при текущем шаге цены');
    const riskPct = number(cfg.risk_percent, 'Риск');
    const ref = reference !== null && reference !== undefined ? number(reference, 'R') : equity.mul(riskPct).div(100);
    const budget = Decimal.min(ref, equity.mul(riskPct).div(100)).mul(fraction);
    const lossPerBase = sign.mul(entry.minus(stop)).plus(costs.total(entry, stop, D(1))).minus(costs.fixed_quote_reserve).mul(fx);
    const lot = item.raw.lotSizeFilter; const inverse = item.category === 'inverse';
    const step = number(pget(lot, 'qtyStep', pget(lot, 'basePrecision', '0')), 'Шаг количества');
    if (step.lte(0)) throw new ValueError('Неизвестная точность количества');
    const reserveUsdt = costs.fixed_quote_reserve.mul(fx);
    if (budget.lte(reserveUsdt)) throw new ValueError(`${item.key}: резерв шага лота ${reserveUsdt.toFixed(4)} USDT превышает бюджет риска ${budget.toFixed(4)} USDT`);
    let base = budget.minus(reserveUsdt).div(lossPerBase);
    const notionalCap = equity.mul(number(cfg.max_notional_percent, 'Номинал')).div(100).mul(fraction);
    base = Decimal.min(base, notionalCap.div(entry.mul(fx)));
    if (availableUsdt !== null && availableUsdt !== undefined) {
      const available = Decimal.max(D(0), number(availableUsdt, 'Свободный бюджет').mul(fraction).minus(reserveUsdt));
      const effectiveLeverage = market !== 'spot' ? lev : D(1);
      const perBase = entry.mul(fx).mul(D(1).div(effectiveLeverage).plus(costs.execution_rate.plus(costs.slippage_rate).mul(2)).plus(costs.carry_rate));
      base = Decimal.min(base, available.div(perBase));
    }
    const rawQty = inverse ? base.mul(entry) : base;
    const maxQty = number(pget(lot, 'maxMarketOrderQty', pget(lot, 'maxMktOrderQty', pget(lot, 'maxOrderQty', '0'))), 'Макс. market');
    const qty = roundStep(Decimal.min(rawQty, maxQty.mul(fraction)), step);
    base = inverse ? qty.div(entry) : qty;
    if (qty.lte(0)) throw new ValueError('Риск/номинал ниже минимального шага');
    const minQty = item.category !== 'spot' ? number(pget(lot, 'minOrderQty', '0'), 'Мин. qty') : D(0);
    const minAmount = number(pget(lot, 'minOrderAmt', pget(lot, 'minNotionalValue', '0')), 'Мин. сумма');
    if (qty.lt(minQty) || base.mul(entry).lt(minAmount)) throw new ValueError('Сделка меньше биржевого минимума');
    const cap = number(pget(lot, 'maxLimitOrderQty', pget(lot, 'maxOrderQty', qty.toString())), 'Макс. limit');
    if (qty.gt(cap)) throw new ValueError('Превышен лимит limit-ордера');
    if (inverse && item.settle !== item.base) throw new ValueError('Неизвестная формула inverse settlement');
    const c = costs.execution_rate.plus(costs.slippage_rate); const h = costs.carry_rate;
    const rr = cfg.quality_management_enabled ? D('3.5') : rewardMultiple(strategy);
    let risk = base.mul(sign).mul(entry.minus(stop)).plus(costs.total(entry, stop, base)).mul(fx);
    const targetReference = cfg.quality_management_enabled ? risk : ref;
    const target = roundStep(rr.mul(targetReference).div(fx).plus(costs.fixed_quote_reserve).div(base).plus(entry.mul(sign.plus(c).plus(h))).div(sign.minus(c)), tick, side === 'Buy');
    if (Decimal.min(target, stop).lte(0)) throw new ValueError('Невозможный положительный TP');
    risk = base.mul(sign).mul(entry.minus(stop)).plus(costs.total(entry, stop, base)).mul(fx);
    const profit = base.mul(sign).mul(target.minus(entry)).minus(costs.total(entry, target, base)).mul(fx);
    if (risk.gt(budget) || risk.lte(0) || profit.lt(MIN_NET_RR.mul(targetReference))) throw new ValueError('План нарушает обязательные границы 1/3 и 4/6');
    if (item.category === 'spot') {
      const closeQty = roundStep(side === 'Buy' ? qty.mul(D(1).minus(costs.execution_rate)) : qty, step);
      if (closeQty.lte(0) || [stop, target].some((x) => closeQty.mul(x).lt(minAmount))) throw new ValueError('Минимальный защитный выход не помещается в лот и допустимый риск');
    }
    const pf = item.raw.priceFilter;
    for (const value of [entry, stop, target]) {
      if (value.lt(number(pget(pf, 'minPrice', tick.toString()), 'Мин. цена')) || value.gt(number(pget(pf, 'maxPrice', '1e30'), 'Макс. цена'))) throw new ValueError('Цена выходит за пределы инструмента');
    }
    return new TradePlan({ instrument_key: item.key, market, strategy, timeframe: tf, side, quantity: qty, base_equivalent: base, entry, stop, target,
      risk_usdt: risk, profit_usdt: profit, reference_usdt: ref, quote_fx: fx, costs, tick, qty_step: step, leverage: lev,
      group_id: (cfg.market_specialization_enabled ? STRATEGY_GROUP : LEGACY_STRATEGY_GROUP)[strategy],
      assignment_version: cfg.market_specialization_enabled ? MARKET_ASSIGNMENT_VERSION : 'legacy-unbound',
      management_version: cfg.quality_management_enabled ? 'quality-partial-v3' : 'legacy', entry_fraction: fraction,
      profit_lock_version: cfg.quality_management_enabled ? 'graduated-v1' : 'none' });
  }

  admit(plan, active, equity, freeUsdt, slotCount, externalRisk = 0) {
    const cfg = this.config;
    const targetReference = plan.management_version === 'quality-partial-v3' ? plan.risk_usdt : plan.reference_usdt;
    if (plan.risk_usdt.lte(0) || plan.risk_usdt.gt(plan.reference_usdt) || plan.profit_usdt.lt(MIN_NET_RR.mul(targetReference))) throw new ValueError('Перед входом не подтверждена чистая цель 3R при убытке не более R');
    if (!cfg.quality_management_enabled && slotCount >= 10) throw new ValueError('Все 10 мест текущей серии заняты/закрыты; ожидание завершения');
    if (parseInt(cfg.max_positions, 10) > 0 && active.length >= parseInt(cfg.max_positions, 10)) throw new ValueError('Достигнут общий лимит позиций');
    if (parseInt(cfg.per_strategy_positions, 10) > 0 && active.filter((p) => p.strategy === plan.strategy).length >= parseInt(cfg.per_strategy_positions, 10)) throw new ValueError('Достигнут лимит позиций стратегии');
    if (active.some((p) => p.instrument_key === plan.instrument_key)) throw new ValueError('Этот инструмент уже занят: нет дублирующих входов');
    equity = number(equity, 'Equity');
    if (plan.risk_usdt.gt(equity.mul(number(cfg.risk_percent, 'Риск сделки')).div(100).mul(plan.entry_fraction))) throw new ValueError('План превышает текущий лимит риска сделки');
    const external = number(externalRisk, 'Reserved legacy risk');
    if (external.lt(0)) throw new ValueError('Negative reserved external risk');
    const used = sumD(active.map((p) => p.risk_usdt)).plus(external);
    if (used.plus(plan.risk_usdt).gt(equity.mul(number(cfg.portfolio_risk_percent, 'Общий риск')).div(100))) throw new ValueError('Недостаточно свободного общего бюджета риска');
    const margin = plan.base_equivalent.mul(plan.entry).mul(plan.quote_fx).div(plan.market !== 'spot' ? plan.leverage : 1);
    if (margin.plus(plan.costs.total(plan.entry, plan.stop, plan.base_equivalent).mul(plan.quote_fx)).gt(number(freeUsdt, 'Свободная маржа'))) throw new ValueError('Недостаточно свободных средств с запасом издержек');
    return true;
  }

  breakeven(plan, currentPrice, currentStop) {
    const price = number(currentPrice, 'Цена'); const old = number(currentStop, 'Текущий SL'); const sign = D(plan.side === 'Buy' ? 1 : -1);
    if (plan.pnl(price).lt(number(this.config.breakeven_at_r, 'BE').mul(plan.risk_usdt))) return null;
    const c = plan.costs.execution_rate.plus(plan.costs.slippage_rate); const h = plan.costs.carry_rate;
    const nw = roundStep(plan.entry.mul(sign.plus(c).plus(h)).plus(plan.costs.fixed_quote_reserve.div(plan.base_equivalent)).div(sign.minus(c)), plan.tick, plan.side === 'Buy');
    if (sign.mul(nw.minus(old)).lte(0) || sign.mul(price.minus(nw)).lte(plan.tick.mul(2))) return null;
    if (plan.pnl(nw).lt(0)) return null;
    return nw;
  }
}

function chooseEntryLeverage(item, market, strategy, side, candles, ticker, current = 3) {
  if (market === 'spot') return D(1);
  if (market === 'margin') return number(current, 'Current margin leverage');
  if (!['Buy', 'Sell'].includes(side) || candles.length < 21) throw new ValueError('Insufficient closed candles for leverage');
  const closes = candles.slice(-21).map((row) => number(row[4], 'Closed price'));
  let travel = D(0); for (let i = 1; i < closes.length; i++) travel = travel.plus(closes[i].minus(closes[i - 1]).abs());
  const move = closes[closes.length - 1].minus(closes[0]);
  const aligned = side === 'Buy' ? move.gt(0) : move.lt(0);
  const efficiency = travel.gt(0) && aligned ? move.abs().div(travel) : D(0);
  const desired = D(3).plus(Decimal.min(D(4), efficiency.mul(4).toDecimalPlaces(0, Decimal.ROUND_FLOOR)));
  const nat = item.raw.leverageFilter || {};
  const minimum = number(pget(nat, 'minLeverage', '1'), 'Native minimum leverage'); const maximum = number(pget(nat, 'maxLeverage', '3'), 'Native maximum leverage'); const step = number(pget(nat, 'leverageStep', '1'), 'Native leverage step');
  if (step.lte(0) || minimum.lte(0) || maximum.lt(minimum)) throw new ValueError('Invalid native leverage limits');
  const price = number(ticker[side === 'Buy' ? 'ask1Price' : 'bid1Price'], 'Entry quote'); const distance = D(String(atr(candles))).mul(stopMultiplier(strategy));
  if (Decimal.min(price, distance).lte(0)) throw new ValueError('Invalid stop context for leverage');
  const stopCap = price.mul('.75').div(distance);
  const upper = Decimal.min(D(7), maximum, desired);
  let value = minimum.plus(upper.minus(minimum).div(step).toDecimalPlaces(0, Decimal.ROUND_FLOOR).mul(step));
  while (value.gte(Decimal.max(D(3), minimum)) && value.gte(stopCap)) value = value.minus(step);
  if (!(value.gte(3) && value.lte(7)) || value.lt(minimum)) throw new ValueError('No leverage3-7 fits native limits and stop');
  return value;
}

module.exports = { CONFIG_DEFAULTS, PortfolioConfig, TradePlan, stopMultiplier, rewardMultiple, BotRisk, chooseEntryLeverage, roundStep, pget };
