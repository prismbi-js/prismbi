# PrismBI

**Power BI-style data modeling and interactive reports for the web, written in TypeScript.**

[Live demo](https://prismbi-js.github.io/) · [Docs](https://prismbi-js.github.io/docs/) · [Playground](https://prismbi-js.github.io/playground.html) · [Studio](https://prismbi-js.github.io/studio.html)

![A PrismBI report: slicers, KPI cards and cross-filtering charts](https://prismbi-js.github.io/docs/images/report-overview.png)

| Studio | Agent panel | Playground |
|---|---|---|
| ![PrismBI Studio](https://prismbi-js.github.io/docs/images/studio.png) | ![The Studio agent panel](https://prismbi-js.github.io/docs/images/studio-agent.png) | ![The live playground](https://prismbi-js.github.io/docs/images/playground.png) |

PrismBI gives you a semantic model with relationships, a DAX-like formula engine, 39 interactive visuals, slicers, cross-filtering, drill down and drill-through, a filter pane, bookmarks and themes. It also includes a drag-and-drop **report editor** (`@prismbi/prismbi/studio`). It has zero dependencies: about 82 KB min+gzip for the core (model, DAX engine, report runtime), about 101 KB for a dashboard with five visuals, and about 125 KB with every visual (`npm run size`). Connectors (CSV, REST, GraphQL, Arrow, SQL, streaming) and a Web Worker engine are separate small entries. It runs in any framework and has first-class React bindings.

```bash
npm install @prismbi/prismbi
```

```ts
import { DataModel, Report } from '@prismbi/prismbi';

const model = new DataModel()
  .addTable('Sales', salesRows)
  .addTable('Products', productRows)
  .addDateTable('Date', '2024-01-01', '2025-12-31')
  .addRelationship({ from: 'Sales[ProductId]', to: 'Products[Id]' })
  .addRelationship({ from: 'Sales[OrderDate]', to: 'Date[Date]' })
  .addMeasure('Total Sales', 'SUM(Sales[Amount])', { format: '$#,0' })
  .addMeasure('YoY %', 'DIVIDE([Total Sales] - CALCULATE([Total Sales], SAMEPERIODLASTYEAR(Date[Date])), CALCULATE([Total Sales], SAMEPERIODLASTYEAR(Date[Date])))', { format: '0.0%' });

new Report(document.getElementById('app')!, {
  model,
  pages: [{
    name: 'Overview',
    visuals: [
      { type: 'slicer', layout: { x: 0, y: 0, w: 12, h: 2 }, fields: { field: 'Date[Year]' }, format: { slicer: { style: 'tiles' } } },
      { type: 'card', layout: { x: 0, y: 2, w: 3, h: 3 }, fields: { value: 'Total Sales', delta: 'YoY %' } },
      { type: 'clusteredColumn', title: 'Sales by category', layout: { x: 3, y: 2, w: 9, h: 7 },
        fields: { category: ['Products[Category]', 'Products[Name]'], values: 'Total Sales' } },
    ],
  }],
});
```

Clicking a column filters the card. Clicking a slicer tile filters both, and double-clicking a column drills from Category down to Name.

## Why PrismBI

| | |
|---|---|
| **Real BI semantics** | Filter context, row context, context transition, `CALCULATE` with `ALL`, `ALLEXCEPT`, `ALLSELECTED`, `KEEPFILTERS`, `USERELATIONSHIP` and `CROSSFILTER`, time intelligence, financial functions (`XNPV`, `XIRR`, `PMT`, `PV`, `FV`, `NPER`, `IPMT`, `PPMT`, `RATE`, `IRR`), bitwise DAX, table constructors, tuple `IN`, auto-exist grouping, and true (non-additive) totals. Over 175 DAX functions |
| **Advanced modeling** | Bidirectional, many-to-many and inactive relationships, calculated tables, calculation groups, field and what-if parameters, hierarchies, perspectives, row-level security |
| **Report editor** | `@prismbi/prismbi/studio`: drag-and-drop canvas with magnetic alignment guides, visual grouping & containers, selection & layers pane, quick measures wizard, fields, build, format and filters panes, measure/column editors, DAG hierarchical model layout, virtualized data view, theme designer, undo/redo, autosave, versioned JSON |
| **Developer tooling** | DAX language service (completion, hover, diagnostics, signature help), formatter, dependency explanation, `evaluateTable()` queries |
| **Slice and narrow down** | Slicers (list, dropdown, tiles, range, relative date, hierarchy tree, synced across pages), cross-filter and cross-highlight, Ctrl+click multi-select, right-click Include / Exclude, drill down / up / expand all, drill-through pages with Back, a decomposition tree, report, page and visual filters, a filter pane with Basic, Advanced and Top N, bookmarks |
| **39 visuals** | Column and bar (clustered, stacked, 100%), line, area, stacked area, combo, ribbon, waterfall, pie, donut, treemap, sunburst, funnel, scatter and bubble, histogram, box plot, bullet, radar, sankey, chord diagram, gantt chart, candlestick (OHLC with volume), heatmap, bubble and filled maps (with custom GeoJSON territories), decomposition tree, card, multi-row card, KPI, gauge, goals scorecard, table, matrix (stepped layout and in-cell sparklines), slicer, text, sweep-line collision avoidance for data labels, and small multiples across cartesian, scatter, and bullet charts |
| **Light and fast** | Zero dependencies. A columnar engine with typed-array views, 64-bit group key encoding, multi-worker parallel execution pool, vectorised aggregations, a single-pass grouped query path, hash indexes and caches. Queries over 1M rows, including YTD per day, take 12–191 ms cold. LTTB-thinned lines, canvas scatter, virtualized tables, and an optional Web Worker engine |
| **Live data** | `@prismbi/prismbi/connectors`: zero-copy streaming CSV to packed columnar buffers, URL streaming, Google Sheets, JSON, paginated REST, GraphQL, Apache Arrow (Parquet via DuckDB-Wasm), SQL adapters, WebSocket and EventSource streaming into sliding windows, scheduled refresh |
| **Analytics** | Continuous time and number axes, log scales, reference lines (constant, average, median, min, max, percentile), trend lines, rule- and gradient-based colours, report-page tooltips, real totals |
| **Customizable** | Theme tokens and CSS variables, Power BI theme JSON import, per-visual format panes, theme `visualStyles`, custom tooltips, custom visuals, PNG/SVG/CSV/PDF/PowerPoint (.pptx)/Word (.docx) export, standalone single-file HTML dashboards, copy visual image to clipboard, edit-interactions mode |
| **Accessible** | Keyboard-reachable marks, ARIA roles, legends whenever there are two or more series, show-as-table on every chart, reduced motion, light and dark palettes validated for colour-vision deficiency |

## Entry points

| Import | What |
|---|---|
| `@prismbi/prismbi` | Everything: model, DAX, report runtime and all 39 visuals |
| `@prismbi/prismbi/core` + `@prismbi/prismbi/visuals` | Lean builds: register only the visuals you use |
| `@prismbi/prismbi/studio` | Drag-and-drop report editor |
| `@prismbi/prismbi/react` | `<PrismReport>`, `<PrismVisual>`, `<PrismStudio>` |
| `@prismbi/prismbi/elements` | `<prism-report>`, `<prism-visual>` web components (Vue, Svelte, Angular, plain HTML) |
| `@prismbi/prismbi/connectors` | CSV, REST, GraphQL, Arrow, SQL, streaming, scheduled refresh |
| `@prismbi/prismbi/worker` | Run the model in a Web Worker |
| `@prismbi/prismbi/geo` | World countries, US states, and custom GeoJSON territories for maps |
| `@prismbi/prismbi/sql` | Push visual queries down to DuckDB, Postgres, SQLite, MySQL, Snowflake, SQL Server (T-SQL), BigQuery, ClickHouse (with parameterized mode and LRU query cache) |
| `@prismbi/prismbi/ai` | Ask, explain, insights, agent tools, and standalone MCP server (Claude, OpenAI, Cursor, Gemini) |
| `@prismbi/prismbi/plugins` | Signed plugins, catalogs and an install gallery |
| `@prismbi/prismbi/collab` | Live co-editing, presence and comments |
| `@prismbi/prismbi/server` | Headless SVG/HTML rendering, measure alerts, scheduled report jobs |
| `@prismbi/prismbi/powerbi` | Import Power BI .pbip projects (model, measures, report) |
| `@prismbi/prismbi/files` | Report files for Git, plus diffs (also the `@prismbi/prismbi` CLI) |

## Lean builds

`@prismbi/prismbi/core` has the model, DAX and report runtime without any visuals. Add visuals per family; each import registers its visuals:

```ts
import { Report, DataModel } from '@prismbi/prismbi/core';
import '@prismbi/prismbi/visuals/bar';      // column and bar charts
import '@prismbi/prismbi/visuals/card';
import '@prismbi/prismbi/visuals/slicer';
```

Entries: `bar`, `line`, `pie`, `treemap`, `sunburst`, `scorecard`, `funnel`, `scatter`, `card`, `kpi`, `gauge`, `table`, `slicer`, `text`, `waterfall`, `heatmap`, `calendar`, `decomposition`, `distribution`, `bullet`, `radar`, `sankey`, `ribbon`, `map`, `gantt`, `candlestick`, `chord`. Each also exports its definitions (`import { waterfall } from '@prismbi/prismbi/visuals/waterfall'`). Minified and gzipped, core with one visual is about 89 KB; the full package is about 125 KB. You can also import definitions from `@prismbi/prismbi/visuals` and call `registerVisual` yourself.

## React

```tsx
import { PrismReport, PrismVisual } from '@prismbi/prismbi/react';

<PrismReport model={model} definition={reportJson} theme="dark"
  onSelectionChanged={(e) => console.log(e.filters)} style={{ height: 720 }} />

<PrismVisual model={model} type="line" fields={{ category: 'Date[MonthShort]', values: 'Total Sales' }} />
```

## Documentation

- [Getting started](https://prismbi-js.github.io/docs/getting-started.html)
- [Transforms: clean and reshape data](https://prismbi-js.github.io/docs/transforms.html)
- [Importing Power BI projects (.pbip)](https://prismbi-js.github.io/docs/powerbi.html)
- [Data modeling](https://prismbi-js.github.io/docs/data-model.html): tables, relationships, measures, calculated columns, date tables
- [Advanced modeling](https://prismbi-js.github.io/docs/advanced-modeling.html): relationships, calculation groups, parameters, hierarchies, RLS
- [Expressions (DAX) reference](https://prismbi-js.github.io/docs/expressions.html)
- [DAX tooling](https://prismbi-js.github.io/docs/tooling.html): language service, formatter, dependency explanation
- [Visuals reference](https://prismbi-js.github.io/docs/visuals.html): every visual, its data roles and format options
- [Slicing, filtering and interactions](https://prismbi-js.github.io/docs/interactions.html)
- [Theming and formatting](https://prismbi-js.github.io/docs/theming.html)
- [Studio (report editor)](https://prismbi-js.github.io/docs/studio.html)
- [React](https://prismbi-js.github.io/docs/react.html)
- [Custom visuals](https://prismbi-js.github.io/docs/custom-visuals.html)
- [AI: ask, explain, insights, agents](https://prismbi-js.github.io/docs/ai.html)
- [Web components, Vue, Svelte, Angular](https://prismbi-js.github.io/docs/frameworks.html)
- [Report files and version control](https://prismbi-js.github.io/docs/files.html)
- [Server: headless rendering, alerts, schedules](https://prismbi-js.github.io/docs/server.html)
- [Collaboration: co-editing, presence, comments](https://prismbi-js.github.io/docs/collab.html)
- [Plugins: signed visuals, themes, connectors](https://prismbi-js.github.io/docs/plugins.html)
- [Connectors and live data](https://prismbi-js.github.io/docs/connectors.html): zero-copy streaming CSV, REST, GraphQL, Arrow, SQL, streaming, scheduled refresh
- [SQL pushdown: DuckDB, Postgres, SQLite, MySQL, Snowflake, SQL Server, BigQuery](https://prismbi-js.github.io/docs/sql.html)
- [Performance and scale](https://prismbi-js.github.io/docs/performance.html): the fast query path, multi-worker pool, 64-bit group keys, rendering at scale, benchmarks
- [Architecture](https://github.com/prismbi-js/prismbi/blob/master/docs/ARCHITECTURE.md) · [Roadmap](https://github.com/prismbi-js/prismbi/blob/master/docs/ROADMAP.md) · [Contributing](https://github.com/prismbi-js/prismbi/blob/master/CONTRIBUTING.md)

## Develop

```bash
npm install
npm run dev        # demo dashboard at http://localhost:5173, studio at /studio.html, scale demo at /perf.html
npm test           # vitest (engine, DAX, formatting, rendering, interactions)
npm run typecheck
npm run bench      # 200k / 1M-row query timings
npm run build      # dist/ (ESM + CJS + .d.ts)
npm run docs       # docs site at /docs/ and the live playground at /playground.html
npm run docs:images  # regenerate the screenshots in docs/images (headless Chrome)
```

## License

MIT
