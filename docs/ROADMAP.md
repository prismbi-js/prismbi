# PrismBI roadmap

PrismBI aims to give web developers everything a Power BI report author has, then go further. It covers a semantic model, a DAX-like formula engine, interactive visuals, slicing and filtering, theming, and authoring. It ships as a TypeScript library that is **modern, fast, light and deeply customizable**.

Each phase ends in a release that can ship on its own. A phase is done when its acceptance criteria pass in CI.

| Phase | Theme | Release | Status |
|---|---|---|---|
| 1 | Core engine and essential visuals | `0.1` | ✅ Implemented (this repo) |
| 2 | Pro visuals and deeper interactivity | `0.2` | ✅ Implemented |
| 3 | Advanced modeling and DAX coverage | `0.3` | ✅ Implemented |
| 4 | Authoring studio (drag-and-drop editor) | `0.4` | ✅ Implemented |
| 5 | Scale, performance and data connectors | `0.5` | ✅ Implemented |
| 6 | Beyond Power BI: AI, collaboration, embedding | `1.0` | In progress (3 of 6) |

## Guiding principles

1. **Light.** Zero runtime dependencies, tree-shakeable ESM, one stylesheet injected at runtime. The core (model, DAX engine with ~160 functions, query engine with the single-pass grouped path, report runtime with edit mode) is **≈60 KB min+gzip**. A typical dashboard that registers five visuals from `@prismbi/prismbi/visuals` is **≈76 KB**, everything (34 visuals) is **≈93 KB**, and the full studio app (`@prismbi/prismbi/studio`) is **≈96 KB**. Connectors (≈3 KB) and the worker engine (≈1.3 KB) are separate entries. Editor tooling is tree-shaken out unless imported.
2. **Fast.** Columnar storage, lazy hash indexes, filter-context caching and measure memoisation. Rendering is batched with `requestAnimationFrame`, and only visuals whose query changed re-run it.
3. **Correct semantics.** Filter context, row context, context transition, CALCULATE, auto-exist and real (non-additive) totals behave as they do in Power BI. When behaviour differs, the docs say so.
4. **Customizable at every layer.** That includes theme tokens and CSS variables, per-visual format panes, theme `visualStyles`, custom tooltips, custom visuals, and swappable palettes. Nothing in a visual is hard-coded.
5. **Framework-agnostic core.** Vanilla DOM and SVG, with thin React bindings. Vue, Svelte and Angular wrappers follow the same pattern.
6. **Accessible by default.** Keyboard-reachable marks, ARIA roles, a legend whenever there are two or more series, a "show as table" view on every chart, and reduced-motion support. Colour palettes are validated for colour-vision deficiency.

---

## Phase 1: Core engine and essential visuals ✅

**Goal:** a developer can model data, write measures, and ship an interactive multi-page report with slicers and cross-filtering in under 50 lines.

### 1.1 Data layer
- [x] `DataTable`: columnar storage, type inference (number, string, boolean, date), ISO date coercion, `fromColumns` fast path
- [x] Lazy per-column hash indexes and sorted distinct values that honour **Sort by column**
- [x] `DataModel`: tables, many-to-one relationships (filters flow one → many, star and snowflake), key-uniqueness check
- [x] Expanded-table semantics, related-value lookup, `RELATED` paths across several hops
- [x] Calculated columns (row context), preserved across `refreshTable`
- [x] Generated date table (`addDateTable`) with Year → Quarter → Month → Day, fiscal year, and pre-wired sort-by columns
- [x] Field list (`fields()`) and serialisable metadata (`toJSON()`)

### 1.2 Formula engine (DAX subset, about 110 functions)
- [x] Lexer and parser: operators, `VAR … RETURN`, comments, quoted tables, `IN { … }`, syntax errors with position
- [x] BLANK semantics, filter context and row context, **context transition**, measure memoisation, circular-reference detection
- [x] `CALCULATE` / `CALCULATETABLE` with boolean, table, `ALL`, `REMOVEFILTERS`, `ALLEXCEPT`, `ALLSELECTED` and `KEEPFILTERS` modifiers
- [x] Aggregations and iterators: `SUM…MEDIAN`, `SUMX…CONCATENATEX`, `RANKX`, `TOPN`, `FILTER`, `VALUES`, `DISTINCT`
- [x] Time intelligence: `TOTALYTD/QTD/MTD`, `DATESYTD/QTD/MTD`, `SAMEPERIODLASTYEAR`, `DATEADD`, `PARALLELPERIOD`, `PREVIOUSMONTH/QUARTER/YEAR`, `DATESBETWEEN`, `FIRSTDATE`, `LASTDATE`
- [x] Logic, math, text and date functions. The full list is in [expressions.md](guide/expressions.md).

### 1.3 Query engine
- [x] `SUMMARIZECOLUMNS`-style grouping with **auto-exist**: only combinations that have data
- [x] Implicit aggregations (`Sum of`, `Average of`, `Count (Distinct) of`, …) and ad-hoc expressions
- [x] Sorting (by key with sort-by columns, or by value), `top`, Top N filters, **real totals**
- [x] Highlight queries: each value is returned alongside its value under the selection, for cross-highlighting
- [x] Filter operators: `in`, `notIn`, `eq`, `neq`, `gt/gte/lt/lte`, `between`, `contains`, `startsWith`, `endsWith`, `isBlank`, `isNotBlank`, multi-column `tuples` and `topN`

### 1.4 Visuals (23 types)
- [x] Column and bar charts (clustered, stacked, 100% stacked), line, area, stacked area, line + clustered column combo
- [x] Pie, donut (with centre total), treemap (squarified), funnel, scatter and bubble
- [x] Card, multi-row card, KPI (goal and sparkline), gauge (min, max, target)
- [x] Table (sorting, totals, data bars, colour scales, rules, icons, incremental rendering), matrix (row hierarchy with expand/collapse, column pivot, real subtotals)
- [x] Slicer: list, dropdown, tiles, between (numeric or date, dual slider), **relative date**, search, single or multi select, Select all
- [x] Text box with safe mini-markdown and live `{{Measure}}` placeholders
- [x] Shared mark specs: thin bars capped at 24 px, 4 px rounded data ends, 2 px surface gaps, 2 px lines, ≥8 px markers, recessive grid. Smart label fitting and rotation, end labels, crosshair tooltips, grow-in animation.

### 1.5 Interactivity: slicing and narrowing down
- [x] Cross-filter and cross-highlight between visuals. Ctrl or ⌘ + click multi-selects, and clicking a legend entry selects that series.
- [x] Per-visual interaction mode (`filter` / `highlight` / `none`) and per-source overrides (`interactionsFrom`)
- [x] Report, page and visual filters, plus a **filter pane** with Basic, Advanced and Top N cards and "add data field"
- [x] Drill down (double-click), drill up, "go to next level", and a drill breadcrumb
- [x] Focus mode, show as table, export CSV, Esc to exit or clear
- [x] Bookmarks (page, filters, slicers, selection and drill) and JSON save/load that keeps dates intact

### 1.6 Report runtime, theming, frameworks
- [x] Multi-page reports, page tabs, a responsive 12-column grid (container queries stack visuals on narrow screens)
- [x] Light and dark themes (validated colour-vision-safe palette), `createTheme`, `registerTheme`, **Power BI theme JSON import**, `visualStyles`
- [x] Power BI format strings (`#,0.00`, `0.0%`, `$#,0`, `#,0,`, `0.00E+00`, date tokens), display units, deterministic default locale
- [x] Typed events: `selectionChanged`, `filtersChanged`, `pageChanged`, `dataPointClick`, `drill`, `rendered`, `error`, …
- [x] React: `<PrismReport>`, `<PrismVisual>`, and the imperative API through a ref
- [x] Custom visuals via `defineVisual` / `registerVisual`, with exported SVG and scale helpers

**Acceptance criteria (met):** 67 unit and integration tests pass (engine, DAX, formatting, rendering and interactions in jsdom). Every built-in visual renders without errors. The demo (≈31k rows, 3 pages, 24 visuals) renders headlessly with no errors. Typecheck is strict and clean.

**Known limitations, carried into later phases:** relationships are single-direction only. Highlight works on column, bar, pie, donut, treemap and funnel; other visuals filter instead. The combo chart's legend splits only the columns. The cold first evaluation of a measure over very many groups (e.g. YTD per day) takes about 0.5 s on 30k rows (cached afterwards).

---

## Phase 2: Pro visuals and deeper interactivity ✅

**Goal:** match Power BI's full core visual set and interaction model.

### Narrowing down
- [x] **Right-click menu** on any data point, table or matrix row: **Include**, **Exclude** (become visual filters), **Drill through**, Clear selection, Clear visual filters
- [x] **Drill-through pages** (`page.drillthrough`) with carried filters (`keepAllFilters`), a **← Back** button, a pane section, `report.drillThrough()` / `back()`
- [x] **Slicer sync groups**, a **hierarchy (tree) slicer**, **Expand all down one level**
- [x] **Decomposition tree** with manual and automatic (High value / Low value) splits that cross-filter the page
- [x] **Edit interactions** mode: pick Filter, Highlight or None per visual pair (toolbar or `setInteraction()`)
- [x] **Report tooltips**: a tooltip page (`page.tooltip`) rendered inside the tooltip, filtered to the hovered point (`format.tooltip.page`)

### Axes & analytics
- [x] **Continuous time and number axes** on line and area charts (calendar-aligned ticks), with a categorical override
- [x] **Log scales** on line and scatter (`valueAxis.scale`, `categoryAxis.scale`)
- [x] Reference lines (constant, average, median, min, max, percentile), trend lines, rule- and gradient-based colours
- [x] Cross-highlighting on line, area and scatter

### Visuals (11 new, 34 in total)
- [x] Waterfall, heatmap, decomposition tree, **small multiples** for column, bar, line and area charts
- [x] Histogram, box plot, bullet, radar, sankey (multi-stage), ribbon
- [x] **Bubble map** and **filled map** (Web Mercator, your own GeoJSON or XYZ tiles, wheel zoom and drag pan, and a lat/long grid fallback)

### Output & persistence
- [x] Export each visual as **PNG or SVG**. Export pages as a **PDF** with a built-in, dependency-free writer that is loaded lazily
- [x] **Persisted visual state** (`spec.state`): table sorting, matrix expansion and decomposition splits are saved in the report JSON
- [x] **Lean entry points**: `@prismbi/prismbi/core` plus `@prismbi/prismbi/visuals` for tree-shaken builds, and one registry shared across entries
- [x] 101 tests in total

### Moved to later phases
- Key influencers (statistical model): Phase 6, alongside AI insights
- Calendar heatmap, forecast band, error bars, zoom slider: Phase 5 polish
- Animated transitions between data states: Phase 4 (studio)
- Per-page mobile layouts: Phase 4 (studio)
- Screenshot (visual regression) tests: once the live-browser review is done

**Acceptance:** visual regression tests (Playwright screenshots) on every visual in both themes. Keyboard-only walkthrough of every interaction. Lighthouse accessibility score ≥95 on the demo.

## Phase 3: Advanced modeling and DAX coverage ✅

**Goal:** model anything Power BI Desktop can.

### Relationships
- [x] **Bidirectional** cross-filtering (`crossFilter: 'both'`), with cycle-safe propagation that only narrows a dimension by filters from the other side
- [x] **Many-to-many** relationships (`cardinality: 'manyToMany'`)
- [x] **Inactive** relationships, plus `USERELATIONSHIP`, `CROSSFILTER` and `TREATAS`, carried in the filter context so caching and `CALCULATE` scoping stay correct

### DAX coverage (about 160 functions)
- [x] Table functions: `SUMMARIZE`, `SUMMARIZECOLUMNS`, `ADDCOLUMNS`, `SELECTCOLUMNS`, `CROSSJOIN`, `UNION`, `INTERSECT`, `EXCEPT`, `GENERATE`, `ROW`, `DATATABLE`, `GENERATESERIES`, `CALENDAR`
- [x] **Calculated tables** (`addCalculatedTable`) and `model.evaluateTable()` (a DAX query's EVALUATE)
- [x] `LOOKUPVALUE`, `CONTAINS`, `EARLIER`, `EARLIEST`, `FIRSTNONBLANK`, `LASTNONBLANK`, the `PATH` family, `ISINSCOPE`, `ISCROSSFILTERED`
- [x] Statistics: `STDEV`, `VAR` (sample and population, column and X), `PERCENTILE(X).INC/EXC`, `GEOMEAN(X)`, `AVERAGEA`, `MAXA`, `MINA`
- [x] Fixed: row context no longer transitions on bare table references or `VALUES` (DAX semantics, which `EARLIER` patterns need). Date ± whole days is now DST-safe.

### Model objects
- [x] **Calculation groups** (`SELECTEDMEASURE`, `SELECTEDMEASURENAME`, `ISSELECTEDMEASURE`, precedence, combining several groups)
- [x] **Field parameters** (a slicer picks the measures or columns a visual shows)
- [x] **What-if parameters**, plus a **slider** slicer style
- [x] **Hierarchies** as model objects (drillable wells; tree slicers), **display folders**, **perspectives**
- [x] **Row-level security**: roles with DAX rules, `USERNAME` / `CUSTOMDATA`, union of roles. It can't be removed by `ALL()`, and slicer domains and the filter pane respect it.

### Tooling
- [x] **Language service**: completion, hover, signature help, diagnostics, formatting
- [x] **DAX formatter** (`formatDax`) and **dependency explanation** (`explainDax`)
- [x] A function catalog checked against the evaluator by a test
- [x] Demo: a Modeling page, a "View as" RLS switch and a **DAX console**

**Acceptance (met):** a conformance suite of more than 60 expressions plus feature tests (167 tests in total). Every catalogued function is implemented. Benchmark timings are unchanged from Phase 2.

**Deferred:** `NATURALINNERJOIN`, `SAMPLE`, `RANK`/`WINDOW` functions and visual calculations (Phase 4 studio work), plus calculation-item format strings (use `FORMAT()` inside the item for now).

## Phase 4: Authoring studio ✅

**Goal:** end users build reports in the browser, the way they do in Power BI Desktop.

- [x] `@prismbi/prismbi/studio` (+ `<PrismStudio>`): edit-mode canvas with select, drag, 8-way resize and grid snapping, plus keyboard nudges, duplicate, copy/paste, delete and front/back
- [x] **Fields pane** (search, folders, hidden toggle, drag and drop, click to add, measure and column actions), **Build pane** (visual picker that keeps fields, wells with reorder, remove and aggregation)
- [x] **Format pane generated from a format schema** (common sections plus visual-specific ones), page settings, report name and a **theme designer**
- [x] **Filters pane** (visual, page, report), **page management** (add, rename, duplicate, hide, reorder, delete)
- [x] **Measure and calculated-column editors** with completion, diagnostics, signature help, a live preview and formats. Renaming a measure updates the visuals that use it
- [x] **Data view** and **model view** (relationship diagram: drag a column to relate tables, edit direction and active state, delete)
- [x] **Undo/redo** for report *and* model edits, **autosave**, export and import. The document stores model changes as a diff
- [x] **Versioned report JSON** (`REPORT_SCHEMA_VERSION`, `migrateReport`, migrations applied by `Report.parse` / `load`)
- [x] **Auto page**: a starter report generated from the model (`autoReport`)
- [x] Report edit-mode APIs (`setEditMode`, `updatePage`, `movePage`, `duplicatePage`, `duplicateVisual`, `arrange`, `findFreeSpot`, `load`, `definitionChanged`)
- [x] Demo: `examples/studio.html`. 18 studio tests (189 in total)

**Deferred:** multi-select with align and distribute, a Power Query-style transform editor, animated transitions between data states, and per-page mobile layouts (Phase 5 polish). Also a usability test with non-developers (acceptance criterion), which is pending the live review.

## Phase 5: Scale, performance and connectors ✅

**Goal:** millions of rows in the browser, and live data.

### Engine
- [x] **Typed column views:** `Float64Array` numeric views and dictionary encoding (`Int32Array` codes), built lazily and cached per column
- [x] **Vectorised aggregations** for `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT(A)`, `DISTINCTCOUNT`
- [x] **Single-pass grouped queries.** Simple measures (those aggregations, `COUNTROWS`, `+ - * /`, `DIVIDE`, measure references) are answered in one pass over the fact rows instead of once per group, with automatic fallback to the general engine. A 16k-group query at 200k rows went from 10 s to 57 ms.
- [x] Cheaper filter cache keys
- [x] **Worker engine** (`@prismbi/prismbi/worker`): `serveModel` / `createWorkerEngine` with an async query, evaluate and mutate API, `AbortSignal` cancellation, and `createLocalEngine` for the same API in-process
- [x] **`model.appendRows(table, rows, { maxRows })`:** incremental calculated columns and a sliding window

### Connectors (`@prismbi/prismbi/connectors`)
- [x] CSV (RFC 4180, delimiter detection, per-column typing), Google Sheets CSV URLs
- [x] JSON, REST with page, offset, cursor and Link-header pagination, GraphQL
- [x] Apache Arrow tables (duck-typed, no dependency). Parquet via DuckDB-Wasm or any Arrow producer
- [x] SQL adapter interface (`loadSqlTables`)
- [x] Streaming from WebSocket, EventSource or any message port (`streamInto`, batched, windowed), and `scheduleRefresh`

### Rendering
- [x] LTTB downsampling for dense lines and areas (hover still reads every point)
- [x] Canvas scatter above 3,000 points, with grid hit-testing for tooltips, selection, the context menu and drill
- [x] Virtualized tables above 500 rows

### Tooling
- [x] `npm run bench` (200k and 1M rows, cold timings with regression ceilings) and the `/perf.html` demo (scale and live stream)

- [x] **Per-dimension pre-aggregation** for time intelligence and running totals: YTD per day at 1M rows went from 2.8 s to 193 ms
- [x] **Reports on the worker engine** (`new Report(el, { model, engine })`): asynchronous visuals, loading and busy states, cancellation of superseded queries

**Acceptance:** 227 tests pass, including equivalence of the fast and scan paths on the demo model, time-intelligence measures, row-level security and edge cases (blanks, unmatched keys, dimension nulls). At 1M rows every benchmark query takes 13–204 ms cold.

A live-browser review in headless Chrome covered every demo page, the studio, dark mode, canvas hit-testing, table scrolling, the live stream and worker mode. It found and fixed four defects:
- Lines were invisible with reduced motion enabled.
- `pos;neg;zero` format sections weren't supported.
- Treemap tiles past the palette were grey.
- The slider slicer was clipped in two-row cells.

**Deferred:**
- Per-visual entry points
- Bitmap or roaring indexes
- DuckDB pushdown (DAX → SQL)
- WebGL rendering
- A Node server runtime with scheduled refresh
- Performance budgets in CI

## Phase 6: Beyond Power BI (in progress)

**Done:**
- [x] **`@prismbi/prismbi/ai`:**
  - `ask`: plain-language questions become visuals, offline, with an optional LLM hook.
  - `explain`: change and composition drivers, plus "Explain this" on right-click.
  - `findInsights`: anomalies, trends, movers, concentration, outliers.
  - The `qna` and `insights` visuals.
  - Agent context (`getAIContext`, `contextToPrompt`) and provider-agnostic tools (`createAgentTools`) for Claude, OpenAI and MCP.
- [x] **`@prismbi/prismbi/elements`:** `<prism-report>` and `<prism-visual>` web components, plus Svelte actions. Vue and Angular use them directly.
- [x] **`@prismbi/prismbi/files`:** split, join and diff of report files, plus the `@prismbi/prismbi` CLI.

**Remaining:**
- Headless rendering, scheduled sends and measure alerts (`@prismbi/prismbi/server`)
- Real-time co-editing, comments and shared bookmarks
- Signed plugins and the marketplace

**Goal:** features Power BI doesn't have, or that are clunky there.

- Questions in plain language ("sales by region last quarter") → a generated visual. Plain-language explanations of any data point. Anomaly and insight detection.
- Real-time collaboration (CRDT-based co-editing), comments on data points, shared bookmarks
- Headless mode: server-side rendering of reports to SVG or PDF, email subscriptions, alerts on measure thresholds
- Plugin marketplace for visuals, connectors and themes. Signed plugins.
- Framework packages: `@prismbi/vue`, `@prismbi/svelte`, `@prismbi/angular`, web components
- Version-control-friendly report files (one file per page or visual) and diffable reviews

---

## Release process

- Semantic versioning. The 0.x series may change APIs between minors, with migration notes in `CHANGELOG.md`.
- Every PR runs typecheck, unit tests, a bundle-size check (fails above +5% of budget), and, from Phase 2, visual regression tests.
- Docs live in `docs/`. Every public API needs a TSDoc comment and a guide entry.
