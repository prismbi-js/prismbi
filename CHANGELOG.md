# Changelog

## 0.22.0 (2026-11-10 / Phase 21: Analytics Reference Bands, Canvas Wallpaper & Watermark, Page Reordering & Visual Size Matching)

- **Analytics Reference Bands & Target Ranges (`referenceBands`, `drawReferenceBands`):**
  - Added shaded reference bands and target ranges across Cartesian charts (Bar, Column, Line, Area, Scatter, Combo) via `VisualFormat.analytics.referenceBands: ReferenceBand[]` (`src/visuals/format.ts`).
  - Supports axis selection (`'y'` or `'x'`), interval ranges (`from` and `to`), custom fill color, opacity, borders (`borderColor`, `borderWidth`, `borderDash`), and text labeling with position alignments (`'top-left'`, `'top-right'`, `'bottom-left'`, `'bottom-right'`) (`src/visuals/analytics.ts`, `src/report/styles.ts`).
  - Seamlessly integrates with existing analytics reference lines and trendlines with zero chart-specific code overhead.

- **Canvas Wallpaper, Page Background Images & Diagonal Watermark (`PageBackground`, `setPageBackground`):**
  - Extended page styling with rich wallpaper capabilities via `PageBackground` interface on `PageDefinition.background?: string | PageBackground` (`src/report/report.ts`).
  - Supports background images with custom fit modes (`'cover'`, `'contain'`, `'fit'`, `'center'`), opacity, and background colors.
  - Added diagonal report text watermarks (`watermark?: string | { text: string; color?: string; opacity?: number; fontSize?: number; angle?: number }`) rendered as non-interactive overlays (`.pbi-watermark`, `src/report/styles.ts`).
  - Added programmatic background management methods on `Report`: `report.setPageBackground(pageIdOrName, bg)` and `report.getPageBackground(pageIdOrName)`.

- **Page Deletion & Bulk Page Reordering (`removePage`, `reorderPages`):**
  - Added programmatic page deletion with validation and automatic active page fallback (`report.removePage(idOrName): boolean`, `src/report/report.ts`).
  - Added bulk page reordering API (`report.reorderPages(order: string[]): void`) enabling arbitrary page tab arrangement.
  - Enhanced Studio page tabs with context actions and drag reordering support.

- **Studio Visual Size Matching & Dimensions Normalization (`matchVisualSize`):**
  - Added multi-visual size matching to align visual dimensions across multi-selections via `report.matchVisualSize(how: 'width' | 'height' | 'both', ids?: string[])`.
  - Normalizes dimensions based on the first selected visual or master visual anchor.
  - Integrated into Studio visual alignment bar (`.pbs-align-bar`) and dropdown actions (`size:width`, `size:height`, `size:both`, `src/studio/studio.ts`).

## 0.21.0 (2026-11-10 / Phase 20: Presentation Auto-Play Carousel, Visual Annotations, Direct Data Export & Canvas Grid)

- **Report Presentation Mode & Auto-Play Slideshow Carousel (`startAutoPlay`, `enterFullscreen`, `.pbi-presentation-bar`):**
  - Added kiosk and executive presentation mode with automated page rotation (`report.startAutoPlay({ intervalMs, loop, showControls })`, `report.stopAutoPlay()`, `report.isAutoPlaying()`, `src/report/report.ts`).
  - Added full browser fullscreen controls (`report.enterFullscreen()`, `report.exitFullscreen()`, `report.toggleFullscreen()`, `report.isFullscreen()`).
  - Sleek floating presentation HUD (`.pbi-presentation-bar`, `src/report/styles.ts`) featuring Play/Pause toggle, Previous/Next page buttons, page progress counter (`Page X of Y`), dynamic countdown progress bar (`.pbi-pres-progress`), fullscreen toggle, and auto-hiding after 3 seconds of cursor inactivity.
  - Studio top/footer integration with quick Present button (`.pbs-present-btn`, `▶`) and `F5` keyboard shortcut.

- **Visual Data Annotations & Callout Pins (`VisualAnnotation`, `VisualSpec.annotations`):**
  - Added rich data annotations and milestone callout pins attached to visual coordinates or category marks (`src/visuals/types.ts`, `src/report/visualHost.ts`).
  - Programmatic annotation management APIs on `Report` (`report.addAnnotation()`, `report.removeAnnotation()`, `report.getAnnotations()`).
  - Interactive callout badges and pins (`.pbi-annotation-pin`, `.pbi-annotation-badge`, `src/report/styles.ts`) rendered on the visual overlay with customizable badge icons, labels, and themes.
  - Interactive popover cards (`.pbi-annotation-popover`) displaying annotation titles, descriptions, and notes on click/hover.

- **Direct Visual Raw Data File Export (`getVisualData`, `exportVisualData`):**
  - Added programmatic visual data retrieval in multiple text formats (`report.getVisualData(visualId, 'csv' | 'tsv' | 'json')`, `src/report/report.ts`).
  - Added direct browser file export downloads across CSV, TSV, JSON, and Excel XLSX (`report.exportVisualData(visualId, format, filename)`).
  - Added JSON serialization and export support (`toJson()`, `exportJson()`) in `VisualHost` (`src/report/visualHost.ts`) alongside CSV, TSV, and XLSX.
  - Expanded visual header export context menu with direct 1-click "Export data (JSON)" action.

- **Studio Canvas Snap-to-Grid & Visual Grid Lines Toggle (`showGrid`, `setSnapToGrid`):**
  - Added precision canvas gridlines rendering (`report.showGrid(visible)`, `report.isGridVisible()`, `.pbi-grid-visible`, `src/report/styles.ts`).
  - Added configurable snap-to-grid toggle during visual drag-and-drop and resize (`report.setSnapToGrid(snap)`, `report.isSnapToGrid()`, `src/report/editing.ts`).
  - Added Studio zoom bar toggles for Gridlines (`#`, `.pbs-grid-btn`) and Snap-to-Grid (`🧲`, `.pbs-snap-btn`) with keyboard shortcuts `Ctrl+'` and `Ctrl+Shift+'`.

## 0.20.0 (2026-11-10 / Phase 19: Global Search Visual Finder, Radial Slice Elevation, Column Reordering & Bookmark Bar)

- **Report-Level Global Search & Studio Visual Finder (`report.find`, `openFinder`, `Ctrl+F`):**
  - Added programmatic search across reports via `report.find(query: string | RegExp): VisualSearchResult[]`, returning matching visuals across all pages with matched fields (`title`, `subtitle`, `field`, or `filter`), page names, indices, and exact hit text (`src/report/report.ts`).
  - Added quick interactive modal search dialog in Studio (`.pbs-finder`, `src/studio/studio.ts`, `src/studio/styles.ts`), togglable via footer zoom bar search button (`🔍`, `.pbs-find-btn`) or `Ctrl+F` keyboard shortcut.
  - Interactive search results navigation with keyboard arrows (`ArrowDown`, `ArrowUp`), Enter to select, and Escape to dismiss.
  - Auto-switches active page, selects and centers target visual in viewport, and triggers smooth visual highlight pulse animation (`.pbi-find-target`, `@keyframes pbi-pulse`, `src/report/styles.ts`).

- **Pie & Donut Slice Multi-Selection & Radial Pop-Out Elevation:**
  - Implemented radial pop-out elevation for selected pie and donut chart slices (`src/visuals/parts.ts`).
  - Selected slices translate radially outward along their angle bisector `(a0 + a1)/2` by 6px with an SVG drop-shadow filter elevation effect (`filter="url(#pbi-slice-shadow)"`).
  - Automatically translates slice value labels and highlight overlays synchronously with the pop-out arc.
  - Enabled additive multi-mark selection across pie/donut slices via Shift+click or Ctrl/Cmd+click (`src/visuals/common.ts`), dimming unselected slices while maintaining multi-slice cross-filtering and drill-down.

- **Interactive Table & Matrix Column Reordering via Drag and Drop (`columnOrder`):**
  - Added interactive HTML5 drag-and-drop column reordering across tables and matrices (`src/visuals/table.ts`).
  - Table headers (`<th>`) feature draggable handles (`draggable="true"`), drag source tracking, and dynamic visual drag-over indicators (`.is-drag-over`, `src/report/styles.ts`).
  - Reordering shifts target columns cleanly and persists column permutations in `format.columnOrder` or local visual state (`TableFormat.columnOrder?: string[]`).
  - Preserves column widths, pinned sticky column offsets, conditional formatting rules, and column totals.

- **Report Bookmark Navigator Bar (`renderBookmarksBar`):**
  - Added embedded bookmark navigator bar generation via `report.renderBookmarksBar(container?: HTMLElement): HTMLElement` (`src/report/report.ts`).
  - Renders sleek navigation pill buttons (`.pbi-bookmark-bar`, `.pbi-bm-pill`, `src/report/styles.ts`) for all saved bookmarks.
  - Active bookmark state tracking with `aria-pressed="true"` attributes, updating seamlessly upon bookmark capture or application without DOM reconstruction.
  - One-click bookmark restoration with seamless page transitions, visual filter state synchronization, and slicer state restoration.

## 0.19.0 (2026-11-10 / Phase 18: Cartesian Bar Brush Selection, Sticky Frozen Columns, Image Export & Studio Minimap)

- **Cartesian Bar & Column Chart Box Brush Multi-Selection (`.pbi-brush`):**
  - Added interactive 2D drag-to-select marquee box and brush selection overlay across clustered and stacked vertical column and horizontal bar charts (`src/visuals/bar.ts`).
  - Employs `.pbi-brush` SVG rectangle overlay with dynamic pointer tracking and AABB axis-aligned bounding box collision detection against all bar marks.
  - Automatically coordinates multi-category batch cross-filtering and highlight synchronization across the entire report (`ctx.host.select(hitIds, { multi: e.ctrlKey || e.shiftKey || e.metaKey })`).
  - Seamlessly coexists with single-bar clicks and tooltips without interfering with standard click events.

- **Table & Matrix Sticky Frozen Columns (`freezeColumns`, `pinnedColumns`):**
  - Added leading column freezing and pinning to tables and matrices (`TableFormat.freezeColumns` and `TableFormat.pinnedColumns`).
  - Implemented sticky CSS positioning (`position: sticky`, `style.left`) with sequential cumulative column offset computation across `<thead>` headers and `<tbody>` cells (`src/visuals/table.ts`).
  - Added elevated right boundary shadow styling (`.pbi-col-pinned-edge`, `src/report/styles.ts`) that smoothly elevates pinned columns over scrolled content during horizontal pagination and scrolling.

- **Report Page & Visual Image Export (`toSvg`, `toImage`, `exportImage`, `copyImage`):**
  - Added programmatic page-level and visual-level image export methods on `Report` (`src/report/report.ts`):
    - `report.toSvg(page)`: Exports self-contained SVG strings suitable for standalone vector graphics rendering.
    - `report.toImage(opts)`: Renders high-DPI canvas snapshots and outputs image `Blob` objects in PNG, JPEG, or WebP formats.
    - `report.exportImage(opts)`: Triggers automatic browser downloads of full page or visual snapshots as SVG or PNG files.
    - `report.copyImage(opts)`: Copies high-resolution rendered PNG bitmaps directly to the system clipboard via `navigator.clipboard.write()`.
  - Employs zero-bundle dynamic module loading (`import('./snapshot')`) to ensure rasterization dependencies remain lazy loaded with zero upfront impact on core bundle sizes.

- **Studio Canvas Minimap Navigator (`.pbs-minimap`):**
  - Added interactive canvas minimap navigator in Studio (`src/studio/studio.ts`, `src/studio/styles.ts`), togglable via the footer zoom bar button (`.pbs-minimap-btn`, `🗺️`).
  - Real-time scaled visualization rendering (`.pbs-minimap-tile`) mirroring all page visuals, layout coordinates, and titles.
  - Interactive viewport indicator (`.pbs-minimap-viewport`) representing the visible canvas scroll bounds.
  - Supports dragging and clicking within the minimap to smoothly pan and center canvas scroll positions, with full zoom-scale awareness.

## 0.18.0 (2026-11-10 / Phase 17: Visual Locking & Grouping, Cartesian Range Brushing & Canvas Zoom)

- **Studio Visual Locking & Grouping:**
  - Added visual locking (`spec.locked: boolean`) preventing accidental moves or resizing of locked background cards, banners, or finalized KPI tiles.
  - Automatically suppresses resize handles (`.pbi-handle`) and drag movements for locked visuals, with `.is-locked` CSS indicator styling (`src/report/styles.ts`).
  - Added `report.toggleLock(id)` and quick alignment toolbar lock button (`.pbs-btn-lock`) with `Ctrl+L` keyboard shortcut.
  - Added visual grouping (`report.groupVisuals` and `report.ungroupVisuals`) with automatic shared group selection, coordinated group drag moving, and top alignment bar buttons (`.pbs-btn-group`, `.pbs-btn-ungroup`) with `Ctrl+G` and `Ctrl+Shift+G` shortcuts.

- **Cartesian Line & Area Chart Range / Brush Multi-Selection (`.pbi-brush`):**
  - Added interactive horizontal drag range brush overlay on line and area charts (`src/visuals/line.ts`).
  - Allows report viewers to drag across time spans or category intervals to batch multi-select all enclosed categories (`ctx.host.select(hitIds, { multi: e.ctrlKey || e.shiftKey || e.metaKey })`).
  - Seamlessly integrates with existing single-point clicks and tooltips.

- **Table & Matrix Cell Font Color Scales & Custom Range Bounds:**
  - Added text/font color scales in `ConditionalFormat` (`fontColor?: boolean | { min?: string; mid?: string; max?: string; minValue?: number; maxValue?: number }`).
  - Added support for explicit threshold bounds (`minValue`, `maxValue`) on both `background` and `fontColor` continuous gradients across tables and matrices.
  - Enabled conditional formatting across all numeric columns (both measure values and unaggregated table columns).

- **Studio Canvas Zoom & Viewport Controls:**
  - Added canvas zoom toolbar in the Studio page footer (`.pbs-zoom-bar`) with Zoom In (`+`), Zoom Out (`−`), Reset (`100%`), and Fit to Screen (`Fit`).
  - Added keyboard shortcuts `Ctrl++`, `Ctrl+-`, and `Ctrl+0` for instant viewport zooming.
  - Synchronized canvas zoom with `EditController` and `Report`, ensuring pixel-perfect drag moving, resizing, magnetic snapping, and marquee selection at any zoom magnification level.

## 0.17.0 (2026-11-10 / Phase 16: Exploratory Analytics, Smart Alignment & Studio Ingestion)

- **Scatter & Cartesian Box/Brush Multi-Selection (`.pbi-brush`):**
  - Added interactive 2D drag-to-select box/brush selection overlay on scatter charts (`src/visuals/scatter.ts`) with `.pbi-brush` SVG rectangle, semi-transparent accent fill, and dashed border (`src/report/styles.ts`).
  - Calculates viewport plot coordinates with automated zero-dimension fallbacks for headless/jsdom testing, hit-tests all points inside the drawn bounding box, and dispatches batch selections to the report runtime.
  - Upgraded `VisualHost.select()` and `ReportRuntime.setSelection()` across `src/visuals/types.ts`, `src/report/visualHost.ts`, `src/report/runtime.ts`, and `src/report/report.ts` to accept `DataPointIdentity | DataPointIdentity[] | null`.
  - Added additive union selection mode when dragging while holding `Shift` or `Ctrl`/`Cmd`.

- **Studio Smart Center Alignment Magnetic Guides (`.pbi-guide.pbi-guide-center`):**
  - Upgraded Studio magnetic alignment engine (`src/report/editing.ts`) with smart center-to-center alignment guides (`.pbi-guide.pbi-guide-center`, `.pbi-guide-center-v`, `.pbi-guide-center-h`).
  - Snaps moving visual midpoints to target visual midpoints (`cur.x + cur.w/2 === ol.x + ol.w/2` and `cur.y + cur.h/2 === ol.y + ol.h/2`) with high-contrast dotted guidelines (`src/report/styles.ts`), simplifying symmetric and balanced dashboard grid authoring.

- **Studio External File Drag-and-Drop Ingestion:**
  - Added direct file drag-and-drop ingestion (`src/studio/studio.ts`) onto the Studio canvas for external `.csv` and `.json` data files.
  - Employs zero-bundle dynamic module loading (`import('../connectors/csv')`) to parse CSV tables on demand without increasing the initial Studio bundle size.
  - Automatically registers new tables into `DataModel` (`this.model.addColumns` / `this.model.addTable`), refreshes sidebar panes, commits to undo/redo history, and auto-spawns a default chart visual on the canvas for instant exploratory analysis.

- **Advanced Visual Calculations (`RUNNINGMIN`, `RUNNINGMAX`, `EMA`):**
  - Added `RUNNINGMIN`, `RUNNINGMAX`, and `EXPONENTIALMOVINGAVERAGE` (alias `EMA`) visual calculations in `src/data/visualCalc.ts`.
  - Supports configurable smoothing period parameter `EMA(period)` with exponential weighting factor \(\alpha = 2 / (period + 1)\), providing out-of-the-box financial and signal-processing analytics directly on chart visual queries.

## 0.16.0 (2026-11-10 / Phase 15: Streaming Columnar IPC, Memory Diagnostics & Visual Polish)

- **Streaming Arrow IPC Ingestion (`streamArrow`):**
  - Added streaming Arrow connector (`streamArrow`, `src/connectors/arrow.ts`) consuming Apache Arrow RecordBatches and Tables from `AsyncIterable<ArrowTableLike>`, WebSockets, EventSources, or SSE/WS URL strings.
  - Streamlines Arrow IPC vectors directly into `DataModel` columnar memory with zero row-object intermediate allocations.
  - Supports sliding-window FIFO eviction (`maxRows`), micro-batch buffering (`intervalMs`), automatic reconnection with exponential backoff, and batch lifecycle callbacks (`onBatch`).
  - Added `report.pushColumns(table, cols, options)` to `Report` runtime, allowing streaming pipelines to update live reports directly in columnar form.
  - Re-exported `streamArrow`, `ArrowSourceLike`, and `StreamArrowOptions` in `@prismbi/prismbi/connectors`.

- **Model Memory Diagnostics & Compaction (`model.memoryStats()` & `model.compact()`):**
  - Added per-column and per-table memory diagnostics (`DataTable.memoryStats()` and `DataModel.memoryStats()`) tracking exact row counts, distinct counts, values array memory, string/date dictionary pool bytes, hash index bytes, and bitmap index bytes.
  - Added compaction engine (`DataTable.compact()` and `DataModel.compact()`) that prunes orphaned dictionary pool keys (e.g. from evicted streaming rows or table splices) and clears transient numeric/codes caches to minimize memory footprint.
  - Exported `ColumnMemoryStats`, `TableMemoryStats`, and `ModelMemoryStats` in `@prismbi/prismbi/core`.

- **Visual Engine Polish & Modern Aesthetics:**
  - Added configurable drop shadows (`format.shadow: { show: boolean, color?: string, blur?: number, spread?: number, x?: number, y?: number }`) mapped to CSS variable `--pbi-v-shadow` on `.pbi-visual.has-shadow`.
  - Added cartesian hover crosshair guidelines (`format.analytics.crosshair: boolean`) on line and area charts with subtle dashed alignment lines (`stroke-dasharray: '3 3'`).
  - Studio Visual Palette completeness: added custom SVG line icons for `candlestick`, `gantt`, `network`, and `chord`, and registered them in `VISUAL_ORDER` and `VISUAL_ICONS`.

- **Direct Columnar Arrow & Parquet Ingestion & DuckDB-Wasm Pushdown Bridge:**
  - Added `DataModel.refreshColumns(name, columns, schema)` and `DataTable.appendColumns(cols)` for high-throughput columnar mutations without row object overhead.
  - Added `loadDuckDbTable` and `loadDuckDbTables` in `@prismbi/prismbi/connectors` to ingest DuckDB-Wasm query results and Parquet files directly.
  - Added `duckdbEngine(model, conn, opts)` and `parquetTables` in `@prismbi/prismbi/sql` for turn-key SQL pushdown against DuckDB-Wasm and Parquet files with automatic model fallback.

- **Studio Canvas Marquee (Lasso) Selection & Quick Alignment Toolbar:**
  - Added canvas marquee drag selection (`.pbi-marquee`) in `EditController` (`src/report/editing.ts`) with interactive hit preview, additive Shift/Ctrl union selection, and background click deselection.
  - Added Studio quick alignment toolbar (`.pbs-align-bar`) with 1-click alignment buttons (`Align Left`, `Align Center`, `Align Right`, `Align Top`, `Align Middle`, `Align Bottom`, `Distribute Horizontal`, `Distribute Vertical`) dynamically activated on multi-visual selection.

## 0.15.0 (2026-11-10 / Phase 14: Analytical Depth & Studio Polish)

- **Small Multiples (Trellis / Grid Layouts):**
  - Unified multi-chart gridding across cartesian, combo, and distribution visuals (`clusteredColumn`, `stackedColumn`, `percentStackedColumn`, `clusteredBar`, `stackedBar`, `percentStackedBar`, `line`, `area`, `stackedArea`, `lineClusteredColumn`, `waterfall`, `scatter`, `bullet`).
  - Added unified Category Axis synchronization (`sharedCategoryAxis: true` by default) across panels, ensuring all facets share the identical domain ordering and category scale positions with blank placeholder slots for side-by-side comparability.
  - Added 2D Trellis Matrix layout (`layout: 'matrix'`) supporting row and column dimension facets (`smallMultiples: ['Region[Country]', 'Product[Category]']`) with aligned top column headers and left row headers.
  - Added outer axes deduplication (`outerAxesOnly: true`) hiding redundant Y-axis tick values on inner columns and X-axis category labels on inner rows while maintaining exact grid spacing and gridlines.
  - Added grid dimensions (`columns`, `rows`, `gap`), panel borders (`border: true`, `borderColor`, `panelBackground`, `padding`), and panel title formatting (`headerAlignment: 'left' | 'center' | 'right'`, `headerPosition: 'top' | 'bottom'`, `headerFontSize`, `headerColor`).
  - Added dual-axis shared scaling support for combo charts (`lineClusteredColumn`) in small multiples with unified secondary Y-axis boundaries and composite series legend.
  - Re-exported `SmallMultiplesFormat` in `@prismbi/prismbi/core` and `@prismbi/prismbi/visuals`.

- **Table & Matrix In-Cell Visualizations (Sparklines & Bi-Directional Data Bars):**
  - Upgraded in-cell sparkline renderer (`renderSparkline`, `src/visuals/table.ts`) to support `'line'`, `'area'` (with translucent filled baseline path), `'column'` (positive/negative zero-axis bar scaling), and `'winloss'` micro-charts.
  - Added configurable point marker dots (`markers: true | 'endpoints' | 'minmax'`) with customizable dot radius (`dotRadius`) and distinct min/max extreme colors.
  - Enabled in-cell sparklines in both `table` (`TableFormat.sparklines`) and `matrix` (`MatrixFormat.sparklines`) with custom values arrays and row series data.
  - Upgraded cell data bars (`ConditionalFormat.dataBars`) with bi-directional zero-axis alignment (`axis: true`), dedicated axis marker line (`axisColor`), distinct negative colors (`negativeColor`), and `barOnly: true` mode (hiding text for compact visual rating columns).
  - Re-exported `TableFormat`, `MatrixFormat`, `SparklineOptions`, and `DataBarOptions` in `@prismbi/prismbi/core` and `@prismbi/prismbi/visuals`.

- **Studio DAX Formatter & Beautifier:**
  - Integrated canonical multi-line DAX formatting into `src/dax/format.ts` and Studio's measure expression editor (`src/studio/expressionEditor.ts`).
  - Specialized multi-line formatting: `SWITCH` condition-result pairs aligned on dedicated lines, `CALCULATE` and `CALCULATETABLE` with separate indented filter predicate lines, and `VAR ... RETURN` block breaks.
  - Support for full measure definitions (`Total Margin = ...` and bracketed measure headers `[Total Margin] = ...`) with clean indentation, and preservation of leading comments (`//`, `--`, `/* ... */`).
  - Added `✦ Format DAX` button (`.pbs-format-btn`) in the Studio formula bar and `Shift+Alt+F` keyboard shortcut for instant in-place beautification.
  - Added `FormatDaxOptions`: `indent`, `maxLine`, `uppercaseFunctions`, `alignSwitch`, `breakCalculateFilters`.

- **PDF Document Outlines & Bookmarks Navigation:**
  - Added PDF 1.4 vector document outlines (bookmarks) generator (`PdfOutlineItem`, `buildPdf`, `exportReportPdf`, `report.toPdf()`).
  - Automatically indexes report pages and visual titles into an interactive hierarchical bookmarks tree with direct `/XYZ` page jump coordinates.
  - Sets `/PageMode /UseOutlines` on the PDF document catalog dictionary so PDF readers (Adobe Acrobat, Chrome, Edge, Safari Preview) automatically open the bookmarks navigation sidebar on launch.
  - Configurable via `outlines: boolean` and `visualOutlines: boolean` in `PdfExportOptions`. Re-exported `PdfOutlineItem` in `@prismbi/prismbi/core`.

- **Copy Visual as SVG & Data (TSV) to Clipboard:**
  - Added `visual.copyData()` and `toTsv()` to copy visual query result rows as clean tab-separated values (TSV) directly to system clipboard for instant pasting into Microsoft Excel / Google Sheets.
  - Added `visual.copySvg()` to copy standalone vector SVG markup directly to clipboard for pasting into Figma, Illustrator, or web design tools.
  - Added "Copy data" and "Copy SVG" actions to visual header ⇩ export dropdown menu alongside "Copy image (PNG)".
  - Exposed `report.visual(id).toTsv()`, `copyData()`, and `copySvg()` in `ReportVisualHandle`.

- **Client-Side Encrypted Standalone HTML Dashboards:**
  - Added AES-GCM (256-bit) client-side encryption with PBKDF2 (100,000 iterations, SHA-256) in `buildStandaloneHtml(model, definition, { password, hint })` and `report.exportHtml({ password, hint })`.
  - Embeds an offline decryption modal dialog with password input, optional hint, error validation, and automatic decryption via `window.crypto.subtle`.
  - Re-exported `encryptPayload`, `decryptPayload`, `EncryptedPayload`, and `StandaloneHtmlOptions` in `@prismbi/prismbi/core`.

- **Modern DAX Window Navigation in Visual Calculations:**
  - Added `OFFSET(delta, [target])`, `INDEX(position, [target])`, and `WINDOW(from, to, [target])` functions to visual calculations engine (`src/data/visualCalc.ts`).
  - Added comprehensive evaluation tests across sorted groups and partitioned dimensions in `tests/dax.test.ts` and `tests/phase7.test.ts`.

- **Zero-Copy Arrow & Parquet Direct Ingestion:**
  - Streamlined `addArrowTable` to load Arrow columnar vectors directly into `DataModel` columnar memory (`DataTable.fromColumns`) with zero row-object allocation overhead.
  - Added `DataModel.refreshColumns(name, columns, schema)` to refresh columnar datasets in place while preserving calculated columns and relationships.
  - Added `loadDuckDbTable` and `loadDuckDbTables` in `@prismbi/prismbi/connectors` to ingest DuckDB-Wasm queries or remote/local Parquet files (`parquet: 'data.parquet'`) directly into the model.

- **DuckDB-Wasm Pushdown Bridge & Parquet Pushdown:**
  - Added `parquetTables` in `SqlOptions` to push queries down directly to DuckDB `read_parquet('...')` table views without loading raw rows.
  - Added `duckdbEngine(model, conn, opts)` in `@prismbi/prismbi/sql` providing a turn-key pushdown engine for DuckDB-Wasm with automatic model fallback.

- **Studio Canvas Marquee (Lasso) Selection & Quick Alignment Toolbar:**
  - Added canvas marquee drag selection (`.pbi-marquee`) in `EditController` (`src/report/editing.ts`) with interactive hit preview, additive Shift/Ctrl union selection, and background click deselection.
  - Added Studio quick alignment toolbar (`.pbs-align-bar`) with 1-click alignment buttons (`Align Left`, `Align Center`, `Align Right`, `Align Top`, `Align Middle`, `Align Bottom`, `Distribute Horizontal`, `Distribute Vertical`) dynamically activated on multi-visual selection.

## 0.14.0 (2026-11-09 / Phase 13: Enterprise Fabric & Advanced Charting)

- **Network graph conditional formatting & metric-driven styling:**
  - Extended `network` visual (`src/visuals/network.ts`, `@prismbi/prismbi/visuals/network`) and `NetworkFormat` with rule-based conditional formatting (`format.colors.rules`), smooth gradient interpolation (`format.colors.gradient`), and category-specific overrides (`format.colors.categories`).
  - Added configurable metric threshold targeting (`network.metric`: `'degree'` | `'size'` | `'inWeight'` | `'outWeight'`), allowing rules and color ramps to evaluate against topological connectivity or edge traffic volume.
  - Added individual node ID and cluster group color overrides via `format.colors.categories`, supporting fixed styling per entity or community cluster.
  - Added edge styling controls: customizable link stroke color (`network.edgeColor`) and dynamic weight-scaled edge stroke width bounds (`network.edgeWidthRange: [min, max]`).
  - Integrated conditional node coloring into interactive hover cascades (adjacent links glow in the highlighted node's rule color) and rich data tooltips.
  - Re-exported `NetworkFormat` in `src/core.ts` alongside existing visual formats.

- **Streaming Ingestion Harness (`streamInto` & `scheduleRefresh`):**
  - Upgraded `streamInto(target, table, source, options)` in `@prismbi/prismbi/connectors` to accept `ReportLike` targets (`DataModel | ReportLike`) for direct sliding window pushdown (`report.pushData()`) with automatic scoped visual re-renders.
  - Added URL string source resolution supporting direct WebSocket (`ws://`, `wss://`) and Server-Sent Events (`http://`, `https://`) endpoint strings without manual socket construction.
  - Added resilient auto-reconnection policies (`reconnect: boolean | ReconnectOptions`) featuring configurable exponential backoff (`delayMs`, `maxDelayMs`, `backoffMultiplier`, `maxRetries`).
  - Added connection lifecycle state tracking (`state: StreamConnectionState`: `'connecting' | 'open' | 'closed' | 'reconnecting' | 'error'`) and `onStateChange` callbacks.
  - Added in-flight row transformation and filter predicate pipeline via `options.transform(row)`.
  - Updated `scheduleRefresh` to support `ReportLike` targets in `'append'` mode with sliding window `maxRows` enforcement.

- **Standardized PDF print paper sizes, orientations, margins & running headers/footers:**
  - Added `PdfExportOptions`, `PdfPaperFormat`, `PdfOrientation`, `PdfMarginOptions`, `STANDARD_PAPER_SIZES`, `resolvePaperSize`, and `resolveMargins` to `src/report/pdf.ts` and exported via `src/core.ts`.
  - Added paper presets for `'a4'`, `'letter'`, `'legal'`, `'ledger'`, and `'a3'`, with `'portrait'` and `'landscape'` orientations.
  - Automatically calculates aspect-ratio fit scaling (`scaleFactor`), centering offsets, and printable boundary boxes within custom margins (`margin: number | { top, right, bottom, left }`).
  - Added running headers and footers supporting static strings, boolean (`footer: true` prints "Page X of Y"), and dynamic callback functions `(ctx) => string`.
  - Fully compatible with both vector (`vector: true`) and raster JPEG output in `report.toPdf()` and `report.exportPdf()`.

- **Dual-axis (Secondary Y-Axis) for combo charts (`lineClusteredColumn`):**
  - Added `SecondaryValueAxisFormat` to `src/visuals/format.ts` and exported via `src/visuals.ts` and `src/core.ts`.
  - Supports configurable secondary scale options: `show`, `title`, `format`, `displayUnits`, `decimals`, `min`, `max`, `tickCount`, and `mode: 'auto' | 'on' | 'off'`.
  - Independent secondary Y-scale renders on the right margin for line series when units/scales diverge or when `mode: 'on'` is selected.
  - Added primary and secondary rotated axis titles (`valueAxis.title`, `secondaryValueAxis.title`) aligned with respective series colors.
  - Added column bar data labels alongside line series markers with conflict-free positioning.
  - Fully backwards compatible: preserves single shared scale when secondary axes are unconfigured.

## 0.13.0 (2026-11-03): Live streaming pushdown, automated anomaly detection, force-directed network graphs, and vector PDF rendering

- **Live streaming data ingestion & bounded pushdown:**
  - Added `report.pushData(table, rows, options)` in `@prismbi/prismbi` (`src/report/report.ts`) and `dataModel.appendRows()` for low-latency telemetry, sensor readings, and real-time operational feeds.
  - Supports sliding FIFO window eviction via `options.maxRows`, batch cache invalidation, and reactive `dataPushed: { table, rowCount }` events on `ReportEvents`.

- **Automated time-series anomaly detection:**
  - Added `detectAnomalies()` engine (`src/visuals/anomaly.ts`) featuring detrended Interquartile Range (IQR) and standard Z-score outlier detection models using linear regression trends.
  - Integrated into continuous line charts via `format.analytics.anomalies`, rendering glowing pulsating beacons (`.pbi-anomaly-beacon`) on anomalies and rich explanatory hover badges (`.pbi-anomaly-badge`) reporting exact directional deviation.

- **Force-directed network graph visual (`network`):**
  - Added built-in `network` visual (`src/visuals/network.ts`, `@prismbi/prismbi/visuals/network`) for entity-relationship and graph network visualization.
  - Features Coulomb node repulsion, Hooke spring link attraction, centering gravity physics relaxation, interactive mouse/touch node dragging, community cluster coloring, and bidirectional cross-filtering.
  - Added to built-in visuals registry, gallery, and modular visual entrypoints (`@prismbi/prismbi/visuals/network`).

- **Resolution-independent vector PDF rendering:**
  - Implemented scalable vector graphics instruction translator for PDF 1.4 (`src/report/pdf.ts`, `svgToPdf()`, `svgPathToPdf()`, `parseColor()`, `buildPdf()`).
  - Added `vector: boolean` option to `report.exportPdf()` and `report.toPdf()`, transforming chart SVG elements (rectangles, cubic/quadratic Bézier curves, circles, ellipses, polylines, polygons, and text) directly into native PDF path operators for crisp, infinite scaling without raster pixelation.
  - Direct PDF byte access is exposed via `await report.toPdf({ pages?: 'current' | 'all', vector?: boolean })`.

## 0.12.0 (2026-10-30): Periodic financial DAX, Word & standalone HTML exporters, Gantt, Candlestick & Chord visuals, ClickHouse SQL pushdown, and visual containers

- **Periodic financial DAX suite:**
  - Added full periodic accounting, loan, and investment functions:
    - `PMT(rate, nper, pv, [fv], [type])`: Periodic payment for annuities and amortized loans.
    - `PV(rate, nper, pmt, [fv], [type])`: Present value of a loan or investment.
    - `FV(rate, nper, pmt, [pv], [type])`: Future value of an investment based on periodic constant payments.
    - `NPER(rate, pmt, pv, [fv], [type])`: Number of periods for an investment or loan.
    - `IPMT(rate, per, nper, pv, [fv], [type])`: Interest payment portion for a given amortization period.
    - `PPMT(rate, per, nper, pv, [fv], [type])`: Principal payment portion for a given amortization period.
    - `RATE(nper, pmt, pv, [fv], [type], [guess])`: Interest rate per period using numerical Newton-Raphson approximation.
    - `IRR(table, values, [guess])`: Internal rate of return for periodic cash flows.
  - All functions are registered under `'Financial'` in `src/dax/functions.ts` and support row compilation, scalar expressions, and iterators.

- **Executive document & dashboard exporters:**
  - **OpenXML Word (.docx) generator:** Zero-dependency OpenXML document builder (`src/report/docx.ts`, `report.exportDocx()`, `buildDocx()`) creating structured briefings with executive headings, styled Word tables, and embedded high-resolution visual snapshots. Compatible with Microsoft Word, Google Docs, Apple Pages, and LibreOffice.
  - **Autonomous single-file HTML dashboard exporter:** Self-contained `.html` report compiler (`src/report/html.ts`, `report.exportHtml()`, `buildStandaloneHtml()`) inlining data models, layouts, theme styles, and runtime for completely offline viewing in any modern browser without external CDNs or scripts.

- **Three new built-in visuals:**
  - **Gantt Chart (`gantt`):** Project schedule timeline with continuous time scales, task bars, progress completion fills, and zero-duration milestone diamonds (`@prismbi/prismbi/visuals/gantt`).
  - **Candlestick Chart (`candlestick`):** Financial OHLC stock chart with green/red theme session states and optional bottom volume bars (`@prismbi/prismbi/visuals/candlestick`).
  - **Chord Diagram (`chord`):** Radial entity relationship flows and directional transfers with perimeter arcs and quadratic Bézier ribbons (`@prismbi/prismbi/visuals/chord`).
  - Each visual provides tree-shakeable individual entry points under `@prismbi/prismbi/visuals/*`.

- **ClickHouse SQL pushdown dialect & LRU query cache:**
  - Added `'clickhouse'` to `SqlDialect` in `src/sql.ts`: backtick identifier quoting, `toDate`, `toYear`, `toMonth`, `toDayOfMonth`, `toStartOfYear/Quarter/Month`, `dateDiff`, `addMonths/Days`, and pushed-down `MEDIAN`.
  - Added LRU query cache in `sqlEngine` supporting capacity eviction (`max: number`) and time-to-live expiration (`ttlMs: number`).

- **Visual grouping & container indicators:**
  - Added multi-visual grouping and ungrouping (`report.groupVisuals()`, `report.ungroupVisuals()`, shortcuts `Ctrl+G` and `Ctrl+Shift+G`).
  - Container metadata (`data-group`) and overlays across visual hosts, canvas snapping guides, and Studio layers.

## 0.11.0 (2026-10-28): Financial & bitwise DAX, T-SQL & BigQuery pushdown, streaming ingestion, PPTX & MCP server, Studio UX enhancements

- **Financial DAX functions:**
  - Added `XNPV(<table>, <values>, <dates>, <rate>)` and `XIRR(<table>, <values>, <dates>, [<guess>])` supporting irregular cash flow schedules, Newton-Raphson numerical solving, and table iterators or column vectors.
- **DAX tuple matching & CONTAINSROW:**
  - Added `CONTAINSROW(<table>, <value>...)` for positional tuple matching across tables and inline constructors.
  - Extended binary `IN` operator to support row tuples: `(v1, v2) IN Table` matching multi-column table rows.
- **Extended SQL pushdown dialects & parameterized mode:**
  - Added **Microsoft SQL Server (T-SQL)** dialect (`'mssql'`): bracket identifier quoting (`[Table].[Column]`), `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY` paging, `DATEPART` temporal extraction, and null-safe ordering.
  - Added **Google BigQuery** dialect (`'bigquery'`): backtick identifiers, `IEEE_DIVIDE` safe division, `CONCAT`, and grouping sets.
  - Added **Parameterized SQL Mode** (`opts.parameterized: true`): extracts literal values into `SqlPlan.params` and emits standard parameter placeholders (`?`).
- **Data label collision avoidance:**
  - Multi-series line, area, and stacked area charts now employ a greedy sweep-line collision solver across series. Colliding labels are dynamically shifted below the point or suppressed to prevent unreadable visual overlapping.
- **Streaming CSV URL connectors:**
  - Added `loadCsvColumns(url, opts)` and `streamCsvUrl(url, opts)` in `@prismbi/prismbi/connectors` for direct URL streaming into columnar typed arrays without intermediate row object overhead.


- **Custom GeoJSON boundaries & small multiples:**
  - **Custom GeoJSON boundary loader:** `registerGeoJson(name, geojson, keys?)`, `hasBoundaries(name)`, `listBoundaries()`, and `removeBoundaries(name)` in `@prismbi/prismbi/geo` allow registering arbitrary GeoJSON shapes (custom sales territories, school districts, postal zip codes) for choropleth filled maps.
  - **Small multiples on scatter & bullet charts:** `scatter` and `bullet` visuals now support small multiples grid splitting with shared axis scaling and legend aggregation.
- **Bitwise DAX functions:**
  - Added `BITAND(<n1>, <n2>)`, `BITOR(<n1>, <n2>)`, `BITXOR(<n1>, <n2>)`, `BITLSHIFT(<n>, <shift>)`, and `BITRSHIFT(<n>, <shift>)` supporting full 64-bit integer precision and row-compilation.
- **Visual copy image to clipboard:**
  - Added `visual.copyImage()` to `VisualHandle` and visual header export menu ("Copy image: Clipboard"), writing full-bleed raster PNG snapshots directly to system clipboard via the Async Clipboard API (`navigator.clipboard.write([new ClipboardItem(...)])`).

- **Enterprise SQL pushdown dialects:**
  - **MySQL & Snowflake support:** Extended `SqlDialect` with `'mysql'` and `'snowflake'`. Generates native pushdown queries with dialect-specific functions (`<=>` null-safe equality, `MAKEDATE`, `DATE_ADD`, `DATEDIFF` for MySQL; `DATEADD`, `DATEDIFF(day, ...)`, `LAST_DAY`, `DATE_TRUNC` for Snowflake), identifier escaping, and parameter substitution.
- **Reporting & visual enhancements:**
  - **Matrix stepped layout toggle:** `format.matrix.stepped = false` (Power BI matrix "Stepped layout: Off") displays distinct column headers and dedicated columns per row hierarchy level instead of single-column indented stepping.
  - **In-cell SVG sparklines:** `renderSparkline(values, opts)` SVG renderer (`line` and `column` modes) and `format.matrix.sparklines` configuration for embedding compact trend lines and bars directly inside matrix and table cells.
- **Standalone PowerPoint (.pptx) presentation export:**
  - Zero-dependency OpenXML `.pptx` presentation generator (`buildPptx`, `PPTX_MIME`, `PptxSlide`) in `src/report/pptx.ts`. Generates standard 16:9 full-bleed slide decks with embedded PNG/JPEG snapshots using native ZIP packaging.
- **Model Context Protocol (MCP) server:**
  - Embedded JSON-RPC 2.0 MCP server (`createMcpServer`, `McpServer`) in `src/ai/agent.ts` with stdio line-delimited streaming transport, exposing data exploration and DAX querying tools to external AI agents.

- **Scale, streaming ingestion & multi-worker execution:**
  - **Zero-copy columnar CSV ingestion:** `parseCsvColumns(text, opts)` parses directly into columnar arrays without intermediate `{ [col]: value }` row objects, saving GC overhead on large files.
  - **Streaming CSV parser:** `streamCsv(stream, opts)` parses chunks incrementally with multiline quote preservation and `onBatch` progressive emission for streaming loads.
  - **High-cardinality BigInt composite grouping:** Group key space in the single-pass path (`fastQuery.ts`) expanded from `Number.MAX_SAFE_INTEGER` (4M–9e15) up to 64-bit BigInt ($1.84 \times 10^{19}$) without string concatenation or GC pauses.
  - **Worker pool:** `createWorkerPool(workers)` distributes read queries in parallel across a pool of Web Workers/ports using least-busy selection, while broadcasting mutations to keep models synchronized.
  - **Studio data view virtualization:** Smooth DOM-virtualized scrolling in `renderDataView` replaces page increments, keeping DOM node count under 40 elements for arbitrarily large tables.

- **Studio UX & visual authoring enhancements:**
  - **Quick measures:** Guided modal for generating standard DAX time-intelligence and statistical patterns without manual authoring (Year-over-Year %, YTD, Running Total, Rolling 3M Average, Month-over-Month Change, % of Total).
  - **Selection / Layers pane:** Manage visual stack order, rename elements, select visuals, and toggle visual visibility directly from the Studio side pane.
  - **Visual visibility toggle:** `hideVisual(id)` / `showVisual(id)` API and persisted hidden state in `ReportSpec` and DOM display.
  - **Smart alignment guides:** Dynamic visual snap guides and distance indicators during canvas drag-and-drop / resize operations.
  - **Model diagram auto-layout:** Automated hierarchical layered graph layout for relationship model diagrams based on connectivity and cardinality.
- **DAX functions:** `TIME(<hour>, <minute>, <second>)`, `TIMEVALUE(<text>)`, `CONTAINSSTRINGEXACT(<within>, <find>)`, and `CALENDARAUTO([<fiscalYearEndMonth>])`.
- **Fix:** `TIME` and `CONTAINSSTRINGEXACT` were listed in pure functions and compiler allowlists but lacked evaluator cases and function catalog entries.
- **Fix:** dynamic imports in `tests/visual-entries.test.ts` now include an explicit `.ts` static extension to prevent Vite bundler warnings.
- **Omitted arguments** parse as their default (BLANK): `RANKX(ALL(Product[Name]), [Sales], , ASC)` (the omitted value is the expression itself), `TOTALYTD([Sales], Date[Date], , "6/30")` (no filter), `IF(cond, , x)`. They were syntax errors.
- **`RANKX(ALL(Table) | ALLSELECTED(Table), …)` on the single-pass path:** rows of a table with a unique key (the one side of a relationship) are ranked by that key.
- **No totals, less work:** when a visual has no totals row, the single pass doesn't accumulate grand totals, and rank and iterator sub-queries skip their totals pass. Product × region share and rank at 1M rows: 799 → 300 ms.
- **Fix: context transition on a table row.** Iterating a whole table (`RANKX(ALL(Product), [Sales])`, `SUMX(ALL(Product), …)`, `FILTER(ALL(Product), …)` with a measure) kept the visual's filters on that table's columns next to the row, so in a visual grouped by product every product ranked 1 and the "all products" sum was the product's own. A row now replaces the filters on its table's columns, as in DAX.
- **Cross-highlighting stays on the single-pass path** for share-of-total, `RANKX` and `AVERAGEX(VALUES(…))` measures and for values that aren't BLANK on empty groups: the highlighted values come from the same sub-queries over the query's filters plus the highlight.
- **More measures in the single-pass grouped path.** Visuals with many groups (product × region at 200k rows, 16k groups) no longer fall back to one evaluation per group for everyday measure shapes. Results match the general engine (`tests/fastscalar.test.ts` compares both for every shape below).
  - **Scalar wrappers:** `SWITCH`, `IF` with any condition, `ISBLANK`, `COALESCE`, `&&` / `||` / `NOT`, comparisons, `&`, `ABS`, `ROUND`, `MIN`/`MAX` of two values, `FORMAT` and other deterministic scalar functions, applied to per-group results by the evaluator itself. About 500 → 30 ms. Values that aren't BLANK for an empty group (`COALESCE([x], 0)`) take their groups from the general path's combinations.
  - **`VAR` / `RETURN`**, including variables defined outside a `CALCULATE`.
  - **Iterators over the fact table:** `MINX`, `MAXX`, `COUNTX`, `COUNTAX` (with `SUMX` / `AVERAGEX`); `COUNTROWS(VALUES(fact[col]))`.
  - **`FILTER(fact, condition)` in `CALCULATE`** becomes a compiled row test (2.3 s → 43 ms). It keeps DAX's rule that filter arguments see the outer context.
  - **Share of total:** `CALCULATE(x, ALL(…) | REMOVEFILTERS(…) | ALLEXCEPT(…) | ALLSELECTED(…), column filters…)` is answered by one coarser grouped query, with the evaluator applying the removals (about 600 → 40 ms).
  - **`RANKX(ALL(T[c]) | ALLSELECTED(T[c]), x [, value, ASC|DESC, SKIP|DENSE])`:** one ranking list per coarse key, sorted once (5.4 s → 48 ms).
  - **Iterators over a column's values with a measure body** (`AVERAGEX(VALUES(Date[Date]), [Sales])`, `MAXX`, `MINX`, `SUMX`, `COUNTX`): one grouped query at the finer grain, folded per group.
  - **Rolling windows:** `DATESINPERIOD(D[Date], MAX(D[Date]) | LASTDATE | MIN | FIRSTDATE, n, DAY|MONTH|QUARTER|YEAR)` joins the single-pass time intelligence.
- **Compiled `FILTER` in the general engine:** `FILTER(table, condition)` over table rows runs a compiled row test. Conditions on one column are judged once per distinct value by the evaluator (text comparison and BLANK rules unchanged); numeric comparisons run on typed views; `&&`, `||`, `AND`, `OR`, `NOT` combine them. `COUNTROWS(FILTER(Sales, …))` and friends are several times faster.
- **Boolean `CALCULATE` filters that only read columns** (`Sales[Amount] > 400`, `Product[Name] = "P1"`) are computed once and reused across groups. A filter on a column the visual groups by went from 8.2 s to 30 ms at 16k groups.
- **Size budgets raised deliberately** (`scripts/size.mjs`): the fast-path additions cost 4.0 KB min+gzip in the core (core api 96.6 → 100.6 KB, budget 98 → 102; core app 87 → 91; full 139 → 143 / 133 → 137; core + visual entries 94 → 98 / 107 → 111).
- **Benchmark:** `npm run bench` adds product × region share-and-rank and `FILTER` cases.

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
