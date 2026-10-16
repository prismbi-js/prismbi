# Architecture

PrismBI is five layers. Each one depends only on the layers below it, and each is usable on its own. For example, you can use the model and DAX engine on a server with no DOM.

```
┌──────────────────────────────────────────────────────────────┐
│ react/            <PrismReport>, <PrismVisual>                │  framework bindings
├──────────────────────────────────────────────────────────────┤
│ report/           Report · VisualHost · FilterPane · Tooltip  │  runtime & chrome
│                   cross-filter state, bookmarks, JSON, events │
├──────────────────────────────────────────────────────────────┤
│ visuals/          defineVisual registry · 34 built-ins        │  presentation
│ render/           svg/html helpers · scales · colour          │
├──────────────────────────────────────────────────────────────┤
│ data/query.ts     QuerySpec → QueryResult (group, sort, top)  │  query engine
│ dax/              lexer · parser · evaluator                  │  formula engine
├──────────────────────────────────────────────────────────────┤
│ data/             DataTable (columnar) · DataModel · filters  │  storage & model
└──────────────────────────────────────────────────────────────┘
```

## Source map

| Path | Responsibility |
|---|---|
| `src/data/types.ts` | `CellValue`, column refs (`'Table[Col]'`), value ordering and keys |
| `src/data/table.ts` | `DataTable`: column arrays, type inference and coercion, lazy hash index, sorted distinct values (sort-by aware) |
| `src/data/filters.ts` | Public `FilterSpec` → compiled `Filter`, cache keys, CALCULATE override rules |
| `src/data/model.ts` | `DataModel`: relationships, expanded tables, `rowsOf(table, ctx)` filter propagation, related lookups, row-set cache |
| `src/data/query.ts` | Field resolution (measures, implicit aggregations, expressions), auto-exist grouping, sorting, Top N, highlights, totals |
| `src/data/dates.ts` | Calendar table generator |
| `src/dax/parser.ts` | Tokenizer and recursive-descent parser for the DAX-like syntax, memoised |
| `src/dax/evaluator.ts` | Evaluator: filter and row context, context transition, CALCULATE modifiers, iterators, time intelligence, about 110 functions |
| `src/format/format.ts` | Power BI format strings, display units, date tokens |
| `src/theme/theme.ts` | Theme tokens, light and dark themes, Power BI theme import |
| `src/render/*` | SVG/HTML element helpers, bar and arc paths, text measurement, linear, band and point scales, colour math |
| `src/visuals/*` | Visual contract (`types.ts`), base format pane (`format.ts`), shared chart plumbing (`common.ts`), built-ins |
| `src/report/visualHost.ts` | One visual: chrome, query building from data roles, query cache, render context, drill, CSV |
| `src/report/report.ts` | Pages, grid layout, interaction state (selection, slicers, filters), bookmarks, theme, events, scheduling |
| `src/report/filterPane.ts` | Filter pane UI (Basic, Advanced, Top N) |
| `src/report/styles.ts` | The single injected stylesheet, driven by CSS variables |

## How a filter flows

1. **Sources of filters** for a visual V on page P:
   report filters + P's page filters + V's visual filters + the selection of every *other* slicer on P + the selection from another visual, when V's interaction mode is `filter`. When V's mode is `highlight`, the selection goes into `QuerySpec.highlight` instead.
2. `VisualHost.buildQuery()` maps data roles to a `QuerySpec`: grouping roles give `groupBy` and measure roles give `values`. For a drillable role, only the current level goes into `groupBy`, and the parent levels become `eq` filters.
3. `runQuery` finds the group combinations that exist under the filters ("auto-exist"). It starts from the most granular table that reaches every group column, which is usually the fact table. Each combination adds `eq` filters marked `origin: 'group'`, which `ALLSELECTED` can remove.
4. For every combination, the evaluator computes each value expression in that filter context.
5. `rowsOf(table, ctx)` resolves which rows are visible:
   - Filters on the table's own columns narrow it through hash-index lookups for `eq`/`in`, or a scan otherwise.
   - For every many-to-one relationship `table → dim` where a filter applies to `dim`'s expanded table, the visible dim rows are mapped to keys, and the keys are mapped back to fact rows through the foreign-key index.
   - Filters that span several related tables (tuple selections) are tested per row through related-value lookup.
   - Results are cached by `(table, context key)`.

### Relationship variants

- **Effective relationships:** `RelFilter` entries in the context (from `USERELATIONSHIP` / `CROSSFILTER`) are applied to the model's relationship list per evaluation. They are part of the context key, so caches stay correct.
- **Reach:** filters apply to a table when all their columns are in its *reach*. That means the tables whose filters flow into it: one → many always, and many → one for bidirectional relationships.
- **Bidirectional step:** a dimension is narrowed by the keys of fact rows visible under the *foreign* filters only (filters that apply to the fact but not already to the dimension). The dimension is "blocked" while computing that fact to prevent cycles.
- **Many-to-many** relationships propagate like any other, but are excluded from `expanded()` / `pathTo()`, so `RELATED` and auto-exist anchors never cross them.
- **Row-level security:** per-table row sets computed from role rules are appended to every `rowsOf` call, beneath the filter context, so `ALL()` can't remove them.

## Evaluation model

- **Filter context** is an array of compiled filters. `CALCULATE` builds a new context in this order: row context becomes filters (context transition), then removals (`ALL`, `REMOVEFILTERS`, `ALLEXCEPT`, `ALLSELECTED`) apply, then new filters override existing filters on the same columns, then `KEEPFILTERS` filters intersect.
- **Boolean filter arguments** such as `Products[Color] = "Red" || Products[Color] = "Blue"` are evaluated over the column's distinct values, like DAX's `FILTER(ALL(col), …)`, and become an `in` filter.
- **Row context** is a stack of bindings: a physical row, or a tuple from `VALUES`/`ALL(col)`. Column references read from the innermost binding. Many-side rows can read one-side columns (lenient `RELATED`).
- **Measures** run with context transition and are memoised by `(measure, context key)`. Any model change clears the cache.
- **Calculation groups:** when a measure is called and exactly one item of a group is visible, the item expression is evaluated instead, with `selectedMeasure` set and that group's filter removed. Groups are applied in precedence order and nest naturally.
- **Time intelligence** returns date tables tagged with their date table. Used inside `CALCULATE`, they clear the other filters on that table, so a `Date[Year] = 2025` grouping doesn't conflict with "same period last year". This is the behaviour of a Power BI table marked as a date table.

## Rendering model

- `Report.schedule(id?)` collects dirty visuals and renders them in one `requestAnimationFrame`. `flush()` renders synchronously (tests, SSR snapshots).
- Each `VisualHost` caches its last query by a key built from the serialised `QuerySpec` and the model version. A selection change re-queries only the visuals whose filters changed. The source visual just re-renders to dim unselected marks.
- Visuals receive a `RenderContext` containing their size, merged format, theme, data, role bindings, entity-stable colours, a formatter and the host API. They render into their root element and may return a cleanup function.
- **Colour follows the entity:** a category's colour is its index in the column's full domain, never its rank in the current result. Filtering never repaints the survivors. Past the palette, values use `theme.otherColor`, and pie, donut and treemap fold extra values into "Other".
- Styles are one injected stylesheet. Themes only set CSS custom properties on the report root, so switching themes needs no re-injection.

## Extending

- **New visual:** `registerVisual(defineVisual({ type, roles, render }))`. Optionally provide `buildQuery` (custom query), `supportsHighlight`, `isSlicer`, `defaultFormat` and `defaultSort`. See [custom-visuals.md](guide/custom-visuals.md).
- **New DAX function:** add a `case` in `Evaluator.call`. If it evaluates arguments in its own context, add its name to `CONTEXT_FUNCS`.
- **New filter operator:** extend `FilterOp` and `compileFilter`, then add a pane option in `filterPane.ts`.
