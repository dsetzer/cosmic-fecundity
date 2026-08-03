// Colour: black-body temperature ramps and pre-rendered glow sprites.
//
// Nothing in the renderer draws a filled circle per particle — at several
// thousand particles per frame that is death by path rasterisation. Instead
// every particle is a `drawImage` of a cached radial-gradient sprite, keyed by
// species and quantised temperature.

/**
 * Approximate black-body colour for a temperature in Kelvin.
 * Tanner Helland's piecewise fit, clamped to 1000K–40000K.
 */
export function blackbody(kelvin) {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r;
  let g;
  let b;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }

  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  return [clamp255(r), clamp255(g), clamp255(b)];
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

export function rgb(c, a = 1) {
  return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

export function mixRGB(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Hue for a generation index — each lineage depth gets its own tint. */
export function generationColor(gen) {
  const hues = [
    [120, 200, 255], // 0 — cold blue
    [150, 255, 220], // 1 — teal
    [190, 255, 150], // 2 — green
    [255, 225, 130], // 3 — gold
    [255, 160, 110], // 4 — amber
    [255, 120, 160], // 5 — rose
    [200, 130, 255], // 6 — violet
  ];
  return hues[gen % hues.length];
}

export const THERMAL_STEPS = 24;

/** Bucket a temperature onto the ramp. Log-spaced, since colour changes fast
 *  at the cool end and barely at all above ~20000 K. */
export function thermalBucket(temp) {
  const t = Math.log(Math.max(600, temp) / 600) / LOG60;
  const b = (t * (THERMAL_STEPS - 1) + 0.5) | 0;
  return b < 0 ? 0 : b > THERMAL_STEPS - 1 ? THERMAL_STEPS - 1 : b;
}

const LOG60 = Math.log(60);

/**
 * Radial glow sprite cache. Sprites are square canvases with a soft falloff;
 * drawn additively they sum into convincing plasma.
 */
export class SpriteCache {
  constructor() {
    this.map = new Map();
  }

  /**
   * @param {number[]} color   base RGB
   * @param {number} px        sprite resolution
   * @param {number} core      0..1 fraction of the radius at full brightness
   * @param {number} falloff   gamma on the outer gradient; higher = tighter
   */
  glow(color, px = 32, core = 0.12, falloff = 2.2) {
    const key = `g${color[0]}_${color[1]}_${color[2]}_${px}_${core}_${falloff}`;
    let c = this.map.get(key);
    if (c) return c;

    c = document.createElement('canvas');
    c.width = c.height = px;
    const ctx = c.getContext('2d');
    const r = px / 2;
    const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
    const stops = 8;
    for (let i = 0; i <= stops; i++) {
      const t = i / stops;
      const a = t <= core ? 1 : Math.pow(1 - (t - core) / (1 - core), falloff);
      grad.addColorStop(t, `rgba(${color[0]},${color[1]},${color[2]},${a.toFixed(4)})`);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, px, px);
    this.map.set(key, c);
    return c;
  }

  /** Anisotropic streak used for jets and umbilical flux. */
  streak(color, w = 48, h = 12) {
    const key = `s${color[0]}_${color[1]}_${color[2]}_${w}_${h}`;
    let c = this.map.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},0)`);
    grad.addColorStop(0.45, `rgba(${color[0]},${color[1]},${color[2]},0.9)`);
    grad.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, h * 0.5 - 0.5, w, 1);
    ctx.filter = 'blur(2px)';
    ctx.drawImage(c, 0, 0);
    this.map.set(key, c);
    return c;
  }

  /**
   * A whole black-body ramp as a flat array of sprites, built once.
   *
   * The hot loop draws thousands of particles per frame; looking a sprite up by
   * a composed string key was costing more than the draw itself, so the ramp is
   * materialised up front and indexed by an integer bucket.
   */
  thermalRamp(px = 32, core = 0.1, falloff = 2.2) {
    const key = `ramp_${px}_${core}_${falloff}`;
    let ramp = this.map.get(key);
    if (ramp) return ramp;
    ramp = [];
    for (let b = 0; b < THERMAL_STEPS; b++) {
      const kelvin = 600 * Math.pow(60, b / (THERMAL_STEPS - 1));
      ramp.push(this.glow(blackbody(kelvin), px, core, falloff));
    }
    this.map.set(key, ramp);
    return ramp;
  }
}
