'use strict';
// Free local supervised ML: two logistic models estimate P(TP before SL within HORIZON bars).
const fs = require('fs');
const crypto = require('crypto');
const { ValueError, RequestCancelled } = require('./errors');
const { pySum } = require('./pymath');
const { PyRandom } = require('./pyrandom');
const { saveJson } = require('./appSupport');

const MODEL_VERSION = 3; const HORIZON = 32; const TARGETS = [3.0, 3.5, 4.0, 5.0, 6.0];
const MIN_TRAIN = 250; const MIN_VALIDATION = 120; const FEATURE_COUNT = 12;
const pyStrFloat = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

const sigmoid = (v) => 1 / (1 + Math.exp(-Math.max(-35.0, Math.min(35.0, v))));
const clip = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const yieldLoop = () => new Promise((r) => setImmediate(r));

function parseCandles(rows, serverMs, interval) {
  const step = (String(interval) === 'W' ? 10080 : String(interval) === 'D' ? 1440 : parseInt(interval, 10)) * 60000;
  const parsed = [];
  for (const row of rows) {
    const timestamp = parseInt(row[0], 10);
    if (timestamp + step > serverMs) continue;
    const [o, h, l, c, v] = row.slice(1, 6).map(Number);
    if (![o, h, l, c, v].every(Number.isFinite) || Math.min(o, h, l, c) <= 0 || v < 0) throw new ValueError('Некорректная история OHLCV');
    if (!(l <= Math.min(o, c) && Math.min(o, c) <= Math.max(o, c) && Math.max(o, c) <= h)) throw new ValueError('Некорректные high/low в истории');
    parsed.push([timestamp, o, h, l, c, v]);
  }
  parsed.sort((a, b) => a[0] - b[0]);
  if (new Set(parsed.map((r) => r[0])).size !== parsed.length) throw new ValueError('Повторяющиеся свечи');
  for (let i = 1; i < parsed.length; i++) if (parsed[i][0] - parsed[i - 1][0] !== step) throw new ValueError('История свечей содержит пропуски');
  return parsed;
}

function featureHistory(candles) {
  const result = []; let fast = candles[0][4], slow = candles[0][4];
  candles.forEach((row, i) => {
    const [, o, h, l, c, v] = row;
    fast += 2 / 21 * (c - fast); slow += 2 / 51 * (c - slow);
    if (i < 60) { result.push(null); return; }
    const ret = (n) => clip((c / candles[i - n][4] - 1) * 20);
    const changes = []; for (let j = i - 13; j <= i; j++) changes.push(candles[j][4] - candles[j - 1][4]);
    const gains = pySum(changes.map((x) => Math.max(x, 0))); const losses = -pySum(changes.map((x) => Math.min(x, 0)));
    const rsi = gains + losses === 0 ? 0 : (gains - losses) / (gains + losses);
    const ranges = []; for (let j = i - 13; j <= i; j++) ranges.push(Math.max(candles[j][2] - candles[j][3], Math.abs(candles[j][2] - candles[j - 1][4]), Math.abs(candles[j][3] - candles[j - 1][4])));
    const vols = []; for (let j = i - 19; j <= i; j++) vols.push(candles[j][5]);
    const avgvolume = pySum(vols) / 20;
    const volume = clip(Math.log((v + 1e-12) / (avgvolume + 1e-12)) / 3);
    result.push([ret(1), ret(3), ret(6), ret(12), clip((fast / slow - 1) * 20), rsi, clip(pySum(ranges) / 14 / c * 20, 0, 1), volume,
      h === l ? 0 : (c - o) / (h - l), clip((c / slow - 1) * 20)]);
  });
  return result;
}

const targetFeatures = (base, stopFraction, targetFraction) => base.concat([clip(stopFraction * 10, 0, 1), clip(targetFraction * 5, 0, 1)]);

function barrierPrices(entry, side, stopFraction, cost, funding, rr) {
  const sign = side === 'Buy' ? 1 : -1; const stop = entry * (1 - sign * stopFraction);
  const loss = sign * (entry - stop) + cost * (entry + stop) + entry * funding;
  const target = (rr * loss + entry * (sign + cost + funding)) / (sign - cost);
  return target <= 0 ? null : [stop, target];
}

function barrierLabel(candles, index, side, stop, target) {
  for (const row of candles.slice(index + 1, index + 1 + HORIZON)) {
    const stopHit = side === 'Buy' ? row[3] <= stop : row[2] >= stop;
    const targetHit = side === 'Buy' ? row[2] >= target : row[3] <= target;
    if (stopHit) return 0; if (targetHit) return 1;
  }
  return 0;
}

async function fitLogistic(samples, cancelled = () => false, epochs = 32) {
  if (!samples.length || samples[0][0].length !== FEATURE_COUNT) throw new ValueError('Нет признаков для обучения');
  const positive = samples.reduce((a, s) => a + s[1], 0);
  if (positive < 30 || samples.length - positive < 30) return null;
  const weights = new Array(FEATURE_COUNT).fill(0.0); const base = (positive + 1) / (samples.length + 2);
  let bias = Math.log(base / (1 - base)); const order = samples.map((_, i) => i); const rng = new PyRandom(2741);
  for (let epoch = 0; epoch < epochs; epoch++) {
    if (cancelled()) throw new RequestCancelled('Обучение остановлено пользователем');
    rng.shuffle(order); const rate = 0.045 / (1 + epoch * 0.15);
    for (const idx of order) {
      const [features, label] = samples[idx];
      const p = sigmoid(bias + pySum(weights.map((w, k) => w * features[k])));
      const delta = p - label; bias -= rate * delta;
      for (let k = 0; k < features.length; k++) weights[k] -= rate * (delta * features[k] + 0.002 * weights[k]);
    }
    await yieldLoop();
  }
  return { weights, bias };
}

const probability = (model, features) => sigmoid(model.bias + pySum(model.weights.map((w, k) => w * features[k])));

function wilsonLower(wins, count) {
  if (!count) return 0; const z = 1.96; const p = wins / count;
  return (p + z * z / (2 * count) - z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count))) / (1 + z * z / count);
}

class Brain {
  constructor(cachePath, configSignature, stopPercent, cost, funding, emit, cancelled = () => false, atrMultiple = null) {
    this.path = cachePath;
    this.signature = crypto.createHash('sha256').update(String(MODEL_VERSION) + configSignature + String(cost) + String(funding) + String(atrMultiple)).digest('hex');
    this.stopFraction = Number(stopPercent) / 100; this.atrMultiple = atrMultiple; this.cost = Number(cost); this.funding = Number(funding);
    this.emit = emit; this.cancelled = cancelled; this.data = null;
    try {
      const candidate = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (candidate && candidate.signature === this.signature && Brain.validCache(candidate)) this.data = candidate;
    } catch (e) { /* retrain */ }
  }
  static validCache(data) {
    if (!data || !Number.isInteger(data.end_ms)) return false;
    const { models, validation } = data;
    if (!models || typeof models !== 'object' || Object.keys(models).sort().join() !== 'Buy,Sell' || !validation || typeof validation !== 'object') return false;
    for (const [side, model] of Object.entries(models)) {
      if (model !== null) {
        if (!Array.isArray(model.weights) || model.weights.length !== FEATURE_COUNT) return false;
        if (![...model.weights, model.bias].every((x) => typeof x === 'number' && Number.isFinite(x))) return false;
      }
      const metrics = validation[side]; if (!metrics || typeof metrics !== 'object') return false;
      for (const [key, stat] of Object.entries(metrics)) {
        if (!TARGETS.map(pyStrFloat).includes(key) || !stat || typeof stat !== 'object') return false;
        if (typeof stat.eligible !== 'boolean' || typeof stat.threshold !== 'number' || !(stat.threshold >= 0 && stat.threshold <= 1)) return false;
      }
    }
    return true;
  }
  needsTraining(endMs, interval) { return !this.data || endMs - this.data.end_ms >= (String(interval) === 'D' ? 1440 : parseInt(interval, 10)) * 60000 * 8; }
  async train(candles) {
    const { atr } = require('./strategies');
    if (candles.length < 1000) throw new ValueError('ИИ нужно не менее 1000 закрытых свечей; новых входов не будет');
    this.emit('log', `ИИ: обучение на ${candles.length} закрытых свечах. Проверка на более поздней части истории.`);
    const features = featureHistory(candles); const split = Math.trunc(candles.length * 0.65);
    const trainEnd = split - HORIZON; const valStart = split; const valEnd = candles.length - HORIZON;
    const trainCount = Math.max(0, trainEnd - 60), valCount = Math.max(0, valEnd - valStart);
    if (trainCount < MIN_TRAIN || valCount < MIN_VALIDATION) throw new ValueError('Недостаточно данных для раздельного обучения и проверки');
    const indices = []; for (let i = 60; i < trainEnd; i++) indices.push(i); for (let i = valStart; i < valEnd; i++) indices.push(i);
    const models = {}, validation = {};
    for (const side of ['Buy', 'Sell']) {
      const training = []; const checks = {}; for (const rr of TARGETS) checks[pyStrFloat(rr)] = [];
      let n = 0;
      for (const i of indices) {
        if (this.cancelled()) throw new RequestCancelled('Обучение остановлено');
        if (++n % 500 === 0) await yieldLoop();
        const entry = candles[i][4]; let fraction = this.stopFraction;
        if (this.atrMultiple !== null) fraction = atr(candles.slice(Math.max(0, i - 15), i + 1)) * Number(this.atrMultiple) / entry;
        for (const rr of TARGETS) {
          const prices = barrierPrices(entry, side, fraction, this.cost, this.funding, rr); if (prices === null) continue;
          const [stop, target] = prices; const x = targetFeatures(features[i], fraction, Math.abs(target / entry - 1)); const y = barrierLabel(candles, i, side, stop, target);
          if (i < split - HORIZON) training.push([x, y]); else checks[pyStrFloat(rr)].push([i, x, y]);
        }
      }
      const model = await fitLogistic(training, this.cancelled); models[side] = model; const metrics = {};
      if (model) {
        for (const [rr, samples] of Object.entries(checks)) {
          let best = null;
          for (const threshold of [0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]) {
            const selected = []; let lastIndex = -HORIZON;
            for (const [i, x, y] of samples) if (i - lastIndex >= HORIZON && probability(model, x) >= threshold) { selected.push(y); lastIndex = i; }
            const cnt = selected.length; const wins = selected.reduce((a, b) => a + b, 0); const lower = wilsonLower(wins, cnt);
            const breakeven = 1 / (1 + Number(rr)); const valid = cnt >= 15 && lower > breakeven + 0.02;
            const candidate = { threshold, samples: cnt, wins, lower95: lower, eligible: valid, hit_rate: cnt ? wins / cnt : 0, target_r: Number(rr) };
            const better = best === null || (valid !== best.eligible ? valid : cnt !== best.samples ? cnt > best.samples : lower > best.lower95);
            if (better) best = candidate;
          }
          metrics[rr] = best;
        }
      }
      validation[side] = metrics;
      const eligible = Object.values(metrics).filter((m) => m.eligible).length;
      this.emit('log', `ИИ ${side}: ${training.length} обучающих примеров; целей с пройденным фильтром: ${eligible}/${TARGETS.length}.`);
    }
    const data = { version: MODEL_VERSION, signature: this.signature, end_ms: candles[candles.length - 1][0], models, validation,
      train_bars: trainCount, validation_bars: valCount, horizon: HORIZON };
    saveJson(this.path, data); this.data = data;
    this.emit('log', 'ИИ: модель сохранена. Если проверка не выявила преимущества, решение — ЖДАТЬ.');
  }
  choose(candles, candidates) {
    if (!this.data || candles.length < 100) return null;
    const base = featureHistory(candles).at(-1); const ranked = [];
    for (const plan of candidates) {
      const model = this.data.models[plan.side]; if (!model) continue;
      const actualRr = plan.profit.div(plan.loss).toNumber();
      if (actualRr < TARGETS[0] - 0.001 || actualRr > TARGETS.at(-1) + 0.001) continue;
      const closest = TARGETS.reduce((a, b) => (Math.abs(b - actualRr) < Math.abs(a - actualRr) ? b : a));
      if (Math.abs(closest - actualRr) > 0.15) continue;
      const stats = (this.data.validation[plan.side] || {})[pyStrFloat(closest)];
      if (!stats || !stats.eligible) continue;
      const stopFraction = Math.abs(plan.stop_loss.div(plan.entry).toNumber() - 1); const targetFraction = Math.abs(plan.take_profit.div(plan.entry).toNumber() - 1);
      const p = probability(model, targetFeatures(base, stopFraction, targetFraction));
      const threshold = Math.max(1 / (1 + actualRr) + 0.02, stats.threshold);
      if (p < threshold) continue;
      const expected = p * plan.profit.toNumber() - (1 - p) * plan.loss.toNumber();
      if (expected > 0) ranked.push([expected, p, plan]);
    }
    if (!ranked.length) return null;
    const best = ranked.reduce((a, b) => (b[0] > a[0] ? b : a));
    return [best[2], best[1]];
  }
  shouldTakeProfit(candles, side) {
    const { atr } = require('./strategies');
    if (!this.data || candles.length < 100) return false;
    const model = this.data.models[side]; if (!model) return false;
    const entry = candles.at(-1)[4]; let fraction = this.stopFraction;
    if (this.atrMultiple !== null) fraction = atr(candles) * Number(this.atrMultiple) / entry;
    const prices = barrierPrices(entry, side, fraction, this.cost, this.funding, 3.0); if (prices === null) return false;
    const base = featureHistory(candles).at(-1);
    return probability(model, targetFeatures(base, fraction, Math.abs(prices[1] / entry - 1))) < 0.40;
  }
}

module.exports = { Brain, parseCandles, featureHistory, fitLogistic, barrierPrices, barrierLabel, probability, wilsonLower, HORIZON, TARGETS };
