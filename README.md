# PrismBI

**Power BI-style data modeling and interactive reports for the web, written in TypeScript.**

PrismBI gives you a semantic model with relationships, a DAX-like formula engine, 34 interactive visuals, slicers, cross-filtering, drill down and drill-through, a filter pane, bookmarks and themes. It has zero dependencies: about 52 KB min+gzip for the core, about 66 KB for a typical dashboard, and about 82 KB with every visual. It runs in any framework and has first-class React bindings.

```bash
npm install prismbi
```

```ts
import { DataModel, Report } from 'prismbi';

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
| **Real BI semantics** | Filter context, row context, context transition, `CALCULATE` with `ALL`, `ALLEXCEPT`, `ALLSELECTED`, `KEEPFILTERS`, `USERELATIONSHIP` and `CROSSFILTER`, time intelligence, table functions, auto-exist grouping, and true (non-additive) totals. About 160 DAX functions |
| **Advanced modeling** | Bidirectional, many-to-many and inactive relationships, calculated tables, calculation groups, field and what-if parameters, hierarchies, perspectives, row-level security |
| **Developer tooling** | DAX language service (completion, hover, diagnostics, signature help), formatter, dependency explanation, `evaluateTable()` queries |
| **Slice and narrow down** | Slicers (list, dropdown, tiles, range, relative date, hierarchy tree, synced across pages), cross-filter and cross-highlight, Ctrl+click multi-select, right-click Include / Exclude, drill down / up / expand all, drill-through pages with Back, a decomposition tree, report, page and visual filters, a filter pane with Basic, Advanced and Top N, bookmarks |
| **34 visuals** | Column and bar (clustered, stacked, 100%), line, area, stacked area, combo, ribbon, waterfall, pie, donut, treemap, funnel, scatter and bubble, histogram, box plot, bullet, radar, sankey, heatmap, bubble and filled maps, decomposition tree, card, multi-row card, KPI, gauge, table, matrix, slicer, text, and small multiples for cartesian charts |
| **Light and fast** | Zero dependencies, columnar engine with hash indexes and caches, `requestAnimationFrame`-batched rendering. Typical queries on 30k rows: under 40 ms cold, under 1 ms warm |
| **Analytics** | Continuous time and number axes, log scales, reference lines (constant, average, median, min, max, percentile), trend lines, rule- and gradient-based colours, report-page tooltips, real totals |
| **Customizable** | Theme tokens and CSS variables, Power BI theme JSON import, per-visual format panes, theme `visualStyles`, custom tooltips, custom visuals, PNG/SVG/CSV/PDF export, edit-interactions mode |
| **Accessible** | Keyboard-reachable marks, ARIA roles, legends whenever there are two or more series, show-as-table on every chart, reduced motion, light and dark palettes validated for colour-vision deficiency |

## Lean builds

```ts
import { Report, DataModel, registerVisual } from 'prismbi/core';
import { clusteredColumn, lineChart, card, slicer, table } from 'prismbi/visuals';
[clusteredColumn, lineChart, card, slicer, table].forEach((v) => registerVisual(v));
```

## React

```tsx
import { PrismReport, PrismVisual } from 'prismbi/react';

<PrismReport model={model} definition={reportJson} theme="dark"
  onSelectionChanged={(e) => console.log(e.filters)} style={{ height: 720 }} />

<PrismVisual model={model} type="line" fields={{ category: 'Date[MonthShort]', values: 'Total Sales' }} />
```

## Documentation

- [Getting started](docs/guide/getting-started.md)
- [Data modeling](docs/guide/data-model.md): tables, relationships, measures, calculated columns, date tables
- [Advanced modeling](docs/guide/advanced-modeling.md): relationships, calculation groups, parameters, hierarchies, RLS
- [Expressions (DAX) reference](docs/guide/expressions.md)
- [DAX tooling](docs/guide/tooling.md): language service, formatter, dependency explanation
- [Visuals reference](docs/guide/visuals.md): every visual, its data roles and format options
- [Slicing, filtering and interactions](docs/guide/interactions.md)
- [Theming and formatting](docs/guide/theming.md)
- [React](docs/guide/react.md)
- [Custom visuals](docs/guide/custom-visuals.md)
- [Architecture](docs/ARCHITECTURE.md) · [Roadmap](docs/ROADMAP.md) · [Contributing](CONTRIBUTING.md)

## Develop

```bash
npm install
npm run dev        # demo dashboard at http://localhost:5173 (examples/)
npm test           # vitest (engine, DAX, formatting, rendering, interactions)
npm run typecheck
npm run build      # dist/ (ESM + CJS + .d.ts)
```

## License

MIT
