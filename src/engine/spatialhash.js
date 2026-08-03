// Uniform grid over a universe's disc, rebuilt each frame.
//
// Used for the only genuinely N-body-ish part of the simulation: finding where
// cold gas has clumped densely enough to ignite a star. Buckets are stored as
// intrusive linked lists inside typed arrays so the whole structure allocates
// once and never produces garbage.

export class SpatialHash {
  /**
   * @param {number} extent half-width of the region to cover (universe radius)
   * @param {number} cell   grid cell size in world units
   * @param {number} capacity maximum number of inserted items
   */
  constructor(extent, cell, capacity) {
    this.extent = extent;
    this.cell = cell;
    this.dim = Math.max(1, Math.ceil((extent * 2) / cell));
    this.heads = new Int32Array(this.dim * this.dim);
    this.next = new Int32Array(capacity);
    this.cx = new Float32Array(capacity);
    this.cy = new Float32Array(capacity);
    this.cellCount = new Uint16Array(this.dim * this.dim);
    this.cellMass = new Float32Array(this.dim * this.dim);
    // First moments, so each cell can act as a single gravitating clump.
    this.cellMx = new Float32Array(this.dim * this.dim);
    this.cellMy = new Float32Array(this.dim * this.dim);
    this.heads.fill(-1);
  }

  clear() {
    this.heads.fill(-1);
    this.cellCount.fill(0);
    this.cellMass.fill(0);
    this.cellMx.fill(0);
    this.cellMy.fill(0);
  }

  cellIndex(x, y) {
    let gx = Math.floor((x + this.extent) / this.cell);
    let gy = Math.floor((y + this.extent) / this.cell);
    if (gx < 0) gx = 0;
    else if (gx >= this.dim) gx = this.dim - 1;
    if (gy < 0) gy = 0;
    else if (gy >= this.dim) gy = this.dim - 1;
    return gy * this.dim + gx;
  }

  insert(i, x, y, mass) {
    const c = this.cellIndex(x, y);
    this.next[i] = this.heads[c];
    this.heads[c] = i;
    this.cx[i] = x;
    this.cy[i] = y;
    this.cellCount[c]++;
    this.cellMass[c] += mass;
    this.cellMx[c] += x * mass;
    this.cellMy[c] += y * mass;
    return c;
  }

  /**
   * Cells whose accumulated mass exceeds `threshold`, densest first.
   * This is the star-formation trigger: a molecular cloud that has cooled and
   * collapsed far enough to become self-gravitating.
   */
  denseCells(threshold, limit, out) {
    out.length = 0;
    const n = this.cellMass.length;
    for (let c = 0; c < n; c++) {
      if (this.cellMass[c] >= threshold && this.cellCount[c] >= 3) out.push(c);
    }
    out.sort((a, b) => this.cellMass[b] - this.cellMass[a]);
    if (out.length > limit) out.length = limit;
    return out;
  }
}
