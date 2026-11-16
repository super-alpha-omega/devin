'use strict';
/* Portfolio coordinator. Physical net positions are owned once per instrument.
 * 24 strategies x 8 intervals are evaluated independently, then share account limits.
 * Native stops are attached on entry. Every uncertain mutation is journaled and
 * reconciled; an unknown order is never blindly submitted again.
 * JS version: uncertain states are resolved automatically by reconciliation rules and
 * per-position quarantine instead of a global halt that waits for a human. */
const path = require('path');
const crypto = require('crypto');
const { D, Decimal, number, roundStep, sumD, MIN_NET_RR } = require('./num');
const { Halt, ValueError, RequestCancelled, ApiRejected, AdmissionRefused, ExternalAccountBusy, NetworkError,
  isTemporary, isAuthError, temporaryRead, safeError, describe } = require('./errors');
const { Universe, FairScheduler, Instrument, minutes } = require('./marketUniverse');
const { BotRisk, TradePlan, stopMultiplier, chooseEntryLeverage } = require('./portfolioRisk');
const { Brain, parseCandles } = require('./localAi');
const { proposals, NAMES, GROUPS, STRATEGY_GROUP, LEGACY_STRATEGY_GROUP, STRATEGY_MARKETS, MARKET_ASSIGNMENT_VERSION } = require('./strategies');
const { ClosedCandles, rank, rankCmp, ordered, prepareMargin, entryAmounts, tighterStop } = require('./smallModules');
const { ProfitDistribution, kyivParts } = require('./profitDistribution');
const { AICostService } = require('./costs');
const partial = require('./partialTake');
const { PUMP_NAMES, protectedTrailingStop } = require('./pumpGuard');
const { PumpScanner, MultiPumpScanner } = require('./pumpScanners');
const entryQuality = require('./entryQuality');

const TERMINAL = new Set(['Filled', 'Cancelled', 'Rejected', 'Deactivated', 'PartiallyFilledCanceled']);
const LOST_ORDER_MS = 120000;          // an order absent from Bybit for 2 minutes never reached the exchange
const QUARANTINE_DETACH_MS = 24 * 3600000;
const linkId = (prefix) => prefix + crypto.randomBytes(14).toString('hex');
const nowSec = () => Date.now() / 1000;
const sideSign = (side) => D(side === 'Buy' ? 1 : -1);
const fmtSigned = (v, n) => (D(v).gte(0) ? '+' : '') + D(v).toFixed(n);

class Portfolio {
  constructor(api, config, store, emit, { cancelled = () => false, clock = null } = {}) {
    this.api = api; this.config = config.validate(); this.store = store; this.emit = emit;
    this.cancelled = cancelled; this.clock = clock || (() => Date.now());
    this.state = store.load();
    this.owner_group = config.market_specialization_enabled ? STRATEGY_GROUP : LEGACY_STRATEGY_GROUP;
    this.assignment_ready = true;
    if (config.market_specialization_enabled && this.state.market_assignment_version !== MARKET_ASSIGNMENT_VERSION) {
      const closed = store.countResults();
      if (Object.keys(this.state.positions).length || closed || Object.values(this.state.groups).some((g) => g.batch.length)) { this.assignment_ready = false; this.owner_group = LEGACY_STRATEGY_GROUP; }
      else { this.state.market_assignment_version = MARKET_ASSIGNMENT_VERSION; store.save(this.state); }
    }
    this.state.detached = this.state.detached || [];
    this.universe = new Universe(api); this.scheduler = new FairScheduler();
    this.risk = new BotRisk(config); this.cost_service = new AICostService(api, this.clock);
    this.entries_enabled = false; this.ready = false; this.wallet = {}; this.account = {}; this.brains = new Map();
    this.external_account = {}; this.last_foreign_check = 0; this.external_risk = D(0);
    this.training = null; this.training_key = null; this.last_prices = 0; this.last_universe = 0; this.last_summary = 0;
    this.max_scan_lag = 0; this.rejects = {}; this.closed = false; this.last_manage = 0; this.candidates = []; this.distributor = null;
    this.last_candidate_check = 0; this.candidate_cursor = 0; this.scan_count = 0; this.signal_count = 0; this.last_scan = '';
    this.wait_reason = 'Ожидание запуска'; this.pump_scanner = null; this.last_pump_scan = 0; this.multi_pump_scanner = null; this.last_multi_pump_scan = 0;
    this.equity = D(0); this.free = D(0); this.scanFailures = new Map(); this.quality_history_cache = new Map(); this.last_entry_quality = {};
    this.closed_candle_cache = null;
  }
  log(text) { this.emit('log', text); }
  persist(closed = null) { this.store.save(this.state, closed); }
  pause(reason, kind = 'error') {
    this.entries_enabled = false; this.state.resume_armed = false;
    if (reason !== this.state.halt) { this.log('ВХОДЫ ПРИОСТАНОВЛЕНЫ: ' + reason + (this.config.auto_recovery_enabled ? ' — автоматическое восстановление включено.' : '')); this.state.halt_since = this.clock(); }
    this.state.halt = reason; this.state.halt_kind = kind; this.persist(); this.publish();
  }
  reject(reason) {
    this.rejects[reason] = (this.rejects[reason] || 0) + 1; this.wait_reason = reason;
    if (this.rejects[reason] <= 3 || this.rejects[reason] % 100 === 0) this.log('Кандидат отклонён: ' + reason);
  }

  async updateWallet() {
    const rows = (await this.api.call('get_wallet_balance', { accountType: 'UNIFIED' })).list || [];
    if (rows.length !== 1) throw new Halt('Не найден единственный Unified wallet');
    this.wallet = rows[0];
    const equity = number(this.wallet.totalEquity || '0', 'Equity'); const free = number(this.wallet.totalAvailableBalance || '0', 'Доступная маржа');
    if (equity.lte(0)) throw new Halt('Нет положительного equity; автоматический риск не вычисляется');
    const fx = this.universe.fx('USD');
    this.equity = equity.mul(fx); this.free = free.mul(fx);
    const day = kyivParts(this.clock()).date;
    if (this.state.day !== day) {
      this.state.day = day; this.state.day_equity = this.equity.toString(); this.state.day_net = '0'; this.persist();
      if (this.state.halt_kind === 'daily') this.log('Новый торговый день (Киев): дневной лимит сброшен, автоматическое возобновление входов.');
    }
    const start = number(this.state.day_equity, 'Дневной equity');
    if (this.equity.lt(start.mul(D(1).minus(number(this.config.daily_loss_percent, 'Дневной лимит').div(100))))) this.pause('Дневное снижение equity превысило установленный лимит; возобновление в новый торговый день', 'daily');
  }
  coin(name) { return (this.wallet.coin || []).find((c) => c.coin === name) || {}; }
  debt(name) { const c = this.coin(name); return Decimal.max(number(c.spotBorrow || '0', 'Spot debt'), number(c.borrowAmount || '0', 'Debt')); }

  async initialize(identity) {
    if (this.state.version !== 3) throw new Halt('Неподдерживаемый формат журнала портфеля');
    if (this.state.identity && this.state.identity !== identity && this.state.started && Object.keys(this.state.positions).length) throw new Halt('Ключ изменён при незавершённых позициях; верните исходный ключ (бот ждёт и проверяет автоматически)');
    this.state.identity = identity;
    this.account = await this.api.call('get_account_info');
    if (this.account.marginMode !== 'REGULAR_MARGIN') throw new Halt('Для общего портфеля нужен UTA Cross/Regular Margin; бот режим не меняет (повторная проверка автоматически)');
    await this.universe.discover(); await this.universe.prices(); await this.updateWallet();
    this.scheduler.sync(this.scanKeys(), nowSec());
    this.last_universe = this.clock(); this.last_prices = this.clock();
    await this.foreignGuard();
    if (!this.state.started && number(this.wallet.totalEquity, 'Стартовый баланс').lt(40)) throw new Halt('Для первого старта нужен баланс от 40 USD в Unified (повторная проверка автоматически)');
    this.state.started = true;
    if (!this.state.equity_profit_basis) this.state.equity_profit_basis = this.equity.toString();
    this.distributor = new ProfitDistribution(this.api, this.state, () => this.persist(), this.clock, this.emit, this.store.mode, this.config.funding_transfer_enabled);
    this.persist(); this.ready = true;
    this.log(`Найдено ${this.universe.instruments.size} инструментов. 24 стратегии × 8 интервалов 15m–1D.`);
    for (const record of Object.values(this.state.positions)) await this.reconcileSafe(record, true);
    this.publish();
  }

  async foreignGuard() {
    const owned = new Set(Object.values(this.state.positions).map((r) => r.plan.instrument_key));
    const evidence = { positions: [], orders: [], debt_coins: [], checked_at: this.clock(), mode: 'observe_only', mutations_allowed: false };
    const linearSettles = [...new Set([...[...this.universe.instruments.values()].filter((i) => i.category === 'linear').map((i) => i.settle), 'USDT', 'USDC'])].sort();
    for (const category of ['linear', 'inverse']) {
      for (const settle of category === 'linear' ? linearSettles : [null]) {
        const args = { category, limit: 200 }; if (settle) args.settleCoin = settle;
        for (const row of await this.pages('get_positions', args)) {
          if (number(row.size || '0', 'Size').gt(0) && !owned.has(category + ':' + row.symbol)) {
            const e = {}; for (const k of ['symbol', 'side', 'size', 'avgPrice', 'markPrice', 'stopLoss', 'takeProfit', 'positionIdx']) e[k] = row[k] ?? null;
            e.category = category; evidence.positions.push(e);
          }
        }
      }
    }
    for (const category of ['spot', 'linear', 'inverse']) {
      for (const settle of category === 'linear' ? linearSettles : [null]) {
        const args = { category, limit: 50, openOnly: 0 }; if (settle) args.settleCoin = settle;
        for (const row of await this.pages('get_open_orders', args)) {
          if (!owned.has(category + ':' + row.symbol)) {
            const e = { category }; for (const k of ['symbol', 'orderId', 'orderLinkId', 'side', 'qty', 'cumExecQty', 'price', 'triggerPrice', 'orderStatus', 'orderType', 'stopOrderType', 'reduceOnly', 'isLeverage', 'tpslMode', 'takeProfit', 'stopLoss']) e[k] = row[k] ?? null;
            evidence.orders.push(e);
          }
        }
      }
    }
    if (!Object.values(this.state.positions).some((r) => r.plan.market === 'margin')) evidence.debt_coins = (this.wallet.coin || []).filter((c) => this.debt(c.coin).gt(0)).map((c) => c.coin);
    // Detached (self-released) records keep their risk reserved while their exchange footprint remains.
    const busyKeys = new Set([...evidence.positions, ...evidence.orders].map((r) => r.category + ':' + r.symbol));
    const keep = [];
    for (const d of this.state.detached) {
      if (busyKeys.has(d.plan.instrument_key)) keep.push(d);
      else this.log('Отсоединённая позиция ' + d.plan.instrument_key + ' больше не видна на бирже; резерв риска освобождён.');
    }
    if (keep.length !== this.state.detached.length) { this.state.detached = keep; this.persist(); }
    this.external_risk = sumD(keep.map((d) => number(d.plan.risk_usdt, 'Detached risk')));
    const busy = !!(evidence.positions.length || evidence.orders.length || evidence.debt_coins.length);
    this.external_account = busy ? evidence : {};
    this.last_foreign_check = this.clock();
    if (busy) Object.assign(evidence, { admission_verified: true, external_debt_present: !!evidence.debt_coins.length, isolation: 'per_instrument' });
  }
  externalInstrumentBusy(item) {
    const evidence = this.external_account || {};
    return ['positions', 'orders'].some((kind) => (evidence[kind] || []).some((row) => row.category === item.category && row.symbol === item.symbol));
  }
  async monitorExternal() {
    for (const record of Object.values(this.state.positions)) await this.reconcileSafe(record);
    await this.updateWallet();
    try { await this.foreignGuard(); } catch (exc) { if (exc instanceof ExternalAccountBusy) { this.publish(); return false; } throw exc; }
    this.publish(); return true;
  }

  async arm() {
    if (!this.assignment_ready) throw new Halt('Старая история требует отдельной версионной миграции назначения рынков; позиции продолжают сопровождаться');
    if (!this.ready || this.state.halt) throw new Halt(this.state.halt || 'Ещё нет подключения');
    await this.updateWallet(); await this.foreignGuard();
    if (this.state.halt) throw new Halt(this.state.halt);
    this.entries_enabled = true; this.state.resume_armed = true; this.persist(); this.log('Автоторговля портфеля включена; ИИ не назначает риск.'); this.publish();
  }
  // Fresh reconciliation; uncertain records are quarantined individually instead of blocking the account.
  async review() {
    this.entries_enabled = false; this.state.resume_armed = false; this.persist();
    for (const rec of Object.values(this.state.positions)) await this.reconcileSafe(rec, true);
    await this.updateWallet();
    const start = number(this.state.day_equity, 'База дневного риска');
    if (this.equity.lt(start.mul(D(1).minus(number(this.config.daily_loss_percent, 'Дневной лимит').div(100))))) throw new Halt('Дневной лимит риска по-прежнему превышен');
    await this.foreignGuard();
    this.state.halt = ''; this.state.halt_kind = ''; delete this.state.halt_since; this.persist();
    const quarantined = Object.values(this.state.positions).filter((r) => r.quarantine).length;
    this.log('Сверка пройдена' + (quarantined ? `; изолировано позиций: ${quarantined} (сверяются отдельно)` : '') + '.');
  }
  group(strategy) { return this.state.groups[this.owner_group[strategy]]; }
  groupSlots(strategy) { return this.state.groups[this.owner_group[strategy]].batch.length; }
  newBatch(groupId = null) {
    const eligible = groupId ? [groupId] : Object.keys(GROUPS); let reset = 0;
    for (const gid of eligible) {
      const group = this.state.groups[gid];
      if (group.batch.length < 10) continue;
      if (Object.values(this.state.positions).some((r) => this.owner_group[r.plan.strategy] === gid)) continue;
      Object.assign(group, { batch: [], reference: null, number: group.number + 1, halt: '' }); delete group.halt_at; reset++;
    }
    if (!reset) throw new Halt('Нет группы с 10 закрытиями без активных ордеров');
    this.persist();
  }
  expireGroupHalts() {
    const hours = Number(this.config.group_halt_cooldown_hours); if (!(hours > 0)) return;
    for (const [gid, group] of Object.entries(this.state.groups)) {
      if (!group.halt) continue;
      if (!group.halt_at) { group.halt_at = this.clock(); this.persist(); continue; }
      if (this.clock() - group.halt_at < hours * 3600000) continue;
      const busy = Object.values(this.state.positions).some((r) => this.owner_group[r.plan.strategy] === gid);
      if (group.batch.length >= 10 && !busy) { try { this.newBatch(gid); } catch (e) { /* not eligible yet */ } }
      else if (group.batch.length < 10) { group.halt = ''; delete group.halt_at; this.persist(); }
      if (!group.halt) this.log(`${gid}: защитная пауза группы истекла (${hours} ч); группа снова ищет сделки.`);
    }
  }

  publish() {
    try {
      this.emit('health', this.health());
      const groups = this.state.groups; const values = Object.values(groups).flatMap((g) => g.batch.map((r) => number(r.net, 'PnL')));
      const net = sumD(values);
      this.emit('groups', Object.entries(groups).map(([gid, g]) => ({ id: gid, strategies: GROUPS[gid].map((s) => NAMES[s]), count: g.batch.length,
        net: sumD(g.batch.map((r) => number(r.net, 'PnL'))).toString(), reference: g.reference, number: g.number, halt: g.halt })));
      this.emit('summary', { count: values.length, wins: values.filter((v) => v.gt(0)).length, losses: values.filter((v) => v.lt(0)).length, net: net.toString(),
        reference: 'отдельно для 8 групп', halt: this.state.halt, active: Object.keys(this.state.positions).length > 0 });
    } catch (exc) { this.emit('log', 'Панель: ошибка подготовки статуса ' + safeError(exc)); }
  }
  health() {
    const positions = [];
    for (const rec of Object.values(this.state.positions)) {
      const p = rec.plan; const plan = TradePlan.restore(p); const row = {};
      for (const k of ['instrument_key', 'market', 'strategy', 'side', 'quantity', 'entry', 'stop', 'target', 'leverage', 'timeframe', 'entry_fraction']) row[k] = p[k] ?? null;
      Object.assign(row, { phase: rec.quarantine ? rec.phase + ' · изоляция: ' + rec.quarantine.reason : rec.phase, id: rec.id, quantity: partial.remaining(rec, plan).toString(),
        management_version: p.management_version || 'legacy', partial_take: (rec.partial_take || {}).state ?? null, stop: rec.soft_stop || p.stop }, entryAmounts(rec, plan));
      positions.push(row);
    }
    const quality = this.config.quality_management_enabled;
    return { at: nowSec(), ready: this.ready, entries_enabled: this.entries_enabled, external_account: this.external_account, external_risk: this.external_risk.toString(),
      entry_policy: quality ? 'Средние: объём ≥1.10, RSI38–62, EMA gap≥0.05ATR / наклон≥0.02ATR, половина размера, ×1–3 · сильные в приоритете: объём≥1.50, узкий RSI, EMA и старший тренд, полный размер, ×4–7 · TP50%/2R на USDT-фьючерсах' : '',
      halt: this.state.halt, halt_kind: this.state.halt_kind || '', scans: this.scan_count, signals: this.signal_count, instruments: this.universe.instruments.size, checks: this.scheduler.seen,
      candidates: this.candidates.length, training: this.training_key, models_ready: [...this.brains.values()].filter((b) => b.data).length, last_scan: this.last_scan,
      waiting: this.state.halt || this.wait_reason, rejects: Object.fromEntries(Object.entries(this.rejects).sort((a, b) => b[1] - a[1]).slice(0, 8)),
      equity: this.equity.toString(), free: this.free.toString(), total_net: this.state.total_net, day_net: this.state.day_net, positions,
      quarantined: Object.values(this.state.positions).filter((r) => r.quarantine).length, detached: this.state.detached.map((d) => d.plan.instrument_key),
      performance: { journal_writes: this.store.write_count, unchanged_writes_skipped: this.store.skipped_writes, candle_cache_hits: this.closed_candle_cache ? this.closed_candle_cache.hits : 0, candle_cache_misses: this.closed_candle_cache ? this.closed_candle_cache.misses : 0 },
      entries_submitted: Object.keys(this.state.positions).length + Object.values(this.state.groups).reduce((a, g) => a + g.batch.length, 0) };
  }
  scanKeys() {
    if (!this.config.market_specialization_enabled) return [...this.universe.instruments.keys()];
    const assigned = new Set(Object.values(STRATEGY_MARKETS).filter((m) => this.config.markets.includes(m))); const keys = [];
    for (const [key, item] of this.universe.instruments) {
      if (item.category === 'linear' && assigned.has('linear') && item.kind === 'LinearPerpetual' && item.settle === 'USDT') keys.push(key);
      else if (item.category === 'spot' && (assigned.has('spot') || (assigned.has('margin') && item.margin))) keys.push(key);
    }
    return keys;
  }

  async history(item, tf, count = 200) {
    let cache = null; const key = item.key + '|' + tf + '|' + count;
    if (this.config.performance_optimizations_enabled === true) {
      if (!this.closed_candle_cache) this.closed_candle_cache = new ClosedCandles();
      cache = this.closed_candle_cache; const cached = cache.get(key, count, this.clock()); if (cached !== null) return cached;
    }
    const found = new Map(); let end = null, server = null, pages = 0;
    while (found.size < count) {
      if (this.cancelled()) throw new RequestCancelled('Остановка');
      pages++;
      if (pages > Math.max(2, Math.floor((count + 999) / 1000) + 2)) throw new ValueError('История: превышен предел страниц');
      if (end !== null && end <= 0) break;
      const args = { category: item.category, symbol: item.symbol, interval: tf, limit: Math.min(1000, count - found.size) };
      if (end !== null) args.end = end;
      const response = await this.api.raw('get_kline', args); if (server === null) server = parseInt(response.time, 10);
      const rows = (response.result || {}).list || [];
      if (!rows.length) break;
      const nextEnd = Math.min(...rows.map((r) => parseInt(r[0], 10))) - 1;
      if (end !== null && nextEnd >= end) throw new ValueError('История: биржа повторяет страницу');
      const before = found.size;
      for (const row of rows) found.set(parseInt(row[0], 10), row);
      if (found.size === before) throw new ValueError('История: нет новых свечей на странице');
      end = nextEnd;
      if (rows.length < args.limit) break;
    }
    const parsed = parseCandles([...found.values()], server, tf);
    if (cache) cache.put(key, parsed, count, server, minutes(tf) * 60000, this.clock());
    return parsed;
  }
  handleScanError(exc, key, tf) {
    const pair = key + '|' + tf;
    if (isAuthError(exc)) { this.pause('Биржа отклонила авторизацию/права ключа: ' + safeError(exc), 'auth'); return; }
    const failures = Math.min(10, (this.scanFailures.get(pair) || 0) + 1); this.scanFailures.set(pair, failures);
    const temporary = isTemporary(exc) || exc instanceof NetworkError;
    const delay = temporary ? Math.min(300, 5 * 2 ** (failures - 1)) : Math.min(3600, 60 * 2 ** (failures - 1));
    this.scheduler.defer(key, tf, nowSec() + delay);
    this.reject((temporary ? 'Временный сбой API/сети: ' : 'Ошибка данных инструмента: ') + safeError(exc) + `; повтор через ${delay}с`);
  }

  async step() {
    if (this.cancelled()) throw new RequestCancelled('Остановка');
    if (this.training && this.training.done) {
      if (this.training.error) { if (!(this.training.error instanceof RequestCancelled)) this.log('ИИ: обучение не завершено: ' + describe(this.training.error)); }
      else {
        this.log('ИИ: обучение кандидата завершено: ' + this.training_key);
        const parts = this.training_key.split(':'); const tf = parts[parts.length - 2]; const key = parts.slice(0, -2).join(':').split('|').slice(1).join('|');
        this.scheduler.wake(key, tf, nowSec());
      }
      this.training = null; this.training_key = null;
    }
    const now = this.clock();
    if (now - this.last_prices >= 10000) { await this.universe.prices(); await this.updateWallet(); this.last_prices = now; }
    if (now - this.last_universe >= 3600000) { await this.universe.discover(); this.scheduler.sync(this.scanKeys(), nowSec()); this.last_universe = now; }
    if (now - this.last_manage >= 3000) {
      for (const record of Object.values(this.state.positions)) await this.reconcileSafe(record);
      this.last_manage = this.clock();
    }
    if (now - this.last_foreign_check >= 10000) await this.foreignGuard();
    this.expireGroupHalts();
    if (!this.entries_enabled && this.state.resume_armed && !this.state.halt && this.ready && this.assignment_ready) {
      this.entries_enabled = true; this.log('Связь с биржей восстановлена: поиск сделок продолжен автоматически.');
    }
    if (this.distributor) {
      try {
        const reserve = sumD(this.activePlans().map((p) => p.risk_usdt)).plus(this.external_risk);
        await this.distributor.tick(this.free, number(this.wallet.totalPerpUPL || '0', 'UPL').mul(this.universe.fx('USD')), reserve,
          (this.wallet.coin || []).some((c) => this.debt(c.coin).gt(0)), this.equity);
      } catch (exc) { if (exc instanceof RequestCancelled) throw exc; this.log('Проверка ежедневного перевода: ' + describe(exc)); }
    }
    if (this.entries_enabled && !this.state.halt && !this.cancelled()) {
      if (this.candidates.length) await this.tryCandidates();
      const task = this.scheduler.next(nowSec());
      if (task) {
        const [key, tf, lag] = task; this.max_scan_lag = Math.max(this.max_scan_lag, lag);
        const item = this.universe.instruments.get(key);
        if (item) {
          try { await this.scan(item, tf); this.scanFailures.delete(key + '|' + tf); } catch (exc) {
            if (exc instanceof RequestCancelled) throw exc;
            if (exc instanceof ValueError) this.reject(exc.message); else this.handleScanError(exc, key, tf);
          }
        }
      }
    }
    if (this.entries_enabled && now - this.last_pump_scan >= 60000 && !this.cancelled()) {
      this.last_pump_scan = now;
      try { if (!this.pump_scanner) this.pump_scanner = new PumpScanner(this); await this.pump_scanner.tick(); } catch (exc) {
        if (exc instanceof RequestCancelled) throw exc; this.log('ПАМП-сканер: сигнал не использован, ошибка чтения: ' + describe(exc));
      }
    }
    if (this.entries_enabled && now - this.last_multi_pump_scan >= 45000 && !this.cancelled()) {
      this.last_multi_pump_scan = now;
      try { if (!this.multi_pump_scanner) this.multi_pump_scanner = new MultiPumpScanner(this); await this.multi_pump_scanner.tick(); } catch (exc) {
        if (exc instanceof RequestCancelled) throw exc; this.log('МУЛЬТИ-ПАМП-сканер: ' + describe(exc));
      }
    }
    if (now - this.last_summary >= 3000) { this.publish(); this.last_summary = now; }
  }
  async marginStatus() {
    const data = await this.api.call('spot_margin_trade_get_status_and_leverage');
    if (String(data.spotMarginMode) !== '1') throw new ValueError('Маржа не активирована в Bybit');
    const lev = number(data.spotLeverage || '0', 'Плечо маржи');
    return lev.gte(3) && lev.lte(7) ? lev : D(3);
  }
  async position(item) {
    const rows = (await this.api.call('get_positions', { category: item.category, symbol: item.symbol })).list || [];
    if (!rows.length) throw new Halt('Не получен режим позиции ' + item.key);
    if (rows.some((r) => parseInt(r.positionIdx ?? -1, 10) !== 0)) throw new ValueError('Для контракта требуется One-Way: ' + item.key);
    const nonzero = rows.filter((r) => number(r.size || '0', 'Размер').gt(0));
    return [nonzero.length ? nonzero[0] : null, number(rows[0].leverage || '0', 'Плечо')];
  }
  orders(item) { return this.pages('get_open_orders', { category: item.category, symbol: item.symbol, openOnly: 0, limit: 50 }); }
  async pages(method, args) {
    const out = []; const seen = new Set(); let cursor = null;
    for (let i = 0; i < 200; i++) {
      const response = await this.api.call(method, cursor ? { ...args, cursor } : { ...args });
      out.push(...(response.list || [])); cursor = response.nextPageCursor;
      if (!cursor) return out;
      if (seen.has(cursor)) throw new Halt('Зацикленная история ' + method);
      seen.add(cursor);
    }
    throw new Halt('История слишком велика ' + method);
  }
  async costs(item, market, tf, side) {
    const ticker = this.universe.tickers.get(item.key) || {}; let borrow = '0';
    if (market === 'margin') {
      const coin = side === 'Buy' ? item.quote : item.base;
      const rows = (await this.api.call('get_collateral_info', { currency: coin })).list || [];
      const row = rows.find((r) => r.currency === coin);
      if (!row || row.borrowable !== true) throw new ValueError('Нет подтверждённой доступности займа ' + coin);
      borrow = row.hourlyBorrowRate;
    }
    return this.cost_service.quote(item.category, item.symbol, this.config.slippage_percent, {
      holdingMinutes: minutes(tf) * 32, fundingRate: ticker.fundingRate || '0', fundingInterval: item.raw.fundingInterval || 480, borrowHourlyRate: borrow,
      baseStep: item.category === 'spot' ? item.raw.lotSizeFilter.basePrecision : '0',
      price: item.category === 'spot' ? number(ticker.ask1Price || ticker.lastPrice || '0', 'Цена').mul(number(this.config.entry_buffer_percent, 'Буфер').div(100).plus(1)) : '0' });
  }
  async brainFor(item, tf, strategy, costs, candles, market = null) {
    const mult = stopMultiplier(strategy); const key = `${market || item.category}|${item.key}:${tf}:${mult}`;
    const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
    let brain = this.brains.get(key);
    const { model_carry } = { model_carry: (v) => D(v).div('0.0001').toDecimalPlaces(0, Decimal.ROUND_CEIL).mul('0.0001') };
    const cost = costs.execution_rate.plus(costs.slippage_rate); const carry = model_carry(costs.carry_rate);
    if (!brain || brain.cost !== cost.toNumber() || brain.funding !== carry.toNumber()) {
      brain = new Brain(path.join(this.store.dir, 'models', `${this.store.mode}_${digest}.json`), key, '1', cost, carry, this.emit, this.cancelled, mult);
      this.brains.set(key, brain);
    }
    if (brain.needsTraining(candles.at(-1)[0], tf)) {
      if (this.training === null) {
        const full = await this.history(item, tf, 6000);
        if (full.length < 1000) throw new ValueError('Недостаточно истории ИИ: ' + key);
        const job = { done: false, error: null };
        job.promise = brain.train(full).then(() => { job.done = true; }, (e) => { job.error = e; job.done = true; });
        this.training = job; this.training_key = key;
        this.log('ИИ: фоновое обучение ' + key + '; сопровождение позиций продолжается.');
      }
      this.wait_reason = 'Обучение ИИ: ' + (this.training_key || key);
      return null;
    }
    return brain;
  }
  strictEntryCosts(costs) {
    if (!this.config.quality_management_enabled) return costs;
    return costs.with({ slippage_rate: Decimal.max(D('.002'), costs.slippage_rate.mul(2)), fixed_quote_reserve: costs.fixed_quote_reserve.mul(2) });
  }
  entryFractionForSignal() {
    if (!this.config.quality_management_enabled) return D(1);
    return (this.last_entry_quality || {}).strong === true ? D(1) : D('.5');
  }
  async selectedLeverage(item, market, strategy, side, rows, ticker, current, tf) {
    if (!this.config.quality_management_enabled) return chooseEntryLeverage(item, market, strategy, side, rows, ticker, current);
    const frames = entryQuality.higherFrames(tf); const cache = this.quality_history_cache; const higher = {};
    for (const interval of frames) {
      const key = item.key + '|' + interval; const saved = cache.get(key); let high;
      const period = minutes(interval) * 60000;
      if (!saved || this.clock() - saved[0] > 60000 || Math.floor(this.clock() / period) !== Math.floor(saved[0] / period)) {
        high = await this.history(item, interval, 100);
        if (!high.length || this.clock() - high.at(-1)[0] > 2 * period) throw new ValueError('Старший таймфрейм устарел');
        if (!cache.has(key) && cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(key, [this.clock(), high]);
      } else high = saved[1];
      higher[interval] = high;
    }
    const quality = entryQuality.assess(rows, higher, side); quality.side = side; this.last_entry_quality = quality;
    return entryQuality.leverage(item, market, quality, rows, strategy, ticker, current);
  }

  async scan(item, tf) {
    this.scan_count++; this.last_scan = item.key + '/' + tf; this.wait_reason = 'Проверка сигнала: ' + this.last_scan;
    const cfg = this.config;
    if (cfg.market_specialization_enabled && item.category === 'linear' && (item.settle !== 'USDT' || item.kind !== 'LinearPerpetual')) { this.reject('Этому составу назначены только бессрочные USDT-фьючерсы'); return; }
    if (cfg.market_specialization_enabled && !Object.keys(NAMES).some((s) => (item.category !== 'spot' ? [item.category] : ['spot', 'margin']).includes(STRATEGY_MARKETS[s]) && cfg.markets.includes(STRATEGY_MARKETS[s]))) { this.reject('Для этого рынка не назначены стратегии текущего состава'); return; }
    const rows = await this.history(item, tf);
    if (rows.length < 100) throw new ValueError('Недостаточно закрытых свечей ' + item.key + '/' + tf);
    const checkpoint = item.key + ':' + tf; const saved = this.store.checkpoint(checkpoint);
    if (saved !== null && saved >= rows.at(-1)[0]) return;
    if (this.clock() - rows.at(-1)[0] > 2 * minutes(tf) * 60000) throw new ValueError('Устарели свечи ' + item.key + '/' + tf);
    const hypotheses = proposals(rows);
    if (!Object.keys(hypotheses).length) { this.wait_reason = 'Нет сигнала стратегий: ' + this.last_scan; this.store.consume(checkpoint, rows.at(-1)[0]); return; }
    this.signal_count += Object.values(hypotheses).reduce((a, v) => a + v.length, 0);
    const ticker = this.universe.tickers.get(item.key); if (!ticker) return;
    let candidates = []; let waitingModel = false;
    for (const [side, strategies] of Object.entries(hypotheses)) {
      const markets = item.category !== 'spot' ? [item.category] : ['spot', ...(item.margin ? ['margin'] : [])];
      for (const market of markets) {
        if (!cfg.markets.includes(market) || (market === 'spot' && side === 'Sell')) continue;
        if (market === 'margin' && Object.values(this.state.positions).some((r) => r.plan.market === 'margin')) continue;
        if (item.category === 'spot' && Object.values(this.state.positions).some((r) => { const it = this.universe.instruments.get(r.plan.instrument_key); return it && it.base === item.base && ['spot', 'margin'].includes(r.plan.market); })) continue;
        const marketStrategies = strategies.filter((s) => !cfg.market_specialization_enabled || STRATEGY_MARKETS[s] === market);
        if (!marketStrategies.length) continue;
        let leverage, costs, fx;
        try {
          leverage = market === 'spot' ? D(1) : market === 'margin' ? await this.marginStatus() : (await this.position(item))[1];
          if (!['spot', 'margin'].includes(market) && !(leverage.gte(1) && leverage.lte(7))) leverage = D(1);
          costs = this.strictEntryCosts(await this.costs(item, market, tf, side)); fx = this.universe.fx(item.quote);
        } catch (exc) { if (exc instanceof ValueError) { this.reject(exc.message); continue; } throw exc; }
        for (const strategy of marketStrategies) {
          if (this.group(strategy).halt) continue;
          try {
            const entryLeverage = await this.selectedLeverage(item, market, strategy, side, rows, ticker, leverage, tf);
            const plan = this.risk.build(item, market, strategy, tf, side, rows, ticker, this.sizingEquity(), this.group(strategy).reference, fx, costs, entryLeverage, null, this.entryFractionForSignal());
            if (item.settle !== 'USDT' && item.category !== 'spot' && number(this.coin(item.settle).walletBalance || '0', 'Settlement reserve').lte(0)) throw new ValueError('Нет расчётной валюты ' + item.settle + '; обучение для неисполнимого входа не запускается');
            if (item.category === 'spot' && item.quote !== 'USDT' && number(this.coin(item.quote).walletBalance || '0', 'Quote reserve').lte(0)) throw new ValueError('Нет валюты котировки ' + item.quote + '; обучение для неисполнимого входа не запускается');
            if (!cfg.ai_entry_filter_enabled) { candidates.push([D(0), null, plan]); continue; }
            const brain = await this.brainFor(item, tf, strategy, costs, rows, market);
            if (!brain) { waitingModel = true; continue; }
            const decision = brain.choose(rows, [plan]);
            if (decision) { const prob = number(String(decision[1]), 'Вероятность'); candidates.push([prob.mul(plan.profit).minus(D(1).minus(prob).mul(plan.loss)), decision[1], plan]); }
            else this.reject('ИИ: ожидание, нет подтверждённого положительного ожидания ' + item.key + '/' + tf + '/' + strategy);
          } catch (exc) { if (exc instanceof ValueError) this.reject(exc.message); else throw exc; }
        }
      }
    }
    if (!waitingModel || candidates.length) this.store.consume(checkpoint, rows.at(-1)[0]);
    const q = cfg.quality_management_enabled;
    if (candidates.length) candidates = [candidates.reduce((best, c) => (rankCmp(rank(c[2], c[0], q), rank(best[2], best[0], q)) > 0 ? c : best))];
    for (const [score, p, plan] of candidates) {
      this.candidates = this.candidates.filter((c) => c[3].instrument_key !== plan.instrument_key);
      this.candidates.push([this.clock(), score, p, plan]);
    }
    this.candidates = this.candidates.map((c, i) => [c, i]).sort((a, b) => rankCmp(rank(b[0][3], b[0][1], q), rank(a[0][3], a[0][1], q)) || a[1] - b[1]).map((x) => x[0]).slice(0, 100);
    await this.tryCandidates();
  }
  async tryCandidates() {
    if (this.clock() - this.last_candidate_check < 3000) return;
    this.last_candidate_check = this.clock();
    if (!this.candidates.length) return;
    const q = this.config.quality_management_enabled;
    const offset = this.candidate_cursor % this.candidates.length; const rotated = ordered(this.candidates, offset, q); const ready = [];
    this.candidate_cursor = (offset + 5) % this.candidates.length;
    const removeCandidate = (c) => { const i = this.candidates.indexOf(c); if (i >= 0) this.candidates.splice(i, 1); };
    for (const candidate of rotated.slice(0, 5)) {
      const [created, score, , old] = candidate;
      if (this.clock() - created > minutes(old.timeframe) * 60000) { removeCandidate(candidate); continue; }
      if (!this.entries_enabled || this.state.halt || this.cancelled()) return;
      const item = this.universe.instruments.get(old.instrument_key); if (!item) continue;
      if (Object.values(this.state.positions).some((r) => r.plan.instrument_key === old.instrument_key)) continue;
      try {
        await this.updateWallet();
        const rows = await this.history(item, old.timeframe);
        if (rows.length < 100 || this.clock() - rows.at(-1)[0] > 2 * minutes(old.timeframe) * 60000) { removeCandidate(candidate); continue; }
        if (!(proposals(rows)[old.side] || []).includes(old.strategy)) { removeCandidate(candidate); continue; }
        const tickers = (await this.api.call('get_tickers', { category: item.category, symbol: item.symbol })).list || [];
        if (tickers.length !== 1 || tickers[0].symbol !== item.symbol) throw new ValueError('Нет однозначной текущей котировки кандидата');
        const ticker = tickers[0]; this.universe.tickers.set(item.key, ticker);
        const costs = this.strictEntryCosts(await this.costs(item, old.market, old.timeframe, old.side));
        const lev = await this.selectedLeverage(item, old.market, old.strategy, old.side, rows, ticker, old.leverage, old.timeframe);
        const plan = this.risk.build(item, old.market, old.strategy, old.timeframe, old.side, rows, ticker, this.sizingEquity(), this.group(old.strategy).reference, this.universe.fx(item.quote), costs, lev, this.tradingFree(), this.entryFractionForSignal());
        this.risk.admit(plan, this.activePlans(), this.sizingEquity(), this.tradingFree(), this.groupSlots(plan.strategy), this.external_risk);
        if (!this.config.ai_entry_filter_enabled) { ready.push([candidate, plan, null, { ...(this.last_entry_quality || {}) }]); continue; }
        const brain = await this.brainFor(item, old.timeframe, old.strategy, costs, rows, old.market);
        const decision = brain ? brain.choose(rows, [plan]) : null;
        if (!decision) continue;
        ready.push([candidate, plan, decision[1], { ...(this.last_entry_quality || {}) }]);
      } catch (exc) { if (exc instanceof ValueError) { this.reject(exc.message); continue; } throw exc; }
    }
    if (ready.length) {
      const [candidate, plan, prob, quality] = ready.reduce((best, x) => (rankCmp(rank(x[1], x[0][1], q), rank(best[1], best[0][1], q)) > 0 ? x : best));
      try { await this.updateWallet(); this.risk.admit(plan, this.activePlans(), this.sizingEquity(), this.tradingFree(), this.groupSlots(plan.strategy), this.external_risk); } catch (exc) {
        if (exc instanceof ValueError) { this.reject(exc.message); return; } throw exc;
      }
      this.last_entry_quality = quality;
      try { await this.open(plan, prob); } catch (exc) { if (exc instanceof AdmissionRefused) { this.reject(exc.message); return; } throw exc; }
      removeCandidate(candidate);
    }
  }
  sizingEquity() { return Decimal.max(D(0), this.equity.minus(number((this.external_account || {}).excluded_cash_usdt || '0', 'Excluded passive cash'))); }
  tradingFree() { return Decimal.max(D(0), this.free.minus(number((this.state.distribution || {}).reserved || '0', 'Резерв Funding'))); }
  activePlans() {
    return Object.values(this.state.positions).map((r) => {
      const p = TradePlan.restore(r.plan); const q = partial.remaining(r, p);
      if (!q.eq(p.quantity)) { const f = q.div(p.quantity); return p.with({ quantity: q, base_equivalent: p.base_equivalent.mul(f), risk_usdt: p.risk_usdt.mul(f), profit_usdt: p.profit_usdt.mul(f) }); }
      return p;
    });
  }

  async open(plan, probability) {
    if (this.group(plan.strategy).halt) return;
    if (!this.entries_enabled || this.cancelled() || this.state.halt) return;
    const cfg = this.config;
    if (cfg.market_specialization_enabled && !PUMP_NAMES.includes(plan.strategy) && STRATEGY_MARKETS[plan.strategy] !== plan.market) throw new AdmissionRefused('Стратегия закреплена за другим рынком; вход запрещён');
    const restriction = (this.state.entry_restrictions || {})[plan.instrument_key];
    if (restriction) {
      if (this.clock() - restriction.observed < 7 * 86400000) throw new AdmissionRefused('Биржа запретила вход по ' + plan.instrument_key + ' (код ' + restriction.code + '); другие инструменты доступны');
      delete this.state.entry_restrictions[plan.instrument_key]; this.persist();
    }
    const item = this.universe.instruments.get(plan.instrument_key);
    if (cfg.market_specialization_enabled && item.category === 'linear' && (item.settle !== 'USDT' || item.kind !== 'LinearPerpetual')) throw new AdmissionRefused('Назначение требует бессрочный USDT-контракт');
    await this.updateWallet(); await this.foreignGuard();
    if (this.state.halt) return;
    if (this.externalInstrumentBusy(item)) throw new AdmissionRefused('Инструмент занят ордером или позицией другого бота: ' + item.key);
    if ((this.external_account || {}).external_debt_present && plan.market === 'margin') throw new AdmissionRefused('Новый маржинальный заём запрещён, пока есть долг другого бота');
    try { plan.costs.validate(this.clock()); this.risk.admit(plan, this.activePlans(), this.sizingEquity(), this.tradingFree(), this.groupSlots(plan.strategy), this.external_risk); } catch (exc) {
      if (exc instanceof ValueError) throw new AdmissionRefused(exc.message); throw exc;
    }
    if ((await this.orders(item)).length) throw new AdmissionRefused('На инструменте уже есть ордера');
    if (item.category !== 'spot' && (await this.position(item))[0]) throw new AdmissionRefused('На инструменте уже есть позиция');
    if (item.category === 'spot') {
      const quota = await this.api.call('get_borrow_quota', { category: 'spot', symbol: item.symbol, side: plan.side });
      const qtyLimit = number(quota[plan.market === 'spot' ? 'spotMaxTradeQty' : 'maxTradeQty'] || '0', 'Доступный объём');
      const amountLimit = number(quota[plan.market === 'spot' ? 'spotMaxTradeAmount' : 'maxTradeAmount'] || '0', 'Доступная сумма');
      let cashReserve = D(0);
      if (plan.market === 'spot' && plan.side === 'Buy') cashReserve = sumD(this.activePlans().map((p) => p.risk_usdt)).div(this.universe.fx(item.quote));
      if (plan.quantity.gt(qtyLimit) || (plan.side === 'Buy' && plan.quantity.mul(plan.entry).mul(plan.costs.execution_rate.plus(1)).plus(cashReserve).gt(amountLimit))) throw new AdmissionRefused('Недостаточно доступной валюты/квоты займа для ' + item.key);
    }
    if (item.category === 'spot' && number(this.coin(item.base).walletBalance || '0', 'Баланс монеты').gt(plan.qty_step.mul(2))) throw new AdmissionRefused('Есть неучтённый спотовый остаток ' + item.base + '; торговля этой монетой заблокирована');
    if (plan.market === 'margin') await prepareMargin(this, plan, item);
    if (item.category !== 'spot') {
      const settlementFx = this.universe.fx(item.settle);
      const requiredCoin = plan.risk_usdt.plus(plan.costs.total(plan.entry, plan.stop, plan.base_equivalent).mul(plan.quote_fx)).div(settlementFx);
      const ownedReserve = sumD(this.activePlans().filter((p) => (this.universe.instruments.get(p.instrument_key) || {}).settle === item.settle).map((p) => p.risk_usdt.div(settlementFx)));
      const balance = number(this.coin(item.settle).walletBalance || '0', 'Резерв валюты расчёта').minus(this.debt(item.settle));
      if (balance.lt(requiredCoin.plus(ownedReserve))) throw new AdmissionRefused('Нет свободного резерва убытка/издержек в валюте расчётов ' + item.settle);
      const [pos, current] = await this.position(item);
      if (pos) throw new AdmissionRefused('Появилась позиция перед входом');
      if (!current.eq(plan.leverage)) {
        try { await this.api.call('set_leverage', { category: item.category, symbol: item.symbol, buyLeverage: plan.leverage.toString(), sellLeverage: plan.leverage.toString() }); } catch (exc) {
          if (exc instanceof RequestCancelled) throw exc;
          if (!(await this.position(item))[1].eq(plan.leverage)) throw new AdmissionRefused('Плечо не подтверждено; вход отменён');
        }
      }
      if (!(await this.position(item))[1].eq(plan.leverage)) throw new AdmissionRefused('Плечо не подтверждено');
    }
    const link = linkId('ab2-');
    const rec = { id: link, phase: 'pending', plan: plan.export(), created: this.clock(), entry_order: null, entry_exec: [], children: [], exit_link: null, exit_order: null,
      soft_stop: plan.stop.toString(), be_sent: false, repay_sent: [], protect_attempted: false, entry_fraction: plan.entry_fraction.toString(),
      entry_quality: this.last_entry_quality || null, instrument: item.raw, category: item.category, probability: probability === null ? null : String(probability),
      entry_authority: probability === null ? 'bot_rules' : 'validated_ai', base_before: String(this.coin(item.base).walletBalance || '0') };
    if (this.group(plan.strategy).reference === null) this.group(plan.strategy).reference = plan.reference_usdt.toString();
    this.state.positions[link] = rec; this.persist();
    const detail = plan.costs.estimate(plan.entry, plan.target, plan.base_equivalent);
    this.log('ИИ — оценка издержек: ' + Object.entries(detail).map(([k, v]) => `${k}=${D(v).toFixed(8)}`).join(', '));
    const args = { category: item.category, symbol: item.symbol, side: plan.side, orderType: 'Limit', timeInForce: 'FOK', qty: plan.quantity.toString(), price: plan.entry.toString(),
      orderLinkId: link, takeProfit: plan.target.toString(), stopLoss: plan.stop.toString(), tpOrderType: 'Market', slOrderType: 'Market' };
    if (item.category === 'spot') args.isLeverage = plan.market === 'margin' ? 1 : 0;
    else Object.assign(args, { positionIdx: 0, tpslMode: 'Full', tpTriggerBy: 'LastPrice', slTriggerBy: 'LastPrice', reduceOnly: false });
    try {
      const result = await this.api.submit(args); rec.entry_order = result.orderId; this.persist();
      this.log(`Вход ${plan.market} ${item.symbol} ${plan.side}, ${NAMES[plan.strategy]}, ${plan.timeframe}m; qty=${plan.quantity}, SL=${plan.stop}, TP=${plan.target}; риск ${plan.risk_usdt.toFixed(4)} USDT. ` +
        (probability === null ? 'Правила бота; ИИ не блокирует вход.' : `ИИ ${(Number(probability) * 100).toFixed(1)}%.`));
    } catch (exc) {
      if (exc instanceof RequestCancelled) { delete this.state.positions[link]; this.clearEmptyReference(plan.strategy); this.persist(); throw exc; }
      if (exc instanceof ApiRejected) {
        if ([110123, 110125, 110126].includes(exc.status_code)) {
          (this.state.entry_restrictions = this.state.entry_restrictions || {})[plan.instrument_key] = { code: exc.status_code, observed: this.clock() };
          (this.state.rejected_entries = this.state.rejected_entries || []).push({ id: link, instrument: plan.instrument_key, code: exc.status_code, observed: this.clock() });
          this.state.rejected_entries = this.state.rejected_entries.slice(-200);
        }
        delete this.state.positions[link]; this.clearEmptyReference(plan.strategy); this.persist();
        if (isAuthError(exc)) this.pause('Биржа отклонила авторизацию/права ключа: ' + safeError(exc), 'auth');
        else this.reject('Биржа явно отклонила вход: ' + safeError(exc));
        return;
      }
      // Unknown outcome: the record stays 'pending' and reconciliation by orderLinkId decides automatically.
      this.log('Ответ на вход ' + link + ' не получен (' + safeError(exc) + '); повторной отправки нет, идёт автоматическая сверка по orderLinkId.');
    }
  }
  clearEmptyReference(strategy) {
    const group = this.group(strategy); const gid = this.owner_group[strategy];
    if (!group.batch.length && !Object.values(this.state.positions).some((r) => this.owner_group[r.plan.strategy] === gid)) group.reference = null;
  }
  async findOrder(item, { link = null, orderId = null, start = null } = {}) {
    const args = { category: item.category, symbol: item.symbol }; if (orderId) args.orderId = orderId; else args.orderLinkId = link;
    for (const method of ['get_open_orders', 'get_order_history']) {
      let extra = {};
      if (method === 'get_order_history' && start !== null && start !== undefined) extra = { startTime: Math.max(0, start - 1000), endTime: Math.min(this.clock(), start + 7 * 86400000 - 1001) };
      const rows = (await this.api.call(method, { ...args, ...extra })).list || [];
      const matches = rows.filter((r) => (orderId ? r.orderId === orderId : r.orderLinkId === link));
      if (matches.length > 1) throw new Halt('Неуникальная история ордера');
      if (matches.length) return matches[0];
    }
    return null;
  }
  async executions(item, orderId) {
    if (!orderId) throw new Halt('Неизвестен orderId; ожидание сверки');
    return this.pages('get_executions', { category: item.category, orderId, limit: 100 });
  }

  // ---------- self-healing reconciliation wrappers ----------
  async reconcileSafe(rec, force = false) {
    if (!this.state.positions[rec.id]) return;
    const q = rec.quarantine;
    if (q && !force && this.clock() < q.next_at) return;
    try {
      await this.reconcile(rec);
      const current = this.state.positions[rec.id];
      if (current && current.quarantine) { this.log('Изоляция снята: ' + current.plan.instrument_key + ' снова сверяется в обычном режиме.'); delete current.quarantine; this.persist(); }
    } catch (exc) {
      if (exc instanceof RequestCancelled || isTemporary(exc) || isAuthError(exc)) throw exc;
      this.quarantine(rec, describe(exc));
    }
  }
  quarantine(rec, reason) {
    if (!this.state.positions[rec.id]) return;
    const now = this.clock(); const q = rec.quarantine || { since: now, attempts: 0 };
    const changed = q.reason !== reason; q.attempts++; q.reason = reason; q.next_at = now + Math.min(900000, 5000 * 2 ** Math.min(8, q.attempts - 1));
    rec.quarantine = q; this.persist();
    if (changed || q.attempts % 20 === 0) this.log(`Изоляция позиции ${rec.plan.instrument_key}: ${reason}. Остальная торговля продолжается; повторная сверка через ${Math.round((q.next_at - now) / 1000)} с.`);
    if (now - q.since > QUARANTINE_DETACH_MS) this.detach(rec, reason);
  }
  detach(rec, reason) {
    this.state.detached.push({ id: rec.id, plan: rec.plan, detached_at: this.clock(), reason, phase: rec.phase });
    this.state.detached = this.state.detached.slice(-100);
    delete this.state.positions[rec.id]; this.clearEmptyReference(rec.plan.strategy); this.persist();
    this.log(`ВНИМАНИЕ: позиция ${rec.plan.instrument_key} не сверялась 24 часа (${reason}). Бот отсоединил её: биржевые TP/SL остаются, инструмент заблокирован, её риск зарезервирован; остальная торговля продолжается.`);
  }
  scaleRecord(rec, qty, reason) {
    const plan = TradePlan.restore(rec.plan); const f = qty.div(plan.quantity);
    rec.plan = plan.with({ quantity: qty, base_equivalent: plan.base_equivalent.mul(f), risk_usdt: plan.risk_usdt.mul(f), profit_usdt: plan.profit_usdt.mul(f) }).export();
    rec.adjusted = (rec.adjusted || []).concat([{ at: this.clock(), from: plan.quantity.toString(), to: qty.toString(), reason }]);
    this.persist(); this.log(`Самовосстановление ${plan.instrument_key}: объём в журнале приведён к фактическому ${plan.quantity} → ${qty} (${reason}).`);
    return TradePlan.restore(rec.plan);
  }

  async reconcile(rec) {
    let plan = TradePlan.restore(rec.plan); let item = this.universe.instruments.get(plan.instrument_key);
    if (!item) {
      const raw = rec.instrument;
      if (!raw) throw new Halt('Инструмент исчез из каталога: ' + plan.instrument_key);
      item = new Instrument(rec.category, raw.symbol, raw.baseCoin, raw.quoteCoin, raw.settleCoin ?? raw.quoteCoin, raw.contractType ?? 'Spot', false, raw);
      this.universe.instruments.set(item.key, item);
    }
    if (rec.phase === 'pending') {
      const order = await this.findOrder(item, { link: rec.id, start: rec.created });
      if (!order) {
        if (this.clock() - rec.created > LOST_ORDER_MS) {
          delete this.state.positions[rec.id]; this.clearEmptyReference(plan.strategy); this.persist();
          this.log('Вход ' + rec.id + ' (' + item.key + ') не найден на бирже за 2 минуты — запрос не дошёл до Bybit. Запись закрыта без сделки.');
        }
        return;
      }
      const status = order.orderStatus; let qty = number(order.cumExecQty || '0', 'Исполнено');
      if (TERMINAL.has(status) && qty.isZero()) { delete this.state.positions[rec.id]; this.clearEmptyReference(plan.strategy); this.persist(); this.log('FOK не исполнен: ' + item.key); return; }
      if (status !== 'Filled' || !qty.eq(plan.quantity)) {
        if (!TERMINAL.has(status)) {
          if (this.clock() - rec.created > 300000 && !rec.cancel_entry_sent) {
            rec.cancel_entry_sent = true; this.persist();
            try { await this.api.call('cancel_order', { category: item.category, symbol: item.symbol, orderLinkId: rec.id }); } catch (exc) { if (exc instanceof RequestCancelled) throw exc; }
            this.log('Вход ' + item.key + ' завис на бирже > 5 мин; отправлена отмена остатка, сверка продолжится.');
          }
          return;
        }
        if (qty.gt(0) && qty.lt(plan.quantity)) plan = this.scaleRecord(rec, qty, 'частичное исполнение входа');
        else if (qty.gt(plan.quantity)) throw new Halt('Исполнено больше заявленного объёма: ' + item.key);
      }
      rec.entry_order = order.orderId; rec.entry_exec = await this.executions(item, order.orderId);
      if (!sumD(rec.entry_exec.map((r) => number(r.execQty, 'Exec qty'))).eq(qty)) return;
      const actual = number(order.avgPrice || '0', 'Исполненный вход');
      if (actual.lte(0)) return;
      if ((plan.side === 'Buy' && actual.gt(plan.entry)) || (plan.side === 'Sell' && actual.lt(plan.entry))) this.log('ВНИМАНИЕ: цена исполнения ' + item.key + ' вышла за limit-границу; позиция сопровождается по фактической цене.');
      rec.actual_entry = actual.toString(); rec.phase = 'open'; this.persist();
    }
    if (item.category !== 'spot' && rec.phase === 'open' && !rec.exit_link && this.clock() - rec.created >= 32 * minutes(plan.timeframe) * 60000) {
      if ((await this.position(item))[0] === null) await this.finishDerivative(rec, item, plan);
      else await this.closeOne(rec, 'Завершён расчётный горизонт удержания (32 свечи)');
      return;
    }
    if (rec.phase === 'repay') { await this.repay(rec, item, plan); return; }
    if (item.category === 'spot') await this.manageSpot(rec, item, plan); else await this.manageDerivative(rec, item, plan);
  }

  async setStop(item, stopLoss, takeProfit) {
    return this.api.call('set_trading_stop', { category: item.category, symbol: item.symbol, positionIdx: 0, tpslMode: 'Full', stopLoss: String(stopLoss), takeProfit: String(takeProfit), slTriggerBy: 'LastPrice', tpTriggerBy: 'LastPrice' });
  }
  async manageDerivative(rec, item, plan) {
    let [pos] = await this.position(item);
    if (pos === null) { await this.finishDerivative(rec, item, plan); return; }
    const ticker = this.universe.tickers.get(item.key) || {};
    const partialPrice = number(ticker[plan.side === 'Buy' ? 'bid1Price' : 'ask1Price'] || '0', 'Partial quote');
    if ((rec.partial_take || {}).state === 'PENDING' && await partial.manage(this, rec, item, plan, pos, partialPrice)) return;
    const size = number(pos.size || '0', 'Размер'); const own = partial.remaining(rec, plan);
    if (pos.side !== plan.side || !size.eq(own)) {
      if (rec.exit_link) { /* close in progress: wait for the exit order outcome */ }
      else if (pos.side === plan.side && size.lt(own) && size.gt(0)) {
        const filled = plan.quantity.minus(own); plan = this.scaleRecord(rec, size.plus(filled), 'позиция уменьшена вне бота');
      } else { this.detach(rec, 'позиция изменена вне журнала (сторона/объём больше собственного)'); return; }
    }
    const liq = number(pos.liqPrice || '0', 'Цена ликвидации'); const soft = number(rec.soft_stop, 'SL');
    if (liq.gt(0) && ((plan.side === 'Buy' && soft.lte(liq)) || (plan.side === 'Sell' && soft.gte(liq)))) {
      if (!rec.exit_link) await this.closeOne(rec, 'SL оказался за ликвидацией');
      this.log('Риск ликвидации до SL: ' + item.key + ' — позиция закрывается.'); return;
    }
    if (rec.exit_requested && !rec.exit_link) { await this.closeOne(rec, 'Сохранён запрос пользователя на закрытие'); return; }
    if (rec.exit_link) {
      const order = await this.findOrder(item, { link: rec.exit_link, start: rec.exit_created ?? rec.created });
      if (order && TERMINAL.has(order.orderStatus) && order.orderStatus !== 'Filled') {
        this.log('Закрытие ' + item.key + ' не исполнено биржей (' + order.orderStatus + '); повтор reduce-only закрытия.');
        rec.exit_link = null; delete rec.exit_created; this.persist();
      } else if (!order && this.clock() - (rec.exit_created ?? rec.created) > LOST_ORDER_MS) {
        this.log('Ордер закрытия ' + item.key + ' не найден на бирже — запрос не дошёл; повтор reduce-only закрытия.');
        rec.exit_link = null; delete rec.exit_created; this.persist();
      }
      return;
    }
    const expected = number(rec.soft_stop, 'SL');
    const stop = number(pos.stopLoss || '0', 'SL биржи'); const target = number(pos.takeProfit || '0', 'TP биржи');
    if (!stop.eq(expected) || !target.eq(plan.target)) {
      if (rec.protect_attempted) { await this.closeOne(rec, 'Защита не подтверждена'); return; }
      rec.protect_attempted = true; this.persist();
      try { await this.setStop(item, expected, plan.target); } catch (exc) {
        if (exc instanceof RequestCancelled) { rec.protect_attempted = false; this.persist(); throw exc; }
        if (isTemporary(exc)) { rec.protect_attempted = false; this.persist(); throw exc; }
        await this.closeOne(rec, 'Ошибка биржевого TP/SL');
      }
      return;
    }
    rec.protect_attempted = false;
    const price = number(ticker[plan.side === 'Buy' ? 'bid1Price' : 'ask1Price'] || '0', 'Цена');
    if (price.lte(0)) return;
    if (PUMP_NAMES.includes(plan.strategy)) {
      let best = D(String(rec.pump_best ?? plan.entry));
      best = plan.side === 'Buy' ? Decimal.max(best, price) : Decimal.min(best, price);
      if (best.toString() !== rec.pump_best) { rec.pump_best = best.toString(); this.persist(); }
      let desired = protectedTrailingStop(plan.side, plan.entry, best, expected);
      desired = roundStep(desired, plan.tick, plan.side === 'Sell');
      const tighter = plan.side === 'Buy' ? desired.gt(expected) : desired.lt(expected);
      const valid = plan.side === 'Buy' ? desired.lt(price) : desired.gt(price);
      if (tighter && valid) {
        rec.soft_stop = desired.toString(); rec.protect_attempted = false; this.persist();
        try { await this.setStop(item, desired, plan.target); } catch (exc) {
          if (exc instanceof RequestCancelled) { rec.soft_stop = expected.toString(); this.persist(); throw exc; }
          this.log('ПАМП: новый SL не подтверждён; прежняя защита требует сверки: ' + item.key + '; ' + safeError(exc));
        }
        return;
      }
    }
    let bePlan = plan;
    if ((rec.partial_take || {}).state === 'FILLED') {
      const fraction = partial.remaining(rec, plan).div(plan.quantity);
      bePlan = plan.with({ quantity: partial.remaining(rec, plan), base_equivalent: plan.base_equivalent.mul(fraction), risk_usdt: plan.risk_usdt.mul(fraction) });
    }
    const pstate = (rec.partial_take || {}).state;
    const eligibleBe = !['quality-partial-v2', 'quality-partial-v3'].includes(plan.management_version) || ['FILLED', 'UNAVAILABLE_MINIMUM_LOT', 'UNFILLED', 'REJECTED'].includes(pstate);
    let nw = eligibleBe ? this.risk.breakeven(bePlan, price, expected) : null;
    const locked = tighterStop(plan, bePlan, price, expected, pstate);
    if (locked !== null && (nw === null || (plan.side === 'Buy' ? locked.gt(nw) : locked.lt(nw)))) nw = locked;
    if (nw !== null) {
      rec.soft_stop = nw.toString(); rec.protect_attempted = false; this.persist();
      try { await this.setStop(item, nw, plan.target); } catch (exc) {
        if (exc instanceof RequestCancelled) { rec.soft_stop = expected.toString(); this.persist(); throw exc; }
        this.log('Безубыток: запрос SL не подтверждён, сверка продолжится: ' + item.key + '; ' + safeError(exc)); return;
      }
      this.log('БОТ: запрос переноса SL отправлен, ожидается сверка Bybit ' + item.key + ' -> ' + nw);
      if (['quality-partial-v2', 'quality-partial-v3'].includes(plan.management_version)) return;
    }
    if (await partial.manage(this, rec, item, plan, pos, price)) return;
    await this.aiExit(rec, item, plan, price);
  }
  async spotChildren(rec, item, plan) {
    let rows = await this.orders(item);
    if (!rec.children.length) rows = rows.concat(await this.pages('get_order_history', { category: 'spot', symbol: item.symbol, startTime: Math.max(0, rec.created - 1000), endTime: Math.min(this.clock(), rec.created + 7 * 86400000 - 1001), limit: 50 }));
    for (const row of rows) {
      if (row.side === plan.side) continue;
      if (parseInt(row.createdTime || '0', 10) < rec.created - 1000) continue;
      if (!row.stopOrderType && !['tpslOrder', 'OcoOrder'].includes(row.orderFilter)) continue;
      if (!rec.children.includes(row.orderId)) rec.children.push(row.orderId);
    }
    this.persist();
  }
  async manageSpot(rec, item, plan) {
    await this.spotChildren(rec, item, plan);
    if (rec.phase === 'spot_cancel') { await this.cancelChildren(rec, item); return; }
    if (rec.exit_link) { await this.spotCloseProgress(rec, item, plan); return; }
    const executed = [];
    for (const oid of rec.children) {
      const order = await this.findOrder(item, { orderId: oid, start: rec.created });
      if (order && number(order.cumExecQty || '0', 'Закрыто').gt(0)) {
        if (!TERMINAL.has(order.orderStatus)) return; // partially executing native exit: wait for terminal state
        executed.push(order);
      }
    }
    if (executed.length) { rec.native_exit = executed.map((o) => o.orderId); rec.phase = 'spot_cancel'; this.persist(); await this.cancelChildren(rec, item); return; }
    if (rec.exit_requested) { await this.closeOne(rec, 'Сохранён запрос пользователя на закрытие'); return; }
    if (this.clock() - rec.created >= 32 * minutes(plan.timeframe) * 60000) { await this.closeOne(rec, 'Завершён расчётный горизонт удержания (32 свечи)'); return; }
    if (!rec.children.length) { if (this.clock() - rec.created > 20000) await this.closeOne(rec, 'Не обнаружены биржевые спотовые TP/SL'); return; }
    const ticker = this.universe.tickers.get(item.key) || {};
    const price = number(ticker[plan.side === 'Buy' ? 'bid1Price' : 'ask1Price'] || '0', 'Цена'); if (price.lte(0)) return;
    const old = number(rec.soft_stop, 'SL'); const nw = this.risk.breakeven(plan, price, old);
    if (nw !== null) { rec.soft_stop = nw.toString(); this.persist(); this.log('ВНИМАНИЕ: программный безубыток спота ' + item.key + ' -> ' + nw + '. Биржевой SL НЕ перенесён; при отключении бота новый уровень НЕ защищён.'); }
    const soft = number(rec.soft_stop, 'SL');
    if (plan.side === 'Buy' ? price.lte(soft) : price.gte(soft)) { await this.closeOne(rec, 'Программный SL/безубыток'); return; }
    await this.aiExit(rec, item, plan, price);
  }
  async aiExit(rec, item, plan, price) {
    const bar = Math.floor(this.clock() / (minutes(plan.timeframe) * 60000));
    if (rec.ai_exit_bar === bar) return;
    rec.ai_exit_bar = bar;
    if (plan.pnl(price).lt(MIN_NET_RR.mul(plan.reference_usdt))) return;
    const brain = this.brains.get(`${plan.market}|${item.key}:${plan.timeframe}:${stopMultiplier(plan.strategy)}`);
    if (brain && brain.data) { const rows = await this.history(item, plan.timeframe); if (brain.shouldTakeProfit(rows, plan.side)) await this.closeOne(rec, 'ИИ: фиксация достаточной прибыли'); }
  }
  async closeOwned(reason = 'Закрытие пользователем') {
    this.entries_enabled = false; this.state.resume_armed = false; this.persist();
    for (const rec of Object.values(this.state.positions)) {
      rec.exit_requested = true; this.persist();
      if (rec.phase !== 'open') { this.log('Запрос закрытия сохранён; сначала подтверждение текущего состояния ' + rec.id); continue; }
      try { await this.closeOne(rec, reason); } catch (exc) { if (exc instanceof RequestCancelled) throw exc; this.log('Не удалось подтвердить закрытие ' + rec.id + ': ' + describe(exc)); }
    }
  }
  async closeOne(rec, reason) {
    if (rec.exit_link) return;
    if (rec.phase !== 'open') throw new Halt('Вход не подтверждён; сначала сверка Bybit');
    const plan = TradePlan.restore(rec.plan); const item = this.universe.instruments.get(plan.instrument_key);
    rec.exit_reason = reason;
    if (item.category === 'spot') { rec.phase = 'spot_cancel'; this.persist(); await this.cancelChildren(rec, item); return; }
    const [pos] = await this.position(item);
    if (!pos) return;
    if ((rec.partial_take || {}).state === 'PENDING') throw new Halt('Сначала сверка частичного выхода');
    const own = partial.remaining(rec, plan);
    if (pos.side !== plan.side) throw new Halt('Не совпадает собственная позиция');
    const qty = Decimal.min(own, number(pos.size, 'Размер'));
    const link = linkId('ac2-'); rec.exit_link = link; rec.exit_created = this.clock(); this.persist();
    try {
      await this.api.submit({ category: item.category, symbol: item.symbol, side: plan.side === 'Buy' ? 'Sell' : 'Buy', orderType: 'Market', qty: qty.toString(), positionIdx: 0, reduceOnly: true, orderLinkId: link });
      this.log('Закрытие ' + item.key + ': ' + reason);
    } catch (exc) {
      if (exc instanceof RequestCancelled) { rec.exit_link = null; delete rec.exit_created; this.persist(); throw exc; }
      if (exc instanceof ApiRejected) { rec.exit_link = null; delete rec.exit_created; this.persist(); this.log('Биржа отклонила закрытие ' + item.key + ' (' + safeError(exc) + '); повтор при следующей сверке.'); return; }
      this.log('Ответ закрытия неизвестен ' + item.key + '; повтора вслепую нет, сверка по orderLinkId.');
    }
  }
  async cancelChildren(rec, item) {
    let waiting = false;
    for (const oid of rec.children) {
      const order = await this.findOrder(item, { orderId: oid, start: rec.created });
      if (order === null) { rec.missing_children = (rec.missing_children || 0) + 1; if (rec.missing_children < 20) { waiting = true; continue; } continue; }
      if (TERMINAL.has(order.orderStatus)) {
        if (number(order.cumExecQty || '0', 'Исполненный выход').gt(0)) { rec.native_exit = rec.native_exit || []; if (!rec.native_exit.includes(oid)) { rec.native_exit.push(oid); this.persist(); } }
        continue;
      }
      rec.cancel_sent = rec.cancel_sent || []; const lastSent = (rec.cancel_times || {})[oid] || 0;
      if (!rec.cancel_sent.includes(oid) || this.clock() - lastSent > 60000) {
        if (!rec.cancel_sent.includes(oid)) rec.cancel_sent.push(oid);
        rec.cancel_times = { ...(rec.cancel_times || {}), [oid]: this.clock() }; this.persist();
        try { await this.api.call('cancel_order', { category: 'spot', symbol: item.symbol, orderId: oid }); } catch (exc) {
          if (exc instanceof RequestCancelled) { rec.cancel_sent = rec.cancel_sent.filter((x) => x !== oid); this.persist(); throw exc; }
        }
      }
      waiting = true;
    }
    if (waiting) return;
    if (rec.native_exit && rec.native_exit.length) { rec.exit_orders = rec.native_exit; await this.finishSpot(rec, item, TradePlan.restore(rec.plan)); return; }
    await this.sendSpotExit(rec, item, TradePlan.restore(rec.plan));
  }
  async sendSpotExit(rec, item, plan) {
    if (rec.exit_link) return;
    const entryQty = sumD(rec.entry_exec.map((r) => number(r.execQty, 'Количество')));
    const baseFees = sumD(rec.entry_exec.filter((r) => r.feeCurrency === item.base).map((r) => number(r.execFee || '0', 'Комиссия')));
    const side = plan.side === 'Buy' ? 'Sell' : 'Buy';
    let qty = side === 'Sell' ? entryQty.minus(baseFees) : entryQty.plus(baseFees);
    await this.updateWallet();
    const availableBase = number(this.coin(item.base).walletBalance || '0', 'Остаток базовой монеты').minus(number(rec.base_before || '0', 'Исходный остаток'));
    if (side === 'Sell' && availableBase.lt(qty)) {
      if (availableBase.lte(plan.qty_step)) { this.log('Спотовый остаток ' + item.base + ' уже продан (вероятно, биржевым TP/SL); учёт по истории исполнений.'); await this.recoverSpotFromHistory(rec, item, plan); return; }
      qty = availableBase;
    }
    if (side === 'Buy') {
      const currentDebt = this.debt(item.base);
      if (currentDebt.lte(0) || availableBase.gte(currentDebt)) { this.log('Заём ' + item.base + ' уже покрыт; учёт по истории исполнений.'); await this.recoverSpotFromHistory(rec, item, plan); return; }
      const interest = number(this.coin(item.base).accruedInterest || '0', 'Проценты');
      qty = roundStep(qty.plus(interest).div(D(1).minus(plan.costs.execution_rate)), plan.qty_step, true);
    } else qty = roundStep(qty, plan.qty_step);
    if (qty.lte(0)) throw new Halt('Нет принадлежащего боту объёма для спотового выхода');
    if ((await this.orders(item)).length) throw new Halt('На споте ещё есть ордера; закрытие не отправлено');
    const link = linkId('as2-'); Object.assign(rec, { exit_link: link, exit_created: this.clock(), exit_qty: qty.toString(), phase: 'spot_exit' }); this.persist();
    try { const result = await this.api.submit({ category: 'spot', symbol: item.symbol, side, orderType: 'Market', qty: qty.toString(), marketUnit: 'baseCoin', isLeverage: 0, orderLinkId: link }); rec.exit_order = result.orderId; this.persist(); } catch (exc) {
      if (exc instanceof RequestCancelled || exc instanceof ApiRejected) { rec.exit_link = null; delete rec.exit_created; delete rec.exit_qty; rec.phase = 'spot_cancel'; this.persist(); if (exc instanceof RequestCancelled) throw exc; this.log('Биржа отклонила спотовый выход ' + item.key + '; повтор при следующей сверке.'); return; }
      this.log('Спотовый выход не подтверждён ' + item.key + '; повтора вслепую нет, сверка по orderLinkId.');
    }
  }
  async recoverSpotFromHistory(rec, item, plan) {
    const rows = await this.pages('get_order_history', { category: 'spot', symbol: item.symbol, startTime: Math.max(0, rec.created - 1000), endTime: Math.min(this.clock(), rec.created + 7 * 86400000 - 1001), limit: 50 });
    const exits = rows.filter((r) => r.side !== plan.side && number(r.cumExecQty || '0', 'q').gt(0) && parseInt(r.createdTime || '0', 10) >= rec.created - 1000).map((r) => r.orderId);
    if (!exits.length) throw new Halt('Спотовый выход не найден в истории; повторная сверка позже');
    rec.exit_orders = exits; this.persist(); await this.finishSpot(rec, item, plan);
  }
  async spotCloseProgress(rec, item, plan) {
    const order = await this.findOrder(item, { link: rec.exit_link, start: rec.exit_created });
    if (!order) {
      if (this.clock() - rec.exit_created > LOST_ORDER_MS) { this.log('Спотовый выход ' + item.key + ' не найден на бирже — запрос не дошёл; повтор.'); rec.exit_link = null; delete rec.exit_created; delete rec.exit_qty; rec.phase = 'spot_cancel'; this.persist(); }
      return;
    }
    if (!TERMINAL.has(order.orderStatus)) return;
    const qty = number(order.cumExecQty || '0', 'Спотовое исполнение');
    if (qty.isZero()) { this.log('Спотовый выход ' + item.key + ' не исполнен (' + order.orderStatus + '); повтор.'); rec.exit_link = null; delete rec.exit_created; delete rec.exit_qty; rec.phase = 'spot_cancel'; this.persist(); return; }
    rec.exit_orders = [...(rec.exit_orders_partial || []), order.orderId];
    if (order.orderStatus !== 'Filled' || !qty.eq(number(rec.exit_qty, 'Размер выхода'))) {
      rec.exit_orders_partial = rec.exit_orders; rec.exit_link = null; delete rec.exit_created; delete rec.exit_qty; rec.phase = 'spot_cancel'; this.persist();
      this.log('Спотовый выход ' + item.key + ' исполнен частично; остаток будет закрыт следующим ордером.'); return;
    }
    await this.finishSpot(rec, item, plan);
  }
  async finishSpot(rec, item, plan) {
    let rows = [];
    for (const oid of rec.exit_orders) rows = rows.concat(await this.executions(item, oid));
    if (!rows.length) return;
    const flows = {}; const seen = new Set(); const add = (k, v) => { flows[k] = (flows[k] || D(0)).plus(v); };
    for (const row of rec.entry_exec.concat(rows)) {
      if (!row.execId) throw new Halt('Нет execId для спотового учёта');
      if (seen.has(row.execId)) continue;
      seen.add(row.execId); const qty = number(row.execQty, 'Exec qty'); const price = number(row.execPrice, 'Exec price'); const sign = D(row.side === 'Buy' ? 1 : -1);
      add(item.base, sign.mul(qty)); add(item.quote, sign.mul(qty).mul(price).neg());
      const fee = number(row.execFee || '0', 'Fee');
      if (!fee.isZero()) { if (!row.feeCurrency) throw new Halt('Неизвестна валюта комиссии'); add(row.feeCurrency, fee.neg()); }
    }
    if (plan.market === 'margin') { rec.spot_flows = Object.fromEntries(Object.entries(flows).map(([k, v]) => [k, v.toString()])); rec.phase = 'repay'; this.persist(); await this.repay(rec, item, plan); }
    else this.book(rec, this.settledSpotNet(flows, item, plan));
  }
  settledSpotNet(flowsIn, item, plan) {
    const flows = { ...flowsIn }; const baseDelta = flows[item.base] || D(0);
    if (baseDelta.lt(0) && baseDelta.abs().gt(plan.qty_step)) this.log('Спотовый объём ' + item.base + ' не сведён после комиссий/процентов (' + baseDelta + '); учтён по рыночному курсу.');
    if (baseDelta.gt(0)) {
      const minimum = number(item.raw.lotSizeFilter.minOrderAmt ?? '0', 'Минимальная сумма');
      if (baseDelta.gte(plan.qty_step) && baseDelta.mul(this.universe.fx(item.base)).gte(minimum.mul(this.universe.fx(item.quote)))) this.log('После выхода остался торгуемый объём ' + item.base + ' ' + baseDelta + '; он учтён по рыночной стоимости.');
      else { this.log('Спотовый остаток ниже минимума: не включён в чистую прибыль ' + item.base); flows[item.base] = D(0); }
    }
    return sumD(Object.entries(flows).map(([coin, value]) => value.mul(this.universe.fx(coin))));
  }
  async repay(rec, item, plan) {
    await this.updateWallet(); const settlement = AICostService.repaymentPlan(this.wallet, [item.base, item.quote]);
    const owed = settlement.map((a) => a.coin);
    for (const coin of owed) {
      rec.repay_times = rec.repay_times || {}; const sentAt = rec.repay_times[coin] || 0;
      if (this.clock() - sentAt >= 60000) {
        if (!rec.repay_sent.includes(coin)) rec.repay_sent.push(coin);
        rec.repay_times[coin] = this.clock(); this.persist();
        try { await this.api.call('manual_no_convert_repay', { coin, repaymentType: 'FLEXIBLE' }); } catch (exc) {
          if (exc instanceof RequestCancelled) { delete rec.repay_times[coin]; rec.repay_sent = rec.repay_sent.filter((c) => c !== coin); this.persist(); throw exc; }
          this.log('Погашение займа ' + coin + ' не подтверждено (' + safeError(exc) + '); повтор через 60 с, активы не конвертируются.');
        }
      }
      return;
    }
    const interestRows = [];
    for (const coin of [item.base, item.quote]) {
      let start = rec.created; const end = this.clock();
      while (start <= end) { const last = Math.min(end, start + 30 * 86400000 - 1); interestRows.push(...await this.pages('get_borrow_history', { currency: coin, startTime: start, endTime: last, limit: 50 })); start = last + 1; }
    }
    const flows = {}; for (const [coin, value] of Object.entries(rec.spot_flows)) flows[coin] = number(value, 'Денежный поток');
    for (const [coin, amount] of Object.entries(AICostService.interestDebits(interestRows))) flows[coin] = (flows[coin] || D(0)).minus(amount);
    this.book(rec, this.settledSpotNet(flows, item, plan));
  }
  async finishDerivative(rec, item, plan) {
    let rows = []; let start = Math.max(rec.created, this.clock() - 60 * 86400000); const end = this.clock();
    while (start <= end) { const last = Math.min(end, start + 7 * 86400000 - 1); rows = rows.concat(await this.pages('get_closed_pnl', { category: item.category, symbol: item.symbol, startTime: start, endTime: last, limit: 100 })); start = last + 1; }
    const unique = new Map(); for (const r of rows) if (parseInt(r.updatedTime ?? r.createdTime ?? 0, 10) >= rec.created) unique.set(r.orderId, r);
    const qty = sumD([...unique.values()].filter((r) => (r.execType ?? 'Trade') !== 'SessionSettlePnL').map((r) => number(r.closedSize || '0', 'Закрыто')));
    if (qty.lt(plan.quantity)) {
      rec.finish_wait = (rec.finish_wait || 0) + 1; this.persist();
      if (rec.finish_wait < 100) return;
      if (qty.isZero()) throw new Halt('Позиция закрыта, но Closed PnL не найден; повторная сверка позже');
    }
    let net = sumD([...unique.values()].map((r) => number(r.closedPnl, 'Closed PnL'))).mul(this.universe.fx(item.settle));
    if (!qty.eq(plan.quantity)) { this.log('Closed PnL ' + item.key + ' содержит объём ' + qty + ' вместо ' + plan.quantity + '; результат пропорционально скорректирован.'); net = net.mul(Decimal.min(D(1), plan.quantity.div(qty))); }
    this.book(rec, net);
  }
  book(rec, net) {
    const plan = TradePlan.restore(rec.plan);
    const result = { id: rec.id, net: net.toString(), closed: this.clock(), plan: rec.plan, reason: rec.exit_reason || 'Bybit TP/SL', initial_risk_usdt: plan.risk_usdt.toString(),
      net_r: plan.risk_usdt.gt(0) ? net.div(plan.risk_usdt).toString() : null, entry_quality: rec.entry_quality ?? null, partial_take_state: (rec.partial_take || {}).state ?? null };
    const group = this.group(plan.strategy); const gid = this.owner_group[plan.strategy];
    const recentLosses = group.batch.filter((r) => number(r.net, 'Итог').lt(0)).map((r) => number(r.net, 'Убыток').neg()).slice(-3);
    if (net.gt(0) && recentLosses.length === 3) {
      const totalLosses = sumD(recentLosses); result.last_three_losses = totalLosses.toString(); result.covers_three_losses = net.gte(totalLosses);
      this.log('Проверка 1/3: прибыль ' + net + (net.gte(totalLosses) ? ' покрыла ' : ' НЕ покрыла ') + 'три последних убытка текущей серии группы, сумма ' + totalLosses + ' USDT.');
    }
    group.batch.push(result); delete this.state.positions[rec.id];
    this.state.total_net = number(this.state.total_net, 'Итог').plus(net).toString();
    this.state.day_net = number(this.state.day_net, 'День').plus(net).toString();
    this.persist(result); this.log(`Закрыто ${plan.instrument_key}: ${fmtSigned(net, 6)} USDT, ${plan.strategy}/${plan.timeframe}.`);
    if (net.lt(plan.reference_usdt.neg())) { group.halt = 'Фактический убыток превысил R; нужна проверка издержек.'; group.halt_at = this.clock(); this.persist(); this.log(gid + ': ' + group.halt); }
    if (net.gt(0) && net.lt(MIN_NET_RR.mul(plan.reference_usdt))) this.log('Ранняя/безубыточная фиксация ниже 3R: учтён фактический результат, покрытие серии не гарантировано.');
    if (!this.config.quality_management_enabled && group.batch.length >= 10) {
      const values = group.batch.map((r) => number(r.net, 'PnL')); const total = sumD(values);
      const wins = values.filter((v) => v.gt(0)).length, losses = values.filter((v) => v.lt(0)).length;
      this.log(`${gid}: 10 закрытий, ${wins} прибыльных/${losses} убыточных, итог ${fmtSigned(total, 5)} USDT. ` + (wins === 4 && losses === 6 && total.gt(0) ? '4 прибыли покрыли 6 убытков.' : 'Фактическое условие 4/6 не подтверждено.'));
      if (total.gt(0) && !group.halt) { if (!Object.values(this.state.positions).some((r) => this.owner_group[r.plan.strategy] === gid)) this.newBatch(gid); }
      else { group.halt = 'Серия завершена без положительного итога или с нарушением R.'; group.halt_at = this.clock(); this.persist(); }
    }
  }
  shutdown(clearResume = true) {
    this.entries_enabled = false; this.closed = true;
    if (clearResume) this.state.resume_armed = false;
    this.persist();
  }
}

module.exports = { Portfolio, TERMINAL };
