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

## What isn't

These throw a `SqlUnsupportedError` that names the cause:

- Time intelligence (`SAMEPERIODLASTYEAR`, `TOTALYTD`…), `ALL` / `ALLSELECTED` / `REMOVEFILTERS`, and `FILTER` tables.
- A `CALCULATE` filter on a column that the query also filters or groups by. DAX replaces that filter, which SQL can't express; wrap it in `KEEPFILTERS` to intersect instead.
- Measures that aggregate several tables, or a dimension aggregated across the fact (DAX filters don't flow that way).
- Row-level security roles and compiled row-set filters.

`fallback: 'model'` answers those queries from the in-memory model instead. That only helps if the model holds the rows it needs, e.g. a summary table.

## Dates

Dates are calendar dates. Literals are written from the local date (`DATE '2025-03-01'`, or `'2025-03-01'` for SQLite). `DATE` values that come back, whether as ISO strings, epoch days or UTC-midnight timestamps, become local-midnight `Date`s, the way the model creates them.
