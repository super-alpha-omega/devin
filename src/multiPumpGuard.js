'use strict';
// Multi-timeframe pump signal research (1m → D1). Closed candles only. Long-only.
const { D } = require('./num');
const { ValueError } = require('./errors');
const { PUMP_NAMES, medianD } = require('./pumpGuard');

const SUPPORTED_TF = ['1', '15', '30', '60', '120', '240', '360', '720', 'D'];
const mins = (tf) => (tf === 'D' ? 1440 : parseInt(tf, 10));

function scanClosed(rows, tf = '1', { maxSpreadPct = null, spreadPct = null } = {}) {
  if (!SUPPORTED_TF.includes(tf)) return [];
  if (rows.length < 40 || spreadPct === null || spreadPct === undefined) return [];
  let maxSpread;
  if (maxSpreadPct === null) maxSpread = mins(tf) <= 15 ? D('0.20') : mins(tf) <= 60 ? D('0.25') : D('0.35');
  else maxSpread = D(String(maxSpreadPct));
  if (D(String(spreadPct)).gt(maxSpread)) return [];
  const histLen = mins(tf) <= 60 ? 30 : 40; const need = histLen + 5;
  if (rows.length < need) return [];
  const recent = rows[rows.length - 1]; const history = rows.slice(-(histLen + 1), -1);
  if (rows.slice(-need).some((r) => r.length < 6 || r[4] <= 0 || r[5] < 0 || r[3] <= 0 || r[2] < r[3])) return [];
  const prices = rows.slice(-need).map((r) => D(String(r[4])));
  const volumes = history.map((r) => D(String(r[5])));
  const medVol = medianD(volumes);
  if (medVol.lte(0)) return [];
  const p = (i) => prices[prices.length - i];
  const lastP = p(1), prior = p(2); const volume = D(String(recent[5])); const ratio = volume.div(medVol);
  if (ratio.lt('2.8') || lastP.lte(prior)) return [];
  const lookback = mins(tf) <= 60 ? 4 : 3;
  if (prices.length <= lookback) return [];
  const change = lastP.div(p(lookback)).minus(1).mul(100);
  let minChg, maxChg;
  if (mins(tf) <= 15) [minChg, maxChg] = [D('0.80'), D('15')];
  else if (mins(tf) <= 60) [minChg, maxChg] = [D('1.20'), D('18')];
  else if (mins(tf) <= 240) [minChg, maxChg] = [D('2.00'), D('25')];
  else [minChg, maxChg] = [D('3.00'), D('40')];
  if (change.gt(maxChg) || change.lt(minChg)) return [];
  const high = history.map((r) => D(String(r[2]))).reduce((a, b) => (b.gt(a) ? b : a));
  const lowRecent = D(String(recent[3])); const highRecent = D(String(recent[2])); const rng = highRecent.minus(lowRecent);
  const typical = medianD(history.map((r) => D(String(r[2])).minus(D(String(r[3])))));
  if (typical.lte(0)) return [];
  const result = [];
  if (lastP.gt(high) && ratio.gte('3.2')) result.push(PUMP_NAMES[0]);
  const prev2 = p(3);
  if (prior.gt(prev2) && lastP.gt(prior) && lastP.div(prior).gt(prior.div(prev2).mul('1.12')) && ratio.gte('4.5')) result.push(PUMP_NAMES[1]);
  if (rng.gte(typical.mul(3)) && lastP.gt(lowRecent.plus(rng.mul('0.80'))) && ratio.gte('3.5')) result.push(PUMP_NAMES[2]);
  if (prices.length >= 5 && [1, 2, 3, 4].every((i) => p(i).gt(p(i + 1))) && ratio.gte('3.2')) result.push(PUMP_NAMES[3]);
  return result;
}

function protectedTrailingStop(side, entry, best, previousStop, { activationPct = '2.0', gapPct = '1.0' } = {}) {
  return require('./pumpGuard').protectedTrailingStop(side, entry, best, previousStop, { activationPct, gapPct });
}

module.exports = { PUMP_NAMES, SUPPORTED_TF, scanClosed, protectedTrailingStop, ValueError };
