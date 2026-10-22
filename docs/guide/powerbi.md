# Importing Power BI projects

`@prismbi/prismbi/powerbi` reads a Power BI project saved as `.pbip` and turns it into a PrismBI model and report. To get one, use **File › Save as › Power BI project** in Power BI Desktop.

```ts
import { importPowerBI } from '@prismbi/prismbi/powerbi';
import { loadCsv } from '@prismbi/prismbi/connectors';

const { model, report, warnings } = importPowerBI(files, {
  data: { Sales: await loadCsv('/data/sales.csv'), Product: await loadCsv('/data/product.csv') },
});
new Report(el, { model, ...report });
console.warn(warnings); // everything that could not be imported, in plain language
```

`files` maps paths inside the project folder to their text, for example `{ 'Shop.SemanticModel/definition/tables/Sales.tmdl': '…', 'Shop.Report/definition/pages/…/visual.json': '…' }`. In Node, read the folder recursively; in a browser, use a folder picker.

## What comes across

| Part | Imported |
|---|---|
| Semantic model (TMDL, or `model.bim` in older projects) | tables and typed columns, hidden flags, formats, display folders, descriptions; calculated columns and calculated tables; measures (single-line, multi-line and fenced DAX); relationships (active or inactive, single or both directions); calculation groups with their items, ordinals, precedence and format strings (static or dynamic); field parameters (as PrismBI field parameters); auto date/time tables and the fields that use them; aggregation tables (`alternateOf` mappings: group by, sum, min, max, count) |
| Report (PBIR folder format, or legacy `report.json`) | pages in order, hidden pages, visuals with their fields, titles and positions (converted to the 12-column grid) |
| Visuals | column, bar and 100% variants, line, area, stacked area, combo, ribbon, waterfall, pie, donut, treemap, funnel, scatter, card, multi-row card, KPI, gauge, table, matrix, slicer, map, filled map, decomposition tree, text box |

- **Data:** projects don't contain rows. Pass rows per table in `data`, keyed by the model's column names (after Power Query's renames), from CSV, REST, SQL or any connector. Tables without data are created empty with their typed columns, so the model and report still load.
- **Date tables built in Power Query** have no rows either. When a date table's key is the target of relationships from other tables' dates, the importer fills that key with every day of the years those dates cover, so relationships and time intelligence work; its other columns stay blank (a warning lists them) until you pass rows. `dateTables: false` turns this off.
- **Not imported:**
  - Power Query (M) steps; rebuild them as [transforms](transforms.md) if needed
  - visual formatting beyond titles, bookmarks and filters
  - custom visuals
  - DAX functions PrismBI doesn't support
- **Warnings:** each gap appears in `warnings`. Measures with unsupported functions are still added so you can fix them.

## Command line

```bash
npx @prismbi/prismbi pbip ./Shop report.json
# 2 tables, 4 measures, 1 relationships, 3 pages, 11 visuals → report.json
#   ! Visual "a1b2" of type someCustomVisual is not supported and was skipped
```

The command converts the report and prints a compatibility summary. It's a quick way to check how much of a project PrismBI can run.

## Lower-level pieces

- **`parseTmdl(texts)` and `parseModelBim(json)`:** return the semantic model as plain objects (`PbiModel`).
- **`buildModelFrom(pbiModel, { data, model })`:** builds or extends a `DataModel`.
- **`mapPbirReport(files)` and `mapLegacyReport(json)`:** return a `ReportDefinition`.
