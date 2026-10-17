# Where work stopped (handoff)

Last updated 2026-10-17. Work happens on branch `phase-5`; `master` is fast-forwarded to the same commit and both are pushed to `origin` (https://github.com/santhoshkumarhari/PrismBI). Pushing is approved, publishing to npm is not (see below). There is deliberately no CI workflow.

## State

- **Phases 1–9 are done**, including the items deferred along the way.
- **Tests:** 350+ pass (`npm test`). `npm run test:visual` covers 78 screenshot baselines. `npm run typecheck` and `npm run build` are clean.
- **Entries:**
  - Main: `@prismbi/prismbi`, `/core`, `/visuals`, `/visuals/<family>` (22).
  - UI and frameworks: `/studio`, `/react`, `/elements`.
  - Data: `/connectors`, `/worker`, `/sql`.
  - Other: `/files`, `/ai`, `/server`, `/collab`, `/plugins`, `/powerbi`.
- **CLI:** `bin/prismbi.mjs` (split, join, diff, pbip) and `scripts/sign-plugin.mjs`.
- **Demo pages** (`npm run dev`, then http://localhost:5173): `/`, `/studio.html` (agent panel, DAX copilot), `/perf.html`, `/elements.html`, `/gallery.html`, `/playground.html`.
- **Docs site:** `npm run docs` (or `npm run docs:build`) writes `examples/docs/`, which is gitignored and served at `/docs/`. Guide code blocks fenced as ```` ```js playground ```` get a Run link, appear in the playground, and are executed by `tests/playground.test.ts`.

## What's left

- **Nothing from the roadmap.** The last deferred items landed on 2026-10-17:
  - animated transitions;
  - keyboard walkthrough tests;
  - calculation-item formats;
  - `NATURALINNERJOIN` / `NATURALLEFTOUTERJOIN` / `SAMPLE`;
  - geo upgrades (`@prismbi/prismbi/geo`, clustering, classed legends).

  Their tests are in `tests/deferred.test.ts`.
- **Closed on 2026-10-17 (second pass):**
  - SQL filter-context mode (time intelligence, `ALL*`, `CALCULATE` overrides);
  - Power BI calculation groups;
  - bitmap indexes;
  - WebGL scatter;
  - screenshots throughout the docs (`npm run docs:images` regenerates them).
- **Known gaps:**
  - SQL: `CROSSFILTER` and bidirectional relationships throw `SqlUnsupportedError`; set `fallback: 'model'` to answer them in memory. (`USERELATIONSHIP`, measures in `FILTER` and RLS are pushed down.)
  - SQLite is slow on non-contiguous date contexts (no subquery decorrelation); DuckDB and Postgres are fine.
- **Playground:** add more ```` ```js playground ```` examples to the guides; each one is tested automatically.

## Planned next (approved by the owner, not started)

Agreed on 2026-10-17 to be done later, in this order. Before starting, check with any other session working in the repo and claim files (two sessions edited the same tree on 2026-10-17).

### 1. Docs site and playground on GitHub Pages

- **Build:** add multi-page inputs to `examples/vite.config.ts` (`index`, `studio`, `perf`, `elements`, `gallery`, `playground`), and set `base: '/PrismBI/'` only for the Pages build (an env flag), so `npm run dev` keeps `/`.
- **Docs:** run `scripts/build-docs.mjs` first, so `examples/docs/` (with `docs/images`) goes into the build.
- **Publish without CI** (the owner wants no workflow): a new `scripts/deploy-pages.mjs` builds into a temp folder, commits it to an orphan `gh-pages` branch through a git worktree, and pushes.
- **Turn Pages on once:** Settings › Pages › branch `gh-pages`. The GitHub CLI isn't installed here, so the owner does this in the browser.
- **Check:** links in the generated docs are relative; the playground loads `docs/guide/*.md` through `import.meta.glob` (bundled at build time); the perf page's 1M-row option still works.
- **Outward-facing:** confirm with the owner before the first push.

### 2. Real-world validation

- **Inputs:** ask the owner for a real `.pbip` project or dataset. Otherwise use a public sample, verified, never invented: a Power BI sample saved as `.pbip`, or a public CSV/Parquet of a few million rows loaded through `@prismbi/prismbi/connectors`.
- **Run it end to end:**
  - `importPowerBI`, then compare its warnings with what Power BI shows;
  - render the report and spot-check measures against Power BI's values;
  - open it in the Studio;
  - run `sqlEngine` against DuckDB (or SQLite) and diff the results with the in-memory engine;
  - time page loads.
- **Output:** a list of breakages and gaps, fixed one by one, each with a test.

### 3. Performance

- **Time intelligence in the single-pass path** (`src/data/fastQuery.ts`):
  - `SAMEPERIODLASTYEAR` / `DATEADD` / `DATESYTD` / `TOTALYTD` when the visual groups by date-table columns.
  - Map each fact row to the group(s) its shifted date belongs to, using the in-memory engine's month-end rule. YTD rows feed every later group of the same year (a prefix sum over date-ordered groups).
  - Today about 190 ms at 1M rows through partial aggregates. Gate it with an equivalence test (fast vs off), like `tests/fastcalc.test.ts`.
- **Dictionary-encoded text columns at load** (`src/data/table.ts`):
  - Store text columns as an `Int32Array` of codes plus a dictionary, and decode lazily in `values` / `toRows`.
  - Expect about 3–5× less memory on large tables, and faster filters and group-bys.
  - Watch out for the incremental append caches added on 2026-10-17 (streaming); appends must extend the dictionary.
- **Zero-copy worker transfer** (`src/worker.ts`):
  - When `crossOriginIsolated` is true, share numeric columns as `SharedArrayBuffer`; otherwise transfer `ArrayBuffer`s instead of structured-cloning arrays.
  - Measure worker start and memory on `/perf.html` at 1M rows.
- **SQL totals in one round trip** (`src/sql.ts`):
  - In aggregate mode, use `GROUPING SETS ((g…), ())` (DuckDB, Postgres) so totals come back with the rows; keep two statements for SQLite.
  - Add an optional result cache in `sqlEngine`, keyed by SQL text plus model version.

### 4. Polish

- **Canvas heatmaps and calendars** (`src/visuals/heatmap.ts`, `calendar.ts`):
  - Above about 3,000 cells, paint on a canvas with a grid hit-test, like `scatter.ts` `paintCanvas` / `overlay`.
  - Keep the SVG path for small grids and for exports.
- **Virtualized matrix** (`src/visuals/table.ts`):
  - Window rows the way the table already does (`format.table.virtualize`), keeping expand/collapse state.
  - Subtotal rows count as rows.
- **Lighter Studio undo** (`src/studio/history.ts`):
  - Store JSON patches (or structural diffs) between documents instead of full snapshots, with a snapshot every N steps.
  - Keep the 200-step limit.
- **Perf budgets:** `npm run size` exists (added by the other session). Extend `npm run bench` with per-query time budgets that fail when exceeded (some cases already carry budgets in `bench/scale.test.ts`).

## Publishing (deferred by the owner: "we will deploy later")

- **Package:** `@prismbi/prismbi@0.6.0` is ready. npm rejected the unscoped name `prismbi` as too close to `prisma` and `prismjs`.
- **Before publishing:** the owner creates the free npm organization `prismbi` on npmjs.com.
- **Then:** run `npm publish --access public --auth-type=web` in a real terminal, since the passkey prompt opens in the browser.
- **Bump first:** Phases 7–9 landed after 0.6.0. Bump to 0.9.0, merge the two unreleased CHANGELOG sections under it with the date, then publish.

## Remaining Phase 6 items (do in this order)

### 1. ✅ DONE: `@prismbi/prismbi/server` (src/server.ts, tests/server.test.ts, docs/guide/server.md)

Kept below for reference.

#### Original plan

Create `src/server.ts` as a new entry. Register it in all of these:
- `tsup.config.ts`
- `package.json` exports (and `sideEffects` only if it registers anything)
- the alias lists in `vitest.config.ts` and `examples/vite.config.ts`

Contents:
- **`withDom(window, fn)`:** installs and later restores the globals. Covers `window`, `document`, `HTMLElement`, `SVGElement`, `Element`, `Node`, `getComputedStyle`, `Event`, `CustomEvent`, `MouseEvent` and `KeyboardEvent`. The caller passes any DOM (jsdom, linkedom, happy-dom), so the library takes on no dependency.
- **Headless sizes:** a layout-less DOM reports `clientWidth` 0, so `VisualHost.render` (`src/report/visualHost.ts`, `this.size = …`) needs explicit pixel sizes.
  - Add a `ReportOptions.measure?: (visualId) => { width, height } | undefined` option, threaded through `ReportRuntime`.
  - Compute boxes from the grid layout: columns, rowHeight and gap, minus about 24 px padding and 20 px title.
- **`renderVisualSvg(model, spec, { window, width, height, theme })`:** returns the visual's own `<svg>` for charts. HTML visuals (cards, tables) fall back to `elementToSvg` in `src/report/snapshot.ts`.
- **`renderReportHtml(model, def, { window, page, width, theme })`:** returns a standalone HTML string. It includes `prismCss` and the theme's CSS variables on the root, with visuals absolutely positioned.
- **`watchMeasure(model, { measure, filters, when: { above } | { below } | { changeBy: pct } | fn, onAlert, debounceMs })`:**
  - Edge-triggered.
  - Re-evaluates on `model.onChange`, so it works with `streamInto` and `scheduleRefresh`.
  - Returns a stop function.
- **`scheduleReport({ every: ms | 'daily@HH:MM', run, onError })`:** a simple scheduler. Email delivery is the user's job; document a nodemailer example.
- **Tests:** run with `// @vitest-environment node` plus `new JSDOM()`. `measureText` already falls back to an estimate under jsdom.
- **Docs:** `docs/guide/server.md`.

### 2. ✅ DONE: Collaboration (src/collab.ts, tests/collab.test.ts, docs/guide/collab.md; demo /studio.html?room=demo)

#### Original plan: Collaboration: `@prismbi/prismbi/collab`

- **Document:** an operation-based document over report JSON. Visuals and pages are keyed by id, and properties use last-writer-wins with Lamport clocks and a site id.
  - Hook into the Studio history snapshots (`src/studio/history.ts`) and `Report.load` / `definitionChanged`.
- **Transport interface:** `send(op)` / `onMessage`. Built in: `BroadcastChannel`, which lets two tabs co-edit with no server, plus a WebSocket relay example.
- **Comments on data points:** `{ id, visualId, identity, text, author, at, resolved }`, stored in the document and shown as badges, plus a comments pane in the Studio.
- **Shared bookmarks:** stored in the document.
- **Demo:** open `/studio.html` in two tabs. Test with two in-memory peers.

### 3. ✅ DONE: Plugins (src/plugins.ts, scripts/sign-plugin.mjs, tests/plugins.test.ts, docs/guide/plugins.md)

**Phase 6 is complete.** Next: Phase 7, starting with visual calculations and window functions plus visual regression tests (see `docs/ROADMAP.md`).

#### Original plan: Plugins: `@prismbi/prismbi/plugins`

- **Manifest:** `{ name, version, kind: 'visual' | 'connector' | 'theme', entry, integrity: 'sha256-…', signature }`.
- **`loadPlugin(url, { trustedKeys })`:**
  - Fetch the code.
  - Verify its SHA-256 and an ECDSA P-256 / Ed25519 signature with WebCrypto.
  - `import()` it from a blob URL and register it.
  - Reject unsigned plugins unless `allowUnsigned`.
- **Signing:** `scripts/sign-plugin.mjs` (Node crypto) to generate keys and sign.
- **Marketplace:** a JSON index format, plus a "Get more visuals" gallery in the Studio's visualizations pane.

### Then

- **Docs:** update `docs/ROADMAP.md` (Phase 6 checklist), `CHANGELOG.md` 0.6.0, the README docs list and sizes, and the CONTRIBUTING budgets.
- **Sizes today, min+gzip:** core ≈60 KB (budget 62), full ≈93 KB (95), studio ≈96 KB (100), ai ≈15.5 KB, elements ≈1.7 KB, files ≈2.7 KB, connectors ≈3 KB, worker ≈1.3 KB. Measure by bundling a `dist` import with esbuild, `--minify`, then gzip.
- **Review:** run a live headless-Chrome check of the new pages. There's a CDP driver pattern in the session scratchpad (`cdp.mjs`): launch Chrome with `--headless=new --remote-debugging-port`, then use the global `WebSocket`.
- **Wrap-up:** commit on `phase-5` (or a new `phase-6` branch), then `git checkout master && git merge --ff-only`. Do not push.

## After Phase 6

**Phase 7 progress:** visual calculations, DAX window functions and visual regression tests are done (tests/phase7.test.ts, scripts/visual-test.mjs, examples/gallery*.ts, baselines in tests/visual/). Transforms (src/data/transform.ts, src/studio/transforms.ts, docs/guide/transforms.md) are done too. Phone layouts are done too. **Phase 7 is complete** (animated transitions deferred). Power BI import (src/powerbi.ts, tests/powerbi.test.ts, docs/guide/powerbi.md) is done. Lineage and impact analysis (src/data/lineage.ts) is done. Accessibility narration and the high-contrast theme are done. Localization, subscriptions and alerts are done. Conditional visibility (`visibleWhen`) and the usage hook (`onUsage`, tests/visibility.test.ts) are done; Phase 8 is complete except optional geo upgrades. The Studio agent panel (src/ai/run.ts, src/ai/panel.ts, tests/agent.test.ts) is done. The narrative visual (src/ai/narrative.ts, tests/narrative.test.ts) is done. The DAX copilot (src/ai/copilot.ts, tests/copilot.test.ts) is done. Anomaly alerts (src/ai/anomaly.ts, tests/anomaly.test.ts) are done. SQL pushdown (src/sql.ts, tests/sql.test.ts, docs/guide/sql.md) is done. Incremental refresh (src/data/refreshPolicy.ts, tests/refresh.test.ts) is done. Per-visual entries (src/visuals/entries/*, tsup globs them, `./visuals/*` export) are done. Next: the rest of Phase 9 (docs site). Earlier Phase 7 notes: visual polish (calendar heatmap, forecast band, error bars, axis zoom, animated transitions). Then Power BI import from Phase 9.

Phases 7–9 are planned in `docs/ROADMAP.md`. Next after Phase 6: visual calculations and window functions, visual regression tests, then Power BI import.

## Gotchas learned

- **Escaping:** inline `node - <<'EOF'` scripts with template literals mangle regex backslashes (`\[`, `\/`, `\\`). Use the Edit tool for lines containing regexes, or write a script file.
- **Stray `cat`:** never leave a bare `cat > file` without a heredoc; it blocks on stdin.
- **Line endings:** LF is enforced (`.gitattributes`). Normalise `\r\n` in scripts.
- **Attribution:** author is Santhoshkumar Hariharan.
- **Previews:** show them as local HTML pages, not published artifacts.
