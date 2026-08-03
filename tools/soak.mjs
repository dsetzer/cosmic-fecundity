// Headless soak test for the simulation core.
//
//   node tools/soak.mjs [minutes] [seed]
//
// Runs the multiverse without a renderer and asserts the two properties the
// demonstration rests on: mass is conserved, and the system never runs down.
// Also prints the selection census so gene drift can be inspected from the CLI.

import { Multiverse } from '../src/sim/multiverse.js';
import { GENES } from '../src/sim/genome.js';

const minutes = Number(process.argv[2] || 6);
const seed = process.argv[3] || 'fecundity';
const DT = 1 / 60;
const steps = Math.round((minutes * 60) / DT);

const mv = new Multiverse(seed);
const M0 = mv.totalMass();

let worstDrift = 0;
let peakUniverses = 0;
let nan = 0;
const t0 = Date.now();

for (let i = 0; i < steps; i++) {
  mv.step(DT);

  // Every simulated minute, walk the focus down the deepest live branch so the
  // level-of-detail system and the dive path are exercised too.
  if (i % 3600 === 0) {
    let f = mv.root;
    while (f.children.length && f.children[0].alive) f = f.children[0];
    mv.focus = f;
  }

  const total = mv.totalMass();
  if (!Number.isFinite(total)) {
    nan++;
    break;
  }
  worstDrift = Math.max(worstDrift, Math.abs(total - M0));
  peakUniverses = Math.max(peakUniverses, mv.universes.length);
}

const elapsed = (Date.now() - t0) / 1000;
const c = mv.counts();
const s = mv.selectionSummary();

const pad = (v, n) => String(v).padStart(n);
console.log(`\nseed "${seed}"  ·  ${minutes} simulated minute(s) in ${elapsed.toFixed(1)}s wall ` +
  `(${(minutes * 60 / elapsed).toFixed(0)}× realtime)\n`);

console.log('census');
console.log(`  live universes     ${pad(c.universes, 6)}   peak ${peakUniverses}`);
console.log(`  universes born     ${pad(c.born, 6)}`);
console.log(`  recycled           ${pad(c.dissolved, 6)}`);
console.log(`  deepest generation ${pad(c.deepest, 6)}`);
console.log(`  particles          ${pad(c.particles, 6)}`);
console.log(`  stars / holes      ${pad(`${c.stars} / ${c.holes}`, 6)}`);

console.log('\nconservation');
console.log(`  initial mass       ${M0.toFixed(3)}`);
console.log(`  final mass         ${mv.totalMass().toFixed(3)}`);
console.log(`  worst drift        ${worstDrift.toExponential(2)}`);

if (s) {
  console.log('\nselection — mean constants by generation');
  const head = ['gen', 'n', ...GENES.map((g) => g.symbol.padStart(6)), 'BH/min'];
  console.log('  ' + head.join(' '));
  for (const g of s.stats) {
    const row = [
      pad(g.generation, 3),
      pad(g.n, 3),
      ...GENES.map((spec) => pad(g.mean[spec.key].toFixed(2), 6)),
      pad(g.collapseRate.toFixed(1), 6),
    ];
    console.log('  ' + row.join(' '));
  }
  console.log('\n  founder → current drift');
  for (const spec of GENES) {
    const d = s.current[spec.key] - s.founder[spec.key];
    console.log(
      `    ${spec.symbol.padEnd(3)} ${spec.label.padEnd(24)} ` +
        `${s.founder[spec.key].toFixed(2)} → ${s.current[spec.key].toFixed(2)}  ` +
        `${d >= 0 ? '+' : ''}${d.toFixed(3)}`
    );
  }
}

const failures = [];
if (nan) failures.push('non-finite mass');
if (worstDrift > 1e-3 * M0) failures.push(`mass drift ${worstDrift.toExponential(2)}`);
if (c.born < 2) failures.push('no reproduction — the multiverse is sterile');
if (c.universes < 2) failures.push('system ran down to a single universe');
if (c.particles < 200) failures.push('particle population collapsed');

console.log('');
if (failures.length) {
  console.log('FAIL: ' + failures.join('; '));
  process.exit(1);
}
console.log('PASS: mass conserved, reproduction sustained, population stable.');
