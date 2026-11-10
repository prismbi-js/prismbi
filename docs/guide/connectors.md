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
parseCsvColumns(text, options): { columns, schema, rowCount }
loadCsvColumns(url, options): Promise<{ columns, schema, rowCount }>
streamCsv(urlOrStream, { batchSize = 5000, onBatch, ...options }): Promise<StreamCsvResult>
streamCsvUrl(url, options): Promise<StreamCsvResult>
```

- RFC 4180: quoted fields, `""` escapes, delimiters and newlines inside quotes, CRLF or LF, byte-order mark.
- The delimiter is detected from the first line (`,` `;` tab `|`) unless you pass one.
- **Columnar & Streaming Ingestion:** `parseCsvColumns` and `loadCsvColumns` parse directly into columnar arrays without intermediate row objects, feeding directly into `DataModel.addColumns`. `streamCsv` and `streamCsvUrl` stream large CSVs in progressive chunks with `onBatch` callbacks.
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

`addArrowTable(model, name, arrowTable, schema?)` adds a table from anything shaped like an Apache Arrow `Table` (`numRows`, `schema.fields`, `getChild(name).get(i)`). PrismBI doesn't depend on `apache-arrow`. BigInts become numbers, `Date` and `Timestamp` columns become `Date`s, and structs and lists become JSON text. Existing tables are refreshed in place using columnar data (`DataModel.refreshColumns`), so calculated columns are preserved with zero row-object allocation overhead.

Parquet files load directly through DuckDB-Wasm with `loadDuckDbTable` or `loadDuckDbTables`:

```ts
import { loadDuckDbTable, loadDuckDbTables } from '@prismbi/prismbi/connectors';

const conn = await db.connect();

// Direct Parquet ingestion (executes read_parquet)
await loadDuckDbTable(model, conn, { table: 'Trips', parquet: 'trips.parquet' });

// Or ingest query results across multiple tables in parallel
await loadDuckDbTables(model, conn, [
  { table: 'Sales', query: 'SELECT * FROM sales WHERE year = 2025' },
  { table: 'Products', parquet: 's3://bucket/products.parquet' },
]);
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

## Warm start: cache loaded tables

Large CSV or API loads can be kept in the browser, so the next visit restores the tables from IndexedDB instead of fetching and parsing them again:

```ts
import { cachedTables, loadCsv } from '@prismbi/prismbi/connectors';

const from = await cachedTables(model, 'sales', async () => {
  model.addTable('Sales', await loadCsv('/data/sales.csv'));
}, { version: DATA_VERSION, maxAgeMs: 24 * 3600_000 });
// 'cache' or 'loaded'; then model the tables as usual
model.addRelationship({ from: 'Sales[ProductKey]', to: 'Product[ProductKey]' }).addMeasure('Total Sales', 'SUM(Sales[Amount])');
```

- **What is stored:** the tables `load` added (or `tables`), as packed typed columns: numbers and dates as `Float64Array`s, text as dictionary codes, plus each column's type, format, sort-by and folder. Calculated columns, relationships and measures are not stored; define them after the call, as on a first visit. Restored tables start with their numeric and dictionary views already built.
- **Invalidation:** `version` (a deploy id, an ETag) and `maxAgeMs` make an old copy a miss; `clearCachedTables(key)` drops it.
- **Lower level:** `saveTables(model, key, options)` and `loadTables(model, key, options)` (`null` on a miss).
- **Storage:** IndexedDB by default (`idbStore(dbName?, storeName?)`). Pass `store` with `get` / `set` / `delete` to use something else. Storage errors (private mode, quota) count as a miss and never fail the load.

In Chrome, 50,000 rows of four columns restore in about 65 ms.

## Live data

### Appending rows

```ts
model.appendRows('Ticks', rows, { maxRows: 100_000 });
```

`appendRows` adds rows to a table and notifies reports once. `maxRows` keeps a sliding window by dropping the oldest rows. Indexes and caches are extended rather than rebuilt, and only the visuals that read the changed table re-query.

- Calculated columns that only read their own row (`Sales[Qty] * Sales[Price]`, `IF`, `FORMAT`, `YEAR`, …) are computed for the new rows only.
- Calculated columns that aggregate (`SUM`, `CALCULATE`, `RANKX`, measures, `RELATED`, …), in this table or in any other, are recomputed in full. So are calculated tables.

### Streaming

```ts
import { streamInto } from '@prismbi/prismbi/connectors';

// Connect directly via WebSocket or EventSource URL:
const live = streamInto(report, 'Ticks', 'wss://example.com/ticks', {
  maxRows: 50_000,
  intervalMs: 250,
  reconnect: { delayMs: 1000, backoffMultiplier: 1.5, maxRetries: 10 },
  transform: (row) => (row.price <= 0 ? null : { ...row, price: Math.round(row.price * 100) / 100 }),
  onStateChange: (state) => console.log('Stream status:', state),
  onBatch: (rows) => console.log(`Ingested ${rows.length} rows`),
});

// Or connect to an existing message source instance (WebSocket, EventSource, BroadcastChannel, Worker):
const liveChannel = streamInto(model, 'Ticks', new BroadcastChannel('telemetry'));

// Inspection and teardown:
console.log(live.state); // 'connecting' | 'open' | 'closed' | 'reconnecting' | 'error'
live.flush();            // Apply buffered rows immediately
live.close();            // Close stream and tear down connection
```

`streamInto(target, table, source, options)` streams live rows into a `DataModel` or directly into a `Report`:

- **Target:** Pass a `DataModel` or a `Report`. When passing a `Report`, incoming rows route through `Report.pushData()`, updating the underlying table with sliding window truncation and triggering scoped visual re-renders.
- **Source:** Pass a URL string (`wss://`, `ws://` for WebSocket, or `http://`, `https://` for EventSource SSE) or any message-like source (`WebSocket`, `EventSource`, `BroadcastChannel`, Worker `MessagePort`).
- **Auto-Reconnection:** When passing a URL (or with `reconnect: true`), connections automatically retry on network failure or socket close using configurable exponential backoff (`delayMs`, `maxDelayMs`, `backoffMultiplier`, `maxRetries`).
- **Connection Lifecycle:** The handle tracks `handle.state` (`'connecting' | 'open' | 'closed' | 'reconnecting' | 'error'`) and notifies `onStateChange(state, detail)`.
- **Parsing:** String payloads are JSON-parsed automatically. Accepts a single row, an array of rows, `{ rows: [...] }`, or column arrays (`{ x: [...], y: [...] }`). Provide custom `parse(data)` for binary or custom wire formats.
- **Transform & Filter:** The optional `transform(row)` pipeline modifies incoming rows on the fly or returns `null`/`undefined` to discard unwanted rows before buffering.
- **Batching & Sliding Window:** Rows buffer in memory and flush every `intervalMs` (default 250 ms) to keep visual redraws smooth and bounded. `maxRows` automatically trims the oldest entries.
- **Handle:** Exposes `flush()`, `close()`, `received`, and `state`.

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
