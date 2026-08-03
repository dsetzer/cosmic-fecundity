// Bundle the whole demonstration into one self-contained HTML file.
//
//   node tools/build.mjs [outfile]
//
// There is no dependency to bundle and no transpiling to do — every module here
// is hand-written ES2020 — so the "bundler" is a concatenation in dependency
// order with the module syntax stripped and the result wrapped in an IIFE. That
// keeps the source a normal multi-file ES-module project while still producing
// a single file that runs from `file://` or from a static host with no build
// step of its own.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, process.argv[2] || 'dist/cosmic-fecundity.html');

/** Dependency order. Kept explicit: it is short, and an explicit list is easier
 *  to reason about than a resolver for eleven files. */
const MODULES = [
  'src/engine/rng.js',
  'src/engine/color.js',
  'src/engine/particles.js',
  'src/engine/spatialhash.js',
  'src/sim/genome.js',
  'src/sim/bodies.js',
  'src/sim/universe.js',
  'src/sim/multiverse.js',
  'src/engine/renderer.js',
  'src/ui/hud.js',
  'src/main.js',
];

function strip(src) {
  return (
    src
      // `import { a, b } from './x.js';`, including multi-line forms
      .replace(/^import[\s\S]*?from\s*['"][^'"]+['"];\s*$/gm, '')
      .replace(/^import\s*['"][^'"]+['"];\s*$/gm, '')
      // `export { a, b };` re-export statements
      .replace(/^export\s*\{[^}]*\}\s*;\s*$/gm, '')
      // `export const/function/class` → plain declaration
      .replace(/^export\s+(?=(const|let|var|function|class|async)\b)/gm, '')
      .trim()
  );
}

const banner = `/*
 * Cosmic Fecundity — a perpetual multiverse.
 *
 * Built from the module sources in src/ by tools/build.mjs.
 * Edit the sources, not this file.
 */`;

const code = MODULES.map((m) => {
  const body = strip(readFileSync(resolve(root, m), 'utf8'));
  return `// ${'='.repeat(74)}\n// ${m}\n// ${'='.repeat(74)}\n\n${body}`;
}).join('\n\n');

const css = readFileSync(resolve(root, 'styles/main.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');

// Take the markup between <body> and the module script tag, so the page
// structure has exactly one source of truth.
const bodyMatch = html.match(/<body>([\s\S]*?)<script type="module"/);
if (!bodyMatch) throw new Error('could not locate the page body in index.html');
const body = bodyMatch[1].trim();

const titleMatch = html.match(/<title>([^<]*)<\/title>/);
const title = titleMatch ? titleMatch[1] : 'Cosmic Fecundity';
const descMatch = html.match(/name="description"\s*\n?\s*content="([^"]*)"/);
const description = descMatch ? descMatch[1].replace(/\s+/g, ' ').trim() : '';
const iconMatch = html.match(/<link\s+rel="icon"[\s\S]*?\/>/);

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    ${iconMatch ? iconMatch[0] : ''}
    <style>
${css}
    </style>
  </head>
  <body>
${body}
    <script>
${banner}
(function () {
'use strict';
${code}
})();
    </script>
  </body>
</html>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log(`wrote ${out}  (${(page.length / 1024).toFixed(1)} kB)`);
