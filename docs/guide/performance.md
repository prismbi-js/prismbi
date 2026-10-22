# Performance and scale

PrismBI keeps everything in the browser. This guide covers how the engine handles large tables, what to expect at a million rows, and how to move work off the main thread.

Try it with `npm run dev`, then open `/perf.html`. That page generates 100k to 1M rows, prints cold query timings, and runs a simulated live feed into the model.

## What the engine does for you

- **Shared values.** A parser makes a new string or `Date` object per row. Tables keep one object per distinct text or date value instead (up to 100,000 per column, which covers anything but near-unique columns), including for appended rows. In Node, a million dates take about 8 MB instead of 120 MB, and a million repeated strings about 8 MB instead of 40 MB.
- **Columnar storage with typed views.** Each column is a plain array. On demand, the engine also builds a `Float64Array` view (numbers, dates as milliseconds) and a dictionary encoding (`Int32Array` codes + distinct values). Both are cached until the table changes.
- **Vectorised aggregations.** `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA` and `DISTINCTCOUNT` over a column run as tight loops over those views.
- **Single-pass grouped queries.** A visual whose measures are built from those aggregations, `COUNTROWS` and compiled `SUMX` / `AVERAGEX` (below) is answered in one pass over the fact rows. Measures may combine them with `+ - * /` and `DIVIDE`, reference other such measures, and wrap them in `CALCULATE` with column filters (`Product[Category] = "Bikes"`, `IN` lists, comparisons, `KEEPFILTERS`, nested filters). Each filter is evaluated once into a lookup over the column's dictionary codes, so it costs about two array reads per row; a `CALCULATE` measure grouped by product × country at 1M rows dropped from about 3.1 s to 0.26 s. This replaces evaluating every group separately. Group columns may be on the fact table or on dimensions reached through many-to-one relationships.
  - **Guards:** `IF(<comparison of such measures>, a, [b])` compiles too, so "only when there are sales" measures stay on the fast path.
  - **Iterators over a column's values** (`AVERAGEX(VALUES(Date[Date]), [Sales])`, `MAXX(VALUES(Product[Name]), …)`, and the other X functions) whose body compiles as above run as one grouped pass under the current filters instead of one context transition per value. On a real report, an average-per-day measure over 1,287 products went from 65 s to 0.5 s.
  - **Time intelligence** joins the single pass when the visual groups by columns of the date table: `CALCULATE(x, SAMEPERIODLASTYEAR(…))`, `DATEADD`, `DATESYTD` / `QTD` / `MTD` (with a fiscal year end), `PARALLELPERIOD`, `PREVIOUSMONTH` / `QUARTER` / `YEAR` and `TOTALYTD` / `QTD` / `MTD`, where `x` is built from the aggregations above (not `DISTINCTCOUNT`). One pass sums the fact rows per date; each group then adds up the dates its rule selects (period-to-date windows and parallel periods are ranges of the sorted dates), with the evaluator's own calendar rules, including the month-end rule of `DATEADD`. Plain measures in the same visual come from the same per-date sums. Groups come from the date table, as in the general engine, so a month without sales still shows last year's. Highlights, groupings outside the date table and bidirectional relationships use the general engine.
  - **Fallback:** anything else (other time-intelligence shapes, `CALCULATE` with `ALL` or table filters, `CALCULATE` filtering a column the query also groups or filters by, other iterators, calculation groups in play, `USERELATIONSHIP`, `includeEmpty`) uses the general engine, so results never change.
  - **When it applies:** in `'auto'` mode it is used for multi-column groupings, for single columns with more than 1,000 values, and whenever a value uses time intelligence. Below that, indexed per-group evaluation is already faster.
  - **Toggle:** use `setFastQuery('always' | 'off' | 'auto')` to compare the two paths.
- **Compiled row expressions.** Iterators (`SUMX`, `AVERAGEX`, `MINX`, `MAXX`, `COUNTX`, `RANKX`…) and calculated columns compile their row expression to a closure over the typed views when it only uses numbers, number columns of the iterated table, `RELATED` (or bare references) to number columns of related tables, unary minus, `+ - * /` and `DIVIDE`. BLANK handling matches the interpreter exactly. `SUMX(Sales, Sales[Quantity] * RELATED(Product[Price]))` over 300k rows drops from about 0.5 s to 40 ms. Anything else, such as measures, variables, text or dates in the row expression, runs in the interpreter, as does everything when `setFastQuery('off')` is set.
- **Relationship maps.** `RELATED`, cross-table filters and grouping by a dimension use a cached `Int32Array` from each fact row to its related row, built once per table pair from the foreign key's dictionary codes.
- **Per-dimension pre-aggregation.** Time intelligence and running totals evaluate the same measure once per day or period, each time with a different set of dates but otherwise identical filters. After a filter split repeats, the engine sums the fact column once per dimension row (per date, per product…). Each evaluation then adds up the visible rows' partials instead of scanning the fact table. This applies to `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT` and `COUNTA` through a direct many-to-one relationship with no bidirectional filtering, and only when the dimension filters leave at least 16 rows visible.
- **Bitmap indexes.** Low-cardinality columns of large tables (at most 512 values, at least 4,096 rows) also get one bitset per value. Filters on them combine with word-wide OR (within a filter) and AND (across filters and relationships) before row lists are built. At 1M rows, that is 2–4× faster for stacked filters such as channel × priority × country (`npm run bench`). `setBitmapIndexes(false)` turns them off.
- **Hash indexes and caches.** `eq`/`in` filters use column indexes. Visible row sets are cached per filter context and measure results per (measure, context). Visuals re-query only when their own filters change.
- **Streaming without rebuilds.** `appendRows` extends the numeric views, dictionaries, indexes and bitmaps for the new rows, and a `maxRows` window shifts them, instead of rebuilding them from scratch. The change notification names the tables whose rows changed (`model.onChange((change) => change?.tables)`), and reports re-query only the visuals that can see those tables. A visual can see a table when its fields, filters, format or measures reference it (directly, or through other measures or calculation items), or when it is connected to one of those through a relationship. Definition changes, and any change while row-level security is active, still refresh every visual.
- **Numeric group keys.** Multi-column groupings key their groups by a mixed-radix number over the column dictionaries, with a dense lookup table for up to 4M combinations, instead of building a string per row.

## Numbers

`npm run bench` generates a star schema and times each query cold, with caches cleared before each run. The schema is a fact table, 400 products, 40 regions and a two-year calendar. The query filters to one year, about half the rows. Timings are from Node 18 on a laptop:

| Query | 200k rows | 1M rows |
|---|---|---|
| Category × sales and average order value (12 groups) | 47 ms | 191 ms |
| Product × region, 16k groups | 58 ms (per-group engine: 11.3 s) | 99 ms |
| Day × sales, 365 groups | 8 ms | 12 ms |
| Product × region, `CALCULATE` filter | 27 ms (per-group engine: 11.6 s) | 79 ms |
| Day × YTD (time intelligence) | 15 ms (per-group engine: 0.65 s) | 21 ms (was 193 ms) |
| Year × month × sales, last year and growth | 17 ms (per-group engine: 47 ms) | 46 ms |

Each query has a time budget in `bench/scale.test.ts` (about three times these figures), so `npm run bench` fails on a real regression.

Generating and loading 1M rows takes about 0.75 s. Warm queries (same filters again) come from the caches in well under a millisecond.

Pre-aggregated results can differ from a row-by-row scan in the last floating-point digits, because the same values are added in a different order. Displayed values are unaffected.

Compare the two paths yourself; they return the same rows:

```js playground
import { setFastQuery } from '@prismbi/prismbi';

const spec = { groupBy: ['Date[Year]', 'Date[MonthNumber]'], values: ['Total Sales', 'Sales LY', 'Sales YTD'], totals: true };
const run = (mode) => {
  setFastQuery(mode);
  const t = performance.now();
  const r = model.query(spec);
  return { ms: Math.round(performance.now() - t), rows: r.rows.length, first: r.rows[0] };
};
const result = { singlePass: run('always'), perGroup: run('off') };
setFastQuery('auto');
return result;
```

## Rendering at scale

![The scale demo: 250,000 rows, a dense line chart, 8,000 scatter points and a virtualized table](../images/performance.png)

- **Lines and areas** with more points than about two per pixel are thinned with Largest-Triangle-Three-Buckets for drawing. Peaks and gaps survive. The crosshair and tooltips still read every point. Stacked areas are drawn in full so the layers meet.
- **Scatter charts** with more than 3,000 points paint on a canvas laid over the SVG axes. A spatial grid finds the point under the pointer, so tooltips, click to select and cross-filter, the context menu and drill keep working. From 50,000 points they draw with WebGL (one draw call of anti-aliased point sprites) when the browser supports it, falling back to canvas. Without canvas support, for example in SSR or jsdom, they fall back to SVG. `format.scatter.renderer: 'auto' | 'svg' | 'canvas' | 'webgl'` forces one. Image exports embed the canvas pixels.
- **Off-screen visuals** wait. When filters, selections or data change, visuals more than 300 px outside the viewport skip their re-render until they are scrolled into view (an `IntersectionObserver`). `report.flush()` and exports still render everything.
- **Tables** with more than 500 rows render only the rows in view, plus a margin, between spacer rows. Sorting, selection and banding behave as before. `format.table.virtualize` forces windowing on or off, and wrapping text turns it off because rows then vary in height.
- **Matrices** window their visible rows the same way once more than 500 are expanded; parent rows carrying subtotals count as rows. Expanding or collapsing keeps the scroll position. `format.matrix.virtualize` forces it on or off.
- **Heatmaps and calendars** with more than 3,000 cells paint on a canvas and find the cell under the pointer from its row and column, with the same tooltips, selection, context menu and drill. `format.heatmap.renderer` / `format.calendar.renderer`: `'auto' | 'svg' | 'canvas'`. They fall back to SVG without canvas support.

## Off the main thread

`@prismbi/prismbi/worker` (about 2 KB) runs the model in a Web Worker. Build or load the model inside the worker, then talk to it from the page:

```ts
// model.worker.ts
import { serveModel } from '@prismbi/prismbi/worker';
import { loadCsv } from '@prismbi/prismbi/connectors';
import { DataModel } from '@prismbi/prismbi/core';

const model = new DataModel().addTable('Sales', await loadCsv('/sales.csv')).addMeasure('Total', 'SUM(Sales[Amount])');
serveModel(model);
```

```ts
// main thread
import { createWorkerEngine } from '@prismbi/prismbi/worker';

const engine = createWorkerEngine(new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' }));
const ctrl = new AbortController();
const result = await engine.query({ groupBy: ['Sales[Region]'], values: ['Total'] }, ctrl.signal);
```

The engine API is asynchronous, and every method returns a promise:

| Method | Does |
|---|---|
| `query(spec, signal?)` | Runs a `QuerySpec` and returns rows and totals. |
| `evaluate(expression, filters?, signal?)` | Evaluates a scalar expression. |
| `evaluateTable(expression, filters?, signal?)` | Evaluates a table expression (DAX `EVALUATE`). |
| `addTable(name, rows, schema?)`, `refreshTable(...)`, `appendRows(name, rows, options?)` | Changes table data. |
| `addColumns(name, columns, schema?, { transfer? })` | Adds a table from column arrays, moving numbers, dates and text codes to the worker as transferred buffers (see below). |
| `addMeasure(def)` | Adds a measure. |
| `setRoles(roles, options?)` | Switches row-level security roles. |
| `metadata()` | Returns tables, columns, measures and relationships, without rows. |
| `dispose()` | Stops the engine and terminates the worker. |

Filters must be filter specs (`{ target, op, value }`), because compiled filters can't be copied to another thread. Requests run in order. Aborting a request rejects it at once with an `AbortError`, and the worker skips it if it hasn't started.

`createLocalEngine(model)` has the same API on the current thread, for tests, server rendering or small models.

**Large tables: send columns, not rows.** `addTable` copies every row object to the worker (structured clone). `addColumns` packs number and date columns as `Float64Array`s and text as `Int32Array` codes plus a dictionary, and *transfers* the buffers, so nothing is copied; the worker adopts them as the table's numeric and dictionary views, which also makes the first query faster. In Node, loading 1M rows of four columns over a `MessageChannel` took about 1.2 s instead of 11.5 s, and the first grouped query about 250 ms instead of 600 ms.

```ts
await engine.addColumns('Sales', {
  Amount: amounts,            // Float64Array or number[]
  Region: regions,            // string[] → codes + dictionary
  OrderDate: dates,           // Date[] → epoch ms
});
```

Typed arrays you pass are moved, and are empty afterwards; pass `{ transfer: false }` to send a copy instead. Arrays backed by a `SharedArrayBuffer` (available when the page is `crossOriginIsolated`) are shared rather than moved. `packColumn` and `addPackedTable` are exported for building the same tables yourself.

### Reports on the worker

Pass the engine to a report and every visual query runs in the worker:

```ts
const report = new Report(el, { model, engine, pages });
```

Visuals render asynchronously. On first load a visual shows a shimmer. After that, a re-query keeps the previous result on screen, dimmed, until the new one arrives, and superseded queries are cancelled.

Slicers and queries without measures still run on `model` on the page, so slicer tiles appear instantly. The page also uses `model` for metadata: field lists, slicer domains, colours.

Keep the two models in step. Build both from the same code, and apply live rows to both: `model.appendRows(...)` plus `engine.appendRows(...)`. The `/perf.html` demo has a "Queries in a Web Worker" switch that does exactly this.

## Tips

- Keep fact tables narrow and put descriptive text on dimensions. Group by dimension columns and let relationships do the work.
- Prefer measures built from the vectorised aggregations, such as `DIVIDE([Sales], [Orders])`, over `SUMX` row iterators when the result is the same.
- For live feeds, use `streamInto(…, { maxRows, intervalMs })`. The sliding window bounds memory, and batching bounds re-renders.
- Calculated columns that read only their own row are cheap to maintain under `appendRows`. Ones that aggregate are recomputed on every append.
