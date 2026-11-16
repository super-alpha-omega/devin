'use strict';
// Bybit V5 REST transport (HMAC). Mirrors pybit + the original ClockAlignedHTTP:
// exchange-anchored timestamps, no automatic retries of mutations.
const crypto = require('crypto');
const { APIError, FailedRequestError, NetworkError } = require('./errors');

const ENDPOINTS = {
  get_kline: ['GET', '/v5/market/kline', false],
  get_tickers: ['GET', '/v5/market/tickers', false],
  get_instruments_info: ['GET', '/v5/market/instruments-info', false],
  get_server_time: ['GET', '/v5/market/time', false],
  get_fee_rates: ['GET', '/v5/account/fee-rate', true],
  get_wallet_balance: ['GET', '/v5/account/wallet-balance', true],
  get_positions: ['GET', '/v5/position/list', true],
  get_open_orders: ['GET', '/v5/order/realtime', true],
  get_order_history: ['GET', '/v5/order/history', true],
  get_executions: ['GET', '/v5/execution/list', true],
  get_closed_pnl: ['GET', '/v5/position/closed-pnl', true],
  get_account_info: ['GET', '/v5/account/info', true],
  get_coin_balance: ['GET', '/v5/asset/transfer/query-account-coin-balance', true],
  get_borrow_history: ['GET', '/v5/account/borrow-history', true],
  get_collateral_info: ['GET', '/v5/account/collateral-info', true],
  place_order: ['POST', '/v5/order/create', true],
  cancel_order: ['POST', '/v5/order/cancel', true],
  set_leverage: ['POST', '/v5/position/set-leverage', true],
  set_trading_stop: ['POST', '/v5/position/trading-stop', true],
  get_borrow_quota: ['GET', '/v5/order/spot-borrow-check', true],
  spot_margin_trade_get_status_and_leverage: ['GET', '/v5/spot-margin-trade/state', true],
  spot_margin_trade_set_leverage: ['POST', '/v5/spot-margin-trade/set-leverage', true],
  manual_no_convert_repay: ['POST', '/v5/account/no-convert-repay', true],
  get_internal_transfer_records: ['GET', '/v5/asset/transfer/query-inter-transfer-list', true],
  create_internal_transfer: ['POST', '/v5/asset/transfer/inter-transfer', true],
  get_transferable_amount: ['GET', '/v5/account/withdrawal', true],
};
const RETRY_CODES = new Set([10002, 10006, 30034, 30035, 130035, 130150]);
const STRING_PARAMS = new Set(['qty', 'price', 'triggerPrice', 'takeProfit', 'stopLoss']);

class BybitHTTP {
  constructor({ demo = false, testnet = false, apiKey = '', apiSecret = '', timeout = 12, recvWindow = 5000, fetchImpl = null } = {}) {
    this.endpoint = testnet ? 'https://api-testnet.bybit.com' : demo ? 'https://api-demo.bybit.com' : 'https://api.bybit.com';
    this.apiKey = apiKey; this.apiSecret = apiSecret; this.timeout = timeout; this.recvWindow = recvWindow;
    this.fetch = fetchImpl || globalThis.fetch;
    this.anchor = null; this.lastRetryableCode = null;
  }

  static prepare(method, params) {
    const clean = {};
    for (const [k, v] of Object.entries(params || {})) if (v !== null && v !== undefined) clean[k] = v;
    if (method === 'GET') {
      return Object.keys(clean).sort().map((k) => k + '=' + (typeof clean[k] === 'boolean' ? (clean[k] ? 'True' : 'False') : String(clean[k]))).join('&');
    }
    for (const k of Object.keys(clean)) {
      if (STRING_PARAMS.has(k) && typeof clean[k] !== 'string') clean[k] = String(clean[k]);
      else if (k === 'positionIdx' && typeof clean[k] !== 'number') clean[k] = parseInt(clean[k], 10);
    }
    return JSON.stringify(clean);
  }

  async exchangeTimestamp() {
    const now = performance.now();
    if (!this.anchor || now - this.anchor.local > 30000) {
      const started = performance.now();
      const response = await this.request('get_server_time', {});
      const received = performance.now();
      if (response.retCode !== 0 || received - started > 2000) throw new NetworkError('Cannot obtain timely exchange clock', true);
      const server = response.time;
      if (!Number.isInteger(server) || server <= 0) throw new FailedRequestError('Invalid exchange clock', 409);
      this.anchor = { server, local: received };
    }
    return Math.trunc(this.anchor.server + Math.max(0, performance.now() - this.anchor.local));
  }

  async request(name, params = {}, { timeout } = {}) {
    const spec = ENDPOINTS[name];
    if (!spec) throw new Error('Unknown Bybit method ' + name);
    const [method, path, auth] = spec;
    const payload = BybitHTTP.prepare(method, params);
    const headers = {};
    if (auth) {
      if (!this.apiKey || !this.apiSecret) throw new APIError(10003, 'API key required');
      const ts = await this.exchangeTimestamp();
      const sign = crypto.createHmac('sha256', this.apiSecret).update(String(ts) + this.apiKey + String(this.recvWindow) + payload).digest('hex');
      Object.assign(headers, { 'Content-Type': 'application/json', 'X-BAPI-API-KEY': this.apiKey, 'X-BAPI-SIGN': sign,
        'X-BAPI-SIGN-TYPE': '2', 'X-BAPI-TIMESTAMP': String(ts), 'X-BAPI-RECV-WINDOW': String(this.recvWindow) });
    } else if (method === 'POST') headers['Content-Type'] = 'application/json';
    const url = this.endpoint + path + (method === 'GET' && payload ? '?' + payload : '');
    const limit = (timeout || this.timeout) * 1000;
    let response, text;
    try {
      response = await this.fetch(url, { method, headers, body: method === 'POST' ? payload : undefined, signal: AbortSignal.timeout(limit) });
      text = await response.text();
    } catch (exc) {
      const isTimeout = exc && (exc.name === 'TimeoutError' || exc.name === 'AbortError');
      throw new NetworkError(isTimeout ? 'Read timeout' : 'Connection error', isTimeout);
    }
    if (response.status !== 200) throw new FailedRequestError(response.status === 403 ? 'IP rate limit or region block' : 'HTTP status ' + response.status, response.status);
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new FailedRequestError('Could not decode JSON', 409); }
    const code = data.retCode !== undefined ? data.retCode : data.ret_code;
    if (code) {
      if (RETRY_CODES.has(code)) {
        this.lastRetryableCode = code;
        if (code === 10002) this.anchor = null;
      }
      throw new APIError(code, typeof data.retMsg === 'string' ? data.retMsg.slice(0, 160) : '');
    }
    return data;
  }

  close() {}
}

module.exports = { BybitHTTP, ENDPOINTS };
