// The read-out. Everything here is descriptive: it reports what the simulation
// did, and never feeds anything back into it.
//
// Charting decisions, briefly:
//   · Gene drift is a *signed* quantity around a founding value, so it gets a
//     diverging encoding — one warm pole, one cool pole, neutral midpoint —
//     with the direction also carried by an arrow and a signed number, never by
//     colour alone.
//   · Black-hole yield by generation is one series over an ordinal axis, so it
//     is a plain line with a direct label on the last point and no legend.

import { GENES } from '../sim/genome.js';
import { PHASE_NAMES } from '../sim/universe.js';
import { generationColor } from '../engine/color.js';

const UP = '#e66767'; // diverging warm pole — above the founding value
const DOWN = '#3987e5'; // diverging cool pole — below it
const INK_2 = '#a7b0c4';
const INK_3 = '#6e788e';

const el = (id) => document.getElementById(id);

function fmt(n, d = 0) {
  if (!isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function clock(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export class HUD {
  constructor(onSelect) {
    this.onSelect = onSelect;
    this.acc = 0;
    this.nodes = {
      focusId: el('focus-id'),
      focusGen: el('focus-gen'),
      focusPhase: el('focus-phase'),
      focusStats: el('focus-stats'),
      genes: el('focus-genes'),
      census: el('census'),
      ledger: el('ledger'),
      drift: el('drift'),
      spark: el('spark'),
      yieldNote: el('yield-note'),
      tree: el('tree'),
      log: el('log'),
    };
    this._buildGenes();
    this._buildDrift();
    this._lastLogLen = -1;
  }

  _buildGenes() {
    this.nodes.genes.innerHTML = '';
    this.geneRows = GENES.map((spec) => {
      const row = document.createElement('div');
      row.className = 'gene';
      row.title = `${spec.label} — ${spec.note}`;
      row.innerHTML = `
        <span class="sym">${spec.symbol}</span>
        <span class="track"><i class="fill"></i><i class="founder"></i></span>
        <span class="val">0.00</span>
        <span class="name">${spec.label}</span>`;
      this.nodes.genes.appendChild(row);
      return {
        spec,
        fill: row.querySelector('.fill'),
        founder: row.querySelector('.founder'),
        val: row.querySelector('.val'),
      };
    });
  }

  _buildDrift() {
    this.nodes.drift.innerHTML = '';
    this.driftRows = GENES.map((spec) => {
      const row = document.createElement('div');
      row.className = 'drow';
      row.innerHTML = `
        <span class="sym">${spec.symbol}</span>
        <span class="dtrack"><i class="mid"></i><i class="bar"></i></span>
        <span class="dv">—</span>`;
      this.nodes.drift.appendChild(row);
      return { spec, row, bar: row.querySelector('.bar'), dv: row.querySelector('.dv') };
    });
  }

  update(mv, dt, extra) {
    this.acc += dt;
    if (this.acc < 0.16) return;
    this.acc = 0;

    this._focus(mv);
    this._census(mv, extra);
    this._selection(mv);
    this._tree(mv);
    this._log(mv);
  }

  // ------------------------------------------------------------------ focus

  _focus(mv) {
    const u = mv.focus;
    const n = this.nodes;
    n.focusId.textContent = `U${u.id}`;
    n.focusId.style.color = `rgb(${u.tint.join(',')})`;
    n.focusGen.textContent = `generation ${u.generation}`;
    n.focusPhase.textContent = PHASE_NAMES[u.phase];

    const born = u.blackHolesFormed;
    n.focusStats.innerHTML = `
      ${stat(u.stars.length, 'stars')}
      ${stat(u.blackHoles.length, 'black holes')}
      ${stat(u.pool.count, 'particles')}
      ${stat(u.starsFormed, 'stars ever')}
      ${stat(born, 'collapses')}
      ${stat(u.children.length, 'offspring')}`;

    const founder = mv.root.genome;
    for (const r of this.geneRows) {
      const v = u.genome[r.spec.key];
      const f = (v - r.spec.lo) / (r.spec.hi - r.spec.lo);
      const fv = (founder[r.spec.key] - r.spec.lo) / (r.spec.hi - r.spec.lo);
      r.fill.style.width = `${(f * 100).toFixed(1)}%`;
      r.founder.style.left = `${(fv * 100).toFixed(1)}%`;
      r.val.textContent = v.toFixed(2);
    }
  }

  // ----------------------------------------------------------------- census

  _census(mv, extra) {
    const c = mv.counts();
    this.nodes.census.innerHTML = `
      ${stat(c.universes, 'live universes')}
      ${stat(c.born, 'universes born')}
      ${stat(c.deepest, 'deepest generation')}
      ${stat(c.dissolved, 'recycled')}
      ${stat(c.particles, 'particles')}
      ${stat(`${c.stars}/${c.holes}`, 'stars / holes')}`;

    const drift = mv.drift;
    const ok = Math.abs(drift) < 1;
    this.nodes.ledger.innerHTML =
      `<span>mass ${fmt(mv.totalMass(), 0)}</span>` +
      `<span class="${ok ? 'ok' : ''}">drift ${drift >= 0 ? '+' : ''}${drift.toFixed(3)}</span>` +
      `<span>${clock(mv.time)} · ${extra.fps | 0} fps</span>`;
  }

  // -------------------------------------------------------------- selection

  _selection(mv) {
    const s = mv.selectionSummary();
    if (!s) return;

    for (const r of this.driftRows) {
      const key = r.spec.key;
      const d = s.current[key] - s.founder[key];
      const range = r.spec.hi - r.spec.lo;
      // Half-track represents a quarter of the full gene range, which keeps
      // realistic drift legible without ever clipping.
      const frac = Math.max(-1, Math.min(1, d / (range * 0.25)));
      const w = Math.abs(frac) * 50;
      const positive = d >= 0;
      r.bar.style.background = Math.abs(d) < range * 0.005 ? 'var(--neutral)' : positive ? UP : DOWN;
      r.bar.style.left = positive ? '50%' : `${50 - w}%`;
      r.bar.style.width = `${Math.max(1.5, w)}%`;
      r.dv.textContent = `${positive ? '▲' : '▼'} ${d >= 0 ? '+' : ''}${d.toFixed(3)}`;
      r.dv.style.color = Math.abs(d) < range * 0.005 ? INK_3 : INK_2;
      r.row.title = `${r.spec.label}: founder ${s.founder[key].toFixed(2)} → now ${s.current[key].toFixed(2)}`;
    }

    this._spark(s);
  }

  /** Single-series line: collapse rate per universe at each generation. */
  _spark(s) {
    const data = s.stats;
    const W = 288;
    const H = 84;
    const pad = { l: 4, r: 30, t: 10, b: 16 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const maxY = Math.max(0.5, ...data.map((d) => d.collapseRate));
    const maxX = Math.max(1, data.length - 1);
    const px = (i) => pad.l + (i / maxX) * iw;
    const py = (v) => pad.t + ih - (v / maxY) * ih;

    const pts = data.map((d, i) => [px(i), py(d.collapseRate)]);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const last = data[data.length - 1];

    const gridY = [0, 0.5, 1]
      .map((f) => {
        const y = pad.t + ih - f * ih;
        return `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + iw}" y2="${y.toFixed(1)}"
                 stroke="rgba(150,175,220,0.1)" stroke-width="1" />`;
      })
      .join('');

    const dots = pts
      .map(
        (p, i) =>
          `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="${UP}" />` +
          `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="9" fill="transparent">` +
          `<title>generation ${data[i].generation}: ${data[i].collapseRate.toFixed(2)} collapses per ` +
          `universe-minute (${data[i].n} universe${data[i].n === 1 ? '' : 's'})</title></circle>`
      )
      .join('');

    this.nodes.spark.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" role="img"
           aria-label="Mean stellar collapses per universe-minute, by generation">
        ${gridY}
        <path d="${path}" fill="none" stroke="${UP}" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round" />
        ${dots}
        <text x="${(pad.l + iw + 5).toFixed(1)}" y="${(py(last.collapseRate) + 3.5).toFixed(1)}"
              fill="${INK_2}" font-size="10" font-family="ui-monospace, monospace">
          ${last.collapseRate.toFixed(1)}
        </text>
        <text x="${pad.l}" y="${H - 3}" fill="${INK_3}" font-size="9"
              font-family="ui-monospace, monospace">gen 0</text>
        <text x="${(pad.l + iw).toFixed(1)}" y="${H - 3}" fill="${INK_3}" font-size="9"
              text-anchor="end" font-family="ui-monospace, monospace">gen ${last.generation}</text>
      </svg>`;

    const first = s.stats[0];
    const delta = last.collapseRate - first.collapseRate;
    this.nodes.yieldNote.textContent =
      s.stats.length < 2
        ? 'Waiting for the second generation.'
        : `Generation ${last.generation} averages ${last.collapseRate.toFixed(1)} collapses per ` +
          `universe-minute, ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta).toFixed(1)} from the founder.`;
  }

  // ------------------------------------------------------------------- tree

  _tree(mv) {
    const rows = mv.tree();
    const frag = document.createDocumentFragment();
    for (const { u, depth } of rows) {
      const node = document.createElement('div');
      node.className = 'tnode' + (u === mv.focus ? ' active' : '');
      const c = generationColor(u.generation);
      node.innerHTML =
        `<span style="width:${depth * 10}px"></span>` +
        `<span class="dot" style="background:rgb(${c.join(',')})"></span>` +
        `<span>U${u.id}</span>` +
        `<span class="meta">${u.stars.length}★ ${u.blackHoles.length}● ${u.children.length}⇣</span>`;
      node.title = `Universe ${u.id}, generation ${u.generation} — click to travel here`;
      node.addEventListener('click', () => this.onSelect(u));
      frag.appendChild(node);
    }
    this.nodes.tree.replaceChildren(frag);
  }

  _log(mv) {
    if (mv.events.length === this._lastLogLen) return;
    this._lastLogLen = mv.events.length;
    const frag = document.createDocumentFragment();
    for (const e of mv.events.slice(0, 14)) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="t">${clock(e.t)}</span><span>${e.text}</span>`;
      frag.appendChild(li);
    }
    this.nodes.log.replaceChildren(frag);
  }
}

function stat(v, label) {
  return `<div class="stat"><div class="v">${typeof v === 'number' ? fmt(v) : v}</div><div class="l">${label}</div></div>`;
}
