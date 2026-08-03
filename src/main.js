// Entry point: camera, input, transport, and the fixed-step loop.

import { Multiverse } from './sim/multiverse.js';
import { Renderer } from './engine/renderer.js';
import { HUD } from './ui/hud.js';

const canvas = document.getElementById('scene');
const renderer = new Renderer(canvas);
const mv = new Multiverse('fecundity');

const MAX_SUBSTEP = 1 / 60;
const TRANSITION = 1.15; // seconds to fall into (or climb out of) a universe

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * The camera never leaves the focused universe's coordinate system. Diving into
 * a child is an animation of the *root* transform such that the child's nested
 * transform lands exactly on the full-screen framing, at which point the root
 * is swapped. Depth therefore costs nothing in precision.
 */
class Camera {
  constructor() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.mode = 'idle';
    this.t = 0;
    this.child = null;
  }

  get fitBase() {
    return Math.min(renderer.width, renderer.height) * 0.46;
  }

  natural() {
    return {
      k: (this.fitBase * this.zoom) / mv.focus.radius,
      x: renderer.width / 2 + this.panX,
      y: renderer.height / 2 + this.panY,
    };
  }

  transform() {
    const T0 = this.natural();
    if (this.mode === 'idle' || !this.child || !this.child.alive) return T0;

    const c = this.child;
    const e = this.mode === 'dive' ? easeInOut(this.t) : 1 - easeInOut(this.t);
    const k1 = this.fitBase / c.displayRadius;
    const k = T0.k * Math.pow(k1 / T0.k, e);
    const sx0 = T0.x + c.anchorX * T0.k;
    const sy0 = T0.y + c.anchorY * T0.k;
    const sx = sx0 + (renderer.width / 2 - sx0) * e;
    const sy = sy0 + (renderer.height / 2 - sy0) * e;
    return { k, x: sx - c.anchorX * k, y: sy - c.anchorY * k };
  }

  update(dt) {
    if (this.mode === 'idle') return;
    this.t += dt / TRANSITION;
    if (this.child && !this.child.alive) {
      this.mode = 'idle';
      this.child = null;
      return;
    }
    if (this.t >= 1) {
      if (this.mode === 'dive') mv.focus = this.child;
      this.mode = 'idle';
      this.child = null;
      this.zoom = 1;
      this.panX = this.panY = 0;
    }
  }

  dive(child) {
    if (this.mode !== 'idle' || !child || !child.alive) return;
    if (child.parent !== mv.focus) return;
    this.mode = 'dive';
    this.t = 0;
    this.child = child;
  }

  ascend() {
    if (this.mode !== 'idle') return;
    const c = mv.focus;
    if (!c.parent) return;
    mv.focus = c.parent;
    this.mode = 'ascend';
    this.t = 0;
    this.child = c;
    this.zoom = 1;
    this.panX = this.panY = 0;
  }

  /** Jump anywhere in the tree; adjacent hops get the full flight. */
  travelTo(u) {
    if (!u || u === mv.focus || this.mode !== 'idle') return;
    if (u.parent === mv.focus) return this.dive(u);
    if (mv.focus.parent === u) return this.ascend();
    mv.focus = u;
    this.zoom = 1;
    this.panX = this.panY = 0;
    flash();
  }
}

const cam = new Camera();
const hud = new HUD((u) => cam.travelTo(u));

// ------------------------------------------------------------------- input

let dragging = false;
let dragMoved = 0;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  dragMoved = 0;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('grabbing');
});

canvas.addEventListener('pointermove', (e) => {
  if (dragging) {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    cam.panX += dx;
    cam.panY += dy;
    lastX = e.clientX;
    lastY = e.clientY;
    return;
  }
  const hit = renderer.pick(e.clientX, e.clientY);
  canvas.classList.toggle('pointing', !!(hit && hit.bh && hit.bh.children.length));
});

canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('grabbing');
  if (!dragging) return;
  dragging = false;
  if (dragMoved > 6) return;
  const hit = renderer.pick(e.clientX, e.clientY);
  if (hit && hit.bh && hit.bh.children.length) {
    const kid = hit.bh.children[hit.bh.children.length - 1];
    if (hit.u === mv.focus) cam.dive(kid);
  }
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const T = cam.natural();
    const lx = (e.clientX - T.x) / T.k;
    const ly = (e.clientY - T.y) / T.k;
    const factor = Math.exp(-e.deltaY * 0.0016);
    cam.zoom = Math.min(9, Math.max(0.4, cam.zoom * factor));
    const T2 = cam.natural();
    cam.panX += e.clientX - (T2.x + lx * T2.k);
    cam.panY += e.clientY - (T2.y + ly * T2.k);
  },
  { passive: false }
);

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  cam.ascend();
});

// ---------------------------------------------------------------- transport

const ui = document.getElementById('ui');
const btnPlay = document.getElementById('btn-play');
const speedInput = document.getElementById('speed');
const speedLabel = document.getElementById('speed-label');
const seedInput = document.getElementById('seed');

let paused = false;
let speed = 1;

function setPaused(v) {
  paused = v;
  btnPlay.innerHTML = `<span>${paused ? '▶' : '❚❚'}</span>`;
  btnPlay.classList.toggle('on', paused);
}

function setSpeed(v) {
  speed = Math.max(0, v / 20);
  speedLabel.textContent = `${speed.toFixed(1)}×`;
}

btnPlay.addEventListener('click', () => setPaused(!paused));
speedInput.addEventListener('input', () => setSpeed(+speedInput.value));
document.getElementById('btn-up').addEventListener('click', () => cam.ascend());
document.getElementById('btn-fittest').addEventListener('click', () => cam.travelTo(mv.fittest()));
document.getElementById('btn-labels').addEventListener('click', (e) => {
  renderer.showLabels = !renderer.showLabels;
  e.currentTarget.classList.toggle('on', !renderer.showLabels);
});
document.getElementById('btn-ui').addEventListener('click', () => ui.classList.toggle('hidden'));
document.getElementById('btn-reset').addEventListener('click', restart);

function restart() {
  mv.reset(seedInput.value.trim() || 'fecundity');
  cam.mode = 'idle';
  cam.child = null;
  cam.zoom = 1;
  cam.panX = cam.panY = 0;
  flash();
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) {
    if (e.key === 'Enter') restart();
    return;
  }
  switch (e.key) {
    case ' ':
      e.preventDefault();
      setPaused(!paused);
      break;
    case 'Backspace':
    case 'Escape':
      e.preventDefault();
      cam.ascend();
      break;
    case 'f':
    case 'F':
      cam.travelTo(mv.fittest());
      break;
    case 'l':
    case 'L':
      renderer.showLabels = !renderer.showLabels;
      break;
    case 'u':
    case 'U':
      renderer.showUmbilicals = !renderer.showUmbilicals;
      break;
    case 'h':
    case 'H':
      ui.classList.toggle('hidden');
      break;
    case 'r':
    case 'R':
      restart();
      break;
    case '+':
    case '=':
      speedInput.value = String(Math.min(60, +speedInput.value + 5));
      setSpeed(+speedInput.value);
      break;
    case '-':
    case '_':
      speedInput.value = String(Math.max(0, +speedInput.value - 5));
      setSpeed(+speedInput.value);
      break;
    default:
      break;
  }
});

window.addEventListener('resize', () => renderer.resize());

let flashT = 0;
function flash() {
  flashT = 1;
}

// --------------------------------------------------------------------- loop

let last = performance.now();
let fpsAcc = 0;
let fpsN = 0;
let fps = 0;

function frame(now) {
  const realDt = Math.min(0.1, (now - last) / 1000) || 0;
  last = now;

  fpsAcc += realDt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0;
    fpsN = 0;
  }

  if (!paused && speed > 0) {
    let remaining = realDt * speed;
    let guard = 0;
    while (remaining > 1e-4 && guard++ < 12) {
      const step = Math.min(MAX_SUBSTEP, remaining);
      mv.step(step);
      remaining -= step;
    }
  }
  cam.update(realDt);

  renderer.render(mv, cam.transform(), realDt);

  if (flashT > 0) {
    flashT = Math.max(0, flashT - realDt * 2.2);
    const ctx = renderer.ctx;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(190,210,255,${(flashT * 0.5).toFixed(3)})`;
    ctx.fillRect(0, 0, renderer.width, renderer.height);
    ctx.globalCompositeOperation = 'source-over';
  }

  hud.update(mv, realDt, { fps });
  requestAnimationFrame(frame);
}

setPaused(false);
setSpeed(+speedInput.value);
requestAnimationFrame(frame);

// Exposed for debugging and for the headless smoke test.
window.__cosmic = { mv, cam, renderer, hud };
