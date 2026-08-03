// Fitness-landscape sweep.
//
//   node tools/sweep.mjs [gene] [minutes] [seeds] [steps]
//   node tools/sweep.mjs all 3 3 5
//
// Selection can only push a gene if that gene actually changes how many
// singularities a universe produces. This measures that directly: hold the
// founding genome fixed, vary one gene across its range, run isolated
// universes that cannot reproduce, and count collapses per minute.
//
// It is a diagnostic, not part of the simulation — nothing here feeds back
// into the physics. Its job is to say whether a drift reported by
// tools/selection.mjs has a mechanism underneath it or is just noise.

import { Universe } from '../src/sim/universe.js';
import { GENES, seedGenome } from '../src/sim/genome.js';
import { makeRNG, hashSeed } from '../src/engine/rng.js';

const which = process.argv[2] || 'cooling';
const minutes = Number(process.argv[3] || 3);
const seeds = Number(process.argv[4] || 3);
const steps = Number(process.argv[5] || 5);
const DT = 1 / 60;
const FRAMES = Math.round((minutes * 60) / DT);
const DOWRY = 900;

/** A universe on its own: it accretes and collapses, but never buds. */
const ISOLATED = { canBirth: () => false, birth: () => {} };

const base = seedGenome(makeRNG(hashSeed('fecundity')), 0);

function measure(genome, seed) {
  const u = new Universe({
    genome,
    rng: makeRNG(seed),
    dowry: DOWRY,
    capacity: 3600,
  });
  for (let i = 0; i < FRAMES; i++) u.step(DT, ISOLATED);
  return {
    collapses: u.blackHolesFormed / minutes,
    stars: u.starsFormed / minutes,
    // Mean stellar mass is the variable that connects cooling to collapse:
    // a star only becomes a singularity if it is heavy enough.
    meanStar: u.starsFormed ? u.starMassTotal / u.starsFormed : 0,
  };
}

const targets = which === 'all' ? GENES : GENES.filter((g) => g.key === which || g.symbol === which);
if (targets.length === 0) {
  console.error(`unknown gene "${which}" — try one of: ${GENES.map((g) => g.key).join(', ')}, or "all"`);
  process.exit(1);
}

console.log(
  `\nisolated universes · ${DOWRY} mass · ${minutes} min each · ${seeds} seeds per point\n` +
    'all other genes held at the founding values\n'
);

for (const spec of targets) {
  console.log(`${spec.symbol}  ${spec.label}  —  ${spec.note}`);
  console.log('    value   collapses/min   stars/min   mean stellar mass');
  for (let s = 0; s < steps; s++) {
    const v = spec.lo + ((spec.hi - spec.lo) * s) / (steps - 1);
    const genome = { ...base, [spec.key]: v };
    let c = 0;
    let st = 0;
    let ms = 0;
    for (let k = 0; k < seeds; k++) {
      const r = measure({ ...genome }, 1000 + k * 7919);
      c += r.collapses;
      st += r.stars;
      ms += r.meanStar;
    }
    const bar = '█'.repeat(Math.round((c / seeds) * 1.5));
    console.log(
      `  ${v.toFixed(2).padStart(6)}   ${(c / seeds).toFixed(1).padStart(11)}   ` +
        `${(st / seeds).toFixed(1).padStart(9)}   ${(ms / seeds).toFixed(1).padStart(17)}  ${bar}`
    );
  }
  console.log('');
}
