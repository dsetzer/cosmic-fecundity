// Massive bodies: stars and black holes.
//
// Particles are cheap and numerous; bodies are few and expensive. Gravity is
// solved as an N-body problem only between particles and bodies (O(N·M) with M
// in the low tens), which is both fast and visually correct — the gas really
// does fall onto the objects you can see.

import { blackbody } from '../engine/color.js';

let nextBodyId = 1;

export class Star {
  constructor(x, y, vx, vy, mass, rng) {
    this.id = nextBodyId++;
    this.kind = 'star';
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.mass = mass;
    this.age = 0;
    /** Acceleration from the universe's force solve, applied by the caller. */
    this.ax = 0;
    this.ay = 0;
    // Massive stars burn their fuel disproportionately fast. This is what makes
    // a high-mass universe a fast-turnover universe.
    this.lifespan = 90 * Math.pow(24 / mass, 1.2) * rng.range(0.75, 1.3);
    this.radius = 5 + Math.pow(mass, 0.55) * 1.9;
    this.temp = 2600 + Math.pow(mass, 1.25) * 340;
    this.color = blackbody(this.temp);
    this.emitAcc = 0;
    this.flicker = rng.angle();
    this.dying = false;
    this.dead = false;
  }

  /** 0 → newborn, 1 → about to leave the main sequence. */
  get burn() {
    return this.age / this.lifespan;
  }

  update(dt) {
    this.age += dt;
    this.flicker += dt * 3.1;
    // Late-life expansion into a red giant: cooler, larger, brighter in red.
    const b = this.burn;
    if (b > 0.78) {
      const t = (b - 0.78) / 0.22;
      this.radius = (5 + Math.pow(this.mass, 0.55) * 1.9) * (1 + t * 1.6);
      this.temp = (2600 + Math.pow(this.mass, 1.25) * 340) * (1 - t * 0.55);
      this.color = blackbody(this.temp);
    }
    if (b >= 1) this.dying = true;
  }
}

export class BlackHole {
  constructor(x, y, vx, vy, mass, rng, progenitorMass = 0) {
    this.id = nextBodyId++;
    this.kind = 'bh';
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.mass = mass;
    this.progenitorMass = progenitorMass;
    this.age = 0;
    /** Acceleration from the universe's force solve, applied by the caller. */
    this.ax = 0;
    this.ay = 0;
    this.spin = rng.chance(0.5) ? 1 : -1;
    this.diskPhase = rng.angle();
    this.jetAngle = rng.angle();
    /** Throughput: swallowed mass earmarked for feeding and outflow. */
    this.reservoir = 0;
    /** Savings: swallowed mass banked toward the next universe. Kept separate
     *  so ongoing feeding can never starve reproduction, or vice versa. */
    this.bank = 0;
    /** Mass routed upstream, waiting to leave this universe. */
    this.backflow = 0;
    /** Mass arriving from descendants, waiting to be blown out as jets here. */
    this.inflow = 0;
    this.accretionRate = 0;
    this.rateSmoothed = 0;
    /** Child universe ids, in birth order. */
    this.children = [];
    this.birthFlash = 0;
    /** Sub-quantum outflow waiting to become a jet particle. */
    this.jetPending = 0;
    /** Upper bound on the capture radius, in world units. */
    this.captureCap = 1e9;
    /** Sub-quantum throughput waiting to become an umbilical quantum. */
    this.fluxPending = 0;
    this.dead = false;
  }

  /** Event horizon in world units. Schwarzschild radius is linear in mass, but
   *  a square root reads better across three orders of magnitude on screen. */
  get horizon() {
    return 4.5 + Math.pow(this.mass, 0.44) * 1.7;
  }

  /** Radius inside which gas is dense enough for viscosity to matter. Outside
   *  it the hole still pulls — through the tree, like everything else — but the
   *  gas is on a clean ballistic orbit. */
  get influenceRadius() {
    return Math.min(this.horizon * 22, this.captureCap * 3);
  }

  update(dt) {
    this.age += dt;
    this.diskPhase += dt * this.spin * 1.4;
    this.jetAngle += dt * this.spin * 0.09;
    this.rateSmoothed += (this.accretionRate - this.rateSmoothed) * Math.min(1, dt * 2.2);
    this.accretionRate = 0;
    if (this.birthFlash > 0) this.birthFlash = Math.max(0, this.birthFlash - dt * 1.1);
  }

  /**
   * Swallow a mass, splitting it three ways. The shares sum to exactly 1, so
   * nothing is created or lost — and only a small fraction is retained as
   * structural growth, because a hole that keeps everything it eats strangles
   * its own universe inside a few minutes.
   */
  swallow(m) {
    // The retained share falls away as the hole grows: past a few hundred units
    // a black hole stops being a sink and becomes almost pure throughput, which
    // is what stops one supermassive hole from swallowing its whole universe.
    const keep = 0.16 * (240 / (240 + this.mass));
    const rest = 1 - keep;
    this.mass += m * keep;
    this.bank += m * rest * 0.52; // savings toward the next universe
    this.reservoir += m * rest * 0.48; // throughput: feeds offspring, or jets
    this.accretionRate += m;
    return this.bank;
  }

  /** Absorb another hole entirely — mass, savings, throughput and offspring. */
  absorb(other) {
    const total = this.mass + other.mass;
    this.vx = (this.vx * this.mass + other.vx * other.mass) / total;
    this.vy = (this.vy * this.mass + other.vy * other.mass) / total;
    this.x = (this.x * this.mass + other.x * other.mass) / total;
    this.y = (this.y * this.mass + other.y * other.mass) / total;
    this.mass = total;
    this.ax = (this.ax * this.mass + other.ax * other.mass) / total;
    this.ay = (this.ay * this.mass + other.ay * other.mass) / total;
    this.bank += other.bank;
    this.reservoir += other.reservoir;
    this.backflow += other.backflow;
    this.inflow += other.inflow;
    this.jetPending += other.jetPending;
    this.fluxPending += other.fluxPending;
    this.birthFlash = Math.max(this.birthFlash, 0.8);
    for (const c of other.children) {
      c.parentBH = this;
      this.children.push(c);
    }
    other.children.length = 0;
    other.dead = true;
  }
}

export function resetBodyIds() {
  nextBodyId = 1;
}
