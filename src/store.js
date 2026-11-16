'use strict';
// Crash-safe journal: atomic JSON state + append-only results, both self-repairing.
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./appSupport');
const { GROUPS } = require('./strategies');

function emptyState() {
  const groups = {};
  for (const g of Object.keys(GROUPS)) groups[g] = { batch: [], reference: null, number: 1, halt: '' };
  return { version: 3, positions: {}, groups, total_net: '0', halt: '', day: null, day_equity: null, day_net: '0', identity: null, resume_armed: false };
}

class PortfolioStore {
  constructor(dir, mode, log = () => {}) {
    this.dir = dir; this.mode = mode; this.log = log;
    fs.mkdirSync(dir, { recursive: true });
    this.statePath = path.join(dir, `portfolio_${mode}.json`);
    this.resultsPath = path.join(dir, `results_${mode}.jsonl`);
    this.candlesPath = path.join(dir, `candles_${mode}.json`);
    this.lastBody = null; this.write_count = 0; this.skipped_writes = 0; this.lastBackup = 0;
    this.results = []; this.resultIds = new Set();
    this.loadResults();
    this.candles = new Map();
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.candlesPath, 'utf8')))) this.candles.set(k, v); } catch (e) { /* rebuilt */ }
    this.candlesDirty = false; this.candleTimer = null;
  }
  loadResults() {
    let text = '';
    try { text = fs.readFileSync(this.resultsPath, 'utf8'); } catch (e) { return; }
    let damaged = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && r.id && !this.resultIds.has(r.id)) { this.results.push(r); this.resultIds.add(r.id); } } catch (e) { damaged++; }
    }
    if (damaged) {
      this.log(`Журнал результатов: пропущено повреждённых строк ${damaged}; файл восстановлен.`);
      writeAtomic(this.resultsPath, this.results.map((r) => JSON.stringify(r)).join('\n') + (this.results.length ? '\n' : ''));
    }
  }
  load() {
    for (const candidate of [this.statePath, this.statePath + '.bak']) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const state = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (state && typeof state === 'object' && state.positions && state.groups) {
          if (candidate !== this.statePath) this.log('Основной журнал повреждён; восстановлен из резервной копии.');
          for (const g of Object.keys(GROUPS)) if (!state.groups[g]) state.groups[g] = { batch: [], reference: null, number: 1, halt: '' };
          return state;
        }
      } catch (e) {
        try { fs.copyFileSync(candidate, candidate + '.corrupt-' + Date.now()); } catch (x) { /* ignore */ }
      }
    }
    return emptyState();
  }
  save(state, closed = null) {
    const body = JSON.stringify(state);
    if (!closed && body === this.lastBody) { this.skipped_writes++; return; }
    if (closed && !this.resultIds.has(closed.id)) {
      const fd = fs.openSync(this.resultsPath, 'a');
      try { fs.writeSync(fd, JSON.stringify(closed) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.results.push(closed); this.resultIds.add(closed.id);
    }
    if (body !== this.lastBody) {
      if (Date.now() - this.lastBackup > 30000 && fs.existsSync(this.statePath)) {
        try { fs.copyFileSync(this.statePath, this.statePath + '.bak'); this.lastBackup = Date.now(); } catch (e) { /* ignore */ }
      }
      writeAtomic(this.statePath, body);
    }
    this.lastBody = body; this.write_count++;
  }
  countResults() { return this.results.length; }
  checkpoint(key) { const v = this.candles.get(key); return v === undefined ? null : v; }
  consume(key, bar) {
    const old = this.candles.get(key);
    if (old !== undefined && old >= bar) return false;
    this.candles.set(key, bar); this.candlesDirty = true;
    if (!this.candleTimer) this.candleTimer = setTimeout(() => { this.candleTimer = null; this.flushCandles(); }, 5000);
    return true;
  }
  flushCandles() {
    if (!this.candlesDirty) return;
    try { writeAtomic(this.candlesPath, JSON.stringify(Object.fromEntries(this.candles))); this.candlesDirty = false; } catch (e) { /* retried later */ }
  }
  close() { if (this.candleTimer) clearTimeout(this.candleTimer); this.candleTimer = null; this.flushCandles(); }
}

function readJournal(dir, mode) {
  let state = null; const results = [];
  for (const candidate of [path.join(dir, `portfolio_${mode}.json`), path.join(dir, `portfolio_${mode}.json.bak`)]) {
    try { state = JSON.parse(fs.readFileSync(candidate, 'utf8')); break; } catch (e) { /* next */ }
  }
  try {
    const seen = new Set();
    for (const line of fs.readFileSync(path.join(dir, `results_${mode}.jsonl`), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (!seen.has(r.id)) { seen.add(r.id); results.push(r); } } catch (e) { /* skip */ }
    }
  } catch (e) { /* none */ }
  return { state, results };
}

module.exports = { PortfolioStore, emptyState, readJournal };
