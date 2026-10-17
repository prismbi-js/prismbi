# Connectors and live data

`@prismbi/prismbi/connectors` loads data into a `DataModel` and keeps it fresh. It is about 3 KB min+gzip and has no dependencies. Every loader returns plain rows, so you can transform them before calling `addTable`.

```ts
import { DataModel } from '@prismbi/prismbi';
import { loadCsv, loadRest, scheduleRefresh, streamInto } from '@prismbi/prismbi/connectors';
import { periodStart } from '@prismbi/prismbi';

const model = new DataModel()
  .addTable('Sales', await loadCsv('/data/sales.csv'))
  .addTable('Customers', await loadRest('https://api.example.com/customers', { path: 'data', pagination: { type: 'cursor', next: 'meta.next', param: 'after' } }));
```

All network loaders accept `headers`, `signal` (an `AbortSignal`) and `fetch` (a custom implementation for tests, proxies or older runtimes). A response that isn't 2xx rejects with the status in the message.

## CSV

```ts
parseCsv(text, { delimiter?, header = true, dynamicTyping = true, skipEmptyLines = true, maxRows? }): Row[]
loadCsv(url, options): Promise<Row[]>
```

- RFC 4180: quoted fields, `""` escapes, delimiters and newlines inside quotes, CRLF or LF, byte-order mark.
- The delimiter is detected from the first line (`,` `;` tab `|`) unless you pass one.
- Types are decided per column, not per cell. A column becomes numeric only when every non-empty value is a plain number, so ZIP codes like `02134` stay text. `true`/`false` columns become booleans and empty cells become blank. ISO dates are typed by the table (`DataTable` infers `date` columns).
- Duplicate or empty headers are made unique (`a`, `a_2`, `Column3`). `header: false` names columns `Column1…n`.

### Google Sheets

```ts
const rows = await loadCsv(googleSheetCsvUrl('https://docs.google.com/spreadsheets/d/<id>/edit#gid=42'));
```

`googleSheetCsvUrl(sheetIdOrUrl, gid?)` builds the CSV export URL. The sheet must be shared "anyone with the link" or published to the web.

## JSON and REST

```ts
loadJson(url, { path? }): Promise<Row[]>
loadRest(url, { path?, params?, pagination?, maxPages = 1000, maxRows?, map? }): Promise<Row[]>
```

`path` is a dotted path to the rows in the response (`data.items`, `results.0.rows`). Rows can be an array of objects, an array of arrays whose first row is the header, or column arrays (`{ id: [...], name: [...] }`).

| `pagination.type` | Requests | Stops when |
|---|---|---|
| `page` | `?page=1`, `?page=2`, … (`param`, `start`, optional `size` sent as `sizeParam`) | a page is empty, or shorter than `size` |
| `offset` | `?offset=0&limit=100`, … (`param`, `limitParam`, `limit`) | a page is shorter than `limit` |
| `cursor` | reads the cursor at `next` in the body and sends it back as `param` | the cursor is empty |
| `link` | follows a URL at `next` in the body, or the `Link: <…>; rel="next"` header | there is no next link |

`map(record)` renames or flattens fields as rows arrive.

## GraphQL

```ts
const orders = await loadGraphQL('/graphql', 'query ($n: Int) { orders(first: $n) { nodes { id total placedAt } } }', {
  variables: { n: 500 },
  path: 'orders.nodes',
  headers: { authorization: `Bearer ${token}` },
});
```

GraphQL `errors` reject the promise with their messages joined.

## Apache Arrow, Parquet and DuckDB

`addArrowTable(model, name, arrowTable, schema?)` adds a table from anything shaped like an Apache Arrow `Table` (`numRows`, `schema.fields`, `getChild(name).get(i)`). PrismBI doesn't depend on `apache-arrow`. BigInts become numbers, `Date` and `Timestamp` columns become `Date`s, and structs and lists become JSON text. Existing tables are refreshed in place, so calculated columns are kept.

Parquet files load through anything that produces Arrow, for example DuckDB-Wasm:

```ts
const conn = await db.connect();
addArrowTable(model, 'Trips', await conn.query(`SELECT * FROM 'trips.parquet' WHERE year = 2025`));
```

## SQL

A `SqlAdapter` is one method, `query(sql, params?, signal?) => Promise<Row[]>`. Wrap a database driver behind your API, DuckDB-Wasm, or sql.js:

```ts
const duck: SqlAdapter = { query: async (sql) => (await conn.query(sql)).toArray().map((r) => r.toJSON()) };
await loadSqlTables(model, duck, [
  { table: 'Sales', sql: 'SELECT * FROM sales WHERE order_date >= ?', params: ['2024-01-01'] },
  { table: 'Products', sql: 'SELECT * FROM products' },
]);
```

Tables load in parallel. Tables that already exist are refreshed, keeping their calculated columns and relationships.

## Live data

### Appending rows

```ts
model.appendRows('Ticks', rows, { maxRows: 100_000 });
```

`appendRows` adds rows to a table and notifies reports once. `maxRows` keeps a sliding window by dropping the oldest rows.

- Calculated columns that only read their own row (`Sales[Qty] * Sales[Price]`, `IF`, `FORMAT`, `YEAR`, …) are computed for the new rows only.
- Calculated columns that aggregate (`SUM`, `CALCULATE`, `RANKX`, measures, `RELATED`, …), in this table or in any other, are recomputed in full. So are calculated tables.

### Streaming

```ts
const socket = new WebSocket('wss://example.com/ticks');
const live = streamInto(model, 'Ticks', socket, { maxRows: 50_000, intervalMs: 250 });
// later
live.close();
```

`streamInto(model, table, source, options)` listens to any message source: a `WebSocket`, an `EventSource`, a `BroadcastChannel` or a worker port.

- **Parsing:** each message is JSON-parsed when it is a string. It can be one row, an array of rows, `{ rows: [...] }` or column arrays. Pass `parse(data)` for other formats.
- **Batching:** rows are batched and appended every `intervalMs` (default 250), so a fast feed re-renders visuals at a steady rate instead of once per message.
- **Handle:** `onBatch` and `onError` report progress. The handle has `flush()`, `close()` (which also closes the source) and `received`.

### Scheduled refresh

```ts
const refresh = scheduleRefresh(model, 'Orders', (signal) => loadRest('/api/orders', { signal }), { intervalMs: 60_000 });
refresh.refresh(); // now
refresh.stop();
```

Options:

| Option | Default | Effect |
|---|---|---|
| `mode` | `'replace'` | Swap the table's rows on each refresh. `'append'` (with `maxRows`) adds them instead. `'incremental'` applies the table's refresh policy (below). |
| `immediate` | `true` | Load once straight away. |
| `pauseWhenHidden` | `true` | Skip ticks while the tab is hidden. |
| `onRefresh` / `onError` | none | Report each successful refresh or failure. |

A refresh that is still running when the next tick comes is not duplicated. Calling `refresh()` manually aborts the one in flight. `stop()` cancels everything.

### Incremental refresh

Large tables don't need a full reload. A refresh policy reloads only the recent periods and keeps the history, as in Power BI:

```ts
model.setRefreshPolicy('Sales', {
  column: 'OrderDate',
  refresh: { last: 3, unit: 'month' },  // this month and the two before are replaced on every refresh
  keep: { last: 5, unit: 'year' },      // optional: drop history older than five years
});

// load only the window from your source…
const since = periodStart(new Date(), 'month', 3);
const result = model.incrementalRefresh('Sales', await loadRest(`/api/sales?since=${since.toISOString()}`));
// { from, keepFrom, kept, replaced, added, ignored, dropped }

// …or on a schedule
scheduleRefresh(model, 'Sales', (signal) => loadRest('/api/sales?since=…', { signal }), { intervalMs: 300_000, mode: 'incremental' });
```

- **Units:** `day`, `week` (weeks start on Monday), `month`, `quarter` and `year`. Periods are local calendar periods, counting the current one.
- **Ignored rows:** incoming rows dated before the window are skipped, so a source that sends a little extra is harmless. Rows without a date count as history.
- **What else updates:** calculated columns and transform steps update as on a full refresh. The column formats are kept.
- **Saving:** the policy is saved in `model.toJSON().refreshPolicies`. `applyRefreshPolicy(existing, incoming, policy, now)` is the same merge as a pure function.
