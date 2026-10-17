# Visuals reference

Every visual is a `VisualSpec`:

```ts
{
  id?: string;                      // stable id (auto-generated otherwise)
  type: 'clusteredColumn';          // see the table below
  title?: string;
  layout?: { x, y, w, h, z? };      // grid units (page default: 12 columns × 44px rows)
  fields?: { [role]: FieldSpec | FieldSpec[] };
  filters?: FilterSpec[];           // visual-level filters
  format?: { ...format pane };      // see "Common format options" below
  sort?: { field: 'Total Sales', direction: 'desc' };
  top?: number;                     // keep first N groups after sorting
  interaction?: 'filter' | 'highlight' | 'none';   // how it reacts to other visuals
  interactionsFrom?: { [sourceVisualId]: 'filter' | 'highlight' | 'none' };
  drill?: { level, path, skip? };   // persisted drill state
  hidden?: boolean; className?: string; style?: string;
}
```

A `FieldSpec` is one of:
- a measure name, e.g. `'Total Sales'`
- a column ref, e.g. `'Products[Category]'`. In a measure role, this gets an implicit aggregation.
- `{ field: 'Sales[Qty]', aggregation: 'avg', name: 'Avg qty', format: '#,0.0' }`
- `{ expression: 'SUM(Sales[Amount]) * 1.1', name: 'Forecast', format: '$#,0' }`

## Catalogue

| Type (aliases) | Roles | Notes |
|---|---|---|
| `clusteredColumn` (`column`) | `category`* (drillable, multiple) · `legend` · `values`* (multiple) · `smallMultiples` | Sorted by first value, descending, unless the category is a number, a date or has sort-by |
| `stackedColumn`, `percentStackedColumn` | same | 2 px gaps between segments. Categories sorted by total |
| `clusteredBar` (`bar`), `stackedBar`, `percentStackedBar` | same | Horizontal versions |
| `line` | `category`* (drillable) · `legend` · `values`* · `smallMultiples` | Crosshair tooltip, end labels (four or fewer series), markers (16 or fewer points), cross-highlight |
| `area`, `stackedArea` | same | 10% area wash. Stacked area sums series |
| `lineClusteredColumn` (`combo`) | `category`* · `legend` (columns) · `values` (columns) · `lineValues` | **One shared value axis** by design. A second y-axis is a known chart anti-pattern |
| `waterfall` | `category`* (drillable) · `values`* | Running total with connectors, increase / decrease / total colours, optional total bar |
| `pie`, `donut` | `legend`* (drillable) · `values`* | Folds slices past the palette into "Other". Donut shows a centre total |
| `treemap` | `category`* (drillable) · `values`* | Squarified layout |
| `funnel` | `category`* · `values`* | Shows % of first stage |
| `scatter` (`bubble`) | `details`* · `legend` · `x`* · `y`* · `size` | Bubble area ∝ size. Cross-highlight, trend line |
| `heatmap` | `rows`* · `columns`* · `values`* | Sequential single-hue ramp, gradient legend, cell labels when they fit |
| `decompositionTree` (`decomp`) | `values`* · `explainBy`* (multiple) | Split a total level by level, click nodes to narrow down, automatic "High value / Low value" splits. Cross-filters the page |
| `histogram` | `values`* (numeric column) · `weight` (optional measure) | Bins by Sturges' rule or `format.histogram.bins` / `binWidth` |
| `boxPlot` | `category` · `values`* (numeric column) | Quartiles, 1.5 × IQR whiskers, outliers, mean marker |
| `bullet` | `category` · `value`* · `target` · `maximum` | Value bar over qualitative bands with a target tick |
| `radar` | `category`* (spokes, 3 or more) · `legend` · `values`* | One polygon per series on a shared radial scale |
| `sankey` | `source`* · `target`* · `values`* | Multi-stage flows (a target that is also a source becomes a middle column) |
| `ribbon` | `category`* · `legend`* · `values`* | Stacked by rank in each column, with ribbons showing rank changes |
| `map` (`bubbleMap`) | `location`* · `legend` · `latitude`* · `longitude`* · `size` | Columns are averaged per location. Your own GeoJSON or tiles via `format.map` |
| `filledMap` (`choropleth`) | `location`* · `values`* | Needs `format.map.geojson`. Matches `featureKey` (default `name`) case-insensitively |
| `card` | `value`* · `delta` | Auto-sized callout value, signed delta with good/bad colour |
| `multiRowCard` | `category` · `values`* | One card per group |
| `kpi` | `trend` · `value`* · `target` | Headline is the last trend point. Shows % vs goal and a sparkline |
| `gauge` | `value`* · `min` · `max` · `target` | 180° arc |
| `table` | `columns`* (columns and measures mixed) | Click a header to sort. Totals, conditional formatting, incremental rendering |
| `matrix` | `rows` (hierarchy) · `columns` · `values`* | Expand/collapse, column pivot, real subtotals and totals |
| `slicer` | `field`* (several fields give a hierarchy tree) | list · dropdown · tiles · between · relative date · tree. Sync groups across pages |
| `text` (`textbox`) | `values` (optional) | Mini-markdown with `{{Measure name}}` placeholders |

`*` marks a required role.

**Small multiples:** put a field in `smallMultiples` (column, bar, line and area charts) to get one panel per member, with a shared value axis and a single legend. Configure it with `format.smallMultiples: { columns?, sharedAxis: true, minWidth: 160, minHeight: 110 }`.

## Common format options

All of these are optional. Values merge as: base defaults ← visual defaults ← `theme.visualStyles['*']` ← `theme.visualStyles[type]` ← `spec.format`.

```ts
format: {
  title:      { show: true, text, subtitle, fontSize, color, align: 'left'|'center'|'right', bold: true },
  background: { show: true, color, transparency: 0 },          // 0–100
  border:     { show: true, color, width: 1, radius },
  shadow:     { show: false },
  padding:    12,
  header:     { show: true, focusMode: true, exportData: true, showAsTable: true, drill: true },
  tooltip:    { show: true, page: 'tooltip-page-id' },  // report tooltip page
  legend:     { show: 'auto' | true | false, position: 'top'|'bottom'|'left'|'right', fontSize },
  dataLabels: { show: false, format, displayUnits: 'auto', decimals, fontSize, color, position: 'auto' },
  categoryAxis: { show: true, maxLabelWidth: 120, labelAngle: 'auto'|0|45|90,
                  type: 'auto'|'categorical'|'continuous',   // auto = continuous for date/number fields on line & area
                  scale: 'linear'|'log' },                   // scatter x-axis
  valueAxis:  { show: true, displayUnits: 'auto', decimals, min, max, gridlines: true, tickCount: 5, scale: 'linear'|'log' },
  colors:     { default, palette: [...], series: { 'Total Sales': '#...' }, categories: { 'Bikes': '#...' },
                rules: [{ op: '<', value: 0, color: '#d03b3b' }],      // single-series charts, first match wins
                gradient: { min: '#cde2fb', max: '#0d366b' } },        // single-series charts, by value
  analytics:  { referenceLines: [{ type: 'average' | 'median' | 'min' | 'max' | 'percentile' | 'constant', value?, percentile?, label?: 'Goal {value}' | false, color?, dash? }],
                trendLine: false | true | { color } },
  bars:       { maxThickness: 24, radius: 4, gap: 2, categoryGap: 0.35 },
  lines:      { width: 2, markers: 'auto', smooth: false, area: false, areaOpacity: 0.1, endLabels: true },
  animation:  { enabled: true, duration: 280 },
}
```

`legend.show: 'auto'` shows a legend when there are two or more series, and hides it for one series because the title already says what is plotted.

### Visual-specific sections

```ts
// card
format: { card: { labelPosition: 'top'|'bottom', showLabel: true, align: 'left'|'center', valueFontSize, upIsGood: true, deltaLabel: 'vs LY' } }

// kpi
format: { kpi: { upIsGood: true } }

// pie / donut
format: { pie: { maxSlices: 8 }, donut: { innerRadius: 0.62, centerLabel: true } }

// table
format: { table: {
  totals: true, rowBanding: true, wrap: false, density: 'compact'|'normal'|'comfortable', pageSize: 200,
  columnWidths: { 'Total Sales': 140 },
  conditional: {
    'Total Sales': { dataBars: true },                         // or { color, negativeColor }
    'Margin %':    { background: true },                       // or { min, mid, max } colours
    'YoY %':       { icons: true },                            // ▲ ▼ ● by sign
    'Profit':      { rules: [{ op: '<', value: 0, color: '#d03b3b' }, { op: 'between', value: 0, value2: 1000, background: '#fff4d6' }] },
  },
} }

// matrix
format: { matrix: { expandAll: false, columnTotals: true, conditional: { /* as table */ } } }

// slicer
format: { slicer: {
  style: 'list' | 'dropdown' | 'tiles' | 'between' | 'relative' | 'slider',   // dates default to 'between'; 'slider' = one value (what-if)
  single: false, search: true, selectAll: true, orientation: 'horizontal', placeholder: 'All',
  relative: { anchor: 'last'|'next'|'this', n: 30, unit: 'days'|'weeks'|'months'|'years', includeToday: true },
} }

// text
format: { text: { content: '# Heading\n**{{Total Sales}}** this period. [Docs](https://example.com)' } }

// waterfall
format: { waterfall: { showTotal: true, totalLabel: 'Total', increaseColor, decreaseColor, totalColor } }

// decomposition tree
format: { decomposition: { maxNodes: 10, aiSplits: true, columnWidth: 190 } }

// histogram
format: { histogram: { bins: 20, binWidth: 50 } }

// bullet
format: { bullet: { bands: [0.6, 0.85, 1], sharedScale: true } }

// maps (bubble and filled)
format: { map: {
  geojson: featureCollection,              // outlines (required for filledMap)
  featureKey: 'name',                      // property matched against the location field
  tiles: 'https://tiles.example.com/{z}/{x}/{y}.png', attribution: '© provider',   // optional raster basemap
  maxRadius: 28, zoom: true, graticule: true,
} }

// slicer sync group (any style)
format: { slicer: { syncGroup: 'year' } }
```

## Header actions

Hovering or focusing a visual shows its header icons:
- **⤢ Focus mode** fills the page. Esc exits.
- **▦ Show as table** displays the query result as a table.
- **⇩ Export** opens a menu: data (CSV), image (PNG at 2×), image (SVG). The same is available in code as `report.visual(id).exportCsv()`, `.exportImage('png' | 'svg')` and `.toSvg()`.
- **↑ Drill up**, **⇊ Go to next level** and **⤓ Expand all down one level** appear when a drillable role has several fields.
- **⌫ Clear selections** appears on slicers.

Each of these can be turned off through `format.header`.

## Accessibility

Marks are focusable (Tab), and Enter or Space selects one. Tooltips also show on focus. Each chart has an `aria-label` from its title, and tables use real `<table>` markup with `aria-sort`. Animations respect `prefers-reduced-motion`.

## Forecast

Line and area charts with a date or number axis can extend each series (up to three) with a forecast:

```ts
{ type: 'line', fields: { category: 'Date[Date]', values: 'Total Sales' },
  format: { analytics: { forecast: { periods: 30, confidence: 0.95, seasonality: 'auto' } } } }
```

- **Model:** damped additive Holt-Winters. Its parameters are chosen by one-step-ahead error, and the season length is detected by autocorrelation, or given as a number, or turned off with `'none'`.
- **Display:** the forecast is a dashed line inside a shaded prediction interval that widens with the horizon.
- **Non-negative series:** a series that has never been negative (sales, counts) is never forecast below zero.
- **Dates:** future dates follow the calendar for monthly, quarterly and yearly data.
