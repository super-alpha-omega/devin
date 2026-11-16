'use strict';
// CPython-compatible Mersenne Twister (random.Random(int).shuffle) for reproducible model training.
class PyRandom {
  constructor(seed) {
    this.mt = new Uint32Array(624); this.index = 625;
    let n = BigInt(Math.abs(seed)); const key = [];
    if (n === 0n) key.push(0); while (n > 0n) { key.push(Number(n & 0xffffffffn)); n >>= 32n; }
    this.initByArray(key);
  }
  initGenrand(s) {
    const mt = this.mt; mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) { const prev = mt[i - 1] ^ (mt[i - 1] >>> 30); mt[i] = (Math.imul(1812433253, prev) + i) >>> 0; }
    this.index = 624;
  }
  initByArray(key) {
    this.initGenrand(19650218); const mt = this.mt; let i = 1, j = 0; const len = key.length;
    for (let k = Math.max(624, len); k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0; i++; j++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; } if (j >= len) j = 0;
    }
    for (let k = 623; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0; i++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
    }
    mt[0] = 0x80000000;
  }
  genrand() {
    const mt = this.mt;
    if (this.index >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let y = mt[this.index++];
    y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
    return y >>> 0;
  }
  getrandbits(k) { return this.genrand() >>> (32 - k); }
  randbelow(n) { const k = n.toString(2).length; let r = this.getrandbits(k); while (r >= n) r = this.getrandbits(k); return r; }
  shuffle(x) { for (let i = x.length - 1; i > 0; i--) { const j = this.randbelow(i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; }
}
module.exports = { PyRandom };
