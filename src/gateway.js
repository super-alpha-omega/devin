'use strict';
const { APIError, ApiRejected, RequestCancelled, safeError, isTemporary, READS } = require('./errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFINITIVE_REJECTIONS = new Set([10001, 10003, 10004, 10005, 10010, 110003, 110004, 110007, 110017, 110020, 110032, 110051,
  110057, 110058, 110123, 110125, 110126]);

class Gateway {
  constructor(session) { this.session = session; this.server_ms = null; }
  async raw(method, kwargs = {}, options = {}) {
    let response;
    try { response = await this.session.request(method, kwargs, options); } catch (exc) {
      exc.api_method = method;
      if (Number.isInteger(this.session.lastRetryableCode)) exc.retry_cause = this.session.lastRetryableCode;
      this.session.lastRetryableCode = null;
      throw exc;
    }
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('API returned malformed response');
    if (response.retCode !== 0) throw new APIError(response.retCode);
    if (response.time) this.server_ms = parseInt(response.time, 10);
    return response;
  }
  async call(method, kwargs = {}) {
    try { return (await this.raw(method, kwargs)).result || {}; } catch (exc) {
      if (method === 'set_trading_stop' && exc.status_code === 34040) return {};
      throw exc;
    }
  }
  async submit(kwargs) {
    try { return await this.call('place_order', kwargs); } catch (exc) {
      if (DEFINITIVE_REJECTIONS.has(exc.status_code)) throw new ApiRejected(safeError(exc), exc.status_code);
      throw exc;
    }
  }
}

// Serialised, rate-limited (8 req/s) gateway; only whitelisted READS are retried.
class RateLimitedGateway extends Gateway {
  constructor(session, cancelled = () => false, { interval = 125, retries = 3 } = {}) {
    super(session); this.cancelled = cancelled; this.last = 0; this.chain = Promise.resolve(); this.interval = interval; this.retries = retries;
  }
  async wait(until) {
    while (performance.now() < until) {
      if (this.cancelled()) throw new RequestCancelled('Остановка');
      await sleep(Math.min(25, Math.max(0, until - performance.now())));
    }
    if (this.cancelled()) throw new RequestCancelled('Остановка');
  }
  raw(method, kwargs = {}) {
    const run = async () => {
      if (this.cancelled()) throw new RequestCancelled('Остановка');
      await this.wait(this.last + this.interval);
      this.last = performance.now();
      const options = (method === 'get_kline' || method === 'get_tickers') ? { timeout: Math.min(this.session.timeout || 12, 4) } : {};
      for (let attempt = 0; attempt < this.retries; attempt++) {
        try { return await super.raw(method, kwargs, options); } catch (exc) {
          if (!READS.has(method) || !isTemporary(exc) || attempt === this.retries - 1) throw exc;
          await this.wait(performance.now() + 500 * (attempt + 1) * (exc.status_code === 429 || exc.status_code === 10006 ? 4 : 1));
          this.last = performance.now();
        }
      }
      throw new Error('unreachable');
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }
}

module.exports = { Gateway, RateLimitedGateway, sleep };
