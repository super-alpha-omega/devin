'use strict';
// Once per Kyiv calendar day: 70% confirmed net profit, UNIFIED -> FUND only. Never blindly repeated.
const crypto = require('crypto');
const { D, Decimal, number } = require('./num');
const { RequestCancelled, isAuthError } = require('./errors');

function kyivParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10), minute: parseInt(parts.minute, 10) };
}

class ProfitDistribution {
  constructor(api, state, save, clock, emit, mode, enabled = false) {
    Object.assign(this, { api, state, save, clock, emit, mode }); this.enabled = enabled === true; this.last_check = 0;
    if (!state.distribution) {
      state.distribution = { watermark: '0', last_day: this.today(), pending: null, reserved: '0', paid: '0', equity_basis: state.equity_profit_basis ?? null };
      save();
    }
  }
  today() { return kyivParts(this.clock()).date; }
  notice(text) { this.emit('log', text); }
  async tick(available, unrealized = '0', riskReserve = '0', marginDebt = false, equity = null) {
    const ledger = this.state.distribution; const now = this.clock();
    if (now - this.last_check < 60000) return;
    this.last_check = now;
    const pending = ledger.pending;
    if (pending) {
      const records = (await this.api.call('get_internal_transfer_records', { transferId: pending.id, startTime: Math.max(0, pending.created - 1000), endTime: Math.min(now, pending.created + 7 * 86400000 - 1001) })).list || [];
      const row = records.find((r) => r.transferId === pending.id);
      if (row) this.confirm(row.status, pending);
      else if (now - pending.created > 3600000) this.confirm('FAILED', pending, 'Перевод не найден на бирже в течение часа — считается не выполненным.');
      return;
    }
    if (!this.enabled) return;
    const local = kyivParts(now); const today = local.date;
    if (today === ledger.last_day || (local.hour === 0 && local.minute < 5)) return;
    if (this.mode !== 'REAL') { ledger.last_day = today; this.save(); this.notice('DEMO: реальный перевод в Funding не выполняется.'); return; }
    const net = number(this.state.total_net, 'Чистый результат');
    let gain = Decimal.max(D(0), net.minus(number(ledger.watermark, 'Учтённая прибыль')).plus(Decimal.min(D(0), number(unrealized, 'Открытый PnL'))));
    if (equity !== null && ledger.equity_basis !== null && ledger.equity_basis !== undefined) gain = Decimal.min(gain, Decimal.max(D(0), number(equity, 'Equity').minus(number(ledger.equity_basis, 'База капитала'))));
    const amount = gain.mul('.70').div('.000001').toDecimalPlaces(0, Decimal.ROUND_FLOOR).mul('.000001');
    ledger.reserved = amount.toString(); this.save();
    if (amount.lte(0)) { ledger.last_day = today; this.save(); return; }
    if (marginDebt) { this.notice('70% прибыли зарезервированы: сначала подтверждённое погашение маржинального долга.'); return; }
    const transferable = await this.api.call('get_transferable_amount', { coinName: 'USDT' });
    const current = number((transferable.availableWithdrawalMap || {}).USDT ?? transferable.availableWithdrawal ?? '0', 'Доступно к переводу');
    if (Decimal.min(current, number(available, 'Доступно')).minus(number(riskReserve, 'Резерв риска')).lt(amount)) { this.notice('Перевод 70% отложен: недостаточно свободного USDT после резервов; Funding не используется.'); return; }
    const p = { id: crypto.randomUUID(), amount: amount.toString(), watermark: number(ledger.watermark, 'Учёт').plus(gain).toString(), day: today, created: now,
      equity_after: equity !== null ? number(equity, 'Equity').minus(amount).toString() : null };
    ledger.pending = p; this.save();
    try {
      const result = await this.api.call('create_internal_transfer', { transferId: p.id, coin: 'USDT', amount: amount.toString(), fromAccountType: 'UNIFIED', toAccountType: 'FUND' });
      this.confirm(result.status, p);
    } catch (exc) {
      if (exc instanceof RequestCancelled) { ledger.pending = null; this.save(); throw exc; }
      if (isAuthError(exc) || exc.status_code === 10001) { this.confirm('FAILED', p); return; }
      this.notice('Ответ перевода неизвестен. Проверка сохранённого transferId; повторной отправки не будет.');
    }
  }
  confirm(status, pending, note = null) {
    const ledger = this.state.distribution;
    if (status === 'SUCCESS') {
      if (pending.equity_after !== null && pending.equity_after !== undefined) ledger.equity_basis = pending.equity_after;
      ledger.watermark = pending.watermark; ledger.last_day = this.today();
      ledger.paid = number(ledger.paid, 'Выплачено').plus(number(pending.amount, 'Перевод')).toString();
      if (this.state.day_equity !== null && this.state.day_equity !== undefined && (this.state.day || this.today()) === pending.day) {
        this.state.day_equity = Decimal.max(D(0), number(this.state.day_equity, 'База дня').minus(number(pending.amount, 'Перевод'))).toString();
      }
      ledger.pending = null; ledger.reserved = '0'; this.save();
      this.notice('Подтверждён перевод 70% чистой прибыли: ' + pending.amount + ' USDT -> Funding.');
    } else if (status === 'FAILED') {
      ledger.pending = null; ledger.last_day = pending.day; ledger.reserved = pending.amount; this.save();
      this.notice(note || 'Биржа отклонила перевод. Прибыль не помечена выплаченной; проверьте права Transfer.');
    }
  }
}

module.exports = { ProfitDistribution, kyivParts };
