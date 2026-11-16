'use strict';
// Cost calculations; rates come ONLY from exchange data.
const { D, Decimal, number, sumD } = require('./num');
const { ValueError } = require('./errors');

const RATE_FIELDS = ['maker_rate', 'taker_rate', 'slippage_rate', 'carry_rate'];

class CostQuote {
  constructor({ maker_rate, taker_rate, slippage_rate, carry_rate, observed_ms, source = 'Bybit account fee rates + current carry estimates', fixed_quote_reserve = D(0) }) {
    Object.assign(this, { maker_rate: D(maker_rate), taker_rate: D(taker_rate), slippage_rate: D(slippage_rate), carry_rate: D(carry_rate), observed_ms, source, fixed_quote_reserve: D(fixed_quote_reserve) });
    Object.freeze(this);
  }
  validate(nowMs = null) {
    for (const name of RATE_FIELDS) { const v = number(this[name], name); if (!(v.gte(0) && v.lt(1))) throw new ValueError('Недопустимые издержки: ' + name); }
    if (number(this.fixed_quote_reserve, 'Резерв округления').lt(0)) throw new ValueError('Отрицательный резерв округления');
    if (!(this.observed_ms > 0)) throw new ValueError('Нет времени получения тарифов');
    if (nowMs !== null && (nowMs - this.observed_ms > 300000 || this.observed_ms - nowMs > 5000)) throw new ValueError('Тарифы устарели; вход запрещён до обновления');
    return this;
  }
  get execution_rate() { return Decimal.max(this.maker_rate, this.taker_rate); }
  estimate(entry, exitPrice, baseQuantity) {
    entry = number(entry, 'Вход'); exitPrice = number(exitPrice, 'Выход'); const qty = number(baseQuantity, 'Количество');
    if (Decimal.min(entry, exitPrice, qty).lte(0)) throw new ValueError('Стоимость рассчитывается только для положительных цен и количества');
    return { entry_fee: qty.mul(entry).mul(this.execution_rate), exit_fee: qty.mul(exitPrice).mul(this.execution_rate),
      slippage: qty.mul(entry.plus(exitPrice)).mul(this.slippage_rate), carry: qty.mul(entry).mul(this.carry_rate), rounding_reserve: this.fixed_quote_reserve };
  }
  total(entry, exitPrice, baseQuantity) { return sumD(Object.values(this.estimate(entry, exitPrice, baseQuantity))); }
  with(changes) { return new CostQuote({ ...this, ...changes }); }
  export() {
    const out = {}; for (const [k, v] of Object.entries(this)) out[k] = v instanceof Decimal ? v.toString() : v; return out;
  }
  static restore(data) {
    const v = {}; for (const [k, x] of Object.entries(data)) v[k] = (k.endsWith('_rate') || k === 'fixed_quote_reserve') ? number(x, k) : x;
    return new CostQuote(v).validate();
  }
}

class AICostService {
  constructor(api, clock) { this.api = api; this.clock = clock; }
  async quote(category, symbol, slippagePercent, { holdingMinutes, fundingRate = '0', fundingInterval = 480, borrowHourlyRate = '0', baseStep = '0', price = '0' }) {
    const rows = (await this.api.call('get_fee_rates', { category, symbol })).list || [];
    if (rows.length !== 1) throw new ValueError('Нет индивидуального тарифа аккаунта для инструмента');
    const maker = Decimal.max(D(0), number(rows[0].makerFeeRate, 'Maker')); const taker = Decimal.max(D(0), number(rows[0].takerFeeRate, 'Taker'));
    const holding = number(holdingMinutes, 'Ожидаемое удержание');
    if (holding.lte(0)) throw new ValueError('Не задан горизонт оценки издержек');
    const periods = holding.div(number(fundingInterval, 'Интервал funding')).toDecimalPlaces(0, Decimal.ROUND_CEIL);
    const hours = holding.div(60).toDecimalPlaces(0, Decimal.ROUND_CEIL);
    const carry = number(fundingRate, 'Funding').abs().mul(periods).plus(Decimal.max(D(0), number(borrowHourlyRate, 'Заём')).mul(hours));
    return new CostQuote({ maker_rate: maker, taker_rate: taker, slippage_rate: number(slippagePercent, 'Проскальзывание').div(100), carry_rate: carry,
      observed_ms: this.clock(), fixed_quote_reserve: number(baseStep, 'Шаг лота').mul(number(price, 'Цена округления')) }).validate(this.clock());
  }
  static repaymentPlan(wallet, coins) {
    const actions = [];
    for (const coin of coins) {
      const row = (wallet.coin || []).find((r) => r.coin === coin) || {};
      const debt = Decimal.max(number(row.spotBorrow || '0', 'Spot debt'), number(row.borrowAmount || '0', 'Debt'));
      if (debt.gt(0)) actions.push({ coin, repaymentType: 'FLEXIBLE', observed_debt: debt.toString(), convert_assets: false });
    }
    return actions;
  }
  static interestDebits(rows) {
    const seen = new Set(); const debits = {};
    for (const row of rows) {
      const key = [row.currency, String(row.createdTime), String(row.borrowAmount ?? ''), row.borrowCost].join('|');
      if (seen.has(key)) continue; seen.add(key);
      debits[row.currency] = (debits[row.currency] || D(0)).plus(number(row.borrowCost, 'Проценты'));
    }
    return debits;
  }
}

module.exports = { CostQuote, AICostService };
