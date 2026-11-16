'use strict';
// 24 distinct closed-candle hypotheses. None can send orders or choose risk.
const { pySum, max, min, argmaxFirst, argminFirst } = require('./pymath');
const { PUMP_NAMES } = require('./pumpGuard');

const NAMES = {
  ema_cross: 'EMA20/50 cross', sma_cross: 'SMA20/50 cross',
  donchian20: 'Donchian20 breakout', donchian55: 'Donchian55 breakout',
  bollinger_reversion: 'Bollinger20 re-entry', bollinger_squeeze: 'Bollinger squeeze breakout',
  rsi_reversal: 'RSI14 30/70 exit', stochastic_reversal: 'Stochastic14 reversal',
  macd_cross: 'MACD12/26/9 cross', adx_trend: 'ADX14 trend confirmation',
  supertrend: 'Supertrend10 x3 flip', ichimoku: 'Ichimoku9/26/52 cloud breakout',
  vwap_reclaim: 'Rolling VWAP20 reclaim', keltner: 'Keltner20 x2 breakout',
  cci_reversal: 'CCI20 +/-100 exit', williams_reversal: 'Williams14 -80/-20 exit',
  roc_momentum: 'ROC12 zero crossing', obv_breakout: 'OBV20 breakout',
  mfi_reversal: 'MFI14 20/80 exit', aroon_cross: 'Aroon25 cross',
  psar_flip: 'Parabolic SAR flip', trend_pullback: 'EMA trend pullback',
  engulfing: 'Engulfing reversal', volume_momentum: 'ATR + volume impulse',
};
if (Object.keys(NAMES).length !== 24) throw new Error('24 strategies expected');
for (const k of PUMP_NAMES) NAMES[k] = k.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

const last = (a, i = 1) => a[a.length - i];

function seriesEma(values, period) {
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) { const p = out[out.length - 1]; out.push(p + 2 / (period + 1) * (values[i] - p)); }
  return out;
}

function rsi(values) {
  const a = values.slice(-15), b = values.slice(-14); const changes = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) changes.push(b[i] - a[i]);
  const up = pySum(changes.map((x) => Math.max(x, 0))); const down = -pySum(changes.map((x) => Math.min(x, 0)));
  return up + down === 0 ? 50 : 100 * up / (up + down);
}

function atr(candles, n = 14) {
  const rows = candles.slice(-n); const start = candles.length - rows.length;
  return pySum(rows.map((row, i) => {
    const prev = candles[Math.max(0, start + i - 1)][4];
    return Math.max(row[2] - row[3], Math.abs(row[2] - prev), Math.abs(row[3] - prev));
  })) / rows.length;
}

const avg = (values, n) => pySum(values.slice(-n)) / n;

function bands(values) {
  const mean = avg(values, 20); const sd = Math.sqrt(pySum(values.slice(-20).map((x) => (x - mean) ** 2)) / 20);
  return [mean - 2 * sd, mean + 2 * sd, mean ? 4 * sd / mean : 0];
}

function oscillator(rows, kind) {
  if (kind === 'cci') {
    const tp = rows.slice(-20).map((r) => (r[2] + r[3] + r[4]) / 3); const mean = pySum(tp) / 20;
    const dev = pySum(tp.map((x) => Math.abs(x - mean))) / 20;
    return dev ? (last(tp) - mean) / (0.015 * dev) : 0;
  }
  const window = rows.slice(-14); const hi = max(window.map((r) => r[2])); const lo = min(window.map((r) => r[3]));
  const k = hi === lo ? 50 : 100 * (last(rows)[4] - lo) / (hi - lo);
  return kind === 'williams' ? k - 100 : k;
}

function mfi(rows) {
  let pos = 0, neg = 0; const a = rows.slice(-15, -1), b = rows.slice(-14);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const previous = (a[i][2] + a[i][3] + a[i][4]) / 3; const now = (b[i][2] + b[i][3] + b[i][4]) / 3;
    if (now > previous) pos += now * b[i][5]; else if (now < previous) neg += now * b[i][5];
  }
  return pos + neg === 0 ? 50 : 100 * pos / (pos + neg);
}

function supertrendSide(rows, n = 10, mult = 3) {
  let upper = null, lower = null, direction = 1, previous = rows[0][4];
  rows.forEach((row, i) => {
    const a = atr(rows.slice(Math.max(0, i - n), i + 1), n); const mid = (row[2] + row[3]) / 2;
    const rawU = mid + mult * a, rawL = mid - mult * a;
    const u = upper === null || rawU < upper || previous > upper ? rawU : upper;
    const l = lower === null || rawL > lower || previous < lower ? rawL : lower;
    if (upper !== null && direction === -1 && row[4] > upper) direction = 1;
    else if (lower !== null && direction === 1 && row[4] < lower) direction = -1;
    upper = u; lower = l; previous = row[4];
  });
  return direction;
}

function psarSide(rows) {
  let up = rows[1][4] >= rows[0][4]; let sar = up ? rows[0][3] : rows[0][2];
  let extreme = up ? rows[0][2] : rows[0][3]; let acc = 0.02;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    sar += acc * (extreme - sar);
    if (up) {
      sar = Math.min(sar, rows[i - 1][3], rows[Math.max(0, i - 2)][3]);
      if (row[3] < sar) { up = false; sar = extreme; extreme = row[3]; acc = 0.02; } else if (row[2] > extreme) { extreme = row[2]; acc = Math.min(0.2, acc + 0.02); }
    } else {
      sar = Math.max(sar, rows[i - 1][2], rows[Math.max(0, i - 2)][2]);
      if (row[2] > sar) { up = true; sar = extreme; extreme = row[2]; acc = 0.02; } else if (row[3] < extreme) { extreme = row[3]; acc = Math.min(0.2, acc + 0.02); }
    }
  }
  return up ? 1 : -1;
}

function proposals(rows) {
  if (rows.length < 100) return {};
  const c = rows.map((r) => r[4]); const f = seriesEma(c, 20); const s = seriesEma(c, 50); const a = atr(rows);
  const result = {};
  const add = (side, name) => { (result[side] = result[side] || []).push(name); };
  const cross = (name, old, now, zero = 0) => { if (old <= zero && zero < now) add('Buy', name); else if (old >= zero && zero > now) add('Sell', name); };
  const cm1 = c.slice(0, -1); const rm1 = rows.slice(0, -1);
  cross('ema_cross', last(f, 2) - last(s, 2), last(f) - last(s));
  cross('sma_cross', avg(cm1, 20) - avg(cm1, 50), avg(c, 20) - avg(c, 50));
  for (const n of [20, 55]) {
    const prior = rows.slice(-n - 1, -1);
    if (last(c) > max(prior.map((r) => r[2]))) add('Buy', 'donchian' + n);
    if (last(c) < min(prior.map((r) => r[3]))) add('Sell', 'donchian' + n);
  }
  const [oldlo, oldhi, width] = bands(cm1); const [lo, hi] = bands(c);
  if (last(c, 2) < oldlo && last(c) > lo) add('Buy', 'bollinger_reversion');
  if (last(c, 2) > oldhi && last(c) < hi) add('Sell', 'bollinger_reversion');
  const widths = []; for (let j = c.length - 19; j < c.length; j++) widths.push(bands(c.slice(0, j))[2]);
  const sorted = [...widths].sort((x, y) => x - y);
  if (width <= sorted[Math.max(0, Math.floor(widths.length / 4))]) {
    if (last(c) > hi) add('Buy', 'bollinger_squeeze');
    if (last(c) < lo) add('Sell', 'bollinger_squeeze');
  }
  for (const [name, old, now, low, high] of [
    ['rsi_reversal', rsi(cm1), rsi(c), 30, 70],
    ['stochastic_reversal', oscillator(rm1, 'k'), oscillator(rows, 'k'), 20, 80],
    ['cci_reversal', oscillator(rm1, 'cci'), oscillator(rows, 'cci'), -100, 100],
    ['williams_reversal', oscillator(rm1, 'williams'), oscillator(rows, 'williams'), -80, -20],
    ['mfi_reversal', mfi(rm1), mfi(rows), 20, 80]]) {
    if (old < low && low <= now) add('Buy', name);
    if (old > high && high >= now) add('Sell', name);
  }
  const e12 = seriesEma(c, 12), e26 = seriesEma(c, 26);
  const macd = e12.map((x, i) => x - e26[i]); const ms = seriesEma(macd, 9);
  cross('macd_cross', last(macd, 2) - last(ms, 2), last(macd) - last(ms));
  const dx = [];
  for (let end = rows.length - 13; end <= rows.length; end++) {
    let plus = 0, minus = 0, tr = 0;
    const xs = rows.slice(end - 15, end - 1), ys = rows.slice(end - 14, end);
    for (let k = 0; k < Math.min(xs.length, ys.length); k++) {
      const x = xs[k], y = ys[k]; const u = y[2] - x[2], d = x[3] - y[3];
      plus += u > d ? Math.max(u, 0) : 0; minus += d > u ? Math.max(d, 0) : 0;
      tr += Math.max(y[2] - y[3], Math.abs(y[2] - x[4]), Math.abs(y[3] - x[4]));
    }
    dx.push(plus + minus ? 100 * Math.abs(plus - minus) / (plus + minus) : 0);
  }
  if (pySum(dx) / dx.length > 25) {
    if (last(c, 2) <= last(f, 2) && last(f, 2) < last(c) && last(f) > last(s)) add('Buy', 'adx_trend');
    if (last(c, 2) >= last(f, 2) && last(f, 2) > last(c) && last(f) < last(s)) add('Sell', 'adx_trend');
  }
  cross('supertrend', supertrendSide(rm1), supertrendSide(rows));
  const midpoint = (end, n) => { const part = rows.slice(end - n, end); return (max(part.map((r) => r[2])) + min(part.map((r) => r[3]))) / 2; };
  const cloud = (end) => [(midpoint(end, 9) + midpoint(end, 26)) / 2, midpoint(end, 52)];
  const oldCloud = cloud(rows.length - 27); const currentCloud = cloud(rows.length - 26);
  if (last(c, 2) <= max(oldCloud) && last(c) > max(currentCloud)) add('Buy', 'ichimoku');
  if (last(c, 2) >= min(oldCloud) && last(c) < min(currentCloud)) add('Sell', 'ichimoku');
  const vwap = (part) => { const total = pySum(part.map((r) => r[5])); return total ? pySum(part.map((r) => (r[2] + r[3] + r[4]) / 3 * r[5])) / total : last(part)[4]; };
  cross('vwap_reclaim', last(c, 2) - vwap(rows.slice(-21, -1)), last(c) - vwap(rows.slice(-20)));
  if (last(c, 2) <= last(f, 2) + 2 * atr(rm1) && last(c) > last(f) + 2 * a) add('Buy', 'keltner');
  if (last(c, 2) >= last(f, 2) - 2 * atr(rm1) && last(c) < last(f) - 2 * a) add('Sell', 'keltner');
  cross('roc_momentum', last(c, 2) / last(c, 14) - 1, last(c) / last(c, 13) - 1);
  const obv = [0];
  for (let i = 1; i < rows.length; i++) { const x = rows[i - 1], y = rows[i]; obv.push(last(obv) + y[5] * (y[4] > x[4] ? 1 : y[4] < x[4] ? -1 : 0)); }
  if (last(obv) > max(obv.slice(-21, -1)) && last(c) > last(c, 2)) add('Buy', 'obv_breakout');
  if (last(obv) < min(obv.slice(-21, -1)) && last(c) < last(c, 2)) add('Sell', 'obv_breakout');
  const aroon = (part) => { const sub = part.slice(-25); return argmaxFirst(25, (i) => sub[i][2]) - argminFirst(25, (i) => sub[i][3]); };
  cross('aroon_cross', aroon(rm1), aroon(rows));
  cross('psar_flip', psarSide(rm1), psarSide(rows));
  if (last(f) > last(s) && last(s) > last(s, 4) && last(c, 2) <= last(f, 2) && last(c) > last(f)) add('Buy', 'trend_pullback');
  if (last(f) < last(s) && last(s) < last(s, 4) && last(c, 2) >= last(f, 2) && last(c) < last(f)) add('Sell', 'trend_pullback');
  const prev = last(rows, 2), lastRow = last(rows);
  if (prev[4] < prev[1] && lastRow[4] > lastRow[1] && lastRow[1] <= prev[4] && lastRow[4] >= prev[1]) add('Buy', 'engulfing');
  if (prev[4] > prev[1] && lastRow[4] < lastRow[1] && lastRow[1] >= prev[4] && lastRow[4] <= prev[1]) add('Sell', 'engulfing');
  const volume = pySum(rows.slice(-21, -1).map((r) => r[5])) / 20;
  if (lastRow[5] > 1.5 * volume) {
    if (last(c) - last(c, 4) > a && last(f) > last(s)) add('Buy', 'volume_momentum');
    if (last(c, 4) - last(c) > a && last(f) < last(s)) add('Sell', 'volume_momentum');
  }
  return result;
}

const LEGACY_GROUPS = {
  G1: ['ema_cross', 'sma_cross', 'macd_cross'], G2: ['donchian20', 'donchian55', 'keltner'],
  G3: ['bollinger_reversion', 'rsi_reversal', 'stochastic_reversal'], G4: ['adx_trend', 'supertrend', 'ichimoku'],
  G5: ['vwap_reclaim', 'obv_breakout', 'mfi_reversal'], G6: ['roc_momentum', 'volume_momentum', 'aroon_cross', ...PUMP_NAMES],
  G7: ['cci_reversal', 'williams_reversal', 'engulfing'], G8: ['psar_flip', 'trend_pullback', 'bollinger_squeeze'],
};
const LEGACY_STRATEGY_GROUP = {}; for (const [g, list] of Object.entries(LEGACY_GROUPS)) for (const s of list) LEGACY_STRATEGY_GROUP[s] = g;

const MARKET_ASSIGNMENT_VERSION = 'market-groups24-v1-20261103';
const GROUPS = {
  G1: ['sma_cross', 'trend_pullback', 'volume_momentum'], G2: ['ema_cross', 'adx_trend', 'donchian20'],
  G3: ['bollinger_reversion', 'rsi_reversal', 'stochastic_reversal'], G4: ['vwap_reclaim', 'obv_breakout', 'mfi_reversal'],
  G5: ['macd_cross', 'ichimoku', 'engulfing'], G6: ['donchian55', 'keltner', 'roc_momentum', ...PUMP_NAMES],
  G7: ['supertrend', 'psar_flip', 'bollinger_squeeze'], G8: ['cci_reversal', 'williams_reversal', 'aroon_cross'],
};
const GROUP_MARKETS = { G1: 'spot', G2: 'linear', G3: 'linear', G4: 'margin', G5: 'spot', G6: 'linear', G7: 'linear', G8: 'margin' };
const GROUP_TITLES = { G1: 'Спот · тренд', G2: 'USDT-фьючерсы · тренд и пробой', G3: 'Деривативы USDT · возврат', G4: 'Маржа · объём', G5: 'Спот · сигналы', G6: 'USDT-фьючерсы · импульс', G7: 'Деривативы USDT · переключение', G8: 'Маржа · разворот' };
const GROUP_MARKET_LABELS = {};
for (const [g, m] of Object.entries(GROUP_MARKETS)) GROUP_MARKET_LABELS[g] = ['G3', 'G7'].includes(g) ? 'Деривативы · USDT-фьючерсы' : { spot: 'Спот', linear: 'USDT-фьючерсы', margin: 'Маржа' }[m];
const STRATEGY_GROUP = {}; for (const [g, list] of Object.entries(GROUPS)) for (const s of list) STRATEGY_GROUP[s] = g;
const STRATEGY_MARKETS = {}; const STRATEGY_VIEWS = {};
for (const [s, g] of Object.entries(STRATEGY_GROUP)) { STRATEGY_MARKETS[s] = GROUP_MARKETS[g]; STRATEGY_VIEWS[s] = ['G3', 'G7'].includes(g) ? 'derivatives' : GROUP_MARKETS[g]; }
if (Object.keys(STRATEGY_GROUP).length !== 28) throw new Error('28 strategy assignments expected');

module.exports = { NAMES, seriesEma, rsi, atr, avg, bands, oscillator, mfi, supertrendSide, psarSide, proposals,
  LEGACY_GROUPS, LEGACY_STRATEGY_GROUP, MARKET_ASSIGNMENT_VERSION, GROUPS, GROUP_MARKETS, GROUP_TITLES, GROUP_MARKET_LABELS,
  STRATEGY_GROUP, STRATEGY_MARKETS, STRATEGY_VIEWS };
