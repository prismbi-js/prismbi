// @vitest-environment node
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlUnsupportedError, sqlEngine, toSql } from '@prismbi/prismbi/sql';
import type { SqlRunner } from '@prismbi/prismbi/sql';
import type { CellValue, QueryResult, QuerySpec } from '@prismbi/prismbi';
import { buildModel } from '../examples/model';

// Node's built-in SQLite (behind a flag in Node 22) runs the generated SQL in a child process.
const sqliteOk = (() => {
  try {
    execFileSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '-e', "require('node:sqlite')"], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const LOAD = `
const { DatabaseSync } = require('node:sqlite');
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const db = new DatabaseSync(process.argv[1]);
for (const [name, t] of Object.entries(data)) {
  db.exec('CREATE TABLE "' + name + '" (' + t.columns.map((c) => '"' + c.name + '" ' + c.sql).join(', ') + ')');
  const ins = db.prepare('INSERT INTO "' + name + '" VALUES (' + t.columns.map(() => '?').join(', ') + ')');
  db.exec('BEGIN');
  for (const r of t.rows) ins.run(...r);
  db.exec('COMMIT');
}`;
const RUN = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
process.stdout.write(JSON.stringify(db.prepare(require('fs').readFileSync(0, 'utf8')).all()));`;

const model = buildModel();
let dir = '';
let db = '';
const statements: string[] = [];
const run: SqlRunner = async (sql) => JSON.parse(execFileSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '-e', RUN, db], { input: sql, maxBuffer: 1 << 26 }).toString());

const pad = (n: number) => String(n).padStart(2, '0');
const sqlValue = (v: CellValue) => (v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : typeof v === 'boolean' ? Number(v) : v);

beforeAll(() => {
  if (!sqliteOk) return;
  dir = mkdtempSync(join(tmpdir(), 'prismbi-sql-'));
  db = join(dir, 'model.db');
  // only stored columns go to the database (calculated ones are translated or mapped)
  const data: Record<string, { columns: { name: string; sql: string }[]; rows: unknown[][] }> = {};
  for (const name of ['Sales', 'Product', 'Region', 'Date']) {
    const t = model.table(name);
    const cols = [...t.columns.values()].filter((c) => !c.expression || c.name === 'ShipDate');
    data[name] = {
      columns: cols.map((c) => ({ name: c.name, sql: c.type === 'number' ? 'REAL' : c.type === 'boolean' ? 'INTEGER' : 'TEXT' })),
      rows: Array.from({ length: t.rowCount }, (_, r) => cols.map((c) => sqlValue(c.values[r]))),
    };
  }
  execFileSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '-e', LOAD, db], { input: JSON.stringify(data), maxBuffer: 1 << 26 });
  return () => rmSync(dir, { recursive: true, force: true });
}, 60_000);

const engine = sqlEngine(model, { run, dialect: 'sqlite', columns: { Sales: { ShipDate: 'ShipDate' } }, onSql: (s) => statements.push(s) });

function expectSame(sql: Awaited<ReturnType<typeof engine.query>>, local: QueryResult) {
  expect(sql.groups.map((g) => g.name)).toEqual(local.groups.map((g) => g.name));
  expect(sql.values.map((v) => [v.name, v.format])).toEqual(local.values.map((v) => [v.name, v.format]));
  expect(sql.rows.length).toBe(local.rows.length);
  const norm = (v: CellValue) => (v instanceof Date ? `D${v.getTime()}` : v);
  sql.rows.forEach((r, i) => {
    expect(r.keys.map(norm)).toEqual(local.rows[i].keys.map(norm));
    r.values.forEach((v, k) => (typeof v === 'number' ? expect(v).toBeCloseTo(local.rows[i].values[k] as number, 6) : expect(v).toBe(local.rows[i].values[k])));
    if (local.rows[i].highlights) r.highlights!.forEach((v, k) => (typeof v === 'number' ? expect(v).toBeCloseTo(local.rows[i].highlights![k] as number, 6) : expect(v).toBe(local.rows[i].highlights![k])));
  });
  if (local.totals) sql.totals!.forEach((v, k) => expect(v as number).toBeCloseTo(local.totals![k] as number, 6));
}

const CASES: [string, QuerySpec][] = [
  ['measures, ratios and totals', { groupBy: ['Product[Category]'], values: ['Total Sales', 'Orders', 'Margin %', 'Avg Order Value'], totals: true }],
  ['two dimensions, filters, sort and top', { groupBy: ['Date[Year]', 'Region[Country]'], values: ['Total Sales'], filters: [{ target: 'Product[Category]', op: 'in', values: ['Bikes', 'Accessories'] }], orderBy: [{ field: 'Total Sales', direction: 'desc' }], top: 5 }],
  ['Top N filter', { groupBy: ['Product[Name]'], values: ['Total Sales'], filters: [{ target: 'Product[Name]', op: 'topN', n: 3, by: 'Total Sales' }, { target: 'Date[Year]', op: 'eq', value: 2025 }] }],
  ['sort-by column (month names in calendar order)', { groupBy: ['Date[MonthShort]'], values: ['Units'], filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }] }],
  ['aggregated columns', { groupBy: ['Region[Group]'], values: [{ field: 'Sales[Quantity]', aggregation: 'avg' }, { field: 'Sales[OrderNumber]', aggregation: 'distinctCount' }, { field: 'Sales[SalesAmount]', aggregation: 'max' }] }],
  ['highlights', { groupBy: ['Product[Category]'], values: ['Total Sales'], highlight: [{ target: 'Region[Country]', op: 'eq', value: 'Canada' }] }],
  ['visual calculations', { groupBy: ['Date[MonthNumber]'], values: ['Total Sales', { name: 'Running', visualCalc: 'RUNNINGSUM([Total Sales])' }], filters: [{ target: 'Date[Year]', op: 'eq', value: 2024 }] }],
  ['text and date filters, date keys', { groupBy: ['Date[Date]'], values: ['Total Sales'], filters: [{ target: 'Product[Name]', op: 'contains', value: 'ROAD' }, { target: 'Date[Date]', op: 'between', min: new Date(2025, 2, 1), max: new Date(2025, 2, 10) }] }],
  ['no grouping', { values: ['Total Sales', 'Total Profit'], filters: [{ target: 'Region[Country]', op: 'notIn', values: ['Canada'] }] }],
];

// measures that need DAX filter-context semantics (correlated subqueries)
model
  .addMeasure('Bike Sales', 'CALCULATE([Total Sales], Product[Category] = "Bikes")')
  .addMeasure('Bike Sales Kept', 'CALCULATE([Total Sales], KEEPFILTERS(Product[Category] = "Bikes"))')
  .addMeasure('All Products Share', 'DIVIDE([Total Sales], CALCULATE([Total Sales], ALL(Product)))')
  .addMeasure('Max List Price', 'MAX(Product[ListPrice])')
  .addMeasure('Product Count', 'COUNTROWS(Product)')
  .addMeasure('Running Sales', 'CALCULATE([Total Sales], FILTER(ALL(Date[Date]), Date[Date] <= MAX(Date[Date])))')
  .addMeasure('Prev Month Sales', 'CALCULATE([Total Sales], DATEADD(Date[Date], -1, MONTH))')
  .addMeasure('Prev Year Sales', 'CALCULATE([Total Sales], PREVIOUSYEAR(Date[Date]))')
  .addMeasure('Region Group Sales', 'CALCULATE([Total Sales], ALLEXCEPT(Region, Region[Group]))')
  .addMeasure('Big Orders', 'COUNTROWS(FILTER(Sales, Sales[SalesAmount] > 1000))')
  .addMeasure('Sales MTD', 'TOTALMTD([Total Sales], Date[Date])')
  .addMeasure('Sales QTD', 'TOTALQTD([Total Sales], Date[Date])');

const y2025 = [{ target: 'Date[Year]', op: 'eq' as const, value: 2025 }];
const CONTEXT_CASES: [string, QuerySpec][] = [
  ['SAMEPERIODLASTYEAR and YoY %', { groupBy: ['Date[Year]'], values: ['Total Sales', 'Sales LY', 'YoY %'] }],
  ['TOTALYTD by month', { groupBy: ['Date[MonthNumber]'], values: ['Sales YTD', 'Sales MTD', 'Sales QTD'], filters: y2025 }],
  ['DATEADD and PREVIOUSYEAR', { groupBy: ['Date[Year]', 'Date[MonthNumber]'], values: ['Prev Month Sales', 'Prev Year Sales'] }],
  ['running total with FILTER(ALL(...))', { groupBy: ['Date[MonthNumber]'], values: ['Running Sales'], filters: y2025 }],
  ['ALLSELECTED share', { groupBy: ['Product[Subcategory]'], values: ['Total Sales', 'Share of Category'], filters: [{ target: 'Product[Category]', op: 'eq', value: 'Bikes' }] }],
  ['ALL share and totals', { groupBy: ['Product[Category]'], values: ['All Products Share'], filters: y2025, totals: true }],
  ['CALCULATE replacing a grouped column, and KEEPFILTERS', { groupBy: ['Product[Category]'], values: ['Bike Sales', 'Bike Sales Kept'] }],
  ['single-direction filters (a dimension measure by another dimension)', { groupBy: ['Region[Group]'], values: ['Max List Price', 'Product Count', 'Total Sales'] }],
  ['ALLEXCEPT', { groupBy: ['Region[Region]'], values: ['Total Sales', 'Region Group Sales'] }],
  ['COUNTROWS(FILTER(...)), sorted, Top N filter', { groupBy: ['Product[Name]'], values: ['Big Orders', 'Sales LY'], filters: [{ target: 'Product[Name]', op: 'topN', n: 5, by: 'Total Sales' }, ...y2025], orderBy: [{ field: 'Big Orders', direction: 'desc' }] }],
  ['no grouping', { values: ['Sales LY', 'Sales YTD'], filters: y2025 }],
  ['highlights in context mode', { groupBy: ['Product[Category]'], values: ['Sales LY'], highlight: [{ target: 'Region[Country]', op: 'eq', value: 'Canada' }], filters: y2025 }],
];

describe.skipIf(!sqliteOk)('sqlEngine on SQLite: filter-context mode', () => {
  for (const [name, spec] of CONTEXT_CASES) {
    it(`matches the in-memory engine: ${name}`, async () => {
      expect(engine.toSql(spec).mode).toBe('context');
      expectSame(await engine.query(spec), model.query(spec));
    });
  }
});

describe.skipIf(!sqliteOk)('sqlEngine on SQLite', () => {
  for (const [name, spec] of CASES) {
    it(`matches the in-memory engine: ${name}`, async () => {
      expectSame(await engine.query(spec), model.query(spec));
    });
  }

  it('inlines calculated columns and maps others', async () => {
    statements.length = 0;
    await engine.query({ values: ['Total Profit'] });
    expect(statements[0]).toMatch(/SUM\(\(+t0\."SalesAmount" - t0\."TotalCost"\)+\)/);
    // a dimension aggregated across a fact (filters don't flow that way in DAX) needs filter-context mode
    expect(toSql(model, { groupBy: ['Region[Group]'], values: [{ field: 'Product[ListPrice]', aggregation: 'max' }] }).mode).toBe('context');
  });
});

describe('toSql', () => {
  it('writes joins, filters, grouping and ordering', () => {
    const plan = toSql(model, { groupBy: ['Product[Category]'], values: ['Total Sales', 'Margin %'], filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }], orderBy: [{ field: 'Total Sales', direction: 'desc' }], top: 3 });
    const lines = plan.sql.split('\n');
    expect(lines[0]).toMatch(/^SELECT t1\."Category" AS g0, \(SUM\(t0\."SalesAmount"\)\) AS v0, .*SUM\(\(+t0\."SalesAmount" - t0\."TotalCost"\)+\).* AS v1$/);
    expect(lines.slice(1, 5)).toEqual(['FROM "Sales" AS t0', 'LEFT JOIN "Product" AS t1 ON t0."ProductKey" = t1."ProductKey"', 'LEFT JOIN "Date" AS t2 ON t0."OrderDate" = t2."Date"', 'WHERE t2."Year" = 2025']);
    expect(lines.slice(5, 6)).toEqual(['GROUP BY 1']);
    expect(lines[6]).toMatch(/^HAVING NOT \(/);
    expect(lines.slice(7)).toEqual(['ORDER BY v0 DESC NULLS LAST, g0 ASC NULLS FIRST', 'LIMIT 3']);
  });

  it('maps table and column names, and CALCULATE filters become FILTER clauses', () => {
    const m = buildModel().addMeasure('Bike Sales', 'CALCULATE([Total Sales], Product[Category] = "Bikes")');
    const plan = toSql(m, { groupBy: ['Region[Country]'], values: ['Bike Sales'] }, { tables: { Sales: 'analytics.fact_sales' }, columns: { Sales: { SalesAmount: 'amount' } } });
    expect(plan.sql).toContain('(SUM(t0."amount") FILTER (WHERE t2."Category" = \'Bikes\'))');
    expect(plan.sql).toContain('FROM "analytics"."fact_sales" AS t0');
    // replacing a filter the query also uses switches to filter-context mode; KEEPFILTERS stays a plain FILTER clause
    expect(toSql(m, { groupBy: ['Product[Category]'], values: ['Bike Sales'] }).mode).toBe('context');
    const k = buildModel().addMeasure('Bike Sales', 'CALCULATE([Total Sales], KEEPFILTERS(Product[Category] = "Bikes"))');
    expect(toSql(k, { groupBy: ['Product[Category]'], values: ['Bike Sales'] }).sql).toContain('FILTER (WHERE');
  });

  it('reports what it cannot push down, and can fall back to the model', async () => {
    // time intelligence and ALLSELECTED now translate (filter-context mode); USERELATIONSHIP still doesn't
    expect(toSql(model, { values: ['Sales LY'] }).mode).toBe('context');
    expect(toSql(model, { values: ['Total Sales'] }).mode).toBe('aggregate');
    expect(() => toSql(model, { values: ['Sales by Ship Date'] })).toThrow(/USERELATIONSHIP is not pushed down/);
    const strict = sqlEngine(model, { run: async () => [] });
    await expect(strict.query({ values: ['Sales by Ship Date'] })).rejects.toThrow(SqlUnsupportedError);
    const lenient = sqlEngine(model, { run: async () => [], fallback: 'model' });
    const y = [{ target: 'Date[Year]', op: 'eq' as const, value: 2025 }];
    expect((await lenient.query({ values: ['Sales by Ship Date'], filters: y })).rows[0].values[0]).toBe(model.query({ values: ['Sales by Ship Date'], filters: y }).rows[0].values[0]);
  });
});

describe('empty local fact table', () => {
  it('queries a fact table that only exists in the database', async () => {
    const { DataModel } = await import('@prismbi/prismbi');
    const m = new DataModel()
      .addTable('Sales', [], { OrderDate: { type: 'date' }, ProductKey: { type: 'number' }, SalesAmount: { type: 'number' } })
      .addTable('Product', [{ ProductKey: 1, Category: 'Bikes' }])
      .addRelationship({ from: 'Sales[ProductKey]', to: 'Product[ProductKey]' })
      .addMeasure('Total Sales', 'SUM(Sales[SalesAmount])');
    const seen: string[] = [];
    const e = sqlEngine(m, { run: async (sql) => (seen.push(sql), [{ g0: 'Bikes', v0: 12n }]) });
    const r = await e.query({ groupBy: ['Product[Category]'], values: ['Total Sales'] });
    expect(r.rows).toEqual([{ keys: ['Bikes'], values: [12] }]);
    expect(seen[0]).toContain('LEFT JOIN "Product" AS t1 ON t0."ProductKey" = t1."ProductKey"');
  });
});
