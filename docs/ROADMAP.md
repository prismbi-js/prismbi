# PrismBI roadmap

PrismBI aims to give web developers everything a Power BI report author has, then go further. It covers a semantic model, a DAX-like formula engine, interactive visuals, slicing and filtering, theming, and authoring. It ships as a TypeScript library that is **modern, fast, light and deeply customizable**.

Each phase ends in a release that can ship on its own. A phase is done when its acceptance criteria pass in CI.

| Phase | Theme | Release | Status |
|---|---|---|---|
| 1 | Core engine and essential visuals | `0.1` | ✅ Implemented (this repo) |
| 2 | Pro visuals and deeper interactivity | `0.2` | Planned |
| 3 | Advanced modeling and DAX coverage | `0.3` | Planned |
| 4 | Authoring studio (drag-and-drop editor) | `0.4` | Planned |
| 5 | Scale, performance and data connectors | `0.5` | Planned |
| 6 | Beyond Power BI: AI, collaboration, embedding | `1.0` | Planned |

## Guiding principles

1. **Light.** Zero runtime dependencies, tree-shakeable ESM, one stylesheet injected at runtime. Today the whole engine plus 23 visuals is **≈52 KB min+gzip**.
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

## Phase 2: Pro visuals and deeper interactivity

**Goal:** match Power BI's full core visual set and interaction model.

- Visuals: waterfall, ribbon, decomposition tree, key influencers (statistical), small multiples for every cartesian chart, a bullet chart, a heatmap, a calendar heatmap, a sankey, a box plot, a histogram, a radar chart, a choropleth or bubble map (pluggable tile and geo source), and an image or shape visual
- Continuous axes (numeric or time scales, log scale), reference lines (constant, average, median, percentile), trend lines, a forecast band, error bars, a zoom slider
- Highlight support on line, area and scatter. "Expand all down one level" for hierarchies. Drill-through pages with a back button and drill-through filters
- Conditional formatting everywhere: field-value, rules and gradients on chart colours, titles and backgrounds
- Report tooltips: a tooltip page rendered inside the tooltip
- Slicer sync across pages (sync groups), a hierarchy slicer, cascading slicers, "edit interactions" UI
- Export: PNG and SVG per visual, PDF per page, underlying-data export
- Animation of transitions between data states (not just entry)
- Mobile layout per page

**Acceptance:** visual regression tests (Playwright screenshots) on every visual in both themes. Keyboard-only walkthrough of every interaction. Lighthouse accessibility score ≥95 on the demo.

## Phase 3: Advanced modeling and DAX coverage

**Goal:** model anything Power BI Desktop can.

- Bidirectional cross-filtering, many-to-many relationships, inactive relationships with `USERELATIONSHIP`, `CROSSFILTER`, `TREATAS`
- Table functions: `SUMMARIZE`, `ADDCOLUMNS`, `SELECTCOLUMNS`, `GENERATE`, `CROSSJOIN`, `UNION`, `EXCEPT`, `INTERSECT`, `DATATABLE`, calculated tables
- Calculation groups and field parameters (switch measures or dimensions from a slicer), what-if parameters
- Hierarchies as model objects, display folders, perspectives, row-level security (roles and DAX filters)
- `EARLIER`, `PATH*` functions, statistical functions (`PERCENTILE.*`, `STDEV.*`, …), `ROLLUP` and `ISINSCOPE` for matrix subtotals
- A query plan explainer (`model.explain(expr)`), a DAX formatter, and language-server support (completion, hover, diagnostics) for editors

**Acceptance:** a conformance suite of at least 500 DAX expressions checked against reference results.

## Phase 4: Authoring studio

**Goal:** end users build reports in the browser, the way they do in Power BI Desktop.

- `@prismbi/studio`: drag-and-drop canvas with snap, resize and align, Fields pane, Visualizations pane, Format pane (generated from each visual's format schema), Filters pane, page management
- A measure editor with syntax highlighting, autocomplete and live preview
- A data view and model view (relationship diagram), Power Query-lite transforms (rename, type, split, unpivot, merge)
- Undo and redo, autosave, versioned report JSON with migrations, templates, and a theme designer
- Embeddable in any app. Every pane is replaceable.

**Acceptance:** non-developers rebuild the demo report from scratch in a usability test, without docs.

## Phase 5: Scale, performance and connectors

**Goal:** millions of rows in the browser, and live data.

- Execution in a Web Worker (off the main thread), with streaming results and cancellation
- Bitmap or roaring indexes, dictionary-encoded columns, typed arrays, vectorised aggregations
- Optional engines: Apache Arrow tables, DuckDB-WASM pushdown (DAX query → SQL), or a server-side engine on Node
- Connectors: CSV, JSON, Parquet, REST/GraphQL, SQL (via a backend adapter), Google Sheets, streaming/WebSocket. Incremental refresh and scheduled refresh in the server runtime.
- Canvas or WebGL rendering for dense scatter and line charts (≥100k points), virtualized tables
- Performance budgets in CI: 1M rows grouped in under 150 ms, and 60 fps for interactions on the demo

## Phase 6: Beyond Power BI

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
