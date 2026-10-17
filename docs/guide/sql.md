# SQL pushdown: DuckDB, Postgres and SQLite

`@prismbi/prismbi/sql` translates visual queries into SQL and runs them in a database. Large fact tables stay in DuckDB (DuckDB-Wasm in the browser, or DuckDB, Postgres or SQLite on a server) instead of being loaded into memory. The report doesn't change: pass the engine as `ReportOptions.engine`.

```ts
import * as duckdb from '@duckdb/duckdb-wasm';
import { DataModel, Report } from '@prismbi/prismbi';
import { sqlEngine, duckdbRunner } from '@prismbi/prismbi/sql';

// the model keeps the schema, relationships and measures; dimensions can keep their rows (slicers read them)
const model = new DataModel()
  .addTable('Sales', [], { OrderDate: { type: 'date' }, ProductKey: { type: 'number' }, SalesAmount: { type: 'number' }, OrderNumber: { type: 'string' } })
  .addTable('Product', products)
  .addDateTable('Date', '2020-01-01', '2026-12-31')
  .addRelationship({ from: 'Sales[ProductKey]', to: 'Product[ProductKey]' })
  .addRelationship({ from: 'Sales[OrderDate]', to: 'Date[Date]' })
  .addMeasure('Total Sales', 'SUM(Sales[SalesAmount])', { format: '$#,0' })
  .addMeasure('Orders', 'DISTINCTCOUNT(Sales[OrderNumber])');

const conn = await db.connect(); // an AsyncDuckDB with the tables loaded (Parquet, CSV, Arrow…)
const engine = sqlEngine(model, { run: duckdbRunner(conn) });
new Report(el, { model, engine, pages });
```

- **Other databases:** `run` is any `(sql, signal) => Promise<rows>`, so you can send the SQL to your own server for Postgres, DuckDB or SQLite. Set `dialect: 'postgres' | 'sqlite'` (default `'duckdb'`).
- **Different names:** `tables` maps model tables to SQL tables or views (`{ Sales: 'analytics.fact_sales' }`). `columns` maps column names per table (`{ Sales: { SalesAmount: 'amount' } }`).
- **Logging:** `onSql` sees every statement. `engine.toSql(spec)` and `toSql(model, spec, opts)` return the SQL without running it.

## What is pushed down

| Part of the query | SQL |
|---|---|
| Grouping columns, on the fact table or along many-to-one relationships | `LEFT JOIN`s from the fact table, `GROUP BY` |
| Filters: `eq`, `in`, `notIn`, comparisons, `between`, text matching, blanks, multi-column `tuples` | `WHERE` (blank-aware like the in-memory engine) |
| Top N filters | an `IN (SELECT … ORDER BY … LIMIT n)` subquery |
| `orderBy`, `top`, `limit`, sort-by columns (month names in calendar order) | `ORDER BY … NULLS LAST`, `LIMIT` |
| `totals`, `highlight` | extra statements, run in parallel |
| Visual calculations | applied to the SQL result, as in memory |
| `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `DISTINCTCOUNT`, `COUNTROWS(fact)`, `MEDIAN` (DuckDB) | aggregates; empty counts are blank, as in DAX |
| `SUMX`, `AVERAGEX`, `MINX`, `MAXX` over the fact table, with arithmetic and `RELATED` | aggregates of row expressions |
| Measure references, `VAR`, arithmetic (BLANK + 5 = 5), `DIVIDE`, `IF`, `ISBLANK`, `COALESCE`, `ABS`, `ROUND`, comparisons | inlined expressions |
| `CALCULATE` with column comparisons and `IN` lists (and `KEEPFILTERS`) | `FILTER (WHERE …)` on the aggregates |
| Calculated columns with row arithmetic (e.g. `Sales[Amount] - Sales[Cost]`) | inlined; map others (and date columns) to real database columns in `columns` |

## Filter-context mode

Queries that a single `GROUP BY` can't answer switch to filter-context mode automatically (`toSql(...).mode` says which one ran). Each aggregate becomes a correlated subquery over its own table, carrying the DAX filter context at that point:

| DAX | In filter-context mode |
|---|---|
| `CALCULATE` filters that replace a filter the query also uses (and `KEEPFILTERS` to intersect) | the column's filter is replaced |
| `ALL`, `REMOVEFILTERS`, `ALLSELECTED`, `ALLEXCEPT` | filters removed or restored to the query's own |
| `FILTER(ALL(Date[Date]), Date[Date] <= MAX(Date[Date]))` and other row conditions | row predicates; aggregates inside see the outer context |
| `SAMEPERIODLASTYEAR`, `DATEADD`, `DATESYTD` / `QTD` / `MTD`, `TOTALYTD` / `QTD` / `MTD`, `PREVIOUSYEAR` / `QUARTER` / `MONTH`, `DATESBETWEEN` | date ranges derived from the dates in context, with DAX month-end handling (Feb 28, 2025 a year back covers Feb 29, 2024) |
| A dimension measure by another dimension (`MAX(Product[ListPrice])` by region), `COUNTROWS(Product)`, `COUNTROWS(FILTER(...))`, iterators over `FILTER` | evaluated over their own table, with only the filters that reach it (single-direction relationships) |

Filters reach a table only along its many-to-one relationships, as in DAX. Group combinations follow the in-memory engine: one dimension lists its values, several list the combinations present in the fact table. Results are checked against the in-memory engine on SQLite in the tests. DuckDB and Postgres decorrelate these subqueries well; SQLite is slower, but contiguous date contexts (years, months, ranges) use range checks.

### Still not pushed down

These throw a `SqlUnsupportedError` that names the cause:

- `USERELATIONSHIP`, `CROSSFILTER` and bidirectional filtering.
- Measures inside `FILTER` conditions (they need a context transition per row).
- Row-level security roles and compiled row-set filters.
- `MEDIAN` outside DuckDB, and DAX functions without an SQL equivalent.

`fallback: 'model'` answers those queries from the in-memory model instead. That only helps if the model holds the rows it needs, e.g. a summary table.

## Dates

Dates are calendar dates. Literals are written from the local date (`DATE '2025-03-01'`, or `'2025-03-01'` for SQLite). `DATE` values that come back, whether as ISO strings, epoch days or UTC-midnight timestamps, become local-midnight `Date`s, the way the model creates them.

## Try it

See the SQL a visual query becomes:

```js playground
import { toSql } from '@prismbi/prismbi/sql';

return toSql(model, {
  groupBy: ['Product[Category]'],
  values: ['Total Sales', 'Orders'],
  filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }],
  orderBy: [{ field: 'Total Sales', direction: 'desc' }],
  top: 3,
}).sql;
```

On the docs site (`npm run docs`), **▶ Run in playground** opens it in an editor next to its output.
