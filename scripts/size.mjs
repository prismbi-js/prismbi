#!/usr/bin/env node
/**
 * Bundle size check: `npm run build && npm run size`.
 *
 * Each scenario is bundled from `dist/` the way an app bundler would (minified, code splitting on), and the gzipped size
 * of what loads up front is compared with its budget: the entry chunk plus every chunk it imports statically. Chunks
 * behind dynamic `import()` (PDF export, snapshots…) only load on demand and are reported separately.
 *
 * `api` scenarios import everything an entry exports (the worst case); `app` scenarios import what a typical app uses.
 * Exits with 1 when a scenario is over budget. Raise a budget deliberately, in the same commit as the code that needs it.
 */
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = resolve('dist').replace(/\\/g, '/');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
/** `@prismbi/prismbi[/sub]` → the ESM file its `exports` entry points to (entries import each other by package name). */
const PACKAGE_ALIASES = Object.fromEntries(
  Object.entries(pkg.exports)
    .filter(([k, v]) => !k.includes('*') && typeof v === 'object' && v.import)
    .map(([k, v]) => [k === '.' ? pkg.name : `${pkg.name}/${k.slice(2)}`, resolve(v.import).replace(/\\/g, '/')]),
);

/** [name, source, budget in KB min+gzip, optional base scenario: report only the increment over it] */
const SCENARIOS = [
  ['core (api)', `export * from '${dist}/core.js';`, 102],
  ['core (app: DataModel + Report)', `import { DataModel, Report } from '${dist}/core.js'; console.log(DataModel, Report);`, 91],
  ['full (api)', `export * from '${dist}/index.js';`, 143],
  ['full (app: DataModel + Report + visuals)', `import { DataModel, Report } from '${dist}/index.js'; console.log(DataModel, Report);`, 137],
  ['studio (app)', `import { Studio } from '${dist}/studio.js'; console.log(Studio);`, 128],
  ['core app + one visual entry (bar)', `import { DataModel, Report } from '${dist}/core.js'; import '${dist}/visuals/bar.js'; console.log(DataModel, Report);`, 98],
  ['core app + five visual entries', `import { DataModel, Report } from '${dist}/core.js'; ${['bar', 'line', 'pie', 'card', 'slicer'].map((v) => `import '${dist}/visuals/${v}.js';`).join(' ')} console.log(DataModel, Report);`, 111],
  ['connectors', `export * from '${dist}/connectors.js';`, 5],
  ['worker', `export * from '${dist}/worker.js';`, 3],
  ['ai (on top of full)', `export * from '${dist}/index.js'; export * from '${dist}/ai.js';`, 28, 'full (api)'],
  ['sql (on top of full)', `export * from '${dist}/index.js'; export * from '${dist}/sql.js';`, 14, 'full (api)'],
];

const dir = mkdtempSync(join(tmpdir(), 'prismbi-size-'));
const gz = (code) => gzipSync(code, { level: 9 }).length / 1024;
let failed = false;
const rows = [];
try {
  const measured = new Map();
  for (const [i, [name, source, budget, base]] of SCENARIOS.entries()) {
    const entry = join(dir, `s${i}.mjs`);
    writeFileSync(entry, source);
    const out = join(dir, `out${i}`);
    const res = await build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      format: 'esm',
      splitting: true,
      outdir: out,
      metafile: true,
      write: true,
      logLevel: 'error',
      platform: 'browser',
      // resolve the package as an installed app would (dist), not through this repo's tsconfig paths (src)
      tsconfigRaw: '{}',
      alias: PACKAGE_ALIASES,
    });
    const outputs = res.metafile.outputs;
    const entryOut = Object.keys(outputs).find((k) => outputs[k].entryPoint);
    // up-front = the entry chunk and its static imports, transitively
    const upfront = new Set();
    const queue = [entryOut];
    while (queue.length) {
      const k = queue.pop();
      if (upfront.has(k)) continue;
      upfront.add(k);
      for (const imp of outputs[k].imports) if (imp.kind === 'import-statement' && outputs[imp.path]) queue.push(imp.path);
    }
    let initial = 0;
    let lazy = 0;
    for (const k of Object.keys(outputs)) {
      if (!k.endsWith('.js')) continue;
      const size = gz(readFileSync(k));
      if (upfront.has(k)) initial += size;
      else lazy += size;
    }
    measured.set(name, { initial, lazy });
    if (base) {
      initial -= measured.get(base).initial;
      lazy -= measured.get(base).lazy;
    }
    const over = initial > budget;
    failed ||= over;
    rows.push([name, initial.toFixed(1), String(budget), lazy > 0.05 ? `+${lazy.toFixed(1)} lazy` : '', over ? 'OVER BUDGET' : '']);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length), ['scenario', 'KB', 'budget', '', ''][c].length));
const line = (r) => r.map((x, c) => (c === 1 || c === 2 ? x.padStart(widths[c]) : x.padEnd(widths[c]))).join('  ').trimEnd();
console.log(line(['scenario', 'KB', 'budget', '', '']));
for (const r of rows) console.log(line(r));
console.log('\nmin+gzip, loaded up front; lazy chunks load on demand.');
if (failed) {
  console.error('\nSize budget exceeded.');
  process.exit(1);
}
