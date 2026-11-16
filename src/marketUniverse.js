'use strict';
// Discover every Trading spot/linear/inverse symbol; fair multi-timeframe polling.
const { D, number } = require('./num');
const { ValueError } = require('./errors');

const TIMEFRAMES = ['1', '15', '30', '60', '120', '240', '360', '720', 'D'];
const minutes = (interval) => (interval === 'D' ? 1440 : parseInt(interval, 10));

class Instrument {
  constructor(category, symbol, base, quote, settle, kind, margin, raw) {
    Object.assign(this, { category, symbol, base, quote, settle, kind, margin, raw });
    Object.freeze(this);
  }
  get key() { return this.category + ':' + this.symbol; }
}

class Universe {
  constructor(api) { this.api = api; this.instruments = new Map(); this.tickers = new Map(); this.updated_ms = 0; this.fxCache = new Map([['USDT', D(1)]]); }
  async discover() {
    const found = new Map();
    for (const category of ['spot', 'linear', 'inverse']) {
      let cursor = null; const seen = new Set();
      for (;;) {
        const args = { category };
        if (category !== 'spot') Object.assign(args, { limit: 1000, status: 'Trading' });
        if (cursor) args.cursor = cursor;
        const response = await this.api.call('get_instruments_info', args);
        for (const row of response.list || []) {
          if (row.status !== 'Trading') continue;
          const i = new Instrument(category, row.symbol, row.baseCoin, row.quoteCoin, row.settleCoin ?? row.quoteCoin,
            row.contractType ?? 'Spot', ['both', 'utaOnly'].includes(row.marginTrading), row);
          found.set(i.key, i);
        }
        cursor = response.nextPageCursor;
        if (!cursor || category === 'spot') break;
        if (seen.has(cursor)) throw new ValueError('Зацикленная пагинация инструментов');
        seen.add(cursor);
      }
    }
    if (!found.size) throw new ValueError('Bybit не вернул торговые инструменты');
    this.instruments = found;
    return found;
  }
  async prices() {
    const out = new Map();
    for (const category of ['spot', 'linear', 'inverse']) {
      for (const row of (await this.api.call('get_tickers', { category })).list || []) out.set(category + ':' + row.symbol, row);
    }
    this.tickers = out; this.updated_ms = Date.now(); this.fxCache = new Map([['USDT', D(1)]]);
  }
  fx(coin) {
    if (this.fxCache.has(coin)) return this.fxCache.get(coin);
    const graph = new Map();
    const push = (k, v) => { if (!graph.has(k)) graph.set(k, []); graph.get(k).push(v); };
    for (const [key, item] of this.instruments) {
      if (item.category !== 'spot') continue;
      const row = this.tickers.get(key) || {};
      const price = number(row.lastPrice || '0', 'FX');
      if (price.gt(0)) { push(item.base, [item.quote, price]); push(item.quote, [item.base, D(1).div(price)]); }
    }
    if (coin === 'USD') {
      for (const [key, item] of this.instruments) {
        if (item.category === 'inverse' && item.quote === 'USD') {
          const price = number((this.tickers.get(key) || {}).lastPrice || '0', 'USD FX');
          if (price.gt(0)) {
            try { const result = this.fx(item.base).div(price); this.fxCache.set(coin, result); return result; } catch (e) { if (!(e instanceof ValueError)) throw e; }
          }
        }
      }
      throw new ValueError('Нет курса USD/USDT: номинальный паритет не предполагается');
    }
    const queue = [[coin, D(1), 0]]; const seen = new Set([coin]);
    while (queue.length) {
      const [current, value, depth] = queue.shift();
      if (depth >= 3) continue;
      for (const [nxt, rate] of graph.get(current) || []) {
        if (nxt === 'USDT') { const result = value.mul(rate); this.fxCache.set(coin, result); return result; }
        if (!seen.has(nxt)) { seen.add(nxt); queue.push([nxt, value.mul(rate), depth + 1]); }
      }
    }
    throw new ValueError('Нет наблюдаемого FX курса ' + coin + '/USDT');
  }
}

class Heap {
  constructor() { this.a = []; }
  static less(x, y) { return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }
  push(v) { const a = this.a; a.push(v); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (Heap.less(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; } }
  pop() {
    const a = this.a; const top = a[0]; const lastItem = a.pop();
    if (a.length) {
      a[0] = lastItem; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && Heap.less(a[l], a[m])) m = l; if (r < a.length && Heap.less(a[r], a[m])) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; }
    }
    return top;
  }
  peek() { return this.a[0]; }
  get length() { return this.a.length; }
}

const pk = (key, tf) => key + '\u0000' + tf;

class FairScheduler {
  constructor() { this.heap = new Heap(); this.known = new Set(); this.counter = 0; this.seen = 0; this.current = new Map(); this.urgent = []; this.urgentKnown = new Set(); }
  sync(keys, now) {
    keys = new Set(keys);
    for (const p of [...this.known]) {
      const key = p.split('\u0000')[0];
      if (!keys.has(key)) { this.known.delete(p); this.current.delete(p); this.urgentKnown.delete(p); }
    }
    const buckets = {};
    for (const key of [...keys].sort()) { const cat = key.split(':')[0]; (buckets[cat] = buckets[cat] || []).push(key); }
    const rank = { spot: 0, linear: 1, inverse: 2 };
    const order = Object.keys(buckets).sort((x, y) => ((rank[x] ?? 3) - (rank[y] ?? 3)) || (x < y ? -1 : x > y ? 1 : 0));
    const longest = Math.max(0, ...Object.values(buckets).map((v) => v.length));
    const diagonals = longest ? longest + TIMEFRAMES.length - 1 : 0;
    for (let diagonal = 0; diagonal < diagonals; diagonal++) {
      TIMEFRAMES.forEach((tf, tfIndex) => {
        const i = diagonal - tfIndex; if (i < 0) return;
        for (const category of order) {
          if (i >= buckets[category].length) continue;
          const key = buckets[category][i]; const pair = pk(key, tf);
          if (!this.known.has(pair)) { this.known.add(pair); this.counter++; this.current.set(pair, this.counter); this.heap.push([now, this.counter, key, tf]); }
        }
      });
    }
  }
  defer(key, tf, due) {
    const pair = pk(key, tf); if (!this.known.has(pair)) return;
    this.urgentKnown.delete(pair); this.counter++; this.current.set(pair, this.counter); this.heap.push([due, this.counter, key, tf]);
  }
  wake(key, tf, now) {
    const pair = pk(key, tf); if (!this.known.has(pair) || this.urgentKnown.has(pair)) return;
    this.counter++; this.current.set(pair, this.counter); this.urgent.push([key, tf, this.counter]); this.urgentKnown.add(pair);
  }
  next(now) {
    while (this.urgent.length) {
      const [key, tf, generation] = this.urgent.shift(); const pair = pk(key, tf); this.urgentKnown.delete(pair);
      if (this.current.get(pair) !== generation) continue;
      const step = minutes(tf) * 60; this.counter++; this.current.set(pair, this.counter);
      this.heap.push([(Math.floor(now / step) + 1) * step + 2, this.counter, key, tf]); this.seen++;
      return [key, tf, 0];
    }
    while (this.heap.length && this.current.get(pk(this.heap.peek()[2], this.heap.peek()[3])) !== this.heap.peek()[1]) this.heap.pop();
    if (!this.heap.length || this.heap.peek()[0] > now) return null;
    const [due, , key, tf] = this.heap.pop();
    const step = minutes(tf) * 60; const nextDue = (Math.floor(now / step) + 1) * step + 2;
    this.counter++; this.current.set(pk(key, tf), this.counter); this.heap.push([nextDue, this.counter, key, tf]); this.seen++;
    return [key, tf, Math.max(0, now - due)];
  }
}

module.exports = { TIMEFRAMES, minutes, Instrument, Universe, FairScheduler };
