'use strict';
// Decimal arithmetic identical in spirit to Python's decimal module (28 digits, half-even).
const DecimalBase = require('decimal.js');
const Decimal = DecimalBase.clone({ precision: 28, rounding: DecimalBase.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 40 });
const { ValueError } = require('./errors');

const MIN_NET_RR = new Decimal(3);

function D(value) {
  return value instanceof Decimal ? value : new Decimal(typeof value === 'number' ? String(value) : value);
}

function number(value, name) {
  let result;
  try {
    if (value instanceof Decimal) result = value;
    else if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'object') throw new Error();
    else result = new Decimal(String(value).trim().replace(',', '.'));
  } catch (e) {
    throw new ValueError(`${name}: требуется число`);
  }
  if (!result.isFinite()) throw new ValueError(`${name}: число должно быть конечным`);
  return result;
}

function roundStep(value, step, up = false) {
  value = D(value); step = D(step);
  return value.div(step).toDecimalPlaces(0, up ? Decimal.ROUND_CEIL : Decimal.ROUND_FLOOR).mul(step);
}

function sumD(values) { return values.reduce((a, b) => a.plus(b), new Decimal(0)); }
function maxD(...values) { return values.reduce((a, b) => (D(b).gt(a) ? D(b) : a), D(values[0])); }
function minD(...values) { return values.reduce((a, b) => (D(b).lt(a) ? D(b) : a), D(values[0])); }
function fixed(value, digits) { return D(value).toFixed(digits); }

module.exports = { Decimal, D, number, roundStep, sumD, maxD, minD, fixed, MIN_NET_RR };
