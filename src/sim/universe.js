// One universe: a bounded disc of space with its own physical constants.
//
// The lifecycle is a loop, not a line:
//
//   inflation → cold gas → molecular clouds → stars → collapse → black holes
//        ↑                                                          │
//        └──────── umbilical feed ←── parent BH ←── polar jets ←────┘
//
// A universe never "finishes". Its black holes bud off children and keep
// pumping mass into them; the children return a share of their own accretion
// back up the umbilical, where it re-enters the parent as jet outflow and
// becomes the next generation of star-forming gas. Mass is conserved exactly,
// so the whole tree is a closed, perpetual system rather than a decaying one.

import { ParticlePool, PT } from '../engine/particles.js';
import { SpatialHash } from '../engine/spatialhash.js';
import { Star, BlackHole } from './bodies.js';
import { generationColor } from '../engine/color.js';

/** Every universe uses the same local coordinate space, so nesting never
 *  degrades floating-point precision no matter how deep the lineage goes.
 *  This is the radius of a universe holding the reference mass; smaller ones
 *  are correspondingly smaller, which keeps their gas dense enough to collapse. */
export const U_RADIUS = 1000;
export const REFERENCE_MASS = 6200;

const GRID_CELL = 40;
const BODY_SOFT = 1100; // softening length², keeps close encounters finite
const CELL_SOFT = 2200;
/** Extra weight on grid-resolution self-gravity. Gas has to be able to gather
 *  into arms and knots on its own; the bare inverse-square term at this
 *  resolution is far too weak to produce visible structure. */
const CLUMPING = 2.0;
const GRAV_SCALE = 58;
/** Vacuum energy pushes outward; the curvature of the closed space pulls back.
 *  Their difference is what decides whether a universe binds at all — a
 *  universe with Λ above ~0.6 blows itself apart before anything can collapse,
 *  which is exactly the selective pressure the theory needs it to have. */
const LAMBDA_SCALE = 34;
const CURVATURE = 32;
const LONG_RANGE = 0.3;
/** Radial bins used to build the rotation curve. */
const PROFILE_BINS = 24;

const PARTICLE_MASS = 1.0;
/** Mass a grid cell must hold before its gas is self-gravitating. Derived from
 *  the reference density so that a small universe and a large one form stars
 *  with the same statistics — only the number of cells differs. */
const OVERDENSITY = 5.0;
const IGNITION_BASE = (REFERENCE_MASS / (Math.PI * U_RADIUS * U_RADIUS)) * GRID_CELL * GRID_CELL * OVERDENSITY;
const COLD_ENOUGH = 1400; // K — warmer gas is pressure-supported
const PHOTON_MASS = 0.02;
/** A star collapses to a singularity when its mass exceeds the collapse-limit
 *  gene times this multiple of the universe's own ignition mass. Expressing it
 *  relative to the local cloud scale — rather than in absolute units — is what
 *  makes the gene mean the same thing in a small universe and a large one. */
const SN_FACTOR = 1.85;

/** How long a universe may go without producing a singularity before it is
 *  considered spent, in its own elapsed seconds. */
const BARREN_AGE = 150;
const BARREN_WINDOW = 110;

/** Reservoir a black hole must bank before it can bounce into a new universe. */
export const BIRTH_COST = 155;
/**
 * Offspring caps. These are a memory bound, and they must not bind in practice:
 * a low cap silently throws away the entire selective differential, because a
 * universe producing eight singularities a minute and one producing two both
 * stop at the same number of children. What limits the population is the
 * multiverse's own census and its recycling of spent branches, not this.
 */
const MAX_CHILDREN_PER_BH = 6;
const MAX_CHILDREN_PER_UNIVERSE = 10;

export const PHASE = {
  INFLATION: 0,
  STRUCTURE: 1,
  MATURE: 2,
  QUIESCENT: 3,
  DISSOLVING: 4,
};
export const PHASE_NAMES = ['Inflation', 'Structure', 'Mature', 'Quiescent', 'Dissolving'];

let nextUniverseId = 0;

export class Universe {
  constructor({ genome, rng, generation = 0, parent = null, parentBH = null, dowry = 0, capacity = 4200 }) {
    this.id = nextUniverseId++;
    this.genome = genome;
    this.rng = rng;
    this.generation = generation;
    this.parent = parent;
    this.parentBH = parentBH;
    this.children = [];
    this.tint = generationColor(generation);
    /** Sense of rotation. A universe with net angular momentum forms a disc
     *  instead of collapsing to a point, which is what keeps it alive. */
    this.spin = rng.chance(0.5) ? 1 : -1;

    this.pool = new ParticlePool(capacity);
    this.hash = new SpatialHash(U_RADIUS * 1.05, GRID_CELL, capacity);
    this.stars = [];
    this.blackHoles = [];

    /** Mass held in the vacuum, waiting to condense into particles. */
    this.reservoir = dowry;
    /** Scale factor. A universe expands as its parent feeds it and contracts as
     *  it hands mass back — cosmic expansion driven by the umbilical. */
    this.radius = scaleFor(dowry);
    this.age = 0;
    this.phase = PHASE.INFLATION;
    this.inflationT = 0;
    this.flash = 1;

    // Census — read by the HUD and by selection bookkeeping.
    this.starsFormed = 0;
    this.blackHolesFormed = 0;
    this.supernovae = 0;
    this.massReceived = dowry;
    this.massReturned = 0;
    this.peakStars = 0;
    /** Summed birth mass of every star ever formed here, for diagnostics. */
    this.starMassTotal = 0;
    /** Own-clock time of the most recent stellar collapse. A universe that
     *  stops producing singularities is, in this theory, a dead end. */
    this.lastCollapse = 0;

    // Placement of this universe's bubble inside its parent, set by Multiverse.
    this.anchorAngle = 0;
    this.anchorDist = 0;
    this.anchorX = 0;
    this.anchorY = 0;
    this.displayRadius = U_RADIUS * 0.13;

    /** Mass a cloud needs to ignite, and the yardstick for stellar collapse. */
    this.ignitionMass = IGNITION_BASE * genome.ignition;
    this._formAcc = 0;
    this._genesisAcc = 0;
    this._cells = [];
    this._items = [];
    this._dissolveT = 0;
    this._scaleAcc = 0;
    this._profile = new Float32Array(PROFILE_BINS);
    this.lod = 1; // 1 = fully simulated, <1 = reduced spawn budget
  }

  /** Whether this universe can still hold matter. False the instant it starts
   *  dissolving, so no mass is ever handed to a universe that is going away. */
  get alive() {
    return this.phase !== PHASE.DISSOLVING;
  }

  /**
   * A universe with no singularities left and none formed in a long while has
   * reached the end of its productive life. It is not destroyed for being
   * unfit — it simply runs down, and its matter returns to the ancestor that
   * paid for it.
   */
  get barren() {
    return (
      this.age > BARREN_AGE &&
      this.blackHoles.length === 0 &&
      this.age - this.lastCollapse > BARREN_WINDOW
    );
  }

  /** Whether it should still be drawn — dissolution has a brief fade. */
  get visible() {
    return this.phase !== PHASE.DISSOLVING || this._dissolveT < 1;
  }

  /** Inward acceleration per unit radius: curvature minus vacuum energy.
   *  Negative means the universe is unbound and will simply disperse. */
  get binding() {
    return (CURVATURE - this.genome.lambda * LAMBDA_SCALE) / this.radius;
  }

  /**
   * Circular speed at radius r: the cosmological (harmonic) term plus the pull
   * of everything enclosed within r. Matter injected at this speed goes into
   * orbit rather than falling in, which is what turns a universe into a disc
   * instead of a point.
   */
  circularSpeed(r) {
    const k = this.binding;
    const harmonic = k > 0 ? k * r * r : 0;
    const menc = this.enclosedMass(r);
    const kepler = (this.genome.G * GRAV_SCALE * LONG_RANGE * menc) / Math.max(60, r);
    return Math.sqrt(harmonic + kepler);
  }

  /** Mass inside radius r, from the profile rebuilt each frame. */
  enclosedMass(r) {
    const prof = this._profile;
    if (!prof) return 0;
    const f = (r / this.radius) * PROFILE_BINS;
    const i = f <= 0 ? 0 : f >= PROFILE_BINS - 1 ? PROFILE_BINS - 1 : f | 0;
    return prof[i];
  }

  /** Everything this universe owns, including mass in transit and in bodies. */
  totalMass() {
    let m = this.pool.totalMass() + this.reservoir;
    for (const s of this.stars) m += s.mass;
    for (const b of this.blackHoles) {
      m += b.mass + b.bank + b.reservoir + b.backflow + b.inflow + b.jetPending + b.fluxPending;
    }
    return m;
  }

  /** Accept mass arriving from the parent black hole. A dissolving universe
   *  bounces it straight back up, so nothing is stranded. */
  feed(m) {
    if (!this.alive) {
      if (this.parentBH) this.parentBH.inflow += m;
      else if (this.parent) this.parent.reservoir += m;
      return;
    }
    this.reservoir += m;
    this.massReceived += m;
  }

  // ---------------------------------------------------------------- lifecycle

  step(dt, ctx) {
    this.age += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 0.55);

    if (this.phase === PHASE.INFLATION) this._inflate(dt);
    if (this.phase === PHASE.DISSOLVING) {
      this._dissolveT += dt * 0.8;
      return;
    }

    this._updateScale(dt);
    this._buildHash();
    this._integrate(dt);
    this._formStars(dt);
    this._updateStars(dt);
    this._gravitateBodies(dt);
    this._updateBlackHoles(dt, ctx);
    this._genesis(dt);
    this._classify();
  }

  /** The bounce: reservoir mass erupts outward as an inflaton shell. */
  _inflate(dt) {
    this.inflationT += dt;
    const pool = this.pool;
    const budget = Math.min(this.reservoir, dt * (this.reservoir + 400) * 1.4);
    let spent = 0;
    while (spent + PARTICLE_MASS <= budget) {
      const a = this.rng.angle();
      const speed = this.rng.range(230, 430) * (1 + this.genome.lambda * 0.35);
      const r = this.rng.range(0, 26);
      const swirl = speed * 0.55 * this.spin;
      const i = pool.spawn(
        PT.INFLATON,
        Math.cos(a) * r,
        Math.sin(a) * r,
        Math.cos(a) * speed - Math.sin(a) * swirl,
        Math.sin(a) * speed + Math.cos(a) * swirl,
        PARTICLE_MASS,
        this.rng.range(9000, 26000),
        this.rng.range(1.6, 3.2),
        this.rng.range(1.1, 2.4)
      );
      if (i < 0) break;
      spent += PARTICLE_MASS;
    }
    this.reservoir -= spent;

    if (this.inflationT > 1.9 || (this.reservoir < PARTICLE_MASS && this.inflationT > 0.6)) {
      this.phase = PHASE.STRUCTURE;
    }
  }

  /** Track the scale factor toward the size implied by the mass on hand. */
  _updateScale(dt) {
    this._scaleAcc += dt;
    if (this._scaleAcc < 0.5) return;
    this._scaleAcc = 0;
    const target = scaleFor(this.totalMass());
    this.radius += (target - this.radius) * 0.22;
  }

  _buildHash() {
    const p = this.pool;
    const h = this.hash;
    h.clear();
    const prof = this._profile;
    prof.fill(0);
    const scale = PROFILE_BINS / this.radius;

    for (let i = 0; i <= p.high; i++) {
      if (!p.alive[i]) continue;
      const t = p.type[i];
      if (t === PT.FLUX) continue;
      const x = p.x[i];
      const y = p.y[i];
      if (t === PT.GAS || t === PT.DUST) h.insert(i, x, y, p.mass[i]);
      const b = Math.min(PROFILE_BINS - 1, (Math.sqrt(x * x + y * y) * scale) | 0);
      prof[b] += p.mass[i];
    }
    for (const s of this.stars) {
      const b = Math.min(PROFILE_BINS - 1, (Math.hypot(s.x, s.y) * scale) | 0);
      prof[b] += s.mass;
    }
    for (const bh of this.blackHoles) {
      const b = Math.min(PROFILE_BINS - 1, (Math.hypot(bh.x, bh.y) * scale) | 0);
      prof[b] += bh.mass;
    }
    for (let i = 1; i < PROFILE_BINS; i++) prof[i] += prof[i - 1];
  }

  // --------------------------------------------------------------- integration

  _integrate(dt) {
    const p = this.pool;
    const h = this.hash;
    const g = this.genome;
    const G = g.G * GRAV_SCALE;
    const lam = g.lambda * LAMBDA_SCALE - CURVATURE;
    const cool = g.cooling;
    const stars = this.stars;
    const holes = this.blackHoles;
    const dim = h.dim;
    const cell = h.cell;
    const extent = h.extent;
    const R = this.radius;

    // Long-range term: everything feels the universe's own centre of mass.
    let gmx = 0;
    let gmy = 0;
    let gm = 0;
    for (let c = 0; c < h.cellMass.length; c++) {
      const m = h.cellMass[c];
      if (m === 0) continue;
      gm += m;
      gmx += h.cellMx[c];
      gmy += h.cellMy[c];
    }
    if (gm > 0) {
      gmx /= gm;
      gmy /= gm;
    }
    this._gm = gm;
    this._gmx = gmx;
    this._gmy = gmy;

    for (let i = 0; i <= p.high; i++) {
      if (!p.alive[i]) continue;
      const t = p.type[i];
      p.age[i] += dt;

      if (p.life[i] > 0 && p.age[i] >= p.life[i]) {
        this._expire(i, t);
        continue;
      }

      let x = p.x[i];
      let y = p.y[i];
      let vx = p.vx[i];
      let vy = p.vy[i];
      let ax = 0;
      let ay = 0;

      if (t === PT.FLUX) {
        // Umbilical throughput: steered, not gravitating. It is threading a
        // wormhole, so ordinary space does not get a vote.
        const child = p.ref[i];
        if (!child || !child.alive) {
          this.reservoir += p.mass[i];
          p.kill(i);
          continue;
        }
        const tx = child.anchorX;
        const ty = child.anchorY;
        const dx = tx - x;
        const dy = ty - y;
        const d = Math.hypot(dx, dy);
        if (d < 16) {
          child.feed(p.mass[i]);
          child.flash = Math.min(1, child.flash + 0.05);
          p.kill(i);
          continue;
        }
        const spd = 330;
        vx += ((dx / d) * spd - vx) * Math.min(1, dt * 5);
        vy += ((dy / d) * spd - vy) * Math.min(1, dt * 5);
        p.x[i] = x + vx * dt;
        p.y[i] = y + vy * dt;
        p.vx[i] = vx;
        p.vy[i] = vy;
        continue;
      }

      if (t === PT.ACCRETION) {
        this._spiral(i, dt);
        continue;
      }

      const gravitates = t === PT.GAS || t === PT.DUST;
      const lensed = t === PT.PHOTON;

      // --- bodies -----------------------------------------------------------
      let nearBH = null;
      let nearD2 = Infinity;
      if (gravitates || lensed) {
        for (let b = 0; b < holes.length; b++) {
          const o = holes[b];
          const dx = o.x - x;
          const dy = o.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < nearD2) {
            nearD2 = d2;
            nearBH = o;
          }
          const s = d2 + BODY_SOFT;
          const f = ((G * o.mass) / s) * (lensed ? 0.5 : 1);
          const inv = 1 / Math.sqrt(s);
          ax += dx * inv * f;
          ay += dy * inv * f;
        }
        if (gravitates) {
          for (let b = 0; b < stars.length; b++) {
            const o = stars[b];
            const dx = o.x - x;
            const dy = o.y - y;
            const s = dx * dx + dy * dy + BODY_SOFT;
            const f = (G * o.mass) / s;
            const inv = 1 / Math.sqrt(s);
            ax += dx * inv * f;
            ay += dy * inv * f;
          }
        }
      }

      // --- self-gravity of the gas, at grid resolution ----------------------
      if (gravitates) {
        const gx = ((x + extent) / cell) | 0;
        const gy = ((y + extent) / cell) | 0;
        for (let oy = -1; oy <= 1; oy++) {
          const ry = gy + oy;
          if (ry < 0 || ry >= dim) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const rx = gx + ox;
            if (rx < 0 || rx >= dim) continue;
            const c = ry * dim + rx;
            const m = h.cellMass[c];
            if (m <= 0) continue;
            const dx = h.cellMx[c] / m - x;
            const dy = h.cellMy[c] / m - y;
            const s = dx * dx + dy * dy + CELL_SOFT;
            const f = (G * m * CLUMPING) / s;
            const inv = 1 / Math.sqrt(s);
            ax += dx * inv * f;
            ay += dy * inv * f;
          }
        }
        if (gm > 0) {
          const dx = gmx - x;
          const dy = gmy - y;
          const s = dx * dx + dy * dy + 40000;
          const f = (G * gm * LONG_RANGE) / s;
          const inv = 1 / Math.sqrt(s);
          ax += dx * inv * f;
          ay += dy * inv * f;
        }
        // Net of vacuum energy and curvature, proportional to distance.
        ax += (x / R) * lam;
        ay += (y / R) * lam;
      }

      // --- species behaviour ------------------------------------------------
      let temp = p.temp[i];
      if (t === PT.GAS || t === PT.DUST) {
        // Radiative cooling, then drag once the gas is cold and dense.
        temp -= temp * cool * 0.42 * dt;
        if (temp < 55) temp = 55;
        const drag = t === PT.DUST ? 0.02 : 0.006;
        const k = Math.min(0.9, drag * dt * (1 - Math.min(1, temp / 5200)));
        vx -= vx * k;
        vy -= vy * k;
      } else if (t === PT.JET) {
        temp -= temp * 0.5 * dt;
      } else if (t === PT.INFLATON) {
        temp -= temp * 1.25 * dt;
      } else if (t === PT.PHOTON) {
        // Photons move at a fixed speed; gravity only bends them.
        const sp = Math.hypot(vx, vy) || 1;
        vx = (vx / sp) * 620;
        vy = (vy / sp) * 620;
      }
      p.temp[i] = temp;

      vx += ax * dt;
      vy += ay * dt;
      x += vx * dt;
      y += vy * dt;

      // --- capture by a black hole -----------------------------------------
      if (nearBH && (gravitates || t === PT.PHOTON)) {
        const d = Math.sqrt(nearD2);
        if (d < nearBH.horizon * 1.15) {
          nearBH.swallow(p.mass[i]);
          p.kill(i);
          continue;
        }
        if ((t === PT.GAS || t === PT.DUST) && d < nearBH.captureRadius) {
          p.retype(i, PT.ACCRETION);
          p.ref[i] = nearBH;
          // Remember where on the disc it entered, so the spiral is continuous.
          p.discA[i] = Math.atan2(y - nearBH.y, x - nearBH.x);
          p.discR[i] = d;
          p.life[i] = 0;
        }
      }

      // --- closed spatial boundary -----------------------------------------
      const r2 = x * x + y * y;
      if (r2 > R * R) {
        const r = Math.sqrt(r2);
        const nx = x / r;
        const ny = y / r;
        if (t === PT.PHOTON) {
          // Absorbed at the horizon of the closed space and returned to the
          // vacuum budget — the step that keeps starlight inside the ledger.
          this.reservoir += p.mass[i];
          p.kill(i);
          continue;
        } else {
          const dot = vx * nx + vy * ny;
          if (dot > 0) {
            vx -= 1.7 * dot * nx;
            vy -= 1.7 * dot * ny;
          }
        }
        x = nx * R;
        y = ny * R;
      }

      p.x[i] = x;
      p.y[i] = y;
      p.vx[i] = vx;
      p.vy[i] = vy;
    }
  }

  /**
   * Accretion is integrated kinematically rather than by force balance: the
   * particle's radius and phase around its hole are advanced directly, so the
   * disc is guaranteed to drain instead of settling into an orbit that a
   * softened inverse-square law can hold indefinitely.
   */
  _spiral(i, dt) {
    const p = this.pool;
    const bh = p.ref[i];
    if (!bh || bh.dead) {
      // Its hole merged away or evaporated; hand the matter back to the medium.
      p.retype(i, PT.GAS);
      p.ref[i] = null;
      p.life[i] = 0;
      p.age[i] = 0;
      p.temp[i] = 4000;
      return;
    }

    const h = bh.horizon;
    let r = p.discR[i];
    let a = p.discA[i];

    if (r <= h * 1.1) {
      bh.swallow(p.mass[i]);
      p.kill(i);
      return;
    }

    // Exponential inspiral, floored so the last stretch is not infinitely slow.
    r -= Math.max(r / 3.4, h * 0.35) * dt;
    const vOrb = 40 + 250 * Math.sqrt(h / Math.max(h, r));
    a += (bh.spin * vOrb * dt) / Math.max(h, r);

    const nx = bh.x + Math.cos(a) * r;
    const ny = bh.y + Math.sin(a) * r;
    p.vx[i] = (nx - p.x[i]) / dt;
    p.vy[i] = (ny - p.y[i]) / dt;
    p.x[i] = nx;
    p.y[i] = ny;
    p.discR[i] = r;
    p.discA[i] = a;
    // Viscous heating rises steeply toward the horizon.
    p.temp[i] = 1400 + 27000 * Math.pow(h / Math.max(h, r), 1.4);
  }

  /** Handle end-of-life for a particle: recycle its species, or bank its mass. */
  _expire(i, t) {
    const p = this.pool;
    if (t === PT.PHOTON) {
      // Starlight thermalises. Its mass goes back to the vacuum budget and
      // re-condenses as a full gas quantum, which keeps every particle in the
      // medium the same mass — molecular clouds stay meaningful.
      this.reservoir += p.mass[i];
      p.kill(i);
      return;
    }
    if (t === PT.INFLATON || t === PT.JET) {
      p.retype(i, PT.GAS);
      p.temp[i] = t === PT.JET ? 7000 : 5200;
      p.life[i] = 0;
      p.age[i] = 0;
      p.size[i] = 1.6;
      p.vx[i] *= 0.35;
      p.vy[i] *= 0.35;
      return;
    }
    this.reservoir += p.mass[i];
    p.kill(i);
  }

  // ------------------------------------------------------------ star formation

  _formStars(dt) {
    if (this.stars.length > 30) return;
    this._formAcc += dt;
    if (this._formAcc < 0.22) return;
    this._formAcc = 0;

    const need = this.ignitionMass;
    const cells = this.hash.denseCells(need, 5, this._cells);
    const p = this.pool;

    for (const c of cells) {
      // Draw the whole neighbourhood into the collapse, not just the trigger
      // cell — a cloud is bigger than one grid square, and the spread of masses
      // this produces is what decides how many stars end as singularities.
      const items = this._neighbourhood(c);
      let mass = 0;
      let mx = 0;
      let my = 0;
      let px = 0;
      let py = 0;
      let cold = 0;
      for (const i of items) {
        if (!p.alive[i]) continue;
        if (p.temp[i] > COLD_ENOUGH) continue;
        cold++;
        const m = p.mass[i];
        mass += m;
        mx += p.x[i] * m;
        my += p.y[i] * m;
        px += p.vx[i] * m;
        py += p.vy[i] * m;
      }
      if (mass < need || cold < 4) continue;

      for (const i of items) {
        if (p.alive[i] && p.temp[i] <= COLD_ENOUGH) p.kill(i);
      }

      const star = new Star(mx / mass, my / mass, px / mass, py / mass, mass, this.rng);
      this.stars.push(star);
      this.starsFormed++;
      this.starMassTotal += mass;
      if (this.stars.length > this.peakStars) this.peakStars = this.stars.length;
    }
  }

  /**
   * Bodies attract each other and sink through the gas. Without this, black
   * holes drift ballistically forever, a universe silts up with dozens of small
   * holes, and none of them ever accumulates enough to reproduce. With it,
   * mass concentrates — which is precisely the behaviour the whole argument
   * turns on.
   */
  _gravitateBodies(dt) {
    const G = this.genome.G * GRAV_SCALE * 2.2;
    const bodies = this._bodies || (this._bodies = []);
    bodies.length = 0;
    for (const s of this.stars) bodies.push(s);
    for (const b of this.blackHoles) bodies.push(b);
    const n = bodies.length;

    for (let i = 0; i < n; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const s2 = dx * dx + dy * dy + BODY_SOFT * 4;
        const inv = 1 / Math.sqrt(s2);
        const f = (G / s2) * inv * dt;
        a.vx += dx * f * b.mass;
        a.vy += dy * f * b.mass;
        b.vx -= dx * f * a.mass;
        b.vy -= dy * f * a.mass;
      }

      // Pull toward the gas, plus dynamical friction against it. Together these
      // are what let heavy objects settle into the centre instead of orbiting
      // forever at the radius where they were born.
      if (this._gm > 0) {
        const dx = this._gmx - a.x;
        const dy = this._gmy - a.y;
        const s2 = dx * dx + dy * dy + 30000;
        const inv = 1 / Math.sqrt(s2);
        const f = ((G * this._gm * 0.6) / s2) * inv * dt;
        a.vx += dx * f;
        a.vy += dy * f;
      }
      const lam = this.genome.lambda * LAMBDA_SCALE - CURVATURE;
      a.vx += (a.x / this.radius) * lam * dt;
      a.vy += (a.y / this.radius) * lam * dt;

      const drag = Math.min(0.5, 0.004 * dt);
      a.vx -= a.vx * drag;
      a.vy -= a.vy * drag;

      // Bodies stay inside the closed space.
      const r2 = a.x * a.x + a.y * a.y;
      const lim = this.radius * 0.97;
      if (r2 > lim * lim) {
        const r = Math.sqrt(r2);
        const nx = a.x / r;
        const ny = a.y / r;
        a.x = nx * lim;
        a.y = ny * lim;
        const dot = a.vx * nx + a.vy * ny;
        if (dot > 0) {
          a.vx -= 1.6 * dot * nx;
          a.vy -= 1.6 * dot * ny;
        }
      }
    }
  }

  /** Indices of every hashed particle in the 3×3 block around a cell. */
  _neighbourhood(c) {
    const h = this.hash;
    const dim = h.dim;
    const gx = c % dim;
    const gy = (c / dim) | 0;
    const out = this._items;
    out.length = 0;
    for (let oy = -1; oy <= 1; oy++) {
      const ry = gy + oy;
      if (ry < 0 || ry >= dim) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const rx = gx + ox;
        if (rx < 0 || rx >= dim) continue;
        let i = h.heads[ry * dim + rx];
        while (i !== -1) {
          out.push(i);
          i = h.next[i];
        }
      }
    }
    return out;
  }

  _updateStars(dt) {
    const p = this.pool;
    for (let s = this.stars.length - 1; s >= 0; s--) {
      const star = this.stars[s];
      star.update(dt);

      // Radiation: mass leaves the star as light and comes back as gas later.
      const lum = Math.pow(star.mass / 14, 1.35) * 7.5;
      star.emitAcc += dt * lum;
      while (star.emitAcc >= 1 && star.mass > 3) {
        star.emitAcc -= 1;
        const a = this.rng.angle();
        const i = p.spawn(
          PT.PHOTON,
          star.x + Math.cos(a) * star.radius,
          star.y + Math.sin(a) * star.radius,
          Math.cos(a) * 620,
          Math.sin(a) * 620,
          PHOTON_MASS,
          star.temp,
          1.1,
          this.rng.range(1.4, 3.0)
        );
        if (i < 0) {
          this.reservoir += PHOTON_MASS;
        }
        star.mass -= PHOTON_MASS;
      }

      if (star.dying) {
        this.stars.splice(s, 1);
        if (star.mass > this.genome.chandra * SN_FACTOR * this.ignitionMass) this._supernova(star);
        else this._nebula(star);
      }
    }
  }

  /** Core-collapse: a singularity forms and the envelope is blown off. */
  _supernova(star) {
    const coreFrac = 0.44;
    const core = star.mass * coreFrac;
    const bh = new BlackHole(star.x, star.y, star.vx * 0.4, star.vy * 0.4, core, this.rng, star.mass);
    bh.birthFlash = 1;
    this.blackHoles.push(bh);
    this.blackHolesFormed++;
    this.supernovae++;
    this.lastCollapse = this.age;
    this._emitShell(star, star.mass - core, 120, 320, 24000);
  }

  /** A low-mass star simply returns its envelope to the medium. */
  _nebula(star) {
    this._emitShell(star, star.mass, 30, 90, 6500);
  }

  _emitShell(star, mass, vMin, vMax, temp) {
    const p = this.pool;
    let left = Math.floor(mass / PARTICLE_MASS) * PARTICLE_MASS;
    this.reservoir += mass - left;
    while (left >= PARTICLE_MASS) {
      const m = PARTICLE_MASS;
      left -= m;
      const a = this.rng.angle();
      const sp = this.rng.range(vMin, vMax);
      const i = p.spawn(
        PT.GAS,
        star.x + Math.cos(a) * star.radius,
        star.y + Math.sin(a) * star.radius,
        star.vx + Math.cos(a) * sp,
        star.vy + Math.sin(a) * sp,
        m,
        temp * this.rng.range(0.7, 1.2),
        2.5
      );
      // Pool saturated: the mass waits in the vacuum instead of vanishing.
      if (i < 0) {
        this.reservoir += left + m;
        return;
      }
    }
  }

  // ------------------------------------------------------------- black holes

  _updateBlackHoles(dt, ctx) {
    const p = this.pool;
    const myMass = this.totalMass();

    for (let b = this.blackHoles.length - 1; b >= 0; b--) {
      const bh = this.blackHoles[b];
      bh.captureCap = this.radius * 0.06;
      bh.update(dt);

      // --- bud off a child universe ---------------------------------------
      const canHost =
        bh.children.length < MAX_CHILDREN_PER_BH && this.children.length < MAX_CHILDREN_PER_UNIVERSE;
      if (bh.bank >= BIRTH_COST && canHost && ctx.canBirth(this)) {
        bh.bank -= BIRTH_COST;
        bh.birthFlash = 1;
        ctx.birth(this, bh, BIRTH_COST);
      }
      // A hole that has all the offspring it can host stops saving and puts
      // everything into throughput instead.
      if (!canHost && bh.bank > 0) {
        bh.reservoir += bh.bank;
        bh.bank = 0;
      }

      // --- throughput: feed descendants, return the rest upstream ----------
      // Drained as a rate on what is stored rather than a flat cap, so a hole
      // can never quietly hoard the mass of its universe.
      const send = Math.min(bh.reservoir, (bh.reservoir * 0.55 + 6) * this.genome.yield * dt);
      if (send > 0) {
        bh.reservoir -= send;
        const kids = bh.children.filter((c) => c.alive);
        if (kids.length > 0) {
          // Matter flows down the gradient: a well-fed universe pushes most of
          // its throughput into a lean child, a lean one keeps more for itself.
          // This is what makes the tree settle into a steady state instead of
          // draining the founder into its descendants.
          let down = 0;
          const each = send / kids.length;
          for (const kid of kids) {
            const km = kid.totalMass();
            const share = Math.min(0.9, Math.max(0.12, 0.5 + (0.5 * (myMass - km)) / (myMass + km + 1)));
            const give = each * share;
            this._emitFlux(bh, kid, give);
            down += give;
          }
          bh.backflow += send - down;
        } else {
          bh.backflow += send;
        }
      }

      // --- polar jets ------------------------------------------------------
      // Everything routed "up" leaves as a relativistic outflow. For a child
      // universe that outflow surfaces in the parent; for the root it recycles
      // into its own interstellar medium.
      if (bh.backflow > 0) {
        const rate = Math.min(bh.backflow, 20 * dt + 0.02);
        bh.backflow -= rate;
        if (this.parent && this.parentBH) {
          this.parentBH.inflow += rate;
          this.massReturned += rate;
        } else {
          this._emitJet(bh, rate);
        }
      }
      // Mass arriving from descendants always erupts here as visible outflow.
      if (bh.inflow > 0) {
        const rate = Math.min(bh.inflow, 26 * dt + 0.02);
        bh.inflow -= rate;
        this._emitJet(bh, rate);
      }

      // --- horizon leakage --------------------------------------------------
      // A steady trickle back out of the hole. Structural growth would
      // otherwise be a one-way ratchet, and the universe would suffocate.
      // Superlinear in mass, so hole growth is self-limiting: past a few
      // hundred units a hole sheds as fast as it eats.
      const leak = Math.min(bh.mass * (0.006 + bh.mass * 1.2e-5) * dt, bh.mass);
      bh.mass -= leak;
      bh.reservoir += leak;

      // --- evaporation ------------------------------------------------------
      // Small, starved holes slowly evaporate; their mass returns to the vacuum
      // so it can condense into gas again rather than being lost.
      if (bh.mass < 6 && bh.rateSmoothed < 0.01 && bh.children.length === 0 && bh.age > 12) {
        this.reservoir +=
          bh.mass + bh.bank + bh.reservoir + bh.backflow + bh.inflow + bh.jetPending + bh.fluxPending;
        bh.dead = true;
        this.blackHoles.splice(b, 1);
      }
    }

    this._mergeBlackHoles();
    void p;
  }

  /** Holes that touch coalesce. Without this a universe silts up with dozens of
   *  small holes; with it, mass concentrates the way it actually does. */
  _mergeBlackHoles() {
    const holes = this.blackHoles;
    for (let i = 0; i < holes.length; i++) {
      const a = holes[i];
      if (a.dead) continue;
      for (let j = i + 1; j < holes.length; j++) {
        const b = holes[j];
        if (b.dead) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const reach = (a.horizon + b.horizon) * 1.9;
        if (dx * dx + dy * dy > reach * reach) continue;
        const big = a.mass >= b.mass ? a : b;
        const small = big === a ? b : a;
        big.absorb(small);
        if (small === a) break;
      }
    }
    for (let i = holes.length - 1; i >= 0; i--) if (holes[i].dead) holes.splice(i, 1);
  }

  /**
   * Push mass down an umbilical as discrete quanta. Emission is accumulated
   * rather than emitted per frame: a frame's worth of throughput is a fraction
   * of one particle, and spawning fractional particles floods the pool with
   * near-massless motes that crowd out real matter.
   */
  _emitFlux(bh, child, mass) {
    if (!child.alive) {
      this.reservoir += mass;
      return;
    }
    bh.fluxPending += mass;
    let left = Math.floor(bh.fluxPending / PARTICLE_MASS) * PARTICLE_MASS;
    bh.fluxPending -= left;
    while (left > 0.001) {
      const m = PARTICLE_MASS;
      left -= m;
      const a = child.anchorAngle + this.rng.gauss(0, 0.12);
      const i = this.pool.spawn(
        PT.FLUX,
        bh.x + Math.cos(a) * bh.horizon * 1.2,
        bh.y + Math.sin(a) * bh.horizon * 1.2,
        Math.cos(a) * 200,
        Math.sin(a) * 200,
        m,
        14000,
        2.0
      );
      if (i >= 0) this.pool.ref[i] = child;
      if (i < 0) {
        // No room to render the transfer — move the mass by bookkeeping.
        child.feed(left + m);
        return;
      }
    }
  }

  /** Blow mass out of the poles, in whole quanta (see _emitFlux). */
  _emitJet(bh, mass) {
    bh.jetPending += mass;
    let left = Math.floor(bh.jetPending / PARTICLE_MASS) * PARTICLE_MASS;
    bh.jetPending -= left;
    while (left > 0.001) {
      const m = PARTICLE_MASS;
      left -= m;
      const pole = this.rng.chance(0.5) ? 0 : Math.PI;
      const a = bh.jetAngle + pole + this.rng.gauss(0, 0.09);
      const sp = this.rng.range(420, 760);
      const i = this.pool.spawn(
        PT.JET,
        bh.x + Math.cos(a) * bh.horizon * 1.4,
        bh.y + Math.sin(a) * bh.horizon * 1.4,
        Math.cos(a) * sp,
        Math.sin(a) * sp,
        m,
        this.rng.range(16000, 30000),
        2.1,
        this.rng.range(1.6, 3.0)
      );
      if (i < 0) {
        this.reservoir += left + m;
        return;
      }
    }
  }

  // ------------------------------------------------------------------ vacuum

  /** Condense banked mass into gas at the horizon — matter "falling in" from
   *  the parent, or the residue of recycled structure re-entering the medium. */
  _genesis(dt) {
    if (this.reservoir <= 0) return;
    this._genesisAcc += dt;
    if (this._genesisAcc < 0.05) return;
    this._genesisAcc = 0;

    const rate = Math.min(this.reservoir, 26 + this.reservoir * 0.12);
    let left = Math.floor(rate / PARTICLE_MASS) * PARTICLE_MASS;
    while (left >= PARTICLE_MASS) {
      const m = PARTICLE_MASS;
      const a = this.rng.angle();
      const r = this.radius * this.rng.range(0.55, 0.99);
      const inward = this.rng.range(2, 18);
      const vc = this.circularSpeed(r) * this.rng.range(0.94, 1.12);
      const tx = -Math.sin(a) * this.spin * vc;
      const ty = Math.cos(a) * this.spin * vc;
      const i = this.pool.spawn(
        PT.GAS,
        Math.cos(a) * r,
        Math.sin(a) * r,
        tx - Math.cos(a) * inward + this.rng.gauss(0, 14),
        ty - Math.sin(a) * inward + this.rng.gauss(0, 14),
        m,
        this.rng.range(2400, 5200),
        2.6
      );
      if (i < 0) break;
      left -= m;
      this.reservoir -= m;
    }
  }

  _classify() {
    if (this.phase === PHASE.DISSOLVING) return;
    const structures = this.stars.length + this.blackHoles.length;
    if (this.blackHoles.length > 0) this.phase = PHASE.MATURE;
    else if (structures > 0 || this.pool.byType[PT.GAS] > 40) this.phase = PHASE.STRUCTURE;
    else this.phase = PHASE.QUIESCENT;
  }

  /** Reduce the particle budget for a universe that is far off-screen.
   *  Trimmed mass is banked, never destroyed. */
  setLOD(lod) {
    this.lod = lod;
    const cap = Math.max(180, Math.floor(this.pool.capacity * lod));
    this.pool.softCap = cap;
    if (this.pool.count > cap * 1.2) {
      const p = this.pool;
      let excess = this.pool.count - cap;
      for (let i = 0; i <= p.high && excess > 0; i++) {
        if (!p.alive[i]) continue;
        const t = p.type[i];
        if (t === PT.PHOTON || t === PT.INFLATON || t === PT.JET) {
          this.reservoir += p.mass[i];
          p.kill(i);
          excess--;
        }
      }
    }
  }

  /** Tear down, handing every gram back to whoever should inherit it. */
  dissolve() {
    this.phase = PHASE.DISSOLVING;
    const m = this.totalMass();
    this.pool.clear();
    this.stars.length = 0;
    this.blackHoles.length = 0;
    this.reservoir = 0;
    return m;
  }
}

/** Radius implied by a mass, relative to the reference universe. */
export function scaleFor(mass) {
  const f = Math.sqrt(Math.max(1, mass) / REFERENCE_MASS);
  return U_RADIUS * Math.min(1.05, Math.max(0.18, f));
}

export function resetUniverseIds() {
  nextUniverseId = 0;
}

export { PARTICLE_MASS };
