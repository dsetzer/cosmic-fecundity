// Canvas renderer.
//
// Everything luminous is drawn additively from pre-rendered radial sprites, so
// overlapping matter sums into plasma the way real emission does. A single
// downsample-blur-composite pass afterwards supplies the bloom.
//
// Nesting is handled by composing affine transforms rather than by moving
// anything in world space: each universe is drawn in its own local coordinates
// through a transform derived from its parent's, so a universe fourteen
// generations deep is rendered with exactly the same numerical precision as
// the root.

import { PT } from './particles.js';
import { SpriteCache, blackbody, rgb, generationColor, thermalBucket } from './color.js';
import { PHASE } from '../sim/universe.js';

const DPR_CAP = 1.6;

/** Detail tiers, selected by how many pixels across a universe is drawn. */
const DETAIL = { FULL: 0, MEDIUM: 1, BLOB: 2, SKIP: 3 };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.sprites = new SpriteCache();
    this.bloom = document.createElement('canvas');
    this.bloomCtx = this.bloom.getContext('2d');
    this.showLabels = true;
    this.showUmbilicals = true;
    this.bloomStrength = 0.45;
    /** 0 = everything, 1 = no volumetric gas, 2 = no bloom either. Raised
     *  automatically when frames get long so the simulation stays fluid on
     *  modest hardware rather than degrading into a slideshow. */
    this.quality = 0;
    this._slow = 0;
    this.time = 0;
    this.pickables = [];
    this.resize();
  }

  resize() {
    const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.dpr = dpr;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.bloom.width = Math.max(1, Math.floor((w * dpr) / 4));
    this.bloom.height = Math.max(1, Math.floor((h * dpr) / 4));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._makeBackdrop();
  }

  /** A static field of very distant light, drawn once into an offscreen tile. */
  _makeBackdrop() {
    const c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.height;
    const g = c.getContext('2d');
    g.fillStyle = '#04040a';
    g.fillRect(0, 0, c.width, c.height);
    // A faint cosmic-background gradient keeps the frame from reading as flat.
    const grd = g.createRadialGradient(
      c.width * 0.5,
      c.height * 0.5,
      0,
      c.width * 0.5,
      c.height * 0.5,
      Math.max(c.width, c.height) * 0.75
    );
    grd.addColorStop(0, 'rgba(30,26,60,0.55)');
    grd.addColorStop(0.55, 'rgba(12,10,28,0.35)');
    grd.addColorStop(1, 'rgba(2,2,7,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, c.width, c.height);
    let s = 1;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < 520; i++) {
      const x = rand() * c.width;
      const y = rand() * c.height;
      const r = rand() * 1.1 + 0.2;
      const a = rand() * 0.5 + 0.08;
      g.fillStyle = `rgba(190,205,255,${a.toFixed(3)})`;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    this.backdrop = c;
  }

  // ---------------------------------------------------------------- main draw

  render(mv, transform, dt) {
    this.time += dt;
    this._adapt(dt);
    const ctx = this.ctx;
    this.pickables.length = 0;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(this.backdrop, 0, 0, this.width, this.height);

    this._drawUniverse(mv.focus, transform, 0);

    this._bloomPass();
    this._overlay(mv, transform);
  }

  /** Watch the frame time and shed effects if we are consistently over budget. */
  _adapt(dt) {
    if (dt > 0.028) this._slow = Math.min(90, this._slow + 1);
    else if (dt < 0.019) this._slow = Math.max(0, this._slow - 1);
    if (this._slow > 60 && this.quality < 2) {
      this.quality++;
      this._slow = 20;
    } else if (this._slow === 0 && this.quality > 0) {
      this.quality--;
      this._slow = 40;
    }
  }

  _detailFor(k, radius) {
    const px = k * radius;
    if (px < 3) return DETAIL.SKIP;
    if (px < 30) return DETAIL.BLOB;
    if (px < 150) return DETAIL.MEDIUM;
    return DETAIL.FULL;
  }

  /**
   * @param {Universe} u
   * @param {{x:number,y:number,k:number}} T local→screen transform
   */
  _drawUniverse(u, T, depth) {
    const detail = this._detailFor(T.k, u.radius);
    if (detail === DETAIL.SKIP || depth > 4) return;

    const R = u.radius * T.k;
    // Cull anything entirely outside the viewport.
    if (T.x + R < -40 || T.x - R > this.width + 40 || T.y + R < -40 || T.y - R > this.height + 40) return;

    if (detail === DETAIL.BLOB) {
      this._drawBlob(u, T);
      return;
    }

    this._drawShell(u, T, detail);
    this._drawParticles(u, T, detail);
    this._drawStars(u, T, detail);

    // Children are drawn before the black holes that host them, so the event
    // horizon reads as being in front of its own offspring bubble.
    for (const c of u.children) {
      if (!c.visible) continue;
      const Tc = {
        x: T.x + c.anchorX * T.k,
        y: T.y + c.anchorY * T.k,
        k: T.k * (c.displayRadius / c.radius),
      };
      this._drawUniverse(c, Tc, depth + 1);
    }

    if (this.showUmbilicals) this._drawUmbilicals(u, T, detail);
    this._drawBlackHoles(u, T, detail);

    if (detail === DETAIL.FULL) {
      this.pickables.push({ u, T });
      this._drawBirthFlash(u, T);
    }
  }

  /** A universe too small to resolve: one glowing mote plus a hint of scale. */
  _drawBlob(u, T) {
    const ctx = this.ctx;
    const R = Math.max(2, u.radius * T.k);
    const tint = u.tint;
    ctx.globalCompositeOperation = 'lighter';
    const sp = this.sprites.glow(tint, 32, 0.18, 1.7);
    const s = R * 5;
    ctx.globalAlpha = 0.75;
    ctx.drawImage(sp, T.x - s / 2, T.y - s / 2, s, s);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Boundary of a closed space, plus the glow of everything inside it. */
  _drawShell(u, T, detail) {
    const ctx = this.ctx;
    const R = u.radius * T.k;
    const tint = u.tint;

    ctx.globalCompositeOperation = 'lighter';
    const grd = ctx.createRadialGradient(T.x, T.y, R * 0.55, T.x, T.y, R);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(0.82, `rgba(${tint[0]},${tint[1]},${tint[2]},0.035)`);
    grd.addColorStop(1, `rgba(${tint[0]},${tint[1]},${tint[2]},0.13)`);
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(T.x, T.y, R, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${detail === DETAIL.FULL ? 0.3 : 0.5})`;
    ctx.lineWidth = Math.max(0.6, R * 0.0022);
    ctx.stroke();

    // Inflation flash: the whole bubble is briefly opaque with light.
    if (u.flash > 0.01) {
      const f = u.flash * u.flash;
      const fg = ctx.createRadialGradient(T.x, T.y, 0, T.x, T.y, R * 1.05);
      fg.addColorStop(0, `rgba(255,255,255,${0.55 * f})`);
      fg.addColorStop(0.35, `rgba(${tint[0]},${tint[1]},${tint[2]},${0.3 * f})`);
      fg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.arc(T.x, T.y, R * 1.05, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawParticles(u, T, detail) {
    const ctx = this.ctx;
    const p = u.pool;
    const k = T.k;
    ctx.globalCompositeOperation = 'lighter';

    if (detail === DETAIL.FULL) {
      // Two-layer gas: a wide, cool, tinted halo for volume, then a hot core
      // per particle. Overlapping halos are what make a nebula read as a
      // continuous medium rather than a field of dots.
      if (this.quality < 1) this._nebula(p, T, k, u.tint);
      this._pass(p, T, PT.GAS, k, 3.6, 0.46, false);
      this._pass(p, T, PT.DUST, k, 3.4, 0.3, false);
      this._pass(p, T, PT.INFLATON, k, 4.2, 0.7, false);
      this._pass(p, T, PT.JET, k, 3.6, 0.65, false);
      this._pass(p, T, PT.ACCRETION, k, 2.6, 0.8, false);
      this._pass(p, T, PT.FLUX, k, 3.0, 0.85, false);
      this._pass(p, T, PT.PHOTON, k, 1.5, 0.5, false);
    } else {
      // One cheap pass, every other particle, for out-of-focus bubbles.
      const sp = this.sprites.glow(u.tint, 32, 0.14, 2.0);
      ctx.globalAlpha = 0.5;
      for (let i = 0; i <= p.high; i += 2) {
        if (!p.alive[i]) continue;
        const t = p.type[i];
        if (t === PT.PHOTON) continue;
        const s = Math.max(1.1, p.size[i] * 2.4 * k);
        ctx.drawImage(sp, T.x + p.x[i] * k - s / 2, T.y + p.y[i] * k - s / 2, s, s);
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Wide tinted halos, one per gas particle, in the universe's own hue. */
  _nebula(p, T, k, tint) {
    if (p.byType[PT.GAS] === 0) return;
    const ctx = this.ctx;
    const sp = this.sprites.glow(tint, 64, 0, 2.4);
    const warm = this.sprites.glow([255, 150, 90], 64, 0, 2.4);
    ctx.globalAlpha = 0.085;
    const types = p.type;
    const alive = p.alive;
    for (let i = 0; i <= p.high; i++) {
      if (!alive[i] || types[i] !== PT.GAS) continue;
      const s = Math.max(7, p.size[i] * 26 * k);
      const half = s * 0.5;
      ctx.drawImage(
        p.temp[i] > 4200 ? warm : sp,
        T.x + p.x[i] * k - half,
        T.y + p.y[i] * k - half,
        s,
        s
      );
    }
  }

  /** One species pass: constant blend state, sprite chosen by temperature. */
  _pass(p, T, type, k, scale, alpha, wide) {
    if (p.byType[type] === 0) return;
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    const ramp = wide
      ? this.sprites.thermalRamp(64, 0, 2.6)
      : this.sprites.thermalRamp(32, 0.14, 2.1);
    const tx = T.x;
    const ty = T.y;
    const px = p.x;
    const py = p.y;
    const temp = p.temp;
    const size = p.size;
    const alive = p.alive;
    const types = p.type;
    for (let i = 0; i <= p.high; i++) {
      if (!alive[i] || types[i] !== type) continue;
      const sp = ramp[thermalBucket(temp[i])];
      const s = size[i] * scale * k;
      const half = (s < 1 ? 1 : s) * 0.5;
      ctx.drawImage(sp, tx + px[i] * k - half, ty + py[i] * k - half, half * 2, half * 2);
    }
  }

  _drawStars(u, T, detail) {
    const ctx = this.ctx;
    const k = T.k;
    ctx.globalCompositeOperation = 'lighter';
    for (const st of u.stars) {
      const x = T.x + st.x * k;
      const y = T.y + st.y * k;
      const r = Math.max(1.2, st.radius * k);
      const pulse = 1 + Math.sin(st.flicker) * 0.05;
      const halo = this.sprites.glow(st.color, 64, 0.02, 2.4);
      const core = this.sprites.glow([255, 255, 255], 32, 0.25, 2.0);

      ctx.globalAlpha = 0.42;
      const hs = r * 11 * pulse;
      ctx.drawImage(halo, x - hs / 2, y - hs / 2, hs, hs);
      ctx.globalAlpha = 0.85;
      const cs = r * 3.4 * pulse;
      ctx.drawImage(core, x - cs / 2, y - cs / 2, cs, cs);

      // Diffraction spikes for the brightest stars — a cheap cue that this is
      // an object, not a particle.
      if (detail === DETAIL.FULL && r > 3.2) {
        ctx.globalAlpha = 0.26;
        ctx.strokeStyle = rgb(st.color, 0.9);
        ctx.lineWidth = Math.max(0.5, r * 0.16);
        const L = r * 5.5 * pulse;
        ctx.beginPath();
        ctx.moveTo(x - L, y);
        ctx.lineTo(x + L, y);
        ctx.moveTo(x, y - L);
        ctx.lineTo(x, y + L);
        ctx.stroke();
      }

      // Terminal instability: a visible tremor before collapse.
      if (st.burn > 0.9 && detail === DETAIL.FULL) {
        const t = (st.burn - 0.9) / 0.1;
        ctx.globalAlpha = 0.4 * t * (0.5 + 0.5 * Math.sin(this.time * 26));
        const ws = r * 20;
        ctx.drawImage(this.sprites.glow([255, 120, 60], 64, 0.02, 2.0), x - ws / 2, y - ws / 2, ws, ws);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawBlackHoles(u, T, detail) {
    const ctx = this.ctx;
    const k = T.k;
    for (const bh of u.blackHoles) {
      const x = T.x + bh.x * k;
      const y = T.y + bh.y * k;
      const h = Math.max(1.2, bh.horizon * k);

      // Lensing halo: light from behind, smeared around the shadow.
      ctx.globalCompositeOperation = 'lighter';
      const lens = ctx.createRadialGradient(x, y, h * 0.9, x, y, h * 6.5);
      lens.addColorStop(0, 'rgba(255,222,180,0.34)');
      lens.addColorStop(0.18, 'rgba(255,170,90,0.16)');
      lens.addColorStop(0.55, 'rgba(120,90,220,0.07)');
      lens.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = lens;
      ctx.beginPath();
      ctx.arc(x, y, h * 6.5, 0, Math.PI * 2);
      ctx.fill();

      // The shadow itself is the one genuinely opaque thing on screen.
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(x, y, h, 0, Math.PI * 2);
      ctx.fill();

      // Photon ring, Doppler-brightened on the approaching side.
      ctx.globalCompositeOperation = 'lighter';
      const ring = h * 1.28;
      const ang = bh.diskPhase;
      const gx = Math.cos(ang) * ring;
      const gy = Math.sin(ang) * ring;
      const dg = ctx.createLinearGradient(x - gx, y - gy, x + gx, y + gy);
      dg.addColorStop(0, 'rgba(255,255,255,0.95)');
      dg.addColorStop(0.5, 'rgba(255,196,120,0.5)');
      dg.addColorStop(1, 'rgba(190,120,255,0.28)');
      ctx.strokeStyle = dg;
      ctx.lineWidth = Math.max(0.7, h * 0.2);
      ctx.beginPath();
      ctx.arc(x, y, ring, 0, Math.PI * 2);
      ctx.stroke();

      if (detail === DETAIL.FULL) {
        // Jet funnels: soft cones along the spin axis.
        const jetPower = Math.min(1, (bh.inflow + bh.rateSmoothed * 0.4) * 0.25);
        if (jetPower > 0.01) {
          for (const pole of [0, Math.PI]) {
            const a = bh.jetAngle + pole;
            const len = h * 26 * (0.4 + jetPower);
            const jg = ctx.createLinearGradient(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len);
            jg.addColorStop(0, `rgba(180,225,255,${0.3 * jetPower})`);
            jg.addColorStop(1, 'rgba(120,90,255,0)');
            ctx.strokeStyle = jg;
            ctx.lineWidth = Math.max(1, h * 0.9);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
            ctx.stroke();
          }
        }

        // Birth flash: the moment a singularity bounces into a new cosmos.
        if (bh.birthFlash > 0) {
          const f = bh.birthFlash;
          const s = h * (10 + 40 * (1 - f));
          ctx.globalAlpha = f * f;
          ctx.drawImage(this.sprites.glow([255, 255, 255], 64, 0.02, 2.2), x - s / 2, y - s / 2, s, s);
          ctx.globalAlpha = 1;
        }

        this.pickables.push({ bh, u, x, y, r: Math.max(12, h * 2.4) });
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /** The wormhole thread from a black hole to the universe it gave rise to. */
  _drawUmbilicals(u, T, detail) {
    const ctx = this.ctx;
    const k = T.k;
    ctx.globalCompositeOperation = 'lighter';
    for (const bh of u.blackHoles) {
      for (const c of bh.children) {
        if (!c.alive) continue;
        const x0 = T.x + bh.x * k;
        const y0 = T.y + bh.y * k;
        const x1 = T.x + c.anchorX * k;
        const y1 = T.y + c.anchorY * k;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (len < 3) continue;
        const bow = 0.22 * len;
        const mx = (x0 + x1) / 2 - (dy / len) * bow;
        const my = (y0 + y1) / 2 + (dx / len) * bow;
        const tint = c.tint;

        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, 'rgba(255,235,200,0.55)');
        g.addColorStop(1, `rgba(${tint[0]},${tint[1]},${tint[2]},0.5)`);
        ctx.strokeStyle = g;
        ctx.lineWidth = Math.max(0.6, len * 0.012);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(mx, my, x1, y1);
        ctx.stroke();

        if (detail === DETAIL.FULL) {
          // Beads travelling the thread show which way mass is moving.
          const beads = 7;
          for (let i = 0; i < beads; i++) {
            const t = ((this.time * 0.35 + i / beads) % 1);
            const it = 1 - t;
            const bx = it * it * x0 + 2 * it * t * mx + t * t * x1;
            const by = it * it * y0 + 2 * it * t * my + t * t * y1;
            const s = Math.max(2, len * 0.03) * (0.6 + 0.4 * Math.sin(t * Math.PI));
            ctx.globalAlpha = 0.55 * Math.sin(t * Math.PI);
            ctx.drawImage(this.sprites.glow([255, 240, 210], 32, 0.2, 2.0), bx - s / 2, by - s / 2, s, s);
          }
          ctx.globalAlpha = 1;
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawBirthFlash(u, T) {
    if (u.phase !== PHASE.INFLATION) return;
    const ctx = this.ctx;
    const R = u.radius * T.k;
    ctx.globalCompositeOperation = 'lighter';
    const t = Math.min(1, u.inflationT / 1.9);
    const s = R * (0.2 + t * 2.2);
    ctx.globalAlpha = (1 - t) * 0.8;
    ctx.drawImage(this.sprites.glow([225, 240, 255], 64, 0.02, 2.0), T.x - s / 2, T.y - s / 2, s, s);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _bloomPass() {
    if (this.quality >= 2) return;
    const bc = this.bloomCtx;
    const bw = this.bloom.width;
    const bh = this.bloom.height;
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.globalCompositeOperation = 'source-over';
    bc.globalAlpha = 1;
    bc.clearRect(0, 0, bw, bh);
    bc.filter = 'blur(4px)';
    bc.drawImage(this.canvas, 0, 0, bw, bh);
    bc.filter = 'none';

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = this.bloomStrength;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.bloom, 0, 0, this.width, this.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Labels and the "you are here" frame, drawn after bloom so they stay crisp. */
  _overlay(mv, T) {
    const ctx = this.ctx;
    const u = mv.focus;
    const R = u.radius * T.k;

    // Vignette.
    const vg = ctx.createRadialGradient(
      this.width / 2,
      this.height / 2,
      Math.min(this.width, this.height) * 0.35,
      this.width / 2,
      this.height / 2,
      Math.max(this.width, this.height) * 0.78
    );
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.width, this.height);

    if (!this.showLabels) return;

    ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const c of u.children) {
      if (!c.visible) continue;
      const x = T.x + c.anchorX * T.k;
      const y = T.y + c.anchorY * T.k;
      const r = c.displayRadius * T.k;
      if (r < 9) continue;
      const tint = c.tint;
      ctx.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},0.85)`;
      ctx.fillText(`U${c.id} · gen ${c.generation}`, x, y + r + 12);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(`${c.stars.length}★  ${c.blackHoles.length}●`, x, y + r + 25);
    }

    // The parent, when we are inside one of its black holes.
    if (u.parent) {
      const tint = generationColor(u.parent.generation);
      ctx.strokeStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},0.22)`;
      ctx.setLineDash([6, 9]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(T.x, T.y, R * 1.035, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},0.6)`;
      ctx.textAlign = 'left';
      ctx.fillText(`↑ inside a singularity of U${u.parent.id}`, 18, this.height - 22);
    }
    ctx.textAlign = 'left';
  }

  /** Screen-space hit test against black holes drawn this frame. */
  pick(mx, my) {
    let best = null;
    let bestD = Infinity;
    for (const p of this.pickables) {
      if (!p.bh) continue;
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < p.r && d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }
}
