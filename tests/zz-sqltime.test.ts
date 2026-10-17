// @vitest-environment node
import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { toSql } from '@prismbi/prismbi/sql';
import { buildModel } from '../examples/model';
const db = 'C:/Users/santh/AppData/Local/Temp/prismbi-sql-9anBYC/model.db';
const RUN = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); const t = Date.now(); db.prepare(require('fs').readFileSync(0, 'utf8')).all(); process.stdout.write(String(Date.now() - t));`;
it('time', () => {
  const model = buildModel()
    .addMeasure('Running Sales', 'CALCULATE([Total Sales], FILTER(ALL(Date[Date]), Date[Date] <= MAX(Date[Date])))')
    .addMeasure('Prev Month Sales', 'CALCULATE([Total Sales], DATEADD(Date[Date], -1, MONTH))')
    .addMeasure('Prev Year Sales', 'CALCULATE([Total Sales], PREVIOUSYEAR(Date[Date]))');
  const y = [{ target: 'Date[Year]', op: 'eq' as const, value: 2025 }];
  const cases: [string, object][] = [
    ['sply by year', { groupBy: ['Date[Year]'], values: ['Sales LY'] }],
    ['ytd by month', { groupBy: ['Date[MonthNumber]'], values: ['Sales YTD'], filters: y }],
    ['prev month', { groupBy: ['Date[Year]', 'Date[MonthNumber]'], values: ['Prev Month Sales'] }],
    ['prev year', { groupBy: ['Date[Year]', 'Date[MonthNumber]'], values: ['Prev Year Sales'] }],
    ['running', { groupBy: ['Date[MonthNumber]'], values: ['Running Sales'], filters: y }],
    ['share', { groupBy: ['Product[Subcategory]'], values: ['Share of Category'], filters: [{ target: 'Product[Category]', op: 'eq', value: 'Bikes' }] }],
  ];
  for (const [name, spec] of cases) {
    const sql = toSql(model, spec as never, { dialect: 'sqlite', columns: { Sales: { ShipDate: 'ShipDate' } } }).sql;
    let ms = 'timeout';
    try { ms = execFileSync(process.execPath, ['--experimental-sqlite', '--no-warnings', '-e', RUN, db], { input: sql, timeout: 30_000 }).toString(); } catch { /* */ }
    console.log(name.padEnd(14), ms);

  }
}, 400_000);
