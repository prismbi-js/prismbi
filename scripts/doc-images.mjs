#!/usr/bin/env node
// Screenshots for the docs: the demo pages, the Studio and its dialogs, and every visual from /gallery.html.
//   npm run docs:images            writes docs/images/*.png and docs/images/visuals/*.png
//   npm run docs:images -- studio  only shots whose name contains "studio"
// Uses the demo data, so images are reproducible; rerun after visual changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { launch, sleep } from './lib/chrome.mjs';
import { buildDocs } from './build-docs.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'images');
const only = process.argv[2];

// click / right-click the first data point of a visual (by visual id)
const point = (id, type = 'click') => `(() => { const m = document.querySelector('[data-visual-id="${id}"] .pbi-mark'); const r = m.getBoundingClientRect(); m.dispatchEvent(new MouseEvent('${type}', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); })()`;
const button = (text) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`;

/** name, page, setup script, optional clip selector, viewport and theme. */
const SHOTS = [
  { name: 'report-overview', url: '/index.html' },
  { name: 'report-overview-dark', url: '/index.html', dark: true },
  { name: 'report-cross-filter', url: '/index.html', setup: point('by-cat') },
  { name: 'report-context-menu', url: '/index.html', setup: point('by-cat', 'contextmenu') },
  { name: 'report-filter-pane', url: '/index.html', setup: button('Filters') },
  { name: 'report-high-contrast', url: '/index.html', setup: `report.setTheme('high-contrast')` },
  { name: 'report-analysis', url: '/index.html', setup: `report.goToPage('analysis')` },
  { name: 'report-insights', url: '/index.html', setup: `report.goToPage('insights')` },
  { name: 'report-modeling', url: '/index.html', setup: `report.goToPage('modeling')` },
  { name: 'decomposition-tree', url: '/index.html', setup: `report.goToPage('insights')`, clip: '[data-visual-id="i-tree"]' },
  { name: 'qna', url: '/index.html', setup: `report.goToPage('insights'); document.querySelector('[data-visual-id="i-qna"]').scrollIntoView()`, clip: '[data-visual-id="i-qna"]' },
  { name: 'insights', url: '/index.html', setup: `report.goToPage('insights'); document.querySelector('[data-visual-id="i-auto"]').scrollIntoView()`, clip: '[data-visual-id="i-auto"]' },
  { name: 'narrative', url: '/index.html', setup: `report.goToPage('insights'); document.querySelector('[data-visual-id="i-story"]').scrollIntoView()`, clip: '[data-visual-id="i-story"]' },
  { name: 'report-phone', url: '/index.html', width: 390, height: 844, setup: `report.autoMobileLayout(); report.setLayoutMode('mobile')` },
  { name: 'dax-console', url: '/index.html', setup: `document.getElementById('dax').click()` },
  { name: 'studio', url: '/studio.html' },
  { name: 'studio-agent', url: '/studio.html', setup: `agent.open(); agent.run('Build a page about bikes: sales by month, top 5 products by sales, sales by country')`, wait: 2500 },
  { name: 'studio-dax-copilot', url: '/studio.html', setup: `studio.editMeasure(); (() => { const d = document.querySelector('[role=dialog]'); d.querySelector('input[aria-label="Describe the measure"]').value = 'sales yoy % for bikes'; [...d.querySelectorAll('button')].find((b) => b.textContent === '✦ Write DAX').click(); setTimeout(() => [...d.querySelectorAll('button')].find((b) => b.textContent === 'Explain').click(), 300); })()`, clip: '[role=dialog]', wait: 1200 },
  { name: 'studio-transforms', url: '/studio.html', setup: `studio.editTransforms('Sales')`, clip: '[role=dialog]' },
  { name: 'studio-schedules', url: '/studio.html', setup: `studio.editSchedules()`, clip: '[role=dialog]' },
  { name: 'studio-quick-measures', url: '/studio.html', setup: `studio.quickMeasure()`, clip: '[role=dialog]', wait: 500 },
  { name: 'studio-layers', url: '/studio.html', setup: `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Layers')?.click()`, wait: 500 },
  { name: 'studio-model-view', url: '/studio.html', setup: `studio.setView('model')` },
  { name: 'studio-data-view', url: '/studio.html', setup: `studio.setView('data')` },
  { name: 'studio-phone', url: '/studio.html', setup: `studio.setPhoneLayout(true)` },
  { name: 'performance', url: '/perf.html', wait: 6000 },
  { name: 'web-components', url: '/elements.html' },
  { name: 'playground', url: '/playground.html#interactions/0' },
  { name: 'docs-site', url: '/docs/ai.html' },
];

const server = await createServer({ configFile: join(ROOT, 'examples', 'vite.config.ts'), server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
buildDocs();
mkdirSync(join(OUT, 'visuals'), { recursive: true });
const chrome = await launch({ width: 1440, height: 900 });
let written = 0;

const ready = async () => {
  for (let i = 0; i < 120; i++) {
    const ok = await chrome.evaluate(`document.readyState === 'complete' && !document.querySelector('.pbi-loading')`).catch(() => false);
    if (ok) break;
    await sleep(250);
  }
};

try {
  for (const shot of SHOTS) {
    if (only && !shot.name.includes(only)) continue;
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: shot.width ?? 1440, height: shot.height ?? 900, deviceScaleFactor: 1, mobile: !!shot.width && shot.width < 600 });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: shot.dark ? 'dark' : 'light' }] });
    await chrome.send('Page.navigate', { url: `${base}${shot.url}` });
    await sleep(1500);
    await ready();
    if (shot.setup) await chrome.evaluate(`(async () => { ${shot.setup}; })()`);
    await sleep(shot.wait ?? 900);
    await ready();
    let clip;
    if (shot.clip) {
      const r = await chrome.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(shot.clip)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, width: b.width, height: b.height }; })()`);
      if (!r) throw new Error(`${shot.name}: ${shot.clip} not found`);
      clip = { ...r, scale: 1 };
    }
    const { data } = await chrome.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
    writeFileSync(join(OUT, `${shot.name}.png`), Buffer.from(data, 'base64'));
    written++;
  }

  // every visual, light theme, from the gallery
  if (!only || 'visuals'.includes(only)) {
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: 1640, height: 1200, deviceScaleFactor: 1, mobile: false });
    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] });
    await chrome.send('Page.navigate', { url: `${base}/gallery.html?theme=light` });
    for (let i = 0; i < 120; i++) {
      if (await chrome.evaluate(`document.body?.dataset.ready === 'true'`).catch(() => false)) break;
      await sleep(250);
    }
    await sleep(400);
    const cells = await chrome.evaluate(`[...document.querySelectorAll('.cell')].map((c) => { const r = c.querySelector('.vis').getBoundingClientRect(); return { key: c.dataset.key, x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; })`);
    for (const c of cells) {
      const { data } = await chrome.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 1 } });
      writeFileSync(join(OUT, 'visuals', `${c.key}.png`), Buffer.from(data, 'base64'));
      written++;
    }
  }
} finally {
  await chrome.close();
  await server.close();
}
console.log(`Docs images: ${written} written to docs/images/`);
