// Headless visual check.
//
//   node tools/shot.mjs [seconds] [outfile] [speed]
//
// Loads the page in Chromium, lets the multiverse run at an accelerated rate,
// then writes a screenshot and reports any console errors. Used to verify the
// renderer without a display.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const seconds = Number(process.argv[2] || 40);
const out = process.argv[3] || 'dist/shots/scene.png';
const speed = Number(process.argv[4] || 60);

mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto('http://127.0.0.1:8123/index.html', { waitUntil: 'networkidle' });
await page.evaluate((s) => {
  const el = document.getElementById('speed');
  el.value = String(s);
  el.dispatchEvent(new Event('input'));
}, speed);

await page.waitForTimeout(seconds * 1000);

// Software rasterisation in headless mode trips the adaptive-quality guard;
// pin full quality so the screenshot shows what real hardware renders.
await page.evaluate(() => {
  window.__cosmic.renderer.quality = 0;
  window.__cosmic.renderer._adapt = () => {};
});
await page.waitForTimeout(600);

// Optionally dive into a child universe before capturing.
if (process.env.DIVE) {
  await page.evaluate(() => {
    const { mv, cam } = window.__cosmic;
    const kid = mv.focus.children.find((c) => c.alive);
    if (kid) cam.dive(kid);
  });
  await page.waitForTimeout(4000);
}

const state = await page.evaluate(() => {
  const { mv } = window.__cosmic;
  const c = mv.counts();
  return {
    ...c,
    time: Math.round(mv.time),
    drift: mv.drift,
    focus: mv.focus.id,
    focusStars: mv.focus.stars.length,
    focusHoles: mv.focus.blackHoles.length,
    focusParticles: mv.focus.pool.count,
    children: mv.focus.children.length,
  };
});

await page.screenshot({ path: out });
console.log(JSON.stringify(state, null, 2));
if (errors.length) {
  console.log('\nCONSOLE ERRORS:');
  for (const e of errors.slice(0, 12)) console.log('  ' + e);
}
await browser.close();
process.exit(errors.length ? 1 : 0);
