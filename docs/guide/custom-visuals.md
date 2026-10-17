# Custom visuals

A visual is a plain object: its data roles plus a `render` function. PrismBI runs the query, works out the filters, cross-filtering and highlighting, and handles the chrome (title, header, focus mode, CSV export, show as table).

```ts
import { defineVisual, registerVisual, svg as s, linearScale, bandScale, chart } from '@prismbi/prismbi';

registerVisual(defineVisual({
  type: 'lollipop',
  displayName: 'Lollipop chart',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'Category', kind: 'grouping', required: true, drillable: true, multiple: true },
    { name: 'values', displayName: 'Value', kind: 'measure', required: true },
  ],
  supportsHighlight: false,
  defaultSort: 'value',
  defaultFormat: { dataLabels: { show: true } },

  render(ctx) {
    const pv = chart.pivot(ctx);               // categories × series, entity-stable colours
    if (!pv.categories.length) return chart.emptyState(ctx);
    const [series] = pv.series;
    const { width, height } = ctx;
    const x = bandScale(pv.categories.length, [40, width - 8]);
    const y = linearScale(0, Math.max(...series.values.map((v) => v ?? 0)), [height - 24, 8]);
    const root = s('svg', { width, height, class: 'pbi-svg' });

    pv.categories.forEach((cat, i) => {
      const v = series.values[i];
      if (v === null) return;
      const cx = x(i) + x.bandwidth / 2;
      root.append(s('line', { x1: cx, x2: cx, y1: y(0), y2: y(v), stroke: ctx.theme.axis, 'stroke-width': 2 }));
      const dot = s('circle', { cx, cy: y(v), r: 6, fill: series.color, stroke: ctx.theme.surface, 'stroke-width': 2,
        opacity: chart.markOpacity(ctx, cat.identity) });
      // click to cross-filter, hover tooltip, keyboard access – one call
      chart.interactive(ctx, dot, cat.identity, () => ({ title: cat.label, items: [{ label: series.name, value: ctx.fmt(series.field, v) }] }), cat.keys);
      root.append(dot);
    });
    ctx.root.replaceChildren(root);
  },
}));
```

Use it like any built-in: `{ type: 'lollipop', fields: { category: 'Products[Name]', values: 'Total Sales' } }`.

## The contract

### `VisualDefinition`

| Field | Meaning |
|---|---|
| `type`, `displayName`, `category` | Identity |
| `roles` | Data wells. `kind`: `grouping` → `groupBy`, `measure` → `values`, `any` → handled by your own `buildQuery`. `drillable` + `multiple` makes the role a drill hierarchy |
| `supportsHighlight` | Receive cross-highlights (`row.highlights`) instead of being filtered |
| `isSlicer` | Contributes filters with `host.setFilter()` and is not filtered by itself |
| `static` | Needs no data |
| `defaultFormat` | Format defaults merged under the theme and spec |
| `defaultSort` | `'value'` (first value, descending) or `'key'` |
| `buildQuery(ctx, base)` | Optional: return a custom `QuerySpec` (e.g. add `totals: true`) |
| `render(ctx)` | Draw into `ctx.root`. May return a cleanup function |

### `RenderContext`

| Member | Meaning |
|---|---|
| `root`, `width`, `height` | Target element and its size (re-rendered on resize) |
| `data` | `QueryResult`: `groups`, `values`, `rows[{ keys, values, highlights? }]`, `totals`, `baseFilters` |
| `role(name)` | `{ kind, indices, fields }`: where a role's fields sit in `data` |
| `format`, `theme`, `spec`, `model` | Merged format pane, theme tokens, the spec and the model (for extra queries) |
| `colorFor(field, value)`, `seriesColor(name, i)` | Entity-stable colours that honour `format.colors` |
| `fmt(field, value, opts?)` | Format with the field's format string and display units |
| `animate` | True when the data changed (not for a selection-only re-render) |
| `host` | `select`, `isSelected`, `showTooltip`, `hideTooltip`, `setFilter`, `currentFilter`, `domain`, `drillDown`, `drillUp`, `drill`, `state`, `setState`, `emit`, `rerender` |

### Helpers (exported)

- `svg(tag, attrs)` (`s`) and `html(tag, attrs, ...children)` (`h`)
- `barPath`, `arcPath`, `measureText`, `fitText`
- `linearScale`, `bandScale`, `pointScale`, `niceStep`
- `mix`, `ramp`, `textOn`, `contrastRatio`, `withAlpha`
- `chart.*`: `pivot`, `renderLegend`, `withLegend`, `emptyState`, `interactive`, `markOpacity`, `drawValueAxisY/X`, `categoryLabelLayout`, `drawCategoryLabels`, `tooltipItems`, `labelFormatter`, `valueAxisFormatter`, `animateIn`

### Tips

- Respect `format.tooltip.show`, `format.dataLabels`, `format.legend` and `format.colors`, so users can customise your visual like a built-in.
- Use theme tokens for every colour (`ctx.theme.foregroundSecondary` for text, never the series colour), so dark mode works.
- Keep marks keyboard-accessible: `chart.interactive` adds `tabindex` and Enter/Space selection.
