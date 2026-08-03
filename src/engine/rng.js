// Deterministic pseudo-random number generation.
//
// Every stochastic decision in the simulation — mutation, star formation,
// particle jitter — draws from a seeded stream so a given seed always replays
// the same multiverse. Each universe gets its own stream derived from its
// parent's, which keeps sibling branches statistically independent.

const TAU = Math.PI * 2;

/** Mulberry32: small, fast, good enough distribution for visual simulation. */
export function makeRNG(seed) {
  let a = seed >>> 0;
  let spare = null;

  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** Uniform in [0, 1). */
    float: next,
    /** Uniform in [lo, hi). */
    range: (lo, hi) => lo + next() * (hi - lo),
    /** Integer in [0, n). */
    int: (n) => Math.floor(next() * n) % n,
    /** Uniform angle in radians. */
    angle: () => next() * TAU,
    /** True with probability p. */
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length) % arr.length],
    /** Box-Muller normal deviate. */
    gauss(mu = 0, sigma = 1) {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return mu + sigma * v;
      }
      let u = 0;
      let v = 0;
      let s = 0;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        s = u * u + v * v;
      } while (s === 0 || s >= 1);
      const f = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * f;
      return mu + sigma * u * f;
    },
    /** A fresh independent stream, for handing to a child universe. */
    fork: () => makeRNG(Math.floor(next() * 0xffffffff)),
    /** Current internal state, so a run can be captured and resumed. */
    state: () => a,
  };
}

/** Turn a human-typed seed string into a 32-bit integer. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export { TAU };
