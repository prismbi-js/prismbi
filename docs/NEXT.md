# Where work stopped (handoff)

Last updated 2026-10-28. Work happens on branch `phase-5`; `master` is fast-forwarded to the same commit and both are pushed to `origin` (https://github.com/prismbi-js/prismbi). Pushing is approved, publishing to npm is not (see below). There is deliberately no CI workflow.

## State

- **v0.11.0 enhancements delivered:** Financial DAX (`XNPV`, `XIRR`), bitwise DAX, `CONTAINSROW`/tuple `IN`, T-SQL & BigQuery SQL pushdown (parameterized mode), streaming CSV URL connectors, PowerPoint PPTX exporter, standalone MCP server, Matrix stepped layout & sparklines, GeoJSON boundaries, Small Multiples expansion, Studio UX & quick measures.
- **Tests:** 520 pass across 46 test suites (`npm test`; the SQLite cases need Node 22, e.g. `C:/Users/santh/AppData/Local/nvm/v22.10.0/node.exe node_modules/vitest/vitest.mjs run`). `npm run test:visual` covers 90 screenshot baselines (0 failures). `npm run bench` has per-query time budgets. `npm run typecheck`, `npm run build` and `npm run size` are clean.
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
  - SQL: everything below is pushed down: `CROSSFILTER` (all modes), bidirectional relationships, `USERELATIONSHIP`, measures in `FILTER`, RLS, `DATESINPERIOD`, date windows in variables, iterators over `VALUES` with a measure, `SELECTEDVALUE` / `HASONEVALUE`. Still needing `fallback: 'model'`: `MEDIAN` outside DuckDB, `FORMAT` patterns other than simple date parts, table variables other than date windows, iterators over `ALL(…)` or `FILTER(…)` with a measure body. Postgres is checked with PGlite (`@electric-sql/pglite` installed into the scratchpad, not the project): a copy of `tests/sql.test.ts` with an in-process runner, tables loaded through `json_populate_recordset`; the real-world sample passes on it too.
- **Playground:** add more ```` ```js playground ```` examples to the guides; each one is tested automatically.

## Planned next (approved by the owner, not started)

Agreed on 2026-10-17 to be done later, in this order. Before starting, check with any other session working in the repo and claim files (two sessions edited the same tree on 2026-10-17).

### 1. Docs site and playground on GitHub Pages (done 2026-10-19)

- `npm run deploy:pages` (`scripts/deploy-pages.mjs`) builds the docs, then the Vite pages, copies `examples/docs/` to `docs/`, and pushes the result to the site repo's `main`. `--dry` builds into `node_modules/.pages/site` only. No CI; redeploy by hand after doc or demo changes.
- Live at https://prismbi-js.github.io/ (docs at `/docs/`). Source: https://github.com/prismbi-js/prismbi (moved from santhoshkumarhari/PrismBI on 2026-10-19). The built site is pushed to a separate repo, `prismbi-js/prismbi-js.github.io` (branch `main`), which Pages serves at the root.
- The README links the live site; the npm page picks that up with the next published version.

### 2. Real-world validation

- **Inputs:** ask the owner for a real `.pbip` project or dataset. Otherwise use a public sample, verified, never invented: a Power BI sample saved as `.pbip`, or a public CSV/Parquet of a few million rows loaded through `@prismbi/prismbi/connectors`.
- **Run it end to end:**
  - `importPowerBI`, then compare its warnings with what Power BI shows;
  - render the report and spot-check measures against Power BI's values;
  - open it in the Studio;
  - run `sqlEngine` against DuckDB (or SQLite) and diff the results with the in-memory engine;
  - time page loads.
- **Output:** a list of breakages and gaps, fixed one by one, each with a test.

### Done on 2026-10-23 (session reactbi-78)

Fast-path coverage for everyday measure shapes (CHANGELOG, Unreleased): scalar wrappers, VAR, MINX/MAXX/COUNTX, FILTER over the fact table, ALL/REMOVEFILTERS/ALLEXCEPT/ALLSELECTED shares, RANKX(ALL(col)), iterators over VALUES(col) with a measure, DATESINPERIOD rolling windows; compiled FILTER and cached column-only boolean filters in the evaluator. Equivalence tests in `tests/fastscalar.test.ts`. How it fits together (`src/data/fastQuery.ts`): `expr` tree nodes are evaluated by the evaluator on literal arguments; `sub` / `rank` nodes are coarser or finer grouped queries (`resolveSub`, `resolveRank`, `resolveIter`) that recurse into `fastGroupQuery`, with filter removal done by `evaluator.removeWith`; row tests come from `compileRowTest` (`src/dax/rowCompile.ts`). Core +4 KB (budgets raised). Bench budgets for the two new cases (900 / 300 ms) checked on an idle machine on 2026-10-23: 300 and 67 ms at 1M rows.

**Not covered yet (still per group):** RANKX over a table without a unique key, or with a measure that isn't BLANK for missing values; FILTER next to a time-intelligence filter in the same CALCULATE; ALL/RANKX nested inside another CALCULATE's filters or inside time intelligence.

### Done on 2026-10-22 (session reactbi-8c)

All in `CHANGELOG.md` under Unreleased. Highlights:

- **Fixed:** plugin signing on Node 18 (no global `crypto`); SQL silently ignored bidirectional relationships (now semi-joins; `CROSSFILTER` BOTH/ONEWAY pushed down).
- **Performance:** time intelligence in the single-pass path (`src/data/fastQuery.ts` + shared calendar rules in `src/dax/timeIntel.ts`; day × YTD at 1M rows 193 → 21 ms); SQL totals via `GROUPING SETS` and an optional result cache; canvas heatmaps/calendars (`src/visuals/raster.ts`); virtualized matrix; undo history as splices; worker `addColumns` with transferred typed buffers (`src/data/packed.ts`); faster `allRows`.
- **Features:** sunburst visual; warm start (`cachedTables` etc. in connectors, IndexedDB).
- **Budgets raised deliberately** (`scripts/size.mjs`): core +3 KB, full +3 / +5 KB, studio +2, worker 3, connectors 5.
- **Verification aids not committed:** DuckDB checks ran through a scratch copy of `tests/sql.test.ts` with Python `duckdb` (pip into a temp dir); repeat that way when changing `src/sql.ts`.

**Storage decisions (measured 2026-10-22):** text and date columns now share one object per distinct value, which takes 1M dates from 120 to 8 MB and 1M strings from 40 to 8 MB with no API change. That was the bulk of the memory the columnar-storage item aimed at, so the full typed-storage refactor is shelved. Typed row lists (`Int32Array` from `rowsOf`) were measured too: 2.5× less memory and about 15% faster intersections in Node, but little gain in browsers (V8 pointer compression already stores small-integer arrays compactly), against an audit of every evaluator path that consumes row lists. Not done; revisit only for server-side use with many cached contexts.

**Real-world validation (2026-10-22):** ran against the public PBIP sample [RuiRomano/pbip-demo](https://github.com/RuiRomano/pbip-demo) (no licence, so used locally only and nothing committed) with its CSV data from `pbi-tools/sales-sample`. All five reports import and render with 0 errors after the fixes listed in the changelog. To repeat: clone it into the scratchpad, map each table's CSV through the columns' `sourceColumn` (applying `Table.RenameColumns` steps), call `importPowerBI`, evaluate every measure, render every page, and compare `setFastQuery('off')` against `'auto'`. The product matrix that combined time intelligence with product grouping (8.6 s with the general engine) now takes about 0.35 s: the time-intelligence fast path handles mixed groupings since 2026-10-22 (later the same day), with results identical to `setFastQuery('off')`. SQL on this model (also 2026-10-22): a scratch test loads every table into SQLite and runs every query the reports issue plus every measure by a few columns through `sqlEngine` with no fallback, comparing with the in-memory engine (relative 1e-6). DuckDB checks: copy `tests/sql.test.ts` with a Python `duckdb` runner (columns as `DOUBLE` and `DATE`; DuckDB's `REAL` is 32-bit). Not validated: comparing values with Power BI itself (no Power BI here).

**Still open from the plan below:** feature ideas other than the sunburst and warm start (key influencers, aggregation tables, goals and scorecards); real-world validation (item 2).

### 3. Performance

- **Time intelligence in the single-pass path** (`src/data/fastQuery.ts`):
  - `SAMEPERIODLASTYEAR` / `DATEADD` / `DATESYTD` / `TOTALYTD` when the visual groups by date-table columns.
  - Map each fact row to the group(s) its shifted date belongs to, using the in-memory engine's month-end rule. YTD rows feed every later group of the same year (a prefix sum over date-ordered groups).
  - Today about 190 ms at 1M rows through partial aggregates. Gate it with an equivalence test (fast vs off), like `tests/fastcalc.test.ts`.
- **Columnar storage from load time** (`src/data/table.ts`; merges both sessions' items):
  - Keep number and date columns as `Float64Array`, and text as an `Int32Array` of codes plus a dictionary, from the moment a table loads, instead of plain arrays plus lazily built views.
  - Expect about 3–5× less memory on large tables, and faster filters and group-bys.
  - Do it as a phased refactor, because `Column.values` is read in many places: decode lazily in `values` / `toRows`, and move hot readers to the typed views first.
  - Watch the incremental append caches (streaming, 2026-10-17): appends must extend the dictionary and grow the typed arrays.
- **Typed row lists** (`rowsOf` / `rowsCache` as `Int32Array`):
  - Less memory and faster intersections.
  - Audit every caller first: `.map` on a typed array coerces results to integers.
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

### 5. From the other session (reactbi-9e, 2026-10-17)

- **Excel export: implemented but NOT committed.**
  - New files: `src/report/xlsx.ts` and `tests/xlsx.test.ts`.
  - Changes in `src/core.ts`, `src/report/report.ts`, `src/report/visualHost.ts`, `docs/guide/interactions.md`, `docs/guide/visuals.md` and `CHANGELOG.md`.
  - The full suite passed (406 tests), and openpyxl reads the files back correctly.
  - Build passes. **`npm run size` currently FAILS** (measured 2026-10-17, working tree = `8bb376b` + the uncommitted Excel export):

    | Scenario | At `916f12e` | Now | Budget |
    |---|---|---|---|
    | core, `DataModel` + `Report` | 75.3 KB | 79.9 KB | 77 KB |
    | core, everything exported | 85.7 KB | 90.3 KB | 88 KB |
    | full entry, every visual | 117.1 KB | 121.8 KB | 120 KB |

    The core bundles grew about 4.6 KB. The xlsx writer loads lazily (lazy chunks grew only 0.2 → 0.4 KB), so most of it likely comes from `8bb376b` (CALCULATE in the fast path) and the new export methods in `report.ts` / `visualHost.ts`. This is unconfirmed.
  - Before committing:
    1. Compare per-module sizes at `916f12e` and now (esbuild `--metafile` on the core entry).
    2. Trim, or raise the budgets in `scripts/size.mjs` deliberately in that commit.
    3. Rerun `npm run build && npm run size`.
- **Visual baselines after lazy rendering:** run `npm run test:visual` once, to confirm lazy off-screen rendering didn't change the screenshots. The gallery renders through `flush()`, so it should pass. (A run on 2026-10-17 after `e499abb`/`8bb376b` passed: 86 screenshots, 0 failures.)
- **Core trimming (optional, decided against for now):** lazy-loading edit mode (`setEditMode`), the filter pane (`toggleFilterPane`) and transforms (`transformTable`) would save about 5–6 KB gzipped, but needs API changes. The size budgets in `scripts/size.mjs` prevent further growth.
- **Feature ideas:**
  - a key influencers visual;
  - aggregation tables (Power BI's "manage aggregations", alongside SQL pushdown);
  - warm start from IndexedDB (persist the model and its caches);
  - goals and scorecards (built on `watchMeasure`);
  - a sunburst visual.

## Publishing (deferred by the owner: "we will deploy later")

- **Package:** `@prismbi/prismbi@0.11.0` is ready (npm org `prismbi` created 2026-10-19). npm rejected the unscoped name `prismbi` as too close to `prisma` and `prismjs`.
- **Before publishing:** the owner creates the free npm organization `prismbi` on npmjs.com.
- **Then:** run `npm publish --access public --auth-type=web` in a real terminal, since the passkey prompt opens in the browser.

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
