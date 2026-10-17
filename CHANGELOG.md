# Changelog

## Unreleased: Phases 8 and 9

- **Size check:** `npm run size` (also run by `prepublishOnly`) bundles each entry from `dist` like an app would and fails over budget (`scripts/size.mjs`). Size figures in the README, roadmap and contributing guide are corrected: the core is about 75 KB min+gzip, not 60 KB.
- **Streaming refresh:** `appendRows` and `maxRows` windows extend or shift the table caches (numeric views, dictionaries, indexes, bitmaps) instead of rebuilding them. `model.onChange` listeners receive a `ModelChange` (`{ tables }`) for data-only changes, and reports re-query only the visuals whose fields, filters, format or measures can reach those tables. Row-local calculated columns compute appended rows with the row-expression compiler, and the visible-rows cache is bounded by total row indices as well as entries.
- **Numeric group keys:** multi-column fast-path groupings use mixed-radix numeric keys (dense table up to 4M combinations) instead of per-row strings.
- **Lazy rendering:** scheduled re-renders skip visuals more than 300 px outside the viewport until they scroll into view; `report.flush()` and exports still render everything.
- **Faster iterators and RELATED:** numeric row expressions in iterators and calculated columns compile to closures over typed views; `SUMX` / `AVERAGEX` measures join the single-pass grouped path; relationship paths and fact-to-dimension row maps are cached (`model.relatedRows`). `SUMX` with `RELATED` is about 12× faster at 300k rows, grouped `SUMX` about 8×. Results are unchanged (`tests/rowcompile.test.ts`).
- **Accessibility:** chart narration (`describe()`, `narrate`, `format.accessibility.narration`) and the `high-contrast` theme (`highContrastTheme`).
- **Subscriptions and alerts:** `ReportDefinition.subscriptions` / `alerts`, `report.setSubscriptions` / `setAlerts`, `runSubscriptions` and `watchAlerts` (server entry), and a Studio Schedules dialog.
- **Localization:** `ReportDefinition.translations`, `ReportOptions.direction`, `report.setLocale()`, `report.translate()`.
- **Lineage:** `lineage`, `impactOf`, `expressionRefs`, `renameInExpression`, `renameModelField`, `model.renameColumn`, `DataTable.renameColumn`. The Studio measure and column renames now update dependent DAX (previously only visual fields).

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

## 0.7.0 (unreleased): Phase 7, analyst essentials

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
