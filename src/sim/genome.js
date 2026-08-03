// The heritable physics of a universe.
//
// This is the crux of the cosmological-natural-selection ("cosmic fecundity")
// argument: the low-energy constants are not fixed background facts but
// heritable traits. A universe that collapses more of its matter into black
// holes leaves more descendants, so whatever gene values raise the black-hole
// count get copied more often. No selection pressure is applied by hand
// anywhere in this codebase — the drift you see in the readout is purely a
// consequence of fecund universes out-reproducing barren ones.

/**
 * Gene definitions. `lo`/`hi` are hard clamps (a universe outside them simply
 * cannot form structure); `spread` is the standard deviation of the mutation
 * applied at each bounce, expressed as a fraction of the range.
 */
export const GENES = [
  {
    key: 'G',
    label: 'Gravitational coupling',
    symbol: 'G',
    lo: 0.35,
    hi: 3.2,
    init: 1.0,
    spread: 0.055,
    note: 'Stronger gravity collapses clouds faster.',
  },
  {
    key: 'lambda',
    label: 'Vacuum energy',
    symbol: 'Λ',
    lo: 0.0,
    hi: 1.4,
    init: 0.45,
    spread: 0.05,
    note: 'Expansion pressure; too much and nothing binds.',
  },
  {
    key: 'cooling',
    label: 'Radiative cooling',
    symbol: 'κ',
    lo: 0.15,
    hi: 2.6,
    init: 1.0,
    spread: 0.06,
    note: 'How fast gas sheds heat and becomes collapsible.',
  },
  {
    key: 'ignition',
    label: 'Ignition threshold',
    symbol: 'ρ★',
    lo: 0.35,
    hi: 3.0,
    init: 1.0,
    spread: 0.06,
    note: 'Cloud mass needed to light a star. Lower is more fecund.',
  },
  {
    key: 'chandra',
    label: 'Collapse limit',
    symbol: 'M𝒸',
    lo: 0.4,
    hi: 3.0,
    init: 1.45,
    spread: 0.06,
    note: 'Stellar mass above which the core becomes a singularity.',
  },
  {
    key: 'yield',
    label: 'Accretion yield',
    symbol: 'η',
    lo: 0.2,
    hi: 2.2,
    init: 0.85,
    spread: 0.05,
    note: 'Efficiency of turning infalling mass into throughput.',
  },
];

export const GENE_KEYS = GENES.map((g) => g.key);

function clampGene(spec, v) {
  return v < spec.lo ? spec.lo : v > spec.hi ? spec.hi : v;
}

/** The root universe's genome — deliberately mediocre, so drift is visible. */
export function seedGenome(rng, jitter = 0.12) {
  const g = {};
  for (const spec of GENES) {
    const range = spec.hi - spec.lo;
    g[spec.key] = clampGene(spec, spec.init + rng.gauss(0, range * jitter));
  }
  return g;
}

/**
 * Reproduction with variation. The bounce through a singularity is violent but
 * not perfectly lossy: constants are re-randomised only slightly, which is
 * exactly the small-mutation regime cumulative selection needs.
 */
export function mutate(parent, rng, rate = 1) {
  const g = {};
  for (const spec of GENES) {
    const range = spec.hi - spec.lo;
    g[spec.key] = clampGene(spec, parent[spec.key] + rng.gauss(0, range * spec.spread * rate));
  }
  return g;
}

/** Human-readable divergence between two genomes, 0 = identical. */
export function genomeDistance(a, b) {
  let sum = 0;
  for (const spec of GENES) {
    const range = spec.hi - spec.lo;
    const d = (a[spec.key] - b[spec.key]) / range;
    sum += d * d;
  }
  return Math.sqrt(sum / GENES.length);
}

/**
 * Descriptive only — never fed back into the simulation. Reproductive success
 * is measured, not assigned: it is literally the number of singularities the
 * universe has produced per unit of its own elapsed time.
 */
export function fecundity(u) {
  return u.blackHolesFormed / Math.max(1, u.age / 60);
}

export function formatGenome(g) {
  return GENES.map((s) => `${s.symbol} ${g[s.key].toFixed(2)}`).join('  ');
}
