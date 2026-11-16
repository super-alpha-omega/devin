'use strict';
// One durable reduce-only partial per NEW linear position. No blind retries.
const crypto = require('crypto');
const { D, number, roundStep, sumD } = require('./num');
const { Halt, RequestCancelled, ApiRejected } = require('./errors');
const TERMINAL = new Set(['Filled', 'Cancelled', 'Rejected', 'Deactivated', 'PartiallyFilledCanceled']);
const linkId = (prefix) => prefix + crypto.randomBytes(14).toString('hex');

function remaining(rec, plan) {
  const p = rec.partial_take || {};
  return p.state === 'FILLED' ? plan.quantity.minus(number(p.filled_qty ?? '0', 'Partial filled')) : plan.quantity;
}

function lot(plan, item) {
  const q = roundStep(plan.quantity.mul('.50'), plan.qty_step); const left = plan.quantity.minus(q); const raw = item.raw.lotSizeFilter;
  const minimum = number(raw.minOrderQty || '0', 'Minimum qty'); const notional = number(raw.minNotionalValue || '0', 'Minimum notional');
  const small = q.lt(left) ? q : left; const low = [plan.entry, plan.stop, plan.target].reduce((a, b) => (b.lt(a) ? b : a));
  if (small.lte(0) || small.lt(minimum) || small.mul(low).lt(notional)) return null;
  return q;
}

async function manage(owner, rec, item, plan, pos, price) {
  if (!['quality-partial-v2', 'quality-partial-v3'].includes(plan.management_version) || item.category !== 'linear') return false;
  let p = rec.partial_take;
  if (p && p.state === 'PENDING') {
    const order = await owner.findOrder(item, { link: p.id, start: p.created });
    if (order === null) {
      if (owner.clock() - p.created > 120000) {
        // Self-healing: the FOK request never reached Bybit (no order with this link id exists).
        rec.partial_take = { state: 'UNFILLED', resolved_at: owner.clock(), receipt: null, lost: true }; owner.persist();
        owner.log('Частичный выход не найден на бирже — запрос не дошёл; позиция сопровождается с исходными TP/SL ' + item.key);
        return false;
      }
      return true;
    }
    if (order.orderLinkId !== p.id || order.symbol !== item.symbol || (p.order_id && p.order_id !== order.orderId)) throw new Halt('Не совпала идентичность частичного ордера ' + item.key);
    if (!TERMINAL.has(order.orderStatus)) return true;
    if (!('cumExecQty' in order)) throw new Halt('Нет подтверждённого объёма частичного выхода ' + item.key);
    const qty = number(order.cumExecQty || '0', 'Partial qty'); const wanted = number(p.qty, 'Requested qty');
    if (qty.isZero()) {
      if (order.orderStatus === 'Filled') throw new Halt('Некорректный нулевой Filled частичного выхода');
      Object.assign(p, { state: 'UNFILLED', resolved_at: owner.clock(), receipt: order }); owner.persist();
      owner.log('Частичный FOK не исполнен; исходные TP/SL сохранены ' + item.key); return false;
    }
    if (!qty.eq(wanted) || order.side !== (plan.side === 'Buy' ? 'Sell' : 'Buy') || order.symbol !== item.symbol || order.reduceOnly !== true || order.orderType !== 'Limit' || order.orderLinkId !== p.id || (p.order_id && p.order_id !== order.orderId)) throw new Halt('Не совпадает исполнение частичного выхода ' + item.key);
    const executions = await owner.executions(item, order.orderId);
    if (!sumD(executions.map((x) => number(x.execQty, 'Partial fill'))).eq(qty)) return true;
    if (executions.some((x) => x.orderId !== order.orderId)) throw new Halt('Чужое исполнение частичного выхода');
    const limit = number(p.price, 'Partial limit');
    if (executions.some((x) => { const px = number(x.execPrice || '0', 'Partial price'); return px.lte(0) || (plan.side === 'Buy' ? px.lt(limit) : px.gt(limit)); })) throw new Halt('Частичный выход нарушил лимитную цену');
    const [actual] = await owner.position(item);
    if (actual === null) return true;
    if (actual.side !== plan.side || !number(actual.size || '0', 'Remaining qty').eq(plan.quantity.minus(qty))) throw new Halt('Остаток после частичного выхода не совпал ' + item.key);
    Object.assign(p, { state: 'FILLED', filled_qty: qty.toString(), order_id: order.orderId, executions }); owner.last_prices = 0; owner.persist();
    owner.log('Частичный тейк подтверждён ' + item.key + '; остаток сопровождается с TP/SL');
    return true;
  }
  if (p && p.state === 'UNFILLED' && owner.clock() - (p.resolved_at ?? owner.clock()) >= 30000) {
    if ((rec.partial_take_attempts || []).length >= 2) {
      if (!p.retry_exhausted) { p.retry_exhausted = true; owner.persist(); owner.log('Частичный FOK трижды не исполнен; полный TP и безубыток сохраняются ' + item.key); }
      return false;
    }
    (rec.partial_take_attempts = rec.partial_take_attempts || []).push(p); delete rec.partial_take; owner.persist(); p = null;
  }
  if (p || rec.exit_link || rec.exit_requested) return false;
  if (plan.pnl(price).lt(plan.risk_usdt.mul(2))) return false;
  const q = lot(plan, item);
  if (q === null) { rec.partial_take = { state: 'UNAVAILABLE_MINIMUM_LOT' }; owner.persist(); owner.log('Частичный тейк не помещается в минимумы биржи ' + item.key); return false; }
  const link = linkId('ap2-'); const limit = roundStep(price, plan.tick, plan.side === 'Buy');
  rec.partial_take = { id: link, state: 'PENDING', qty: q.toString(), created: owner.clock(), price: limit.toString() }; owner.persist();
  try {
    const result = await owner.api.submit({ category: 'linear', symbol: item.symbol, side: plan.side === 'Buy' ? 'Sell' : 'Buy', orderType: 'Limit', timeInForce: 'FOK', qty: q.toString(), price: limit.toString(), positionIdx: 0, reduceOnly: true, orderLinkId: link });
    rec.partial_take.order_id = result.orderId; owner.persist();
  } catch (exc) {
    if (exc instanceof RequestCancelled) { delete rec.partial_take; owner.persist(); throw exc; }
    if (exc instanceof ApiRejected) { Object.assign(rec.partial_take, { state: 'REJECTED', code: exc.status_code }); owner.persist(); owner.log('Биржа отклонила частичный тейк; полный TP/SL сохранён ' + item.key); }
    else owner.log('Исход частичного тейка неизвестен; повтор запрещён, идёт сверка по orderLinkId ' + item.key);
  }
  return true;
}

module.exports = { remaining, lot, manage, TERMINAL, linkId };
