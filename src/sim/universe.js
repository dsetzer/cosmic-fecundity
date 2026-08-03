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
import { Quadtree } from '../engine/quadtree.js';
import { Star, BlackHole } from './bodies.js';
import { generationColor } from '../engine/color.js';

/** Every universe uses the same local coordinate space, so nesting never
 *  degrades floating-point precision no matter how deep the lineage goes.
 *  This is the radius of a universe holding the reference mass; smaller ones
 *  are correspondingly smaller, which keeps their gas dense enough to collapse. */
export const U_RADIUS = 1000;
export const REFERENCE_MASS = 6200;

const GRID_CELL = 40;

/**
 * Gravity is a genuine N-body solve: every particle, star and black hole goes
 * into one Barnes-Hut tree each step and is accelerated by all the others.
 * There is no imposed central force and no boundary — a universe is held
 * together by its own mass, the way a real self-gravitating system is, and
 * anything that ends up unbound really does leave.
 */
const GRAV_SCALE = 2200;
const SOFTENING2 = 1250; // softening length², keeps close encounters finite
const THETA2 = 0.85 * 0.85; // Barnes-Hut opening angle, squared
/** Substeps between full force solves. Acceleration changes slowly compared to
 *  position, so re-solving every step buys accuracy nobody can see. */
const FORCE_INTERVAL = 3;
/** Speed ceiling, in units/s. Softened gravity cannot produce a true
 *  singularity in the force law, but a close pass can still throw a particle
 *  hard enough to spoil the integration. */
const V_MAX = 520;

/**
 * Vacuum energy: a genuine repulsive acceleration proportional to distance,
 * which is how a cosmological constant actually behaves. Nothing pulls back
 * except the universe's own gravity, so a universe with too much Λ really does
 * come apart before it can form structure — that is the selection pressure,
 * not a tuned penalty.
 */
// Calibrated against the gravity of a typical universe: at the founding value
// the repulsion is a sizeable but sub-dominant fraction of the inward pull, and
// it overwhelms gravity somewhere past Λ ≈ 1.2. Because it grows with radius
// while gravity falls off, it also sets a natural outer scale — matter inside
// that radius stays bound, matter outside it accelerates away, which is what a
// cosmological constant genuinely does.
const LAMBDA_SCALE = 0.03;

/** Bins used to find the half-mass radius. */
const RADIAL_BINS = 40;

/** Beyond this multiple of the matter radius a particle has left for good. */
const ESCAPE_FACTOR = 2.2;

/** Disc viscosity, per second, at the horizon. Gas rubbing against gas is what
 *  lets an accretion disc shed angular momentum and drain; without it a disc
 *  orbits forever and the hole starves. */
const DISC_VISCOSITY = 2.4;

const PARTICLE_MASS = 1.0;
/** Mass a grid cell must hold before its gas is self-gravitating. Derived from
 *  the reference density so that a small universe and a large one form stars
 *  with the same statistics — only the number of cells differs. */
// Sized so that stars stay a small share of a universe's mass. Let stars carry
// most of it and the system becomes a few dozen heavy point masses, which
// relax, segregate and evaporate — real dynamics, but nothing like a galaxy,
// because a real star is a negligible fraction of the mass around it.
const OVERDENSITY = 3.2;
const IGNITION_BASE = (REFERENCE_MASS / (Math.PI * U_RADIUS * U_RADIUS)) * GRID_CELL * GRID_CELL * OVERDENSITY;
const COLD_ENOUGH = 1400; // K — warmer gas is pressure-supported
// Small enough that a star sheds only a modest fraction of itself over its
// life. At the previous value a star radiated away everything it had before it
// could reach the collapse limit, so nothing ever became a singularity.
const PHOTON_MASS = 0.0015;
/** A star collapses to a singularity when its mass exceeds the collapse-limit
 *  gene times this multiple of the universe's own ignition mass. Expressing it
 *  relative to the local cloud scale — rather than in absolute units — is what
 *  makes the gene mean the same thing in a small universe and a large one. */
const SN_FACTOR = 0.7;

/** Ceiling on the share of a universe's mass that may sit in stars at once. */
const STELLAR_FRACTION = 0.22;

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
    this.hash = new SpatialHash(U_RADIUS * 1.6, GRID_CELL, capacity);
    /** One tree per universe, sized for every particle plus every body. */
    this.tree = new Quadtree(capacity + 128);
    this._treeSlot = new Int32Array(capacity);
    this._starSlots = [];
    this._holeSlots = [];
    this._forceTick = 0;
    this._treeBuilt = false;
    this._radialBins = new Float32Array(RADIAL_BINS);
    this.stars = [];
    this.blackHoles = [];

    /** Mass held in the vacuum, waiting to condense into particles. */
    this.reservoir = dowry;
    /** The dowry, remembered: the inflating disc needs to know its own total
     *  before any of it has been laid down. */
    this.birthMass = dowry;
    /** Scale factor. A universe expands as its parent feeds it and contracts as
     *  it hands mass back — cosmic expansion driven by the umbilical. */
    this.radius = scaleFor(dowry);
    /** Radius containing half the matter. Set here rather than alongside the
     *  other scratch state because it is derived from `radius`, which is
     *  assigned below it. */
    this.halfMassRadius = this.radius * 0.42;
    /**
     * Scale of the disc laid down at the bounce. Fixed at birth — deriving it
     * from the measured radius while the disc is still being created feeds the
     * measurement back into the velocities it is measuring — and set well
     * inside the radius where the vacuum takes over, so that the breathing of
     * a starburst cycle cannot carry the whole disc out past the point of no
     * return.
     */
    this.discRadius = this.boundRadius * 0.3;
    this.radius = this.discRadius * 1.7;
    this.halfMassRadius = this.discRadius * 0.6;
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
    /** Mass that left the system entirely and went back to the vacuum budget. */
    this.massEscaped = 0;
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
    this._items2 = new Int32Array(capacity);
    this._dissolveT = 0;
    this._scaleAcc = 0;
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
  /** Radius containing essentially all of the matter. Measured, not imposed:
   *  there is no wall here, so this is simply where the universe currently is.
   *  Used for framing, for placing offspring, and for the escape test. */
  get matterRadius() {
    return this.radius;
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

    this._buildHash();
    this._gravity(dt);
    this._integrate(dt);
    this._formStars(dt);
    this._updateStars(dt);
    this._updateBlackHoles(dt, ctx);
    this._genesis(dt);
    if (this.phase !== PHASE.INFLATION) this._measureExtent(dt);
    this._classify();
  }

  /**
   * The bounce: banked mass condenses into a rotating disc.
   *
   * The velocity field matters more than it looks. Matter laid down cold — or
   * with a speed derived from the mass already present, which is zero before
   * the first particle exists — undergoes a cold collapse, and a cold collapse
   * violently ejects a large fraction of itself and never recovers. So the
   * disc is laid down already rotating, on the solid-body curve that a uniform
   * disc of this mass actually has, and it is stable from the first frame.
   */
  _inflate(dt) {
    this.inflationT += dt;
    const pool = this.pool;
    const budget = Math.min(this.reservoir, dt * (this.reservoir + 400) * 1.4);

    // Enclosed mass of a uniform disc grows as r², so the circular speed grows
    // linearly with radius: v(r) = r · sqrt(G M / R³).
    const R0 = this.discRadius;
    const M = Math.max(1, this.birthMass);
    const omega = Math.sqrt((this.genome.G * GRAV_SCALE * M) / (R0 * R0 * R0));
    const vEdge = omega * R0;

    // Rotation alone is not enough. A self-gravitating disc with no random
    // motion is violently unstable: it fragments, the fragments scatter each
    // other, and the disc heats until half of it is unbound. Real discs are
    // held up by velocity dispersion as well as rotation, so this one starts
    // with both, near virial equilibrium.
    const sigma = vEdge * 0.28;

    let spent = 0;
    while (spent + PARTICLE_MASS <= budget) {
      const a = this.rng.angle();
      const r = Math.sqrt(this.rng.float()) * R0;
      const vt = omega * r * this.spin * 0.88;
      const disp = sigma;
      const i = pool.spawn(
        PT.INFLATON,
        Math.cos(a) * r,
        Math.sin(a) * r,
        -Math.sin(a) * vt + this.rng.gauss(0, disp),
        Math.cos(a) * vt + this.rng.gauss(0, disp),
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

  /**
   * Circular speed at radius r for the mass currently inside it. Used only to
   * choose sensible velocities for matter *entering* the universe — once a
   * particle exists, its trajectory comes from the force solve and nothing
   * else.
   */
  circularScale(r) {
    const m = this.massWithin(r);
    if (m <= 0) return 0;
    return Math.sqrt((this.genome.G * GRAV_SCALE * m) / Math.max(40, r));
  }

  /**
   * Radius where the vacuum's outward push balances the universe's own inward
   * pull. Inside it matter is bound; outside it accelerates away. A stable,
   * physically meaningful scale — unlike the half-mass radius, which swings
   * with every starburst — so it is what new matter is injected against.
   */
  get boundRadius() {
    const lam = this.genome.lambda * LAMBDA_SCALE;
    const gm = this.genome.G * GRAV_SCALE * Math.max(1, this.totalMass());
    if (!(lam > 1e-9)) return U_RADIUS;
    return Math.cbrt(gm / lam);
  }

  massWithin(r) {
    const p = this.pool;
    const r2 = r * r;
    let m = 0;
    for (let i = 0; i <= p.high; i++) {
      if (!p.alive[i]) continue;
      const t = p.type[i];
      if (t === PT.FLUX) continue;
      if (p.x[i] * p.x[i] + p.y[i] * p.y[i] <= r2) m += p.mass[i];
    }
    for (const s of this.stars) if (s.x * s.x + s.y * s.y <= r2) m += s.mass;
    for (const b of this.blackHoles) if (b.x * b.x + b.y * b.y <= r2) m += b.mass;
    return m;
  }

  _buildHash() {
    const p = this.pool;
    const h = this.hash;
    h.extent = Math.max(200, this.radius * 1.4);
    h.clear();
    for (let i = 0; i <= p.high; i++) {
      if (!p.alive[i]) continue;
      const t = p.type[i];
      if (t !== PT.GAS && t !== PT.DUST) continue;
      h.insert(i, p.x[i], p.y[i], p.mass[i]);
    }
  }

  // ----------------------------------------------------------------- gravity

  /**
   * One Barnes-Hut solve over every gravitating thing in the universe. Gas,
   * dust, infalling matter, stars and black holes all sit in the same tree and
   * all feel each other; nothing is on a rail.
   */
  _gravity(dt) {
    this._forceTick = (this._forceTick + 1) % FORCE_INTERVAL;
    if (this._forceTick !== 0 && this._treeBuilt) return;

    const p = this.pool;
    const tree = this.tree;
    const G = this.genome.G * GRAV_SCALE;
    const lambda = this.genome.lambda * LAMBDA_SCALE;

    tree.reset();
    const slot = this._treeSlot;
    for (let i = 0; i <= p.high; i++) {
      slot[i] = -1;
      if (!p.alive[i]) continue;
      const t = p.type[i];
      // Light and umbilical throughput carry mass but are not sources: photons
      // are massless in every sense that matters here, and flux is inside a
      // wormhole rather than in this universe's space.
      if (t === PT.PHOTON || t === PT.FLUX) continue;
      slot[i] = tree.add(p.x[i], p.y[i], p.mass[i]);
    }
    const starSlot = this._starSlots;
    starSlot.length = 0;
    for (const s of this.stars) starSlot.push(tree.add(s.x, s.y, s.mass));
    const holeSlot = this._holeSlots;
    holeSlot.length = 0;
    for (const b of this.blackHoles) holeSlot.push(tree.add(b.x, b.y, b.mass));

    tree.build();
    this._treeBuilt = true;

    for (let i = 0; i <= p.high; i++) {
      if (!p.alive[i]) continue;
      const t = p.type[i];
      const x = p.x[i];
      const y = p.y[i];
      if (t === PT.FLUX) continue;

      if (t === PT.PHOTON) {
        // Light is deflected but does not fall: only the strongest local
        // gradient bends it, and it never picks up speed.
        tree.accel(x, y, G * 0.35, SOFTENING2 * 4, THETA2, -1);
        p.ax[i] = tree.ax;
        p.ay[i] = tree.ay;
        continue;
      }

      tree.accel(x, y, G, SOFTENING2, THETA2, slot[i]);
      p.ax[i] = tree.ax + x * lambda;
      p.ay[i] = tree.ay + y * lambda;
    }

    // Stars and black holes are solved from the same tree, so a star really is
    // pulled by the gas it formed from and by every other body.
    for (let k = 0; k < this.stars.length; k++) {
      const s = this.stars[k];
      tree.accel(s.x, s.y, G, SOFTENING2, THETA2, starSlot[k]);
      s.ax = tree.ax + s.x * lambda;
      s.ay = tree.ay + s.y * lambda;
    }
    for (let k = 0; k < this.blackHoles.length; k++) {
      const b = this.blackHoles[k];
      tree.accel(b.x, b.y, G, SOFTENING2, THETA2, holeSlot[k]);
      b.ax = tree.ax + b.x * lambda;
      b.ay = tree.ay + b.y * lambda;
    }
    void dt;
  }

  // --------------------------------------------------------------- integration

  _integrate(dt) {
    const p = this.pool;
    const cool = this.genome.cooling;
    const holes = this.blackHoles;
    const escape = this.boundRadius * ESCAPE_FACTOR;
    const escape2 = escape * escape;

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

      if (t === PT.FLUX) {
        // Umbilical throughput: steered, not gravitating. It is threading a
        // wormhole, so ordinary space does not get a vote.
        const child = p.ref[i];
        if (!child || !child.alive) {
          this.reservoir += p.mass[i];
          p.kill(i);
          continue;
        }
        const dx = child.anchorX - x;
        const dy = child.anchorY - y;
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

      vx += p.ax[i] * dt;
      vy += p.ay[i] * dt;

      let temp = p.temp[i];
      if (t === PT.GAS || t === PT.DUST) {
        temp -= temp * cool * 0.42 * dt;
        if (temp < 55) temp = 55;
      } else if (t === PT.JET) {
        temp -= temp * 0.5 * dt;
      } else if (t === PT.INFLATON) {
        temp -= temp * 1.25 * dt;
      } else if (t === PT.PHOTON) {
        // Photons travel at a fixed speed; gravity only changes their heading.
        const sp = Math.hypot(vx, vy) || 1;
        vx = (vx / sp) * 300;
        vy = (vy / sp) * 300;
      }

      // --- black holes: capture, and the viscosity that lets a disc drain ---
      let captured = false;
      for (let b = 0; b < holes.length; b++) {
        const o = holes[b];
        const dx = x - o.x;
        const dy = y - o.y;
        const d2 = dx * dx + dy * dy;
        const h = o.horizon;
        if (d2 < h * h) {
          o.swallow(p.mass[i]);
          p.kill(i);
          captured = true;
          break;
        }
        if (t !== PT.GAS && t !== PT.DUST && t !== PT.ACCRETION) continue;
        const reach = o.influenceRadius;
        if (d2 > reach * reach) continue;

        // Inside the disc, gas rubs against gas. Real viscosity transports
        // angular momentum outward and lets the rest sink; here that is a drag
        // on motion relative to the hole, strongest where the disc is densest.
        // The orbit itself is never scripted — it comes out of the force solve.
        const d = Math.sqrt(d2) || 1;
        const rel = d / h;
        const visc = DISC_VISCOSITY / (1 + rel * rel * 0.06);
        const rvx = vx - o.vx;
        const rvy = vy - o.vy;
        const k = Math.min(0.5, visc * dt);
        vx -= rvx * k;
        vy -= rvy * k;
        if (t !== PT.ACCRETION) p.retype(i, PT.ACCRETION);
        p.ref[i] = o;
        temp += (1400 + 26000 * Math.pow(h / d, 1.3) - temp) * Math.min(1, dt * 1.6);
      }
      if (captured) continue;

      // Matter that drifted out of every hole's reach is ordinary gas again.
      if (t === PT.ACCRETION && p.ref[i]) {
        const o = p.ref[i];
        const dx = x - o.x;
        const dy = y - o.y;
        const reach = o.influenceRadius;
        if (o.dead || dx * dx + dy * dy > reach * reach) {
          p.retype(i, PT.GAS);
          p.ref[i] = null;
        }
      }

      p.temp[i] = temp;

      const sp2 = vx * vx + vy * vy;
      if (!(sp2 >= 0)) {
        // Non-finite: drop the particle back into the vacuum budget rather than
        // letting a NaN spread through the tree into every other trajectory.
        this.reservoir += p.mass[i];
        p.kill(i);
        continue;
      }
      if (sp2 > V_MAX * V_MAX) {
        const s = V_MAX / Math.sqrt(sp2);
        vx *= s;
        vy *= s;
      }

      x += vx * dt;
      y += vy * dt;

      // No wall. A particle thrown clear of the universe's gravity simply
      // leaves, and its mass returns to the vacuum budget so the ledger still
      // balances and the matter can condense again later.
      if (x * x + y * y > escape2) {
        this.reservoir += p.mass[i];
        this.massEscaped += p.mass[i];
        p.kill(i);
        continue;
      }

      p.x[i] = x;
      p.y[i] = y;
      p.vx[i] = vx;
      p.vy[i] = vy;
    }

    this._moveBodies(dt, escape2);
  }

  /** Stars and holes integrate from the same force solve as everything else. */
  _moveBodies(dt, escape2) {
    for (const s of this.stars) {
      s.vx += s.ax * dt;
      s.vy += s.ay * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    for (const b of this.blackHoles) {
      b.vx += b.ax * dt;
      b.vy += b.ay * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    // A star flung clear of the system takes its mass with it; a black hole is
    // heavy enough that letting it wander off would drain the universe, so it
    // is treated as still bound and turned around at the escape radius.
    for (let i = this.stars.length - 1; i >= 0; i--) {
      const s = this.stars[i];
      if (s.x * s.x + s.y * s.y > escape2) {
        this.reservoir += s.mass;
        this.massEscaped += s.mass;
        this.stars.splice(i, 1);
      }
    }
    for (const b of this.blackHoles) {
      const r2 = b.x * b.x + b.y * b.y;
      if (r2 > escape2) {
        const r = Math.sqrt(r2);
        b.vx -= (b.vx * b.x + b.vy * b.y) / r2 * b.x * 1.8;
        b.vy -= (b.vx * b.x + b.vy * b.y) / r2 * b.y * 1.8;
        void r;
      }
    }
  }

  /** Track where the matter actually is, so framing follows the universe
   *  rather than the universe being forced to fit the frame. */
  _measureExtent(dt) {
    this._scaleAcc += dt;
    if (this._scaleAcc < 0.4) return;
    this._scaleAcc = 0;

    const p = this.pool;
    const bins = this._radialBins;
    bins.fill(0);
    const span = this.radius * 2.5;
    const scale = RADIAL_BINS / span;
    let m = 0;

    const put = (x, y, mass) => {
      const r = Math.sqrt(x * x + y * y);
      const b = Math.min(RADIAL_BINS - 1, (r * scale) | 0);
      bins[b] += mass;
      m += mass;
    };
    for (let i = 0; i <= p.high; i++) {
      if (!p.alive[i] || p.type[i] === PT.FLUX) continue;
      put(p.x[i], p.y[i], p.mass[i]);
    }
    for (const s of this.stars) put(s.x, s.y, s.mass);
    for (const b of this.blackHoles) put(b.x, b.y, b.mass);
    if (m <= 0) return;

    // Half-mass radius. A root-mean-square radius is dominated by the few
    // particles on their way out of the system and pulls the frame open;
    // the half-mass radius tracks where the universe actually is.
    let acc = 0;
    let half = RADIAL_BINS - 1;
    for (let b = 0; b < RADIAL_BINS; b++) {
      acc += bins[b];
      if (acc >= m * 0.5) {
        half = b;
        break;
      }
    }
    const rHalf = ((half + 0.5) / RADIAL_BINS) * span;
    this.halfMassRadius = rHalf;
    if (!Number.isFinite(rHalf) || rHalf <= 0) return;
    const cap = Math.min(U_RADIUS * 1.5, this.boundRadius * 1.5);
    const target = Math.max(120, Math.min(cap, rHalf * 2.4));
    this.radius += (target - this.radius) * 0.25;
  }

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
    if (this.stars.length > 70) return;
    this._formAcc += dt;
    if (this._formAcc < 0.22) return;
    this._formAcc = 0;

    // Star-formation efficiency. Left alone, a self-gravitating gas disc turns
    // most of itself into stars within seconds, and a universe whose mass is
    // mostly point-like stars relaxes and evaporates. Real star formation is
    // inefficient — a few percent of a cloud per free-fall time — and this is
    // the same limit: gas stays the dominant component.
    let stellar = 0;
    for (const s of this.stars) stellar += s.mass;
    if (stellar > this.totalMass() * STELLAR_FRACTION) return;

    const need = this.ignitionMass;
    const maxMass = need * 3.4;
    const cells = this.hash.denseCells(need, 2, this._cells);
    const p = this.pool;

    for (const c of cells) {
      const items = this.hash.cellItems(c, this._items);
      // Coldest gas collapses first, and only as much as one star can take.
      items.sort((a, b) => p.temp[a] - p.temp[b]);

      let mass = 0;
      let mx = 0;
      let my = 0;
      let px = 0;
      let py = 0;
      let taken = 0;
      for (const i of items) {
        if (!p.alive[i] || p.temp[i] > COLD_ENOUGH) continue;
        if (mass >= maxMass) break;
        const m = p.mass[i];
        mass += m;
        mx += p.x[i] * m;
        my += p.y[i] * m;
        px += p.vx[i] * m;
        py += p.vy[i] * m;
        this._items2[taken++] = i;
      }
      if (mass < need || taken < 4) continue;

      for (let k = 0; k < taken; k++) p.kill(this._items2[k]);

      const star = new Star(mx / mass, my / mass, px / mass, py / mass, mass, this.rng);
      this.stars.push(star);
      this.starsFormed++;
      this.starMassTotal += mass;
      if (this.stars.length > this.peakStars) this.peakStars = this.stars.length;
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
          Math.cos(a) * 300,
          Math.sin(a) * 300,
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
    this._emitShell(star, star.mass - core, 30, 95, 24000);
  }

  /** A low-mass star simply returns its envelope to the medium. */
  _nebula(star) {
    this._emitShell(star, star.mass, 8, 30, 6500);
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
      const sp = this.rng.range(60, 150);
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

    const rate = Math.min(this.reservoir, 0.9 + this.reservoir * 0.02);
    let left = Math.floor(rate / PARTICLE_MASS) * PARTICLE_MASS;

    // Matter enters through the mouth of the umbilical that feeds this
    // universe, as a stream falling into the potential — not as a uniform
    // shower on a rim, which was what produced the ring of orbits.
    const mouth = this._mouthAngle();
    // Matter arrives at the outskirts of the *bound* material, not at the
    // nominal frame edge — dropping it far outside the mass leaves it with
    // nothing to orbit, and lets the frame drift open a little further every
    // time it happens.
    const r0 = Math.max(80, this.boundRadius * 0.5);

    while (left >= PARTICLE_MASS) {
      const m = PARTICLE_MASS;
      const a = mouth + this.rng.gauss(0, 0.9);
      const r = r0 * this.rng.range(0.75, 1.12);
      const vc = this.circularScale(r);
      // Injected on a loosely bound, eccentric orbit: enough angular momentum
      // to swing past the centre rather than fall straight in, but not so much
      // that it parks in a circle at the radius it arrived at.
      const tang = vc * this.rng.range(0.72, 1.0) * this.spin;
      const infall = vc * this.rng.range(0.05, 0.3);
      const i = this.pool.spawn(
        PT.GAS,
        Math.cos(a) * r,
        Math.sin(a) * r,
        -Math.cos(a) * infall - Math.sin(a) * tang + this.rng.gauss(0, vc * 0.12),
        -Math.sin(a) * infall + Math.cos(a) * tang + this.rng.gauss(0, vc * 0.12),
        m,
        this.rng.range(2400, 5200),
        2.6
      );
      if (i < 0) break;
      left -= m;
      this.reservoir -= m;
    }
  }

  /** Direction the feeding umbilical enters from, in local coordinates. */
  _mouthAngle() {
    if (this._mouth === undefined || this.age - this._mouthAt > 9) {
      this._mouth = this.rng.angle();
      this._mouthAt = this.age;
    }
    return this._mouth;
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
