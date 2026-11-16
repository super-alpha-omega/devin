'use strict';
// Float helpers reproducing CPython 3.12 semantics exactly (sum() uses Neumaier compensation).
function pySum(values) {
  let f = 0, c = 0, first = true;
  for (const x of values) {
    if (first) { f = 0 + x; first = false; continue; }
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x; else c += (x - t) + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}
const max = (arr) => arr.reduce((a, b) => (b > a ? b : a));
const min = (arr) => arr.reduce((a, b) => (b < a ? b : a));
function argmaxFirst(n, key) { let best = 0; for (let i = 1; i < n; i++) if (key(i) > key(best)) best = i; return best; }
function argminFirst(n, key) { let best = 0; for (let i = 1; i < n; i++) if (key(i) < key(best)) best = i; return best; }
const slice = (arr, a, b) => arr.slice(a, b);
module.exports = { pySum, max, min, argmaxFirst, argminFirst, slice };
