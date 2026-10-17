#!/usr/bin/env node
// Visual regression tests: screenshot every visual in /gallery.html (light + dark) with headless Chrome and
// compare against baselines in tests/visual/<theme>/<visual>.png.
//   npm run test:visual            compare (exit 1 on differences; failures saved to tests/visual/__diff__/)
//   npm run test:visual -- --update   write new baselines
// Chrome is found automatically or via CHROME_PATH. Baselines depend on fonts, so keep them per machine/CI image.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, sleep } from './lib/chrome.mjs';
import { createServer } from 'vite';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'tests', 'visual');
const UPDATE = process.argv.includes('--update');
const THRESHOLD = 0.005; // share of pixels allowed to differ

/** Pixel difference ratio between two PNGs (base64), computed in the page with a canvas. */
const diffInPage = (a, b) => `(async () => {
  const load = (src) => new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = err; i.src = 'data:image/png;base64,' + src; });
  const [x, y] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
  if (x.width !== y.width || x.height !== y.height) return 1;
  const px = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
  const p = px(x), q = px(y);
  let bad = 0;
  for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 48) bad++;
  return bad / (p.length / 4);
})()`;

const server = await createServer({ configFile: join(ROOT, 'examples', 'vite.config.ts'), server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const chrome = await launch();
const failures = [];
let checked = 0;
let written = 0;
try {
  for (const theme of ['light', 'dark']) {
    await chrome.send('Page.navigate', { url: `${base}/gallery.html?theme=${theme}` });
    for (let i = 0; i < 120; i++) {
      if (await chrome.evaluate(`document.body?.dataset.ready === 'true'`).catch(() => false)) break;
      await sleep(250);
    }
    await sleep(400);
    const cells = await chrome.evaluate(`[...document.querySelectorAll('.cell')].map((c) => { const r = c.querySelector('.vis').getBoundingClientRect(); return { key: c.dataset.key, x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, error: c.querySelector('.pbi-error')?.textContent ?? null }; })`);
    mkdirSync(join(OUT, theme), { recursive: true });
    for (const c of cells) {
      if (c.error) {
        failures.push(`${theme}/${c.key}: render error: ${c.error}`);
        continue;
      }
      const shot = (await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 } })).data;
      const file = join(OUT, theme, `${c.key}.png`);
      checked++;
      if (UPDATE || !existsSync(file)) {
        writeFileSync(file, Buffer.from(shot, 'base64'));
        written++;
        continue;
      }
      const ratio = await chrome.evaluate(diffInPage(readFileSync(file).toString('base64'), shot));
      if (ratio > THRESHOLD) {
        mkdirSync(join(OUT, '__diff__'), { recursive: true });
        writeFileSync(join(OUT, '__diff__', `${theme}-${c.key}.png`), Buffer.from(shot, 'base64'));
        failures.push(`${theme}/${c.key}: ${(ratio * 100).toFixed(2)}% of pixels differ`);
      }
    }
  }
} finally {
  await chrome.close();
  await server.close();
}
console.log(`Visual tests: ${checked} screenshots, ${written} baseline(s) written, ${failures.length} failure(s).`);
for (const f of failures) console.log(`  ✗ ${f}`);
if (failures.length) {
  console.log('New screenshots are in tests/visual/__diff__/. Run with --update if the change is intended.');
  process.exitCode = 1;
}
