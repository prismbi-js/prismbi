# Changelog

## 0.2.0 (unreleased): Phase 2, part 1

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
