'use strict';
// Closed-candle quality, never an order or a risk increase.
const { D, Decimal, number } = require('./num');
const { ValueError } = require('./errors');
const { seriesEma, rsi, atr } = require('./strategies');
const { pySum, max } = require('./pymath');
const { minutes } = require('./marketUniverse');

const HIGHER_RANGE = ['60', '120', '240', '360', '720', 'D'];
function higherFrames(entryTf) {
  const frame = minutes(String(entryTf)); const out = HIGHER_RANGE.filter((tf) => minutes(tf) > frame);
  return out.length ? out : ['D'];
}

function assess(rows, higher, side) {
  if (!['Buy', 'Sell'].includes(side) || rows.length < 60) throw new ValueError('Недостаточно закрытых свечей');
  const sign = side === 'Buy' ? 1 : -1; const c = rows.map((x) => Number(x[4])); const fast = seriesEma(c, 12); const slow = seriesEma(c, 26); const scale = atr(rows);
  const prior = rows.slice(-21, -1).map((x) => Number(x[5])); const mean = pySum(prior) / prior.length;
  if (Math.min(mean, scale) <= 0) throw new ValueError('Нет достоверного объёма/ATR');
  const lastVol = Number(rows[rows.length - 1][5]);
  const ratio = lastVol / mean; const record = lastVol > max(prior);
  const gap = sign * (fast[fast.length - 1] - slow[slow.length - 1]) / scale;
  const slope = sign * (fast[fast.length - 1] - fast[fast.length - 6]) / scale; const osc = rsi(c);
  const normal = side === 'Buy' ? (osc >= 40 && osc <= 55) : (osc >= 45 && osc <= 60);
  let aligned = 0; const trends = []; const frames = Array.isArray(higher) ? { D: higher } : higher;
  for (const [tf, bars] of Object.entries(frames)) {
    if (bars.length < 60) throw new ValueError('Недостаточно старшего EMA-тренда ' + tf);
    const values = bars.map((x) => Number(x[4])); const e12 = seriesEma(values, 12); const e26 = seriesEma(values, 26); const unit = atr(bars);
    if (unit <= 0) throw new ValueError('Нет старшего ATR');
    const separation = sign * (e12[e12.length - 1] - e26[e26.length - 1]) / unit; const incline = sign * (e12[e12.length - 1] - e12[e12.length - 4]) / unit;
    if (separation < -0.20 && incline < -0.05) throw new ValueError('Вход против явного старшего EMA-тренда ' + tf);
    const agrees = separation >= 0.20 && incline >= 0.05; aligned += agrees ? 1 : 0; trends.push({ timeframe: tf, aligned: agrees });
  }
  if (!((ratio >= 1.1 || record) && gap >= 0.05 && slope >= 0.02 && osc >= 38 && osc <= 62)) throw new ValueError('Слабый сигнал: объём +10%/максимум20, EMA gap0.05ATR/наклон0.02ATR, RSI38–62');
  if (ratio < 1.25 || gap < 0.12 || slope < 0.06) throw new ValueError('Слабый сигнал: не достигнут минимальный уровень среднего качества');
  const count = Object.keys(frames).length;
  const strong = normal && aligned === count && (ratio >= 1.5 || record) && gap >= 0.3 && slope >= 0.15;
  const desired = strong ? Math.min(7, 4 + Math.trunc(Math.max(0, ratio - 1.5) * 2) + Math.trunc(Math.min(slope, 1) * 2))
    : (ratio >= 1.5 && slope >= 0.15 ? 3 : ratio >= 1.25 ? 2 : 1);
  return { version: 'medium-strong-v1', higher_trend: aligned === count, higher_trends: trends, volume_ratio: ratio, volume_record: record,
    ema_gap_atr: gap, ema_slope_atr: slope, rsi: osc, strong, desired_leverage: desired };
}

function leverage(item, market, quality, rows, strategy, ticker, current) {
  const { stopMultiplier } = require('./portfolioRisk');
  if (market === 'spot') return D(1);
  if (market === 'margin') return Decimal.min(D(7), Decimal.max(D(2), D(quality.desired_leverage)));
  const f = item.raw.leverageFilter || {}; const lo = number(f.minLeverage ?? '1', 'Minimum leverage');
  const hi = Decimal.min(D(7), number(f.maxLeverage ?? '1', 'Maximum leverage'), D(quality.desired_leverage)); const step = number(f.leverageStep ?? '1', 'Leverage step');
  if (step.lte(0)) throw new ValueError('Неверный шаг плеча');
  let value = lo.plus(hi.minus(lo).div(step).toDecimalPlaces(0, Decimal.ROUND_FLOOR).mul(step));
  const price = number(ticker[quality.side === 'Buy' ? 'ask1Price' : 'bid1Price'], 'Quote');
  const distance = D(String(atr(rows))).mul(Decimal.max(D(2), D(String(stopMultiplier(strategy)))));
  while (value.gte(lo) && distance.div(price).gte(D('.75').div(value))) value = value.minus(step);
  if (!(value.gte(1) && value.lte(7)) || value.lt(lo)) throw new ValueError('Плечо не помещается в биржевой лимит/защитный стоп');
  return value;
}

module.exports = { HIGHER_RANGE, higherFrames, assess, leverage };
