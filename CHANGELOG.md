# Changelog

## 0.10.0 (2026-10-22): real-world validation, new visuals and analyses, faster queries

- **Validated on real Power BI projects** (a public five-report PBIP sample with calculated tables, a time-intelligence calculation group, field parameters, roles, translations and Northwind-style auto date/time). All five reports import and render without errors. Fixes from that run:
  - **Import:** calculated tables written with a `mode: import` line (as Desktop writes them) were dropped; hierarchy levels' `column: X` lines created bogus columns; `sortByColumn` wasn't applied; calculated tables now take their declared column names (`sourceColumn`) and keep their calculated columns; relationships to calculated tables (auto date/time tables) are added after them; auto date/time fields (`PropertyVariationSource`) resolve to the hidden date table via the column's `variation`; Power BI field parameters become PrismBI field parameters; `azureMap` visuals map to `map`.
  - **Date tables built in Power Query** arrive without rows: the importer now fills their date key over the years of the related dates (warning which columns stay blank), so relationships and time intelligence work. `dateTables: false` turns this off.
  - **DAX:** table constructors with row tuples `{ ("a", 1), ("b", 2) }` (columns `Value1`, `Value2`, …), `NAMEOF`, `DATESINPERIOD`.
  - **Performance** (a product matrix with rolling averages, last year and average per day went from 9.9 s to 3.5 s; average per day alone 65 s to 0.5 s; results identical): iterators over `VALUES(column)` with a measure body run as one grouped pass; `IF(<comparison>, a, [b])` compiles into the single-pass path; date-range functions use a sorted date index; time-intelligence date tables, table filters and cross-table row mappings are memoised across groups; `valuesOf` is cached by row list.
- **Less memory for text and dates:** tables keep one object per distinct string or date (per column, up to 100,000, also for appended rows) instead of one per row: 1M dates 120 → 8 MB, 1M repeated strings 40 → 8 MB (Node), with no API change.
- **Aggregation tables** (Power BI's "manage aggregations"): `model.addAggregation({ table, detail, groupBy, columns, rows, precedence })` answers covered queries from a pre-aggregated table (measures are rewritten through other measures; time intelligence and `CALCULATE` filters stay); `result.aggregation`, `model.aggregationFor(spec)`, `removeAggregation`, `aggregations()`. `sqlEngine` answers covered queries in memory without a round trip. `importPowerBI` reads `alternateOf` mappings (TMDL and model.bim).
- **Key influencers** (`@prismbi/prismbi/ai`): `keyInfluencers(model, { measure, explainBy, filters, basis, minShare, max })` ranks the column values that move a measure (sums and counts per row, rates as they are; duplicate segments listed once), and the `keyInfluencers` visual (alias `influencers`, registered by `registerAI()`) lists them next to the chosen column's breakdown, cross-filtering from its bars.
- **Scorecard (goals) visual** (`scorecard`, alias `goals`, entry `@prismbi/prismbi/visuals/scorecard`): current value, target (a paired measure or a fixed number), progress, On track / At risk / Behind status (`direction`, `atRisk`), sparkline, owner and due date per goal; drops columns in narrow tiles. `goalStatus()` exported.
- **Warm start (table cache):** `cachedTables(model, key, load, { version, maxAgeMs, tables, store })`, `saveTables`, `loadTables`, `clearCachedTables` and `idbStore` in `@prismbi/prismbi/connectors` keep loaded tables in IndexedDB as packed typed columns and restore them on the next visit (50k rows in about 65 ms in Chrome). Packed-column helpers moved to `src/data/packed.ts`, shared with the worker.
- **Sunburst visual** (`sunburst`, entry `@prismbi/prismbi/visuals/sunburst`): one ring per hierarchy level, each level a real measure evaluation, children sized within their parent, curved labels, centre total, selection and tooltips at any level; in the Studio palette and `ask()` ("sunburst of sales by category and subcategory"). Full-bundle budgets +2 KB for it, and +3 KB for the scorecard; the AI entry +1 KB for key influencers; core +2 KB for aggregation tables (+1.3 KB).
- **Time intelligence in the single-pass path:** visuals grouped by date-table columns answer `SAMEPERIODLASTYEAR`, `DATEADD`, `DATES*TD`, `TOTAL*TD` (fiscal year ends too), `PARALLELPERIOD` and `PREVIOUS*` from per-date partial sums in one pass; plain measures in the same visual reuse them. Day × YTD at 1M rows: 193 → 21 ms cold; year × month × sales, last year and growth: about 130 → 46 ms. The evaluator and the fast path share the calendar rules (`src/dax/timeIntel.ts`); equivalence tests in `tests/fastti.test.ts`.
- **SQL (filter-context mode) validated on the real-world sample.** Every query the five reports issue, and every measure by year, category, store and gender, runs on SQLite and on Postgres (PGlite) and matches the in-memory engine. DuckDB and Postgres also pass the SQL test cases. What that needed:
  - `DATESINPERIOD` as a `CALCULATE` filter, and date windows kept in variables (`VAR p = DATESINPERIOD(…) RETURN CALCULATE(…, p)`, `MINX(p, Date[Date])`), as in rolling averages.
  - Iterators whose expression is a measure (`AVERAGEX(VALUES(Date[Date]), [Sales])`, `MAXX(VALUES(Region[Region]), …)`). A plain aggregate body is one grouped pass over the fact table; other bodies run once per distinct row with context transition.
  - `SELECTEDVALUE`, `HASONEVALUE`; `YEAR`, `MONTH`, `DAY` and `FORMAT` with date patterns (`MMMM`, `MMM`, `yyyy`, `MM`, `dd`) in calculated columns, whose bare `[Column]` references now resolve to their own table.
  - **Performance:** variables and window bounds that depend only on the group are computed once per group rather than per fact row. On SQLite, the rolling-average test went from 76 s to 1.2 s.
- **Size budgets:** the sql entry 12 → 14 KB (13.2 KB with the translations above); full (api) 138 → 139 KB (138.1 KB after the faster group combinations).
- **Fix (SQL): `&` with BLANK.** DAX joins BLANK as empty text (`BLANK() & " Selected"` is " Selected"); the SQL gave NULL.
- **Fix (SQL): hoisting.** Scalars that refer to an enclosing row (a FILTER or iterator row) or to another hoisted scalar are no longer moved to the group layer, where they would fail with an unknown column.
- **Time intelligence by product (and any other dimension):** the single-pass path now also answers visuals that group by columns outside the date table, alone or with date columns (product × month YTD, category × last year). It keeps partial sums per group and date and resolves each date set once per date key. On the real-world sample, a product matrix with last year and last-year margin went from 8.6 s to 0.35 s; product × month × YTD and last year at 1M rows takes 177 ms (new bench case, budget 600 ms). Results match the general engine (`tests/fastti.test.ts`).
- **Faster group combinations:** visuals that group by columns from several tables find the existing combinations by dictionary codes rather than a string key per fact row. At 1M rows this step took about 770 ms of the product × month query above.
- **Fix (single-pass time intelligence): rows without a date.** Fact rows whose date has no row in the date table were left out of totals (and of groups that no date filters) when plain measures shared the time-intelligence pass. The general engine counts them, and the fast path now does too.
- **Faster unfiltered row lists:** the all-rows list of a table is built with a counting loop (several times faster than `Array.from` at 1M rows).
- **Size budgets raised deliberately** (`scripts/size.mjs`): the time-intelligence fast path adds about 2.3 KB min+gzip to the core (core app 82.4 KB, budget 80 → 83; full 131.4 KB, 130 → 133, and the other core scenarios by 3 KB); the worker entry is 2.1 KB with packed columns (budget 2 → 3).
- **Benchmark budgets:** `npm run bench` ceilings tightened to about 3× measured times, plus a last-year growth query.
- **SQL totals in one round trip:** with `totals`, aggregate-mode queries on DuckDB and Postgres return the grand total in the grouped statement (`GROUPING SETS`, `SqlPlan.totalsInline`); SQLite keeps two statements.
- **SQL result cache:** `sqlEngine(model, { cache: true | { max, ttlMs } })` runs each distinct statement once and shares concurrent duplicates; cleared on model changes and by `engine.clearCache()`; `engine.dispose()`.
- **Canvas heatmaps and calendars:** above 3,000 cells they paint on a canvas hit-tested by row and column (tooltips, selection, context menu and drill unchanged); `format.heatmap.renderer` / `format.calendar.renderer` (`auto` | `svg` | `canvas`). Exports and canvas-less environments keep SVG.
- **Virtualized matrix:** above 500 visible rows (expanded children and subtotal rows count) the matrix renders only the rows in view, like the table; `format.matrix.virtualize`. Expanding or collapsing keeps the scroll position.
- **Lighter Studio undo:** each of the 200 undo steps stores the splice between neighbouring report states instead of a full JSON snapshot (`History.stored` reports the characters held).
- **Worker: packed columns.** `engine.addColumns(name, columns, schema?, { transfer })` sends numbers and dates as `Float64Array`s and text as dictionary codes in transferred buffers (shared when they live in a `SharedArrayBuffer`); the worker adopts them as its numeric and dictionary views. About 10× faster than `addTable` with row objects at 1M rows. `model.addColumns(name, columns, schema?)` builds a table from column arrays in process. `packColumn`, `addPackedTable`; `PortLike.postMessage` takes a transfer list.
- **Fix (SQL): bidirectional relationships.** Filter-context SQL ignored `crossFilter: 'both'` and silently returned unfiltered dimension measures (a product count by country counted every product). Filters on the "many" side now flow back as semi-joins, matching the in-memory engine (verified on SQLite and DuckDB). `CROSSFILTER(…, BOTH | ONEWAY | NONE)` in `CALCULATE` is pushed down too.
- **SQL on SQLite: non-contiguous dates.** Shifted-date sets that depend on the group (e.g. last year by year, with a Q1 + Q3 filter) are materialized once per group instead of re-run for every fact row: 130 s → 11 s on the demo data. Sets that don't depend on the group stay uncorrelated.
- **Fix:** plugin signing and verification work on Node 18, which has no global `crypto` (falls back to `node:crypto` `webcrypto`).

## 0.9.1 (2026-10-19)

- **New home:** source at https://github.com/prismbi-js/prismbi, docs and live demo at https://prismbi-js.github.io/. The package `repository`, `homepage` and `bugs` links point there.
- **README:** links and images are absolute, so they work on npm.
- **Site:** a shared menu on every page (demo, docs, playground, Studio, gallery, web components, performance); docs links to files outside the guides open on GitHub; the docs fit phone screens.

## 0.9.0 (2026-10-19): Phases 7, 8 and 9

- **Excel export:** `report.exportXlsx({ pages })` / `toXlsx()` (one sheet per visual, toolbar **Export Excel**), `visual.exportXlsx()` / `toXlsx()` (visual menu **Export data · Excel**), and `buildXlsx`, `resultToSheet`, `excelFormat`, `XLSX_MIME` from the core. Typed cells, format strings as Excel number formats, frozen bold header with filters; a dependency-free writer loaded on demand.
- **Size check:** `npm run size` (also run by `prepublishOnly`) bundles each entry from `dist` like an app would and fails over budget (`scripts/size.mjs`). Budgets raised by 3 KB for the core and full scenarios to cover Phases 7–9 (core about 90 KB api, 80 KB app). Size figures in the README, roadmap and contributing guide are corrected: the core is about 80 KB min+gzip, not 60 KB.
- **Streaming refresh:** `appendRows` and `maxRows` windows extend or shift the table caches (numeric views, dictionaries, indexes, bitmaps) instead of rebuilding them. `model.onChange` listeners receive a `ModelChange` (`{ tables }`) for data-only changes, and reports re-query only the visuals whose fields, filters, format or measures can reach those tables. Row-local calculated columns compute appended rows with the row-expression compiler, and the visible-rows cache is bounded by total row indices as well as entries.
- **Numeric group keys:** multi-column fast-path groupings use mixed-radix numeric keys (dense table up to 4M combinations) instead of per-row strings.
- **Lazy rendering:** scheduled re-renders skip visuals more than 300 px outside the viewport until they scroll into view; `report.flush()` and exports still render everything.
- **Faster iterators and RELATED:** numeric row expressions in iterators and calculated columns compile to closures over typed views; `SUMX` / `AVERAGEX` measures join the single-pass grouped path; relationship paths and fact-to-dimension row maps are cached (`model.relatedRows`). `SUMX` with `RELATED` is about 12× faster at 300k rows, grouped `SUMX` about 8×. Results are unchanged (`tests/rowcompile.test.ts`).
- **Accessibility:** chart narration (`describe()`, `narrate`, `format.accessibility.narration`) and the `high-contrast` theme (`highContrastTheme`).
- **Subscriptions and alerts:** `ReportDefinition.subscriptions` / `alerts`, `report.setSubscriptions` / `setAlerts`, `runSubscriptions` and `watchAlerts` (server entry), and a Studio Schedules dialog.
- **Localization:** `ReportDefinition.translations`, `ReportOptions.direction`, `report.setLocale()`, `report.translate()`.
- **Lineage:** `lineage`, `impactOf`, `expressionRefs`, `renameInExpression`, `renameModelField`, `model.renameColumn`, `DataTable.renameColumn`. The Studio measure and column renames now update dependent DAX (previously only visual fields).

- **CALCULATE in the single-pass path:** measures wrapping aggregations in `CALCULATE` with column filters (comparisons, `IN`, `KEEPFILTERS`, nesting) stay on the fast grouped path; about 12× faster for a 1M-row two-dimension grouping (`tests/fastcalc.test.ts`).
- **SQL: USERELATIONSHIP, measures in FILTER, row-level security:** pushed down in filter-context mode (relationship swaps, per-row context transition, role rules that ALL can't remove).
- **SQL filter-context mode:** `toSql` falls back to correlated subqueries with DAX filter-context semantics: `ALL` / `ALLSELECTED` / `ALLEXCEPT` / `REMOVEFILTERS`, `CALCULATE` replacing filters, `FILTER(ALL(...), ...)`, time intelligence (`SAMEPERIODLASTYEAR`, `DATEADD`, `DATES*TD`, `TOTAL*TD`, `PREVIOUS*`, `DATESBETWEEN`), single-direction filter flow. `SqlPlan.mode`.
- **Time intelligence:** `DATEADD` / `SAMEPERIODLASTYEAR` extend a month's last day to the rest of the target month, as in DAX.
- **Power BI import:** calculation groups (TMDL and model.bim) with ordinals, precedence and format string definitions.
- **Bitmap indexes:** low-cardinality columns of large tables filter with bitsets (`setBitmapIndexes`); `bench/bitmap.test.ts`.
- **WebGL scatter:** `format.scatter.renderer`; WebGL from 50,000 points; snapshots embed canvas pixels.
- **Docs images:** screenshots in the guides and README, `npm run docs:images`, a visual gallery in the visuals guide.
- **Geo:** new entry `@prismbi/prismbi/geo` (`worldCountries`, `usStates`); `format.map.boundaries`, `featureKey` lists, `legend: 'classes'`, `cluster`; bubble maps without latitude/longitude; `registerBoundaries`, `getBoundaries`, `featureCentroid`, `clusterPoints`, `quantileBreaks`.
- **Animated transitions:** data points tween from their previous geometry when data changes (identity-keyed; respects reduced motion).
- **Keyboard:** roving data-point focus with arrows/Home/End, Shift+F10 menus with focus return, page-tab arrows, edit-mode arrow moves and Shift+arrow resizes; walkthrough tests.
- **DAX:** `NATURALINNERJOIN`, `NATURALLEFTOUTERJOIN`, `SAMPLE`.
- **Calculation-item formats:** `format` and `formatExpression` on calculation items, `SELECTEDMEASUREFORMATSTRING()`, `QueryRow.formats`.
- **Docs site and playground:** `npm run docs` / `docs:build` (generated from `docs/guide`, with search), `/playground.html` with editable examples from the guides; every playground example is run by the tests.
- **Per-visual entry points:** `@prismbi/prismbi/visuals/bar`, `…/line`, `…/waterfall` and 19 more; each registers its visuals on import.
- **Incremental refresh:** `model.setRefreshPolicy`, `refreshPolicyOf`, `incrementalRefresh`; `applyRefreshPolicy` and `periodStart`; `scheduleRefresh` `mode: 'incremental'`; `toJSON().refreshPolicies`.
- **SQL pushdown:** new entry `@prismbi/prismbi/sql` with `sqlEngine`, `toSql`, `duckdbRunner`, `SqlUnsupportedError`. Core now exports `visualCalcPlan`, `resolveValueField` and `resolveGroupField`.
- **Anomaly alerts:** `watchAnomalies`; `ReportAlert.when` accepts `{ anomaly: true, kinds? }`; `AlertEvent.insight`.
- **DAX copilot:** `writeDax`, `writeDaxSync`, `explainDax`, `daxCopilot`, `daxPrompt`, `dateColumn`; `StudioOptions.copilot`, `studio.setCopilot()` and the `ExpressionCopilot` type.
- **Narrative visual:** `narrative` (registered by the AI entry), `writeNarrative`, `filterPhrase`, `setNarrativeWriter`.
- **Agent panel:** `agentPanel` (Studio), `runAgent`, `anthropicLLM`, `openAILLM`, `ruleBasedLLM`, `planPrompt`, the `add_page` agent tool, and `studio.restore()` / `studio.addToolbarButton()`.
- **Conditional visibility:** `VisualSpec.visibleWhen` and `report.isVisualVisible()`.
- **Usage analytics:** `ReportOptions.onUsage` with `UsageEvent` records.

- **Power BI import:** `@prismbi/prismbi/powerbi` with `importPowerBI`, `parseTmdl`, `parseModelBim`, `buildModelFrom`, `mapPbirReport`, `mapLegacyReport`; the `prismbi pbip <dir> [report.json]` CLI.

- **Visual calculations:** `{ visualCalc: 'RUNNINGSUM([Total Sales])', reset? }` on value fields, evaluated over the visual's rows after sorting and Top N.
- **DAX window functions:** `OFFSET`, `INDEX`, `WINDOW`, `RANK`, `ROWNUMBER`, `ORDERBY`, `PARTITIONBY` (also in the DAX catalog and language service).
- **Transforms:** `model.transformTable`, `transformsOf`, `sourceRowsOf`, and `applySteps` / `applyStep` / `describeStep`; 19 step types; a **Transform** editor in the Studio data view, saved in Studio documents.
- **Phone layouts:** `PageDefinition.mobile`, `ReportOptions.layoutMode` / `mobileBreakpoint`, `report.setLayoutMode`, `autoMobileLayout`, `setMobileVisibility`, `setMobileLayout`, `isMobileLayout`; a Studio **Phone** toggle with **Reset phone layout**.
- **Multi-select editing:** `selectedVisuals`, `selectVisuals`, `toggleVisualSelection`, `alignVisuals`, `distributeVisuals`, `groupVisuals`, `ungroupVisuals`, `commitLayouts`, and `arrange(…, forward | backward)`; `VisualSpec.group`; a Studio Arrange menu and Layers pane.
- **Forecast:** `format.analytics.forecast = { periods, confidence?, seasonality? }` on line and area charts with a date or number axis.
- **Error bars:** `errorLower` / `errorUpper` roles on clustered column and bar charts.
- **Calendar heatmap** (`type: 'calendar'`) and **axis zoom** (`format.categoryAxis.zoom`).
- **Visual regression tests:** `npm run test:visual` (with `--update`), `/gallery.html` with every visual.
- **Fixes:** combo charts put a line on a different scale (or unit) on a secondary axis; map bubbles stay inside the frame; radar tick labels no longer overlap category labels; the decomposition tree scrolls instead of clipping.

## 0.6.0 (2026-10-17): Phase 6, beyond Power BI

- **`@prismbi/prismbi/ai`:**
  - `ask` / `askSync`, with an optional `llm` hook.
  - `explain`, `findInsights`, `suggestQuestions`.
  - The `qna` and `insights` visuals and "Explain this" in context menus.
  - Agent support: `getAIContext`, `contextToPrompt`, `createAgentTools`, `runTool`, `toAnthropicTools`, `toOpenAITools`, `toMcpTools`.
- **`@prismbi/prismbi/elements`:** web components `<prism-report>` and `<prism-visual>`, `registerModel`, and the Svelte actions `prismReport` / `prismVisual`.
- **`@prismbi/prismbi/files`:** `splitReport`, `joinReport`, `diffReports`, `formatDiff`, and the `prismbi split|join|diff` CLI.
- **`@prismbi/prismbi/server`:** `renderVisualSvg`, `renderReportHtml`, `withDom`, `watchMeasure`, `scheduleReport`, plus a new `measure` report option for explicit visual sizes.
- **`@prismbi/prismbi/collab`:** `connectReport`, `CollabDoc`, `broadcastChannelTransport`, `webSocketTransport`, `memoryHub`; presence outlines, comment badges and threads, "Comment on this point". The Studio demo co-edits with `?room=<name>`.
- **`@prismbi/prismbi/plugins`:** `loadPlugin`, `verifyPlugin`, `signPlugin`, `generateSigningKeys`, `integrityOf`, `fetchCatalog`, `renderPluginGallery`, `loadedPlugins`, and the `prismbi-sign-plugin` CLI.
- **Package name:** published as `@prismbi/prismbi` (npm rejected the unscoped `prismbi` as too close to `prisma` and `prismjs`).
- **Core:** `registerMenuItems` (context-menu plugins), plus `Report.reportFilterList` and `Report.currentSelection`.


## 0.5.0 (unreleased): Phase 5, scale, performance and connectors

- **Faster engine.**
  - Typed-array column views and dictionary codes.
  - Vectorised single-column aggregations.
  - A single-pass grouped query path for simple measures, with automatic fallback (`setFastQuery('auto' | 'always' | 'off')`).
  - Cheaper filter cache keys.
- **Streaming data:** `model.appendRows(table, rows, { maxRows })` with incremental calculated columns and a sliding window.
- **`@prismbi/prismbi/connectors`:**
  - `parseCsv` / `loadCsv`, `googleSheetCsvUrl`
  - `loadJson`, `loadRest` (page, offset, cursor and link pagination), `loadGraphQL`
  - `addArrowTable`, `loadSqlTables` (`SqlAdapter`)
  - `streamInto` (WebSocket, EventSource, ports) and `scheduleRefresh`
- **`@prismbi/prismbi/worker`:** `serveModel`, `createWorkerEngine` and `createLocalEngine`. The model runs off the main thread, with cancellation.
- **Rendering at scale:**
  - LTTB downsampling for dense lines and areas
  - canvas scatter above 3,000 points, with hit-testing
  - virtualized tables above 500 rows (`format.table.virtualize`)
- **Tooling:** `npm run bench` and the `/perf.html` demo page (100k–1M rows, live stream).
- **Per-dimension pre-aggregation:** YTD and running totals per day over 1M rows take about 0.2 s instead of 2.8 s.
- **Reports on a query engine:** `new Report(el, { model, engine })` runs visual queries in a worker. Visuals load asynchronously, with loading and busy states and cancellation.
- **Fixes from the live-browser review:**
  - Line and area strokes no longer disappear when the OS asks for reduced motion.
  - Format strings support `positive;negative;zero` sections (also in `FORMAT`).
  - Treemaps cycle the palette instead of greying out tiles.
  - The slider slicer fits a two-row cell.
- **Internal:** the model clears the evaluator's measure cache directly (`Evaluator.clearCache`) instead of through a change listener.


## 0.4.0 (unreleased): Phase 4, the studio

- **`@prismbi/prismbi/studio`** and **`<PrismStudio>`**: a drag-and-drop report editor. Canvas edit mode (select, move, resize, grid snap, keyboard), Fields, Build, Format and Filters panes, page management, measure and column editors, data and model views (relationship diagram), theme designer, Auto page, preview, export and import.
- **Undo/redo** across report and model edits, **autosave** (`storageKey`), and a studio document that stores model changes as a diff.
- **Report edit-mode APIs:** `setEditMode`, `selectedVisual`, `visualFormat`, `updatePage`, `movePage`, `duplicatePage`, `pageDefinition`, `duplicateVisual`, `arrange`, `findFreeSpot`, `load`, plus the events `definitionChanged` and `visualSelected`.
- **Versioned report JSON:** `REPORT_SCHEMA_VERSION` and `migrateReport`.
- **Model:** `updateRelationship`, `removeRelationship`, `removeColumn`.
- **Fixes:** data labels use each series' own format and avoid collisions. Clustered charts flag mixed scales.


## 0.3.0 (unreleased): Phase 3

- **Relationships:** `crossFilter: 'both'`, `cardinality: 'manyToMany'`, inactive relationships, `USERELATIONSHIP`, `CROSSFILTER`, `TREATAS`.
- **DAX:** about 45 new functions. Table functions (`SUMMARIZE`, `SUMMARIZECOLUMNS`, `ADDCOLUMNS`, `SELECTCOLUMNS`, `CROSSJOIN`, `UNION`, `INTERSECT`, `EXCEPT`, `GENERATE`, `ROW`, `DATATABLE`, `GENERATESERIES`, `CALENDAR`), `LOOKUPVALUE`, `CONTAINS`, `EARLIER`, the `PATH` family, statistics, `ISINSCOPE`, `ISCROSSFILTERED`, `FIRSTNONBLANK`, `LASTNONBLANK`, `USERNAME`, `NETWORKDAYS` and more.
- **Model:** `addCalculatedTable`, `evaluateTable`, `addCalculationGroup`, `addFieldParameter`, `addWhatIfParameter`, `addHierarchy`, display folders, `addPerspective`, `addRole` / `setRoles` (row-level security).
- **Visuals:** field parameters and hierarchies expand in every field well. New `slider` slicer style.
- **Tooling:** `DaxLanguageService` (completion, hover, signature help, diagnostics, format), `formatDax`, `explainDax`, `DAX_FUNCTIONS` catalog.
- **Fixes:** a bare table reference or `VALUES` in a row context no longer transitions to the current row. Date ± days is DST-safe. Variable names keep their case. The filter pane respects RLS.
- Demo: Modeling page, "View as" RLS switch, DAX console.


## 0.2.0 (unreleased): Phase 2

### Part 2
- **Continuous axes:** time and number fields on line and area charts are placed at their real positions, with calendar-aligned ticks (`categoryAxis.type`). **Log scales** on line and scatter.
- **Report tooltips** (`page.tooltip` + `format.tooltip.page`).
- **Edit interactions** mode and `report.setInteraction()`.
- **PDF export** (`report.exportPdf()`, toolbar button) with a lazily loaded, dependency-free writer.
- **Persisted visual state** (`spec.state`): table sort, matrix expansion and decomposition splits are saved with the report.
- **New visuals:** histogram, box plot, bullet, radar, sankey, ribbon, bubble map, filled map.
- **Lean builds:** `@prismbi/prismbi/core` and `@prismbi/prismbi/visuals` entry points with pure annotations, so unused visuals are tree-shaken. The registry is shared across entries.
- **Fixes:** scatter bubbles no longer spill over the axes, and the legend follows colour order. Zero shows as "$0" rather than "$0M". The date-range slider thumbs sit on the track and the selected span is highlighted. Map SVGs clip to their box. Ribbon slivers never vanish.
- The repo now enforces LF line endings (`.gitattributes`).

### Part 1

- **Narrowing down:** a right-click menu with Include, Exclude and Drill through. Drill-through pages (`page.drillthrough`) with carried filters, a Back button and `report.drillThrough()` / `back()`. Slicer sync groups. A hierarchy (tree) slicer. "Expand all down one level".
- **Decomposition tree** with manual and automatic (High value / Low value) splits that cross-filter the page.
- **New visuals:** waterfall, heatmap, and small multiples (`smallMultiples` role) for column, bar, line and area charts.
- **Analytics:** reference lines and trend lines (`format.analytics`). Value-based colours (`format.colors.rules`, `format.colors.gradient`).
- **Cross-highlighting** on line, area and scatter.
- **Export** of any visual as PNG or SVG (header menu, `visual(id).exportImage()`, `toSvg()`).
- Filters: `tuples` filters accept `exclude: true`.
- Demo: Insights and Product details (drill-through) pages, synced year slicers. No more light-to-dark flash on load.

## 0.1.0 (unreleased): Phase 1

First release: the core engine and essential visuals.

- **Model:** columnar `DataTable` with type inference and lazy hash indexes. `DataModel` with many-to-one relationships, expanded tables, calculated columns, generated date tables, a field list and JSON metadata.
- **Formulas:** a DAX-compatible parser and evaluator covering filter and row context, context transition, `CALCULATE` modifiers (`ALL`, `REMOVEFILTERS`, `ALLEXCEPT`, `ALLSELECTED`, `KEEPFILTERS`), iterators, `RANKX`, `TOPN`, time intelligence, and about 115 functions.
- **Query engine:** auto-exist grouping, implicit aggregations, sorting that honours sort-by columns, Top N, highlight values, real totals.
- **Visuals (23):** column and bar (clustered, stacked, 100%), line, area, stacked area, combo, pie, donut, treemap, funnel, scatter, card, multi-row card, KPI, gauge, table, matrix, slicer (5 styles), text box.
- **Interactions:** cross-filter and cross-highlight, multi-select, legend selection, drill down and up, report, page and visual filters, filter pane (Basic, Advanced, Top N), focus mode, show as table, CSV export, bookmarks, JSON save and load.
- **Theming:** light and dark themes validated for colour-vision deficiency, `createTheme`, Power BI theme import, CSS variables, `visualStyles`, custom tooltips, Power BI format strings and display units.
- **React:** `<PrismReport>`, `<PrismVisual>`.
