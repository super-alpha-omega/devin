'use strict';
// Error taxonomy of the original bot plus classification helpers for self-healing.

class ValueError extends Error { constructor(m) { super(m); this.name = 'ValueError'; } }
class Halt extends Error { constructor(m) { super(m); this.name = 'Halt'; } }
class RequestCancelled extends Error { constructor(m) { super(m || 'Остановка'); this.name = 'RequestCancelled'; } }
class APIError extends Error {
  constructor(code, message) { super('Bybit API code ' + code + (message ? ': ' + message : '')); this.name = 'APIError'; this.status_code = code; }
}
class FailedRequestError extends Error {
  constructor(message, status) { super(message); this.name = 'FailedRequestError'; this.status_code = status; }
}
class NetworkError extends Error {
  constructor(message, timeout = false) { super(message); this.name = timeout ? 'ReadTimeout' : 'ConnectionError'; this.timeout = timeout; }
}
class ApiRejected extends Error {
  constructor(message, code) { super(message); this.name = 'ApiRejected'; this.status_code = code; }
}
class AdmissionRefused extends ValueError { constructor(m) { super(m); this.name = 'AdmissionRefused'; } }
class ExternalAccountBusy extends Halt {
  constructor(evidence) {
    const symbols = [...new Set((evidence.positions || []).map((p) => p.symbol))].sort();
    super('Позиции другого бота или ручной торговли: ' + (symbols.join(', ') || 'заявки/заём') +
      '. Наблюдение без изменения чужих позиций. Новые входы ожидают освобождения счёта и повторной проверки риска.');
    this.name = 'ExternalAccountBusy';
    this.evidence = evidence;
  }
}

const TEMP_CODES = new Set([400, 403, 408, 409, 429, 500, 502, 503, 504, 10000, 10002, 10006, 10016, 10018, 10429, 30034, 30035, 130035, 130150]);
const AUTH_CODES = new Set([10003, 10004, 10005, 10007, 10009, 10010, 33004]);
const READS = new Set(['get_kline', 'get_tickers', 'get_instruments_info', 'get_server_time', 'get_fee_rates', 'get_wallet_balance',
  'get_positions', 'get_open_orders', 'get_order_history', 'get_executions', 'get_closed_pnl', 'get_account_info', 'get_coin_balance',
  'get_borrow_history', 'get_collateral_info', 'get_borrow_quota', 'spot_margin_trade_get_status_and_leverage',
  'get_internal_transfer_records', 'get_transferable_amount']);

function isTemporary(exc) {
  if (!exc) return false;
  if (exc instanceof NetworkError) return true;
  if (exc.code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(exc.code)) return true;
  return TEMP_CODES.has(exc.status_code) || TEMP_CODES.has(exc.retry_cause);
}
function isAuthError(exc) { return !!exc && AUTH_CODES.has(exc.status_code); }
function temporaryRead(exc) { return !!exc && READS.has(exc.api_method) && isTemporary(exc); }

function safeError(exc) {
  if (!exc) return 'Unknown';
  const code = exc.status_code;
  let result = (exc.name || (exc.constructor && exc.constructor.name) || 'Error') + (Number.isInteger(code) ? ` (код ${code})` : '');
  if (Number.isInteger(exc.retry_cause)) result += ` [Bybit ${exc.retry_cause}]`;
  if (typeof exc.api_method === 'string' && /^[a-z_]{1,64}$/.test(exc.api_method)) result += '; ' + exc.api_method;
  if ((exc instanceof ValueError || exc instanceof Halt) && exc.message) result += ': ' + exc.message;
  return result;
}

function describe(exc) { return exc instanceof Halt || exc instanceof ValueError ? exc.message : safeError(exc); }

module.exports = { ValueError, Halt, RequestCancelled, APIError, FailedRequestError, NetworkError, ApiRejected, AdmissionRefused,
  ExternalAccountBusy, isTemporary, isAuthError, temporaryRead, safeError, describe, READS };
