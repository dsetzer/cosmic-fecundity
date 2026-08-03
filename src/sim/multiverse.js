// The multiverse: a tree of universes plus the bookkeeping that turns it into
// a demonstration rather than a screensaver.
//
// Two invariants make the whole thing work:
//
//   1. Mass is conserved. Nothing is created; a child universe is paid for out
//      of its parent black hole's accretion, and every dissolved universe hands
//      its mass back up the tree. The ledger in the HUD shows the drift, which
//      stays at zero.
//
//   2. Nothing selects for anything. Universes reproduce when their black holes
//      accumulate enough mass, full stop. The gene drift you see in the readout
//      is differential reproduction and nothing else.

import { Universe, PHASE, resetUniverseIds } from './universe.js';
import { seedGenome, mutate, GENES, fecundity } from './genome.js';
import { makeRNG, hashSeed } from '../engine/rng.js';
import { resetBodyIds } from './bodies.js';

const MAX_ACTIVE = 12;
const ROOT_CAPACITY = 4600;
const CHILD_CAPACITY = 2400;
const ROOT_MASS = 6200;
const CULL_GRACE = 70; // seconds a young universe is safe from culling —
// long enough that every universe gets a fair chance to produce a singularity

export class Multiverse {
  constructor(seed = 'fecundity') {
    this.reset(seed);
  }

  reset(seed) {
    resetUniverseIds();
    resetBodyIds();
    this.seed = seed;
    this.rng = makeRNG(hashSeed(String(seed)));
    this.time = 0;
    this.universes = [];
    this.records = [];
    this.births = 0;
    this.deaths = 0;
    this.deepest = 0;
    this.events = [];

    const root = new Universe({
      genome: seedGenome(this.rng),
      rng: this.rng.fork(),
      generation: 0,
      dowry: ROOT_MASS,
      capacity: ROOT_CAPACITY,
    });
    root.isRoot = true;
    this.root = root;
    this._register(root, null);
    this.focus = root;

    this.M0 = this.totalMass();
    this.drift = 0;
    this.log('The first universe inflates.', root);
  }

  _register(u, parentRecord) {
    this.universes.push(u);
    const rec = {
      id: u.id,
      generation: u.generation,
      parent: parentRecord ? parentRecord.id : null,
      genome: { ...u.genome },
      bornAt: this.time,
      diedAt: null,
      offspring: 0,
      blackHoles: 0,
      stars: 0,
      universe: u,
    };
    u.record = rec;
    this.records.push(rec);
    if (parentRecord) parentRecord.offspring++;
    if (u.generation > this.deepest) this.deepest = u.generation;
    return rec;
  }

  log(text, u) {
    this.events.unshift({
      t: this.time,
      text,
      generation: u ? u.generation : 0,
      id: u ? u.id : -1,
    });
    if (this.events.length > 40) this.events.length = 40;
  }

  // -------------------------------------------------------------------- step

  step(dt) {
    this.time += dt;

    const ctx = {
      canBirth: (u) => this._canBirth(u),
      birth: (u, bh, dowry) => this._birth(u, bh, dowry),
    };

    this._layout();
    this._assignLOD();

    for (const u of this.universes) {
      u.step(dt, ctx);
      if (u.record) {
        u.record.blackHoles = u.blackHolesFormed;
        u.record.stars = u.starsFormed;
      }
    }

    this._cull();
    this.drift = this.totalMass() - this.M0;
  }

  /** Position each child's bubble beside the black hole that produced it. */
  _layout() {
    for (const u of this.universes) {
      for (const bh of u.blackHoles) {
        const n = bh.children.length;
        for (let i = 0; i < n; i++) {
          const c = bh.children[i];
          if (!c.alive) continue;
          const spread = n === 1 ? 0 : (i / (n - 1) - 0.5) * 1.5;
          c.anchorAngle = bh.jetAngle + Math.PI / 2 + spread;
          c.anchorDist = bh.horizon * 2.4 + u.radius * 0.2 + i * u.radius * 0.04;
          c.displayRadius = u.radius * 0.125;
          c.anchorX = bh.x + Math.cos(c.anchorAngle) * c.anchorDist;
          c.anchorY = bh.y + Math.sin(c.anchorAngle) * c.anchorDist;
        }
      }
    }
  }

  /**
   * Level of detail. The focused universe, its parent and its children run at
   * full particle budget; everything else is throttled so the frame cost stays
   * flat no matter how big the tree gets.
   */
  _assignLOD() {
    const f = this.focus;
    for (const u of this.universes) {
      let lod = 0.12;
      if (u === f) lod = 1;
      else if (u.parent === f) lod = 0.42;
      else if (f.parent === u) lod = 0.5;
      else if (u.parent && u.parent === f.parent) lod = 0.18;
      u.setLOD(lod);
    }
  }

  get liveCount() {
    let n = 0;
    for (const u of this.universes) if (u.alive) n++;
    return n;
  }

  _canBirth(u) {
    if (this.liveCount < MAX_ACTIVE) return true;
    return this._cullCandidate() !== null;
  }

  _birth(parent, bh, dowry) {
    if (this.liveCount >= MAX_ACTIVE) {
      const victim = this._cullCandidate();
      if (!victim) return null;
      this._dissolve(victim, 'crowded out of the multiverse');
    }

    const child = new Universe({
      genome: mutate(parent.genome, parent.rng),
      rng: parent.rng.fork(),
      generation: parent.generation + 1,
      parent,
      parentBH: bh,
      dowry,
      capacity: CHILD_CAPACITY,
    });

    parent.children.push(child);
    bh.children.push(child);
    this._register(child, parent.record);
    this.births++;

    const drifted = GENES.map((g) => {
      const d = child.genome[g.key] - parent.genome[g.key];
      return { g, d };
    }).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
    this.log(
      `Universe ${child.id} bounces out of a singularity in ${parent.id} — ` +
        `${drifted.g.symbol} ${drifted.d > 0 ? '+' : ''}${drifted.d.toFixed(2)}`,
      child
    );
    return child;
  }

  /** The least fecund expendable universe, or null if everything is protected. */
  _cullCandidate() {
    const protectedSet = new Set();
    for (let u = this.focus; u; u = u.parent) protectedSet.add(u);
    for (const c of this.focus.children) protectedSet.add(c);

    let worst = null;
    let worstScore = Infinity;
    for (const u of this.universes) {
      if (u === this.root || protectedSet.has(u)) continue;
      if (!u.alive) continue;
      if (u.age < CULL_GRACE) continue;
      if (u.children.some((c) => c.alive)) continue;
      // Shallow, infertile universes go first: a founder that keeps budding
      // barren children would otherwise pin the census at one generation.
      const score = fecundity(u) + u.blackHolesFormed * 0.001 + u.generation * 0.02;
      if (score < worstScore) {
        worstScore = score;
        worst = u;
      }
    }
    return worst;
  }

  _cull() {
    // Spent universes go first, whether or not the census is crowded. This is
    // what keeps the tree turning over: dead ends return their matter to the
    // lineage that produced them, and it gets spent on fresh attempts.
    for (const u of this.universes) {
      if (u === this.root || !u.alive) continue;
      if (u === this.focus || this.focus.parent === u) continue;
      if (u.children.some((c) => c.alive)) continue;
      if (u.barren) this._dissolve(u, 'runs down — no singularity left');
    }

    for (let i = this.universes.length - 1; i >= 0; i--) {
      const u = this.universes[i];
      if (u.phase === PHASE.DISSOLVING && u._dissolveT >= 1) {
        this.universes.splice(i, 1);
        if (u.parent) {
          const k = u.parent.children.indexOf(u);
          if (k >= 0) u.parent.children.splice(k, 1);
        }
        if (u.parentBH) {
          const k = u.parentBH.children.indexOf(u);
          if (k >= 0) u.parentBH.children.splice(k, 1);
        }
        if (this.focus === u) this.focus = u.parent || this.root;
      }
    }
  }

  _dissolve(u, why) {
    const mass = u.dissolve();
    // Every gram goes home: back through the umbilical into the parent's black
    // hole, where it re-emerges as jet outflow and becomes gas again.
    if (u.parentBH) u.parentBH.inflow += mass;
    else this.root.reservoir += mass;
    u.record.diedAt = this.time;
    this.deaths++;
    this.log(`Universe ${u.id} ${why}; ${Math.round(mass)} mass returns upstream.`, u);
  }

  // ------------------------------------------------------------------ ledger

  totalMass() {
    let m = 0;
    for (const u of this.universes) m += u.totalMass();
    return m;
  }

  // -------------------------------------------------------------- statistics

  /**
   * Mean gene values per generation, over every universe ever born at that
   * depth. This is the census that shows selection: no universe is scored or
   * ranked anywhere in the simulation, yet the mean moves.
   */
  generationStats() {
    const byGen = [];
    for (const r of this.records) {
      const g = r.generation;
      if (!byGen[g]) {
        byGen[g] = { generation: g, n: 0, sums: {}, rate: 0, offspring: 0 };
        for (const spec of GENES) byGen[g].sums[spec.key] = 0;
      }
      const b = byGen[g];
      b.n++;
      // Rate, not a raw count: a generation-4 universe has simply had less time
      // to collapse anything than the founder, and comparing totals would read
      // that age difference as a difference in fecundity.
      const lifetime = (r.diedAt === null ? this.time : r.diedAt) - r.bornAt;
      b.rate += r.blackHoles / Math.max(0.25, lifetime / 60);
      b.offspring += r.offspring;
      for (const spec of GENES) b.sums[spec.key] += r.genome[spec.key];
    }
    return byGen
      .filter(Boolean)
      .map((b) => {
        const mean = {};
        for (const spec of GENES) mean[spec.key] = b.sums[spec.key] / b.n;
        return {
          generation: b.generation,
          n: b.n,
          mean,
          collapseRate: b.rate / b.n,
          offspringPer: b.offspring / b.n,
        };
      });
  }

  /** Gene drift from the founding genome to the current generations. */
  selectionSummary() {
    const stats = this.generationStats();
    if (stats.length === 0) return null;
    const first = stats[0];
    const recent = stats.slice(-Math.min(3, stats.length));
    const mean = {};
    for (const spec of GENES) {
      let s = 0;
      let n = 0;
      for (const g of recent) {
        s += g.mean[spec.key] * g.n;
        n += g.n;
      }
      mean[spec.key] = s / Math.max(1, n);
    }
    return {
      founder: first.mean,
      current: mean,
      generations: stats.length,
      stats,
    };
  }

  /** Live universe with the highest reproductive rate. */
  fittest() {
    let best = null;
    let score = -1;
    for (const u of this.universes) {
      const f = fecundity(u);
      if (f > score) {
        score = f;
        best = u;
      }
    }
    return best;
  }

  counts() {
    let particles = 0;
    let stars = 0;
    let holes = 0;
    for (const u of this.universes) {
      particles += u.pool.count;
      stars += u.stars.length;
      holes += u.blackHoles.length;
    }
    return {
      particles,
      stars,
      holes,
      universes: this.universes.length,
      born: this.births,
      dissolved: this.deaths,
      deepest: this.deepest,
    };
  }

  /** Depth-first walk of the live tree, for the lineage panel. */
  tree() {
    const out = [];
    const walk = (u, depth) => {
      out.push({ u, depth });
      for (const c of u.children) if (c.alive) walk(c, depth + 1);
    };
    walk(this.root, 0);
    return out;
  }
}
