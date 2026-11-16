'use strict';
// Isolated 1-minute pump signal research and monotone protective-stop calculations.
const { Decimal, D } = require('./num');
const { ValueError } = require('./errors');

const PUMP_NAMES = ['pump_volume_breakout', 'pump_acceleration', 'pump_range_expansion', 'pump_trend_continuation'];

function medianD(values) {
  const s = [...values].sort((a, b) => a.cmp(b)); const n = s.length; if (!n) throw new ValueError('no median for empty data');
  const i = Math.floor(n / 2); return n % 2 ? s[i] : s[i - 1].plus(s[i]).div(2);
}
function medianF(values) {
  const s = [...values].sort((a, b) => a - b); const n = s.length; const i = Math.floor(n / 2);
  return n % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}

function scanClosed1m(rows, { maxSpreadPct = D('0.20'), spreadPct = null } = {}) {
  if (rows.length < 35 || spreadPct === null || spreadPct === undefined || D(String(spreadPct)).gt(maxSpreadPct)) return [];
  const recent = rows[rows.length - 1]; const history = rows.slice(-31, -1);
  if (rows.slice(-35).some((r) => r.length < 6 || r[4] <= 0 || r[5] < 0 || r[3] <= 0 || r[2] < r[3])) return [];
  const prices = rows.slice(-35).map((r) => D(String(r[4])));
  const volumes = history.map((r) => D(String(r[5])));
  if (medianD(volumes).lte(0)) return [];
  const last = prices[prices.length - 1]; const prior = prices[prices.length - 2];
  const volume = D(String(recent[5])); const ratio = volume.div(D(medianD(volumes).toString()));
  if (ratio.lt('2.5') || last.lte(prior)) return [];
  const change = last.div(prices[prices.length - 4]).minus(1).mul(100);
  if (change.gt(12) || change.lt('0.35')) return [];
  const high = history.map((r) => D(String(r[2]))).reduce((a, b) => (b.gt(a) ? b : a));
  const rng = D(String(recent[2])).minus(D(String(recent[3])));
  const typical = D(String(medianF(history.map((r) => D(String(r[2])).minus(D(String(r[3]))).toNumber()))));
  if (typical.lte(0)) return [];
  const p = (i) => prices[prices.length - i];
  const result = [];
  if (last.gt(high) && ratio.gte(3)) result.push(PUMP_NAMES[0]);
  if (last.div(p(2)).gt(p(2).div(p(3))) && ratio.gte(4)) result.push(PUMP_NAMES[1]);
  if (rng.gte(typical.mul(3)) && last.gt(D(String(recent[3])).plus(rng.mul('.75')))) result.push(PUMP_NAMES[2]);
  if ([1, 2, 3].every((i) => p(i).gt(p(i + 1))) && ratio.gte(3)) result.push(PUMP_NAMES[3]);
  return result;
}

function protectedTrailingStop(side, entry, best, previousStop, { activationPct = '1.2', gapPct = '0.65' } = {}) {
  entry = D(String(entry)); best = D(String(best)); const old = D(String(previousStop));
  const activation = D(String(activationPct)).div(100); const gap = D(String(gapPct)).div(100);
  if (entry.lte(0) || best.lte(0) || old.lte(0) || !(gap.gt(0) && gap.lt(1)) || activation.lte(0)) throw new ValueError('Invalid trailing parameters');
  const mx = (...v) => v.reduce((a, b) => (b.gt(a) ? b : a)); const mn = (...v) => v.reduce((a, b) => (b.lt(a) ? b : a));
  if (side === 'Buy') { if (best.lt(entry.mul(activation.plus(1)))) return old; return mx(old, entry, best.mul(D(1).minus(gap))); }
  if (side === 'Sell') { if (best.gt(entry.mul(D(1).minus(activation)))) return old; return mn(old, entry, best.mul(gap.plus(1))); }
  throw new ValueError('Unknown side');
}

module.exports = { PUMP_NAMES, scanClosed1m, protectedTrailingStop, medianD, medianF, Decimal };
