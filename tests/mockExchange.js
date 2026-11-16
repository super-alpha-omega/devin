'use strict';
// Scripted in-memory Bybit for offline tests (linear BTCUSDT only) with fault injection.
const { APIError, NetworkError } = require('../src/errors');
class MockExchange {
  constructor() {
    this.time = Date.now(); this.orders = []; this.position = null; this.leverage = '3'; this.faults = []; this.calls = []; this.dropNextOrder = false; this.equity = '1000';
  }
  inject(method, error, times = 1) { this.faults.push({ method, error, times }); }
  async request(name, p = {}) {
    this.calls.push(name);
    const f = this.faults.find((x) => (x.method === name || x.method === '*') && x.times > 0);
    if (f) { f.times--; throw typeof f.error === 'function' ? f.error() : f.error; }
    const ok = (result) => ({ retCode: 0, retMsg: 'OK', result, time: this.time });
    const pos = () => ({ symbol: 'BTCUSDT', side: this.position ? this.position.side : '', size: this.position ? this.position.size : '0', positionIdx: 0, leverage: this.leverage, avgPrice: '100', liqPrice: '0', stopLoss: this.position ? this.position.sl : '', takeProfit: this.position ? this.position.tp : '' });
    switch (name) {
      case 'get_server_time': return ok({});
      case 'get_account_info': return ok({ marginMode: 'REGULAR_MARGIN' });
      case 'get_instruments_info': return ok({ list: p.category === 'linear' ? [{ symbol: 'BTCUSDT', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual',
        priceFilter: { tickSize: '0.01', minPrice: '0.01', maxPrice: '1000000' }, lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001', maxOrderQty: '100', maxMktOrderQty: '100', minNotionalValue: '5' }, leverageFilter: { minLeverage: '1', maxLeverage: '50', leverageStep: '0.01' } }] : p.category === 'spot' ? [{ symbol: 'BTCUSDT', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDT', priceFilter: { tickSize: '0.01' }, lotSizeFilter: { basePrecision: '0.000001', minOrderAmt: '1' } }]
        : [{ symbol: 'BTCUSD', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USD', settleCoin: 'BTC', contractType: 'InversePerpetual', priceFilter: { tickSize: '0.5' }, lotSizeFilter: { qtyStep: '1' } }] });
      case 'get_tickers': return ok({ list: p.category === 'linear' ? [{ symbol: 'BTCUSDT', bid1Price: '100', ask1Price: '100.01', lastPrice: '100', fundingRate: '0.0001' }] : p.category === 'spot' ? [{ symbol: 'BTCUSDT', lastPrice: '100', bid1Price: '100', ask1Price: '100.01' }] : [{ symbol: 'BTCUSD', lastPrice: '100', bid1Price: '100', ask1Price: '100.5' }] });
      case 'get_wallet_balance': return ok({ list: [{ totalEquity: this.equity, totalAvailableBalance: this.equity, totalPerpUPL: '0', coin: [{ coin: 'USDT', walletBalance: this.equity, borrowAmount: '0', spotBorrow: '0' }] }] });
      case 'get_positions': return ok({ list: p.symbol || p.settleCoin === 'USDT' ? [pos()] : [] });
      case 'get_open_orders': return ok({ list: this.orders.filter((o) => o.orderStatus === 'New' && (!p.orderLinkId || o.orderLinkId === p.orderLinkId) && (!p.orderId || o.orderId === p.orderId)) });
      case 'get_order_history': return ok({ list: this.orders.filter((o) => (!p.orderLinkId || o.orderLinkId === p.orderLinkId) && (!p.orderId || o.orderId === p.orderId)) });
      case 'get_fee_rates': return ok({ list: [{ symbol: p.symbol, makerFeeRate: '0.0002', takerFeeRate: '0.00055' }] });
      case 'set_leverage': this.leverage = p.buyLeverage; return ok({});
      case 'set_trading_stop': if (this.position) { this.position.sl = p.stopLoss; this.position.tp = p.takeProfit; } return ok({});
      case 'get_executions': return ok({ list: this.orders.filter((o) => o.orderId === p.orderId).map((o) => ({ execId: 'e' + o.orderId, orderId: o.orderId, execQty: o.cumExecQty, execPrice: o.avgPrice, side: o.side, execFee: '0', feeCurrency: 'USDT' })) });
      case 'get_closed_pnl': return ok({ list: this.closed || [] });
      case 'place_order': {
        if (this.dropNextOrder) { this.dropNextOrder = false; throw new NetworkError('Read timeout', true); }
        const id = 'o' + (this.orders.length + 1);
        const order = { orderId: id, orderLinkId: p.orderLinkId, symbol: p.symbol, side: p.side, orderType: p.orderType, qty: p.qty, cumExecQty: p.qty, avgPrice: p.price || '100', orderStatus: 'Filled', reduceOnly: !!p.reduceOnly, createdTime: String(this.time) };
        this.orders.push(order);
        if (!p.reduceOnly) this.position = { side: p.side, size: p.qty, sl: p.stopLoss, tp: p.takeProfit };
        else { this.position = null; this.closed = [{ orderId: id, closedSize: p.qty, closedPnl: '1.5', updatedTime: String(this.time) }]; }
        return ok({ orderId: id });
      }
      default: throw new APIError(10001, 'unsupported in mock: ' + name);
    }
  }
  close() {}
}
module.exports = { MockExchange };
