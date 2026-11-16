'use strict';
// Read-only per-mode/per-market accounting; no order or transfer functions.
const { D, Decimal } = require('./num');
const { NAMES, GROUPS, STRATEGY_GROUP, GROUP_TITLES, GROUP_MARKET_LABELS, STRATEGY_VIEWS } = require('./strategies');
const { readJournal } = require('./store');

const MARKETS = { spot: 'Спот', linear: 'USDT-фьючерсы', derivatives: 'Деривативы · те же USDT-фьючерсы', margin: 'Маржа', inverse: 'Обратные контракты' };
const PHYSICAL = { derivatives: 'linear' };

function buildDashboard(dataDir, mode, configuredMarkets = ['spot', 'linear', 'inverse', 'margin']) {
  const configured = new Set(configuredMarkets); const records = [];
  const failed = (error) => ({ available: false, mode, error, groups: [], strategies: [], markets: [], by_market: {} });
  try {
    const { state, results } = readJournal(dataDir, mode);
    if (state) for (const r of Object.values(state.positions || {})) records.push([r, false]);
    for (const r of results) records.push([r, true]);
  } catch (e) { return failed('Статистика журнала недоступна; значения не подставляются'); }
  function aggregate(selected = null) {
    const metrics = (markets) => ({ open: 0, pending: 0, closed: 0, wins: 0, losses: 0, neutral: 0, net: '0', markets });
    const rows = {}; const groups = {}; let unknown = 0;
    for (const g of Object.keys(GROUPS)) {
      groups[g] = { id: g, name: GROUP_TITLES[g] || g, ...metrics([GROUP_MARKET_LABELS[g]]) };
      for (const s of GROUPS[g]) rows[s] = { id: s, name: NAMES[s], group: STRATEGY_GROUP[s], ...metrics([GROUP_MARKET_LABELS[g]]) };
    }
    for (const [record, closed] of records) {
      const plan = record.plan || {}; const strategy = plan.strategy; const view = STRATEGY_VIEWS[strategy] ?? plan.market;
      if (selected && view !== selected) continue;
      if (!(strategy in rows)) { unknown++; continue; }
      const row = rows[strategy]; const group = groups[row.group];
      for (const target of [row, group]) {
        if (closed) {
          const value = D(String(record.net)); if (!value.isFinite()) throw new Error('Invalid closed result');
          target.closed++; target[value.gt(0) ? 'wins' : value.lt(0) ? 'losses' : 'neutral']++; target.net = D(target.net).plus(value).toString();
        } else target[record.phase === 'open' ? 'open' : 'pending']++;
      }
    }
    let r = rows, gs = groups;
    if (selected) {
      r = Object.fromEntries(Object.entries(rows).filter(([k]) => STRATEGY_VIEWS[k] === selected));
      const gids = new Set(Object.values(r).map((v) => v.group)); gs = Object.fromEntries(Object.entries(groups).filter(([k]) => gids.has(k)));
    }
    return { groups: Object.values(gs), strategies: Object.values(r), unknown_records: unknown };
  }
  let all, buckets;
  try { all = aggregate(); buckets = {}; for (const k of Object.keys(MARKETS)) buckets[k] = aggregate(k); } catch (e) { return failed('Неподтверждённые данные журнала'); }
  const overview = [];
  for (const [k, name] of Object.entries(MARKETS)) {
    if (k === 'inverse') continue;
    const supported = configured.has(PHYSICAL[k] || k);
    const count = Object.keys(NAMES).filter((s) => STRATEGY_VIEWS[s] === k).length;
    const groups = buckets[k].groups;
    overview.push({ id: k, name, strategy_count: count, supported, enabled: supported && count > 0, status: supported && count ? 'Назначено стратегий: ' + count : 'Не используется этим составом',
      open: groups.reduce((a, r) => a + r.open, 0), closed: groups.reduce((a, r) => a + r.closed, 0), wins: groups.reduce((a, r) => a + r.wins, 0),
      losses: groups.reduce((a, r) => a + r.losses, 0), net: groups.reduce((a, r) => a.plus(D(r.net)), D(0)).toString() });
  }
  return { available: true, mode, source: 'own_journal_only', markets: overview, by_market: buckets, ...all };
}

function fundingStatus(dataDir, mode, enabled = false, supported = false, workerActive = false) {
  let ledger = {};
  try { const { state } = readJournal(dataDir, mode); ledger = (state && state.distribution) || {}; } catch (e) { /* none */ }
  const realEnabled = supported && enabled === true && mode === 'REAL';
  return { supported, enabled: realEnabled, percent: 70, destination: 'Funding',
    state: !supported ? 'НЕ ПОДДЕРЖИВАЕТСЯ' : mode !== 'REAL' ? 'ВЫКЛЮЧЕН В DEMO' : realEnabled ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН',
    active: realEnabled && workerActive, pending: !!ledger.pending, reserved: ledger.reserved || '0', paid: ledger.paid || '0',
    note: supported ? 'Только подтверждённая положительная чистая прибыль; без использования Funding для торговли.' : 'В этой сборке автоматических переводов нет.' };
}

module.exports = { buildDashboard, fundingStatus, MARKETS, Decimal };
