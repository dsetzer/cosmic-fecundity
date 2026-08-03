// Multi-seed selection test.
//
//   node tools/selection.mjs [minutes] [runs] [seed-prefix]
//
// A single run is mostly mutation noise — a handful of universes per generation
// is a tiny sample. This pools independent seeds and reports, per gene, how the
// population mean moved relative to the founding value, plus how many runs
// agreed on the direction. That is the only honest way to say whether a drift
// is selection or chance.

import { Multiverse } from '../src/sim/multiverse.js';
import { GENES } from '../src/sim/genome.js';

const minutes = Number(process.argv[2] || 20);
const runs = Number(process.argv[3] || 8);
// Batches must use different prefixes to be independent. Re-running with more
// runs but the same prefix re-uses every earlier seed, so the second result is
// not a replication of the first — it contains it.
const prefix = process.argv[4] || 'run';
const DT = 1 / 60;
const steps = Math.round((minutes * 60) / DT);

const totals = {};
const agree = {};
for (const g of GENES) {
  totals[g.key] = [];
  agree[g.key] = 0;
}
let born = 0;
let recycled = 0;
let deepest = 0;

for (let r = 0; r < runs; r++) {
  const mv = new Multiverse(`${prefix}-${r}`);
  for (let i = 0; i < steps; i++) mv.step(DT);
  const s = mv.selectionSummary();
  const c = mv.counts();
  born += c.born;
  recycled += c.dissolved;
  deepest = Math.max(deepest, c.deepest);
  for (const g of GENES) {
    const range = g.hi - g.lo;
    const d = (s.current[g.key] - s.founder[g.key]) / range;
    totals[g.key].push(d);
    if (d > 0) agree[g.key]++;
  }
  process.stdout.write(`  run ${r + 1}/${runs}: ${c.born} born, ${c.dissolved} recycled, depth ${c.deepest}\n`);
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1));
};

console.log(`\nseed prefix "${prefix}" · ${runs} seeds × ${minutes} min — ${born} universes born, ${recycled} recycled, deepest generation ${deepest}`);
console.log('\ndrift as a fraction of each gene\'s range (founder → current generations)\n');
console.log('  gene                       mean      sd    t     runs up');
for (const g of GENES) {
  const a = totals[g.key];
  const m = mean(a);
  const s = sd(a);
  const t = s > 0 ? (m / (s / Math.sqrt(a.length))) : 0;
  console.log(
    `  ${g.symbol.padEnd(3)} ${g.label.padEnd(22)} ` +
      `${(m >= 0 ? '+' : '') + m.toFixed(4)}  ${s.toFixed(4)}  ${t.toFixed(2).padStart(5)}   ${agree[g.key]}/${runs}`
  );
}
console.log('\n  |t| > 2 with this many seeds is suggestive, not conclusive.');
