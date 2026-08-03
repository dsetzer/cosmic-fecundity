// Structure-of-arrays particle pool.
//
// Every universe owns one pool. Storage is flat typed arrays with a free-list,
// so spawning and killing are O(1) and the per-frame integration loop stays
// cache-friendly. Slots are never compacted; iteration walks `capacity` and
// skips dead slots, which is cheaper than maintaining a dense index list.

/** Particle species. Drives both physics branches and how a particle is drawn. */
export const PT = {
  GAS: 0, // cold baryonic matter — the feedstock for stars
  DUST: 1, // heavier, slower, absorbs radiation
  PHOTON: 2, // stellar radiation, short-lived, re-absorbed as gas
  ACCRETION: 3, // matter captured by a black hole, spiralling in
  JET: 4, // relativistic outflow from a black hole's poles
  FLUX: 5, // energy travelling along an umbilical between universes
  INFLATON: 6, // the expanding shell of a young universe
};

export const PT_COUNT = 7;

export class ParticlePool {
  constructor(capacity) {
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.mass = new Float32Array(capacity);
    this.temp = new Float32Array(capacity); // Kelvin-ish; drives colour
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity); // <= 0 means "never expires"
    this.size = new Float32Array(capacity);
    // Cached gravitational acceleration. Forces are re-solved every few
    // substeps and held constant in between — acceleration varies far more
    // slowly than position, and a full tree walk per particle per substep is
    // the single most expensive thing in the simulation.
    this.ax = new Float32Array(capacity);
    this.ay = new Float32Array(capacity);
    this.type = new Uint8Array(capacity);
    this.alive = new Uint8Array(capacity);
    // Object slot, used by ACCRETION particles to hold the black hole they are
    // spiralling into. Kept out of the typed arrays deliberately: the disc has
    // to follow a specific hole across merges, not "whichever is nearest".
    this.ref = new Array(capacity).fill(null);
    // Orbital state for ACCRETION particles: radius and phase around `ref`.
    this.discR = new Float32Array(capacity);
    this.discA = new Float32Array(capacity);

    this.freeList = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.freeList[i] = capacity - 1 - i;
    this.freeCount = capacity;

    this.count = 0;
    /** Soft cap, lowered for out-of-focus universes to keep the frame budget flat. */
    this.softCap = capacity;
    /** Highest slot ever used, so iteration can stop early on sparse pools. */
    this.high = 0;
    this.byType = new Uint32Array(PT_COUNT);
  }

  /**
   * Allocate a particle. Returns its index, or -1 when the pool is saturated —
   * callers treat -1 as back-pressure rather than an error, which is what keeps
   * the whole multiverse inside a fixed memory budget. Species that need to
   * remember an object (an accretion disc's hole, an umbilical's destination)
   * set `ref[i]` after the call.
   */
  spawn(type, x, y, vx, vy, mass, temp, size, life = 0) {
    if (this.freeCount === 0 || this.count >= this.softCap) return -1;
    const i = this.freeList[--this.freeCount];
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.mass[i] = mass;
    this.temp[i] = temp;
    this.size[i] = size;
    this.age[i] = 0;
    this.life[i] = life;
    this.ax[i] = 0;
    this.ay[i] = 0;
    this.type[i] = type;
    this.alive[i] = 1;
    this.count++;
    this.byType[type]++;
    if (i > this.high) this.high = i;
    return i;
  }

  kill(i) {
    if (!this.alive[i]) return 0;
    this.alive[i] = 0;
    this.ref[i] = null;
    this.byType[this.type[i]]--;
    this.count--;
    this.freeList[this.freeCount++] = i;
    return this.mass[i];
  }

  /** Change species in place, keeping position and momentum. */
  retype(i, type) {
    this.byType[this.type[i]]--;
    this.type[i] = type;
    this.byType[type]++;
  }

  /** Total mass carried by live particles — used by the conservation ledger. */
  totalMass() {
    let sum = 0;
    for (let i = 0; i <= this.high; i++) if (this.alive[i]) sum += this.mass[i];
    return sum;
  }

  clear() {
    this.freeCount = this.capacity;
    for (let i = 0; i < this.capacity; i++) {
      this.freeList[i] = this.capacity - 1 - i;
      this.alive[i] = 0;
    }
    this.byType.fill(0);
    this.ref.fill(null);
    this.count = 0;
    this.high = 0;
  }
}
