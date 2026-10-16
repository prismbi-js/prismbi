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
| `clusteredColumn` (`column`) | `category`* (drillable, multiple) · `legend` · `values`* (multiple) | Sorted by first value, descending, unless the category is a number, a date or has sort-by |
| `stackedColumn`, `percentStackedColumn` | same | 2 px gaps between segments. Categories sorted by total |
| `clusteredBar` (`bar`), `stackedBar`, `percentStackedBar` | same | Horizontal versions |
| `line` | `category`* (drillable) · `legend` · `values`* | Crosshair tooltip, end labels (four or fewer series), markers (16 or fewer points) |
| `area`, `stackedArea` | same | 10% area wash. Stacked area sums series |
| `lineClusteredColumn` (`combo`) | `category`* · `legend` (columns) · `values` (columns) · `lineValues` | **One shared value axis** by design. A second y-axis is a known chart anti-pattern |
| `pie`, `donut` | `legend`* (drillable) · `values`* | Folds slices past the palette into "Other". Donut shows a centre total |
| `treemap` | `category`* (drillable) · `values`* | Squarified layout |
| `funnel` | `category`* · `values`* | Shows % of first stage |
| `scatter` (`bubble`) | `details`* · `legend` · `x`* · `y`* · `size` | Bubble area ∝ size |
| `card` | `value`* · `delta` | Auto-sized callout value, signed delta with good/bad colour |
| `multiRowCard` | `category` · `values`* | One card per group |
| `kpi` | `trend` · `value`* · `target` | Headline is the last trend point. Shows % vs goal and a sparkline |
| `gauge` | `value`* · `min` · `max` · `target` | 180° arc |
| `table` | `columns`* (columns and measures mixed) | Click a header to sort. Totals, conditional formatting, incremental rendering |
| `matrix` | `rows` (hierarchy) · `columns` · `values`* | Expand/collapse, column pivot, real subtotals and totals |
| `slicer` | `field`* | list · dropdown · tiles · between · relative date |
| `text` (`textbox`) | `values` (optional) | Mini-markdown with `{{Measure name}}` placeholders |

`*` marks a required role.

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
  tooltip:    { show: true },
  legend:     { show: 'auto' | true | false, position: 'top'|'bottom'|'left'|'right', fontSize },
  dataLabels: { show: false, format, displayUnits: 'auto', decimals, fontSize, color, position: 'auto' },
  categoryAxis: { show: true, maxLabelWidth: 120, labelAngle: 'auto'|0|45|90 },
  valueAxis:  { show: true, displayUnits: 'auto', decimals, min, max, gridlines: true, tickCount: 5 },
  colors:     { default, palette: [...], series: { 'Total Sales': '#...' }, categories: { 'Bikes': '#...' } },
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
  style: 'list' | 'dropdown' | 'tiles' | 'between' | 'relative',   // dates default to 'between'
  single: false, search: true, selectAll: true, orientation: 'horizontal', placeholder: 'All',
  relative: { anchor: 'last'|'next'|'this', n: 30, unit: 'days'|'weeks'|'months'|'years', includeToday: true },
} }

// text
format: { text: { content: '# Heading\n**{{Total Sales}}** this period. [Docs](https://example.com)' } }
```

## Header actions

Hovering or focusing a visual shows its header icons:
- **⤢ Focus mode** fills the page. Esc exits.
- **▦ Show as table** displays the query result as a table.
- **⇩ Export data (CSV)** exports the current result.
- **↑ Drill up** and **⇊ Go to next level** appear when a drillable role has several fields.
- **⌫ Clear selections** appears on slicers.

Each of these can be turned off through `format.header`.

## Accessibility

Marks are focusable (Tab), and Enter or Space selects one. Tooltips also show on focus. Each chart has an `aria-label` from its title, and tables use real `<table>` markup with `aria-sort`. Animations respect `prefers-reduced-motion`.
