'use strict';
// Bounded minute scanner + multi-TF/multi-market pump scanner. Both use the standard portfolio path.
const { D } = require('./num');
const { RequestCancelled, safeError, describe } = require('./errors');
const { scanClosed1m } = require('./pumpGuard');
const { scanClosed, SUPPORTED_TF } = require('./multiPumpGuard');
const { atr } = require('./strategies');

class PumpScanner {
  constructor(portfolio, maxSymbols = 12) { this.portfolio = portfolio; this.maxSymbols = maxSymbols; this.cursor = 0; this.lastBar = new Map(); this.signals = []; }
  async tick() {
    const results = [];
    for (let i = 0; i < this.maxSymbols; i++) { if (this.portfolio.cancelled()) break; results.push(...await this.scanOne()); }
    return results;
  }
  async scanOne() {
    const p = this.portfolio;
    const items = [...p.universe.instruments.values()].filter((i) => i.category === 'linear' && i.settle === 'USDT' && i.kind === 'LinearPerpetual').sort((a, b) => (a.key < b.key ? -1 : 1));
    if (!items.length) return [];
    const item = items[this.cursor % Math.min(items.length, this.maxSymbols)]; this.cursor++;
    const ticker = p.universe.tickers.get(item.key) || {};
    const bid = D(String(ticker.bid1Price || '0')), ask = D(String(ticker.ask1Price || '0'));
    if (bid.lte(0) || ask.lte(bid)) return [];
    const spread = ask.minus(bid).div(ask).mul(100);
    const rows = await p.history(item, '1', 110);
    if (rows.length < 100) return [];
    const bar = rows.at(-1)[0];
    if (this.lastBar.get(item.key) === bar) return [];
    this.lastBar.set(item.key, bar);
    const results = [];
    for (const strategy of scanClosed1m(rows, { spreadPct: spread })) {
      results.push({ symbol: item.symbol, market: item.category, strategy, bar, spread_pct: spread.toString() });
      p.log('ПАМП 1m сигнал: ' + item.symbol + ' / ' + strategy);
      if (p.store.mode === 'REAL') { p.log('ПАМП REAL: автоматический вход заблокирован до биржевой проверки'); continue; }
      if (p.clock() - bar > 120000 || p.state.halt || !p.entries_enabled) continue;
      if (Object.values(p.state.positions).some((r) => r.plan.instrument_key === item.key)) continue;
      try {
        await p.updateWallet();
        const fresh = (await p.api.call('get_tickers', { category: item.category, symbol: item.symbol })).list || [];
        if (fresh.length !== 1 || fresh[0].symbol !== item.symbol) continue;
        const quote = fresh[0]; const b = D(String(quote.bid1Price || '0')), a = D(String(quote.ask1Price || '0'));
        if (b.lte(0) || a.lte(b) || a.minus(b).div(a).mul(100).gt('.20')) continue;
        p.universe.tickers.set(item.key, quote);
        const costs = p.strictEntryCosts(await p.costs(item, 'linear', '1', 'Buy'));
        let leverage = (await p.position(item))[1];
        if (!(leverage.gte(3) && leverage.lte(7))) leverage = D('3');
        const plan = p.risk.build(item, 'linear', strategy, '1', 'Buy', rows, quote, p.sizingEquity(), p.group(strategy).reference, p.universe.fx(item.quote), costs, leverage, null, p.entryFractionForSignal());
        await p.open(plan, null);
        break;
      } catch (exc) { if (exc instanceof RequestCancelled) throw exc; p.log('ПАМП вход отклонён: ' + describe(exc)); }
    }
    this.signals = this.signals.concat(results).slice(-100);
    return results;
  }
}

class MultiPumpScanner {
  constructor(portfolio, maxPerTick = 8) { this.portfolio = portfolio; this.maxPerTick = maxPerTick; this.cursor = 0; this.lastBar = new Map(); this.signals = []; this.itemsCache = null; this.itemsCacheTs = 0; this.tfs = SUPPORTED_TF.slice(); }
  async tick() {
    const results = [];
    for (let i = 0; i < this.maxPerTick; i++) { if (this.portfolio.cancelled()) break; results.push(...await this.scanOne()); }
    return results;
  }
  eligible() {
    const p = this.portfolio; const now = p.clock();
    if (this.itemsCache && now - this.itemsCacheTs < 60000) return this.itemsCache;
    const markets = new Set(p.config.markets); const items = [];
    for (const item of p.universe.instruments.values()) {
      if (item.category === 'linear' && item.settle === 'USDT' && item.kind === 'LinearPerpetual' && markets.has('linear')) items.push(item);
      else if (item.category === 'spot' && (markets.has('spot') || (markets.has('margin') && item.margin))) items.push(item);
    }
    items.sort((a, b) => (a.key < b.key ? -1 : 1)); this.itemsCache = items; this.itemsCacheTs = now; return items;
  }
  resolveMarket(item) {
    const markets = new Set(this.portfolio.config.markets);
    if (item.category === 'linear') return 'linear';
    if (markets.has('margin') && item.margin) return 'margin';
    if (markets.has('spot')) return 'spot';
    return null;
  }
  chooseLeverage(item, market, rows, ticker) {
    if (market === 'spot') return D(1);
    let lev;
    try {
      const a = D(String(atr(rows))); const price = D(String(ticker.ask1Price || ticker.lastPrice || ticker.bid1Price || '0'));
      if (price.lte(0)) lev = D(3); else { const vol = a.div(price); lev = vol.gt('0.04') ? D(2) : vol.gt('0.02') ? D(3) : vol.gt('0.01') ? D(5) : D(7); }
    } catch (e) { lev = D(3); }
    const lo = market === 'margin' ? D(2) : D(1);
    return lev.gt(7) ? D(7) : lev.lt(lo) ? lo : lev;
  }
  async scanOne() {
    const p = this.portfolio; const items = this.eligible();
    if (!items.length || !this.tfs.length) return [];
    const total = items.length * this.tfs.length; const idx = this.cursor % total; this.cursor++;
    const item = items[Math.floor(idx / this.tfs.length)]; const tf = this.tfs[idx % this.tfs.length];
    const useMarket = this.resolveMarket(item); if (useMarket === null) return [];
    const ticker = p.universe.tickers.get(item.key) || {};
    const bid = D(String(ticker.bid1Price || '0')), ask = D(String(ticker.ask1Price || '0'));
    if (bid.lte(0) || ask.lte(bid)) return [];
    const spread = ask.minus(bid).div(ask).mul(100);
    const maxSpread = ['1', '15'].includes(tf) ? D('0.20') : ['30', '60'].includes(tf) ? D('0.25') : D('0.35');
    if (spread.gt(maxSpread)) return [];
    let rows;
    try { rows = await p.history(item, tf, 120); } catch (exc) { if (exc instanceof RequestCancelled) throw exc; return []; }
    if (rows.length < 50) return [];
    const bar = rows.at(-1)[0]; const cacheKey = item.key + '|' + tf;
    if (this.lastBar.get(cacheKey) === bar) return [];
    this.lastBar.set(cacheKey, bar);
    if (this.lastBar.size > 5000) { const keys = [...this.lastBar.keys()]; for (const k of keys.slice(0, Math.floor(keys.length / 2))) this.lastBar.delete(k); }
    const found = scanClosed(rows, tf, { spreadPct: spread }); if (!found.length) return [];
    const results = [];
    for (const strategy of found) {
      results.push({ symbol: item.symbol, market: useMarket, strategy, timeframe: tf, bar, spread_pct: spread.toString() });
      p.log(`МУЛЬТИ-ПАМП ${tf} сигнал: ${item.symbol} / ${strategy} / ${useMarket}`);
      if (p.state.halt || !p.entries_enabled) continue;
      const maxAge = { 1: 180000, 15: 600000, 30: 1200000, 60: 2400000 }[tf] ?? 3600000;
      if (p.clock() - bar > maxAge) continue;
      if (Object.values(p.state.positions).some((r) => (r.plan || {}).instrument_key === item.key)) continue;
      try {
        await p.updateWallet();
        const freshList = (await p.api.call('get_tickers', { category: item.category, symbol: item.symbol })).list || [];
        if (freshList.length !== 1 || freshList[0].symbol !== item.symbol) continue;
        const quote = freshList[0]; const b = D(String(quote.bid1Price || '0')), a = D(String(quote.ask1Price || '0'));
        if (b.lte(0) || a.lte(b) || a.minus(b).div(a).mul(100).gt(maxSpread)) continue;
        p.universe.tickers.set(item.key, quote);
        const costs = p.strictEntryCosts(await p.costs(item, useMarket, tf, 'Buy'));
        const leverage = this.chooseLeverage(item, useMarket, rows, quote);
        const groupState = p.group(strategy); const reference = groupState ? groupState.reference : null;
        const plan = p.risk.build(item, useMarket, strategy, tf, 'Buy', rows, quote, p.sizingEquity(), reference, p.universe.fx(item.quote), costs, leverage, null, p.entryFractionForSignal());
        await p.open(plan, null);
        break;
      } catch (exc) { if (exc instanceof RequestCancelled) throw exc; p.log('МУЛЬТИ-ПАМП вход отклонён: ' + describe(exc)); }
    }
    this.signals = this.signals.concat(results).slice(-200);
    return results;
  }
}

module.exports = { PumpScanner, MultiPumpScanner, safeError };
