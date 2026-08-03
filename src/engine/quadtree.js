// Barnes-Hut quadtree for 2D self-gravity.
//
// Every gravitating thing in a universe — gas, dust, stars, black holes — goes
// into one tree, and every one of them is accelerated by all the others. A
// distant group is approximated by its centre of mass once it subtends a small
// enough angle, which turns an O(N²) problem into O(N log N) and makes a real
// N-body solve affordable at several thousand particles per frame.
//
// Storage is flat typed arrays with a preallocated node pool, so a frame's
// gravity costs no allocation and produces no garbage.

const MAX_DEPTH = 24;
const STRIDE = 4;

export class Quadtree {
  /** @param {number} capacity maximum number of bodies in a single build */
  constructor(capacity) {
    this.capacity = capacity;
    const nodes = Math.max(128, capacity * 3 + 32);
    this.nodeCap = nodes;

    this.mass = new Float32Array(nodes); // total, after summarise
    this.own = new Float32Array(nodes); // mass held at this node itself
    this.comX = new Float32Array(nodes);
    this.comY = new Float32Array(nodes);
    this.half = new Float32Array(nodes);
    this.cx = new Float32Array(nodes);
    this.cy = new Float32Array(nodes);
    this.child = new Int32Array(nodes * STRIDE);
    this.body = new Int32Array(nodes); // leaf: body index, else -1
    // Precomputed in summarise so the force loop never recomputes them: a leaf
    // test costs four array reads otherwise, and it runs millions of times a
    // second.
    this.leaf = new Uint8Array(nodes);
    this.size2 = new Float32Array(nodes);
    this.count = 0;

    this.bx = new Float32Array(capacity);
    this.by = new Float32Array(capacity);
    this.bm = new Float32Array(capacity);
    this.bn = 0;

    this.stack = new Int32Array(4096);
    this.order = new Int32Array(nodes);
    this.ax = 0;
    this.ay = 0;
  }

  reset() {
    this.bn = 0;
    this.count = 0;
  }

  /** Queue a gravitating point. Returns its index in the tree's numbering. */
  add(x, y, m) {
    if (this.bn >= this.capacity) return -1;
    const i = this.bn++;
    this.bx[i] = x;
    this.by[i] = y;
    this.bm[i] = m;
    return i;
  }

  _newNode(cx, cy, half) {
    if (this.count >= this.nodeCap) return -1;
    const n = this.count++;
    this.mass[n] = 0;
    this.own[n] = 0;
    this.cx[n] = cx;
    this.cy[n] = cy;
    this.half[n] = half;
    this.body[n] = -1;
    const c = n * STRIDE;
    this.child[c] = -1;
    this.child[c + 1] = -1;
    this.child[c + 2] = -1;
    this.child[c + 3] = -1;
    return n;
  }

  build() {
    this.count = 0;
    if (this.bn === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < this.bn; i++) {
      const x = this.bx[i];
      const y = this.by[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const half = Math.max(1, Math.max(maxX - minX, maxY - minY) * 0.5 + 1);

    this._newNode(cx, cy, half);
    for (let i = 0; i < this.bn; i++) this._insert(i);
    this._summarise();
  }

  _quadrant(node, x, y) {
    return (x >= this.cx[node] ? 1 : 0) | (y >= this.cy[node] ? 2 : 0);
  }

  _makeChild(node, q) {
    const h = this.half[node] * 0.5;
    const n = this._newNode(this.cx[node] + (q & 1 ? h : -h), this.cy[node] + (q & 2 ? h : -h), h);
    if (n >= 0) this.child[node * STRIDE + q] = n;
    return n;
  }

  _hasChildren(node) {
    const c = node * STRIDE;
    return this.child[c] >= 0 || this.child[c + 1] >= 0 || this.child[c + 2] >= 0 || this.child[c + 3] >= 0;
  }

  _insert(i) {
    const x = this.bx[i];
    const y = this.by[i];
    let node = 0;
    let depth = 0;

    for (;;) {
      const sitting = this.body[node];
      const branched = this._hasChildren(node);

      if (!branched && sitting < 0) {
        this.body[node] = i;
        return;
      }

      // Coincident points would subdivide forever. Past the depth cap the node
      // simply holds their combined mass at its own centre.
      if (depth >= MAX_DEPTH) {
        this.own[node] += this.bm[i];
        return;
      }

      if (!branched && sitting >= 0) {
        // Displace the sitting body one level down, then place ours.
        this.body[node] = -1;
        const sq = this._quadrant(node, this.bx[sitting], this.by[sitting]);
        const sc = this._makeChild(node, sq);
        if (sc < 0) this.own[node] += this.bm[sitting];
        else this.body[sc] = sitting;
      }

      const q = this._quadrant(node, x, y);
      let next = this.child[node * STRIDE + q];
      if (next < 0) next = this._makeChild(node, q);
      if (next < 0) {
        // Node pool exhausted — keep the mass rather than dropping it.
        this.own[node] += this.bm[i];
        return;
      }
      node = next;
      depth++;
    }
  }

  /** Post-order accumulation of mass and centre of mass. */
  _summarise() {
    const order = this.order;
    const stack = this.stack;
    let sp = 0;
    let on = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const n = stack[--sp];
      order[on++] = n;
      const c = n * STRIDE;
      for (let k = 0; k < 4; k++) {
        const ch = this.child[c + k];
        if (ch >= 0) stack[sp++] = ch;
      }
    }

    for (let i = on - 1; i >= 0; i--) {
      const n = order[i];
      let m = 0;
      let sx = 0;
      let sy = 0;

      const b = this.body[n];
      if (b >= 0) {
        const bm = this.bm[b];
        m += bm;
        sx += this.bx[b] * bm;
        sy += this.by[b] * bm;
      }
      const ownM = this.own[n];
      if (ownM > 0) {
        m += ownM;
        sx += this.cx[n] * ownM;
        sy += this.cy[n] * ownM;
      }

      const c = n * STRIDE;
      for (let k = 0; k < 4; k++) {
        const ch = this.child[c + k];
        if (ch < 0) continue;
        const cm = this.mass[ch];
        if (cm <= 0) continue;
        m += cm;
        sx += this.comX[ch] * cm;
        sy += this.comY[ch] * cm;
      }

      this.mass[n] = m;
      if (m > 0) {
        this.comX[n] = sx / m;
        this.comY[n] = sy / m;
      } else {
        this.comX[n] = this.cx[n];
        this.comY[n] = this.cy[n];
      }
      this.leaf[n] = this._hasChildren(n) ? 0 : 1;
      const size = this.half[n] * 2;
      this.size2[n] = size * size;
    }
  }

  /**
   * Acceleration at (x, y) from everything in the tree, scaled by `G`.
   * `self` is the tree index of the body being accelerated so it does not pull
   * on itself; pass -1 for a test point.
   *
   * The result lands in `this.ax` / `this.ay` — returning a vector object per
   * particle per frame would allocate millions of times a second.
   */
  accel(x, y, G, soft2, theta2, self) {
    if (this.count === 0) {
      this.ax = 0;
      this.ay = 0;
      return;
    }

    // Hoisted into locals: property loads off `this` inside a loop this hot
    // cost more than the arithmetic they feed.
    const mass = this.mass;
    const comX = this.comX;
    const comY = this.comY;
    const size2 = this.size2;
    const leaf = this.leaf;
    const body = this.body;
    const own = this.own;
    const child = this.child;
    const stack = this.stack;
    const limit = stack.length - 4;

    let ax = 0;
    let ay = 0;
    let sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
      const n = stack[--sp];
      const m = mass[n];
      if (m <= 0) continue;

      const dx = comX[n] - x;
      const dy = comY[n] - y;
      const d2 = dx * dx + dy * dy;

      if (leaf[n] === 1 || size2[n] < theta2 * d2) {
        let em = m;
        if (leaf[n] === 1 && body[n] === self) {
          em -= this.bm[self];
          if (em <= 0) continue;
        }
        const s = d2 + soft2;
        const inv = 1 / Math.sqrt(s);
        ax += dx * ((G * em * inv) / s);
        ay += dy * ((G * em * inv) / s);
        continue;
      }

      // Opening an internal node. Mass parked at the node itself (coincident
      // points past the depth cap) and any body sitting there still apply.
      const ownM = own[n];
      if (ownM > 0) {
        const odx = this.cx[n] - x;
        const ody = this.cy[n] - y;
        const s = odx * odx + ody * ody + soft2;
        const inv = 1 / Math.sqrt(s);
        ax += odx * ((G * ownM * inv) / s);
        ay += ody * ((G * ownM * inv) / s);
      }
      const bIdx = body[n];
      if (bIdx >= 0 && bIdx !== self) {
        const bdx = this.bx[bIdx] - x;
        const bdy = this.by[bIdx] - y;
        const s = bdx * bdx + bdy * bdy + soft2;
        const inv = 1 / Math.sqrt(s);
        ax += bdx * ((G * this.bm[bIdx] * inv) / s);
        ay += bdy * ((G * this.bm[bIdx] * inv) / s);
      }

      const c = n * STRIDE;
      for (let k = 0; k < 4; k++) {
        const ch = child[c + k];
        if (ch >= 0 && mass[ch] > 0 && sp < limit) stack[sp++] = ch;
      }
    }

    this.ax = ax;
    this.ay = ay;
  }
}
