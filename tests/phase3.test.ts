import { afterEach, describe, expect, it } from 'vitest';
import { DAX_FUNCTIONS, DataModel, DaxLanguageService, Report, explainDax, formatDax } from '../src/index';
import type { FilterSpec } from '../src/index';
import { makeModel } from './fixtures';

/** Fixture extended with Phase 3 features. */
function richModel(): DataModel {
  const m = makeModel()
    // inactive ship-date relationship
    .addCalculatedColumn('Sales', 'ShipDate', 'Sales[OrderDate] + 20', { type: 'date' })
    .addRelationship({ from: 'Sales[ShipDate]', to: 'Date[Date]', active: false })
    .addMeasure('Sales by Ship Date', 'CALCULATE([Total Sales], USERELATIONSHIP(Sales[ShipDate], Date[Date]))')
    .addMeasure('Products Sold', 'CALCULATE(COUNTROWS(Products), CROSSFILTER(Sales[ProductId], Products[Id], BOTH))')
    // many-to-many: budget at category grain
    .addTable('Budget', [
      { Category: 'Bikes', Year: 2024, Budget: 5000 },
      { Category: 'Bikes', Year: 2025, Budget: 3000 },
      { Category: 'Accessories', Year: 2024, Budget: 400 },
      { Category: 'Clothing', Year: 2024, Budget: 300 },
    ])
    .addRelationship({ from: 'Budget[Category]', to: 'Products[Category]', cardinality: 'manyToMany' })
    .addMeasure('Total Budget', 'SUM(Budget[Budget])')
    // parent-child
    .addTable('Org', [
      { Id: 1, Parent: null, Name: 'CEO' },
      { Id: 2, Parent: 1, Name: 'VP' },
      { Id: 3, Parent: 2, Name: 'Manager' },
    ]);
  return m;
}

const m = richModel();
const ev = (e: string, f: FilterSpec[] = []) => m.evaluate(e, f);
const year = (y: number): FilterSpec => ({ target: 'Date[Year]', op: 'eq', value: y });

describe('conformance: relationships', () => {
  const cases: [string, FilterSpec[], unknown][] = [
    ['[Total Sales]', [{ target: 'Date[Month]', op: 'eq', value: 'February' }], 3400], // Feb 2024 + Feb 2025 by order date
    ['[Sales by Ship Date]', [{ target: 'Date[Month]', op: 'eq', value: 'February' }], 3000],
    ['[Sales by Ship Date]', [year(2024)], 4450],
    ['COUNTROWS(Products)', [{ target: 'Region[Name]', op: 'eq', value: 'South' }], 5], // single direction: dims not filtered by facts
    ['[Products Sold]', [{ target: 'Region[Name]', op: 'eq', value: 'South' }], 4], // CROSSFILTER both
    ['[Total Budget]', [], 8700],
    ['[Total Budget]', [{ target: 'Products[Color]', op: 'eq', value: 'Red' }], 8400], // Bikes + Accessories via many-to-many
    ['[Total Budget]', [{ target: 'Products[Category]', op: 'eq', value: 'Clothing' }], 300],
    ['CALCULATE([Total Sales], TREATAS({"Bikes"}, Products[Category]))', [], 6000],
    ['CALCULATE([Total Sales], TREATAS({"North"}, Region[Name]))', [], 4450],
  ];
  for (const [expr, filters, expected] of cases) it(`${expr} ${JSON.stringify(filters.map((f) => ('value' in f ? f.value : '')))}`, () => expect(ev(expr, filters)).toEqual(expected));

  it('bidirectional relationships filter the one side from the many side', () => {
    const bi = makeModel();
    // replace the product relationship with a bidirectional one
    const b = new DataModel()
      .addTable('Sales', bi.table('Sales').toRows())
      .addTable('Products', bi.table('Products').toRows())
      .addTable('Region', bi.table('Region').toRows())
      .addRelationship({ from: 'Sales[ProductId]', to: 'Products[Id]', crossFilter: 'both' })
      .addRelationship({ from: 'Sales[RegionId]', to: 'Region[Id]' });
    expect(b.evaluate('COUNTROWS(Products)', [{ target: 'Region[Name]', op: 'eq', value: 'South' }])).toBe(4);
    // a product's own filter is not narrowed to products with sales
    expect(b.evaluate('COUNTROWS(Products)', [{ target: 'Products[Color]', op: 'eq', value: 'Blue' }])).toBe(2);
    // and facts are still filtered by products
    expect(b.evaluate('SUM(Sales[Amount])', [{ target: 'Products[Category]', op: 'eq', value: 'Bikes' }])).toBe(6000);
  });

  it('rejects duplicate keys on a many-to-one relationship but allows many-to-many', () => {
    const x = new DataModel().addTable('A', [{ k: 1 }]).addTable('B', [{ k: 1 }, { k: 1 }]);
    expect(() => x.addRelationship({ from: 'A[k]', to: 'B[k]' })).toThrow(/manyToMany/);
    expect(() => x.addRelationship({ from: 'A[k]', to: 'B[k]', cardinality: 'manyToMany' })).not.toThrow();
  });
});

describe('conformance: table functions', () => {
  const cases: [string, unknown][] = [
    ['COUNTROWS(SUMMARIZE(Sales, Products[Category]))', 3],
    ['SUMX(SUMMARIZE(Sales, Products[Category], "S", [Total Sales]), [S])', 6750],
    ['MAXX(SUMMARIZE(Sales, Products[Category], Region[Name], "S", [Total Sales]), [S])', 4000],
    ['MAXX(ADDCOLUMNS(VALUES(Products[Category]), "S", [Total Sales]), [S])', 6000],
    ['COUNTROWS(SELECTCOLUMNS(Products, "N", Products[Name]))', 5],
    ['COUNTROWS(CROSSJOIN(VALUES(Products[Category]), VALUES(Region[Name])))', 6],
    ['COUNTROWS(UNION(ROW("a", 1), ROW("a", 2), ROW("a", 2)))', 3],
    ['COUNTROWS(INTERSECT(VALUES(Products[Category]), {"Bikes", "Cars"}))', 1],
    ['COUNTROWS(EXCEPT(VALUES(Products[Category]), {"Bikes"}))', 2],
    ['COUNTROWS(GENERATE(VALUES(Region[Name]), VALUES(Products[Category])))', 6],
    ['COUNTROWS(GENERATESERIES(1, 10, 2))', 5],
    ['SUMX(GENERATESERIES(1, 5), [Value])', 15],
    ['SUMX(DATATABLE("x", INTEGER, "y", STRING, {{1, "a"}, {2, "b"}, {3, "c"}}), [x])', 6],
    ['COUNTROWS(CALENDAR(DATE(2024, 1, 1), DATE(2024, 1, 31)))', 31],
    ['COUNTROWS(SUMMARIZECOLUMNS(Products[Category], "S", [Total Sales]))', 3],
    ['SUMX(SUMMARIZECOLUMNS(Products[Category], FILTER(ALL(Region[Name]), Region[Name] = "North"), "S", [Total Sales]), [S])', 4450],
    ['COUNTROWS(SUMMARIZECOLUMNS(Products[Category], Region[Name], "S", [Total Sales]))', 6],
    ['CONTAINS(Products, Products[Color], "Blue")', true],
    ['CONTAINS(Products, Products[Color], "Green")', false],
    ['COUNTROWS(FILTER(ADDCOLUMNS(Products, "S", [Total Sales]), [S] > 400))', 2],
  ];
  for (const [expr, expected] of cases) it(expr, () => expect(ev(expr)).toEqual(expected));

  it('evaluateTable returns named columns', () => {
    const t = m.evaluateTable('SUMMARIZECOLUMNS(Products[Category], "Sales", [Total Sales])');
    expect(t.columns).toEqual(['Category', 'Sales']);
    expect(Object.fromEntries(t.rows)).toEqual({ Accessories: 500, Bikes: 6000, Clothing: 250 });
  });

  it('calculated tables can be queried like any table', () => {
    const x = richModel().addCalculatedTable('CategorySales', 'SUMMARIZECOLUMNS(Products[Category], "Sales", [Total Sales])');
    expect(x.table('CategorySales').rowCount).toBe(3);
    expect(x.evaluate('SUM(CategorySales[Sales])')).toBe(6750);
    expect(x.toJSON().tables.find((t) => t.name === 'CategorySales')?.expression).toContain('SUMMARIZECOLUMNS');
  });
});

describe('conformance: lookups, row context and statistics', () => {
  const cases: [string, unknown][] = [
    ['LOOKUPVALUE(Products[Name], Products[Id], 3)', 'Helmet'],
    ['LOOKUPVALUE(Products[Name], Products[Id], 99, "none")', 'none'],
    ['STDEV.P(Sales[Qty])', Math.sqrt(7.75)],
    ['VAR.P(Sales[Qty])', 7.75],
    ['VAR.S(Sales[Qty])', 62 / 7],
    ['PERCENTILE.INC(Sales[Qty], 0.5)', 2.5],
    ['PERCENTILE.EXC(Sales[Qty], 0.25)', 1.25],
    ['STDEVX.P(VALUES(Products[Category]), [Total Sales]) > 0', true],
    ['ROUND(GEOMEAN(Sales[Qty]), 4)', +Math.exp([1, 2, 3, 10, 4, 2, 5, 1].reduce((a, b) => a + Math.log(b), 0) / 8).toFixed(4)],
    ['COMBINEVALUES("|", "a", 1, TRUE)', 'a|1|true'],
    ['NETWORKDAYS(DATE(2024, 1, 1), DATE(2024, 1, 7))', 5],
    ['FIRSTNONBLANK(Products[Name], [Total Sales])', 'Bottle'],
    ['LASTNONBLANK(Products[Name], [Total Sales])', 'Road Bike'],
  ];
  for (const [expr, expected] of cases)
    it(expr, () => {
      const v = ev(expr);
      if (typeof expected === 'number') expect(v as number).toBeCloseTo(expected, 6);
      else expect(v).toEqual(expected);
    });

  it('EARLIER ranks rows in a calculated column', () => {
    const x = makeModel().addCalculatedColumn('Sales', 'Rank', 'COUNTROWS(FILTER(Sales, Sales[Amount] > EARLIER(Sales[Amount]))) + 1');
    const rows = x.table('Sales').toRows();
    expect(rows.find((r) => r.Amount === 3000)!.Rank).toBe(1);
    expect(rows.find((r) => r.Amount === 50)!.Rank).toBe(8);
  });

  it('PATH functions walk a parent-child hierarchy', () => {
    const x = richModel().addCalculatedColumn('Org', 'Path', 'PATH(Org[Id], Org[Parent])');
    expect(x.table('Org').toRows().map((r) => r.Path)).toEqual(['1', '1|2', '1|2|3']);
    expect(x.evaluate('PATHLENGTH("1|2|3")')).toBe(3);
    expect(x.evaluate('PATHITEM("1|2|3", 2, 1)')).toBe(2);
    expect(x.evaluate('PATHITEMREVERSE("1|2|3", 1)')).toBe('3');
    expect(x.evaluate('PATHCONTAINS("1|2|3", "2")')).toBe(true);
  });

  it('ISINSCOPE is true only at grouping levels', () => {
    const r = m.query({ groupBy: ['Products[Category]'], values: [{ expression: 'IF(ISINSCOPE(Products[Category]), 1, 0)', name: 'Scope' }], totals: true });
    expect(r.rows.every((x) => x.values[0] === 1)).toBe(true);
    expect(r.totals![0]).toBe(0);
  });

  it('date + whole days is DST-safe', () => {
    expect(ev('DATE(2024, 3, 30) + 2')).toEqual(new Date(2024, 3, 1));
    expect(ev('DATE(2024, 10, 26) + 3')).toEqual(new Date(2024, 9, 29));
  });
});

describe('row-level security', () => {
  it('limits every query and cannot be removed by ALL', () => {
    const x = makeModel().addRole('South only', { Region: 'Region[Name] = "South"' });
    x.setRoles(['South only']);
    expect(x.evaluate('[Total Sales]')).toBe(2300);
    expect(x.evaluate('CALCULATE([Total Sales], ALL(Region))')).toBe(2300);
    expect(x.evaluate('CALCULATE([Total Sales], REMOVEFILTERS())')).toBe(2300);
    expect(x.query({ groupBy: ['Region[Name]'], values: ['Total Sales'] }).rows.map((r) => r.keys[0])).toEqual(['South']);
    x.setRoles(null);
    expect(x.evaluate('[Total Sales]')).toBe(6750);
  });

  it('supports USERNAME() and role unions', () => {
    const x = makeModel()
      .addRole('Mine', { Region: 'Region[Name] = USERNAME()' })
      .addRole('Clothing', { Products: 'Products[Category] = "Clothing"' });
    x.setRoles(['Mine'], { user: 'North' });
    expect(x.evaluate('[Total Sales]')).toBe(4450);
    x.setRoles(['Mine', 'Clothing'], { user: 'North' });
    // union per table: Region→North and Products→Clothing both apply (different tables intersect)
    expect(x.evaluate('[Total Sales]')).toBe(200);
  });
});

describe('calculation groups', () => {
  const x = makeModel().addCalculationGroup({
    name: 'Time Intelligence',
    items: [
      { name: 'Current', expression: 'SELECTEDMEASURE()' },
      { name: 'Prior year', expression: 'CALCULATE(SELECTEDMEASURE(), SAMEPERIODLASTYEAR(Date[Date]))' },
      { name: 'YTD', expression: 'TOTALYTD(SELECTEDMEASURE(), Date[Date])' },
      { name: 'Tenfold orders', expression: 'IF(ISSELECTEDMEASURE([Orders]), SELECTEDMEASURE() * 10, SELECTEDMEASURE())' },
    ],
  });

  it('rewrites any measure while an item is selected', () => {
    const py = [year(2025), { target: "'Time Intelligence'[Name]", op: 'eq', value: 'Prior year' } as FilterSpec];
    expect(x.evaluate('[Total Sales]', py)).toBe(4450);
    expect(x.evaluate('[Orders]', py)).toBe(5);
    expect(x.evaluate('[Orders]', [{ target: "'Time Intelligence'[Name]", op: 'eq', value: 'Tenfold orders' }])).toBe(80);
    expect(x.evaluate('[Total Sales]', [{ target: "'Time Intelligence'[Name]", op: 'eq', value: 'Tenfold orders' }])).toBe(6750);
  });

  it('works as a grouping column in queries', () => {
    const r = x.query({ groupBy: ["'Time Intelligence'[Name]"], values: ['Total Sales'], filters: [year(2025)] });
    expect(Object.fromEntries(r.rows.map((row) => [row.keys[0], row.values[0]]))).toEqual({ Current: 2300, 'Prior year': 4450, YTD: 2300, 'Tenfold orders': 2300 });
  });

  it('is a no-op when nothing (or several items) is selected', () => {
    expect(x.evaluate('[Total Sales]')).toBe(6750);
  });
});

describe('parameters, hierarchies, perspectives', () => {
  const x = makeModel()
    .addFieldParameter('Metric', [
      { label: 'Sales', field: 'Total Sales' },
      { label: 'Orders', field: 'Orders' },
    ])
    .addWhatIfParameter('Discount', { min: 0, max: 0.5, step: 0.05, default: 0.1, format: '0%' })
    .addMeasure('Discounted Sales', '[Total Sales] * (1 - [Discount Value])')
    .addHierarchy('Date', 'Calendar', ['Year', 'Quarter', 'Month'])
    .addPerspective('Sales analysis', ['Sales', 'Total Sales', 'Products']);

  it('field parameters resolve to the selected fields', () => {
    expect(x.resolveFieldParameter('Metric[Metric]')).toEqual(['Total Sales', 'Orders']);
    expect(x.resolveFieldParameter('Metric[Metric]', [{ target: 'Metric[Metric]', op: 'eq', value: 'Orders' }])).toEqual(['Orders']);
    expect(x.resolveFieldParameter('Products[Name]')).toBeNull();
  });

  it('what-if parameters drive measures', () => {
    expect(x.evaluate('[Discounted Sales]')).toBeCloseTo(6075);
    expect(x.evaluate('[Discounted Sales]', [{ target: 'Discount[Discount]', op: 'eq', value: 0.2 }])).toBeCloseTo(5400);
    expect(x.table('Discount').rowCount).toBe(11);
  });

  it('hierarchies and perspectives shape the field list', () => {
    expect(x.resolveHierarchy('Date[Calendar]')).toEqual(['Date[Year]', 'Date[Quarter]', 'Date[Month]']);
    expect(x.resolveHierarchy('Date[Year]')).toBeNull();
    const f = x.fields({ perspective: 'Sales analysis' });
    expect(f.some((i) => i.table === 'Region')).toBe(false);
    expect(f.some((i) => i.ref === 'Total Sales')).toBe(true);
    expect(x.fields().some((i) => i.kind === 'hierarchy' && i.name === 'Calendar')).toBe(true);
  });

  it('visuals follow field-parameter slicers, use hierarchies and what-if sliders', () => {
    const el = document.createElement('div');
    document.body.append(el);
    const r = new Report(el, {
      model: x,
      pages: [{ name: 'P', visuals: [
        { id: 'metric', type: 'slicer', fields: { field: 'Metric[Metric]' }, format: { slicer: { style: 'tiles', single: true } } },
        { id: 'card', type: 'card', fields: { value: 'Metric[Metric]' } },
        { id: 'cols', type: 'clusteredColumn', fields: { category: 'Date[Calendar]', values: 'Total Sales' } },
        { id: 'disc', type: 'slicer', fields: { field: 'Discount[Discount]' }, format: { slicer: { style: 'slider' } } },
        { id: 'dcard', type: 'card', fields: { value: 'Discounted Sales' } },
      ] }],
    });
    r.flush();
    const cardText = (id: string) => el.querySelector(`[data-visual-id="${id}"] .pbi-card-value`)?.textContent;
    expect(cardText('card')).toBe('$6,750');
    // the slicer on the parameter lists its choices (it must not expand into the fields)
    expect([...el.querySelectorAll('[data-visual-id="metric"] .pbi-tile')].map((t) => t.textContent)).toEqual(['Sales', 'Orders']);
    expect(el.querySelector('.pbi-error')).toBeNull();
    r.setSlicerSelection('metric', [{ target: 'Metric[Metric]', op: 'in', values: ['Orders'] }]);
    r.flush();
    expect(cardText('card')).toBe('8');
    expect(r.visual('cols').data()!.groups[0].name).toBe('Year');
    r.visual('cols').drillDown(2024);
    r.flush();
    expect(r.visual('cols').data()!.groups[0].name).toBe('Quarter');
    expect(el.querySelector('[data-visual-id="disc"] input[type="range"]')).toBeTruthy();
    r.setSlicerSelection('disc', [{ target: 'Discount[Discount]', op: 'eq', value: 0.2 }]);
    r.flush();
    expect(cardText('dcard')).toBe('5,400'); // measure has no currency format
    r.destroy();
    el.remove();
  });
});

describe('tooling', () => {
  const ls = new DaxLanguageService(m);

  it('completes columns, measures, functions and tables', () => {
    expect(ls.complete('SUM(Sales[Am', 12).map((c) => c.label)).toContain('Amount');
    const measures = ls.complete('[Tot', 4);
    expect(measures[0].label).toBe('Total Budget');
    expect(measures.map((c) => c.label)).toContain('Total Sales');
    expect(ls.complete('CALCU', 5)[0].label).toBe('CALCULATE');
    expect(ls.complete("COUNTROWS('Pro", 14).map((c) => c.insertText)).toContain("Products'");
    expect(ls.complete('VAR x = 1 RETURN x', 18).some((c) => c.kind === 'variable' && c.label === 'x')).toBe(true);
  });

  it('diagnoses syntax and reference errors', () => {
    expect(ls.diagnose('SUM(Sales[Amount])')).toEqual([]);
    expect(ls.diagnose('SUM(Sales[Nope])')[0].message).toMatch(/Column \[Nope\] not found/);
    expect(ls.diagnose('FOO(1)')[0].message).toMatch(/Unknown function FOO/);
    expect(ls.diagnose('[Nope] + 1')[0].message).toMatch(/Unknown measure/);
    expect(ls.diagnose('SUM(Sales[Amount]')[0].severity).toBe('error');
    expect(ls.diagnose('DATEADD(Date[Date], -1, YEAR)')).toEqual([]);
    expect(ls.diagnose('VAR a = 1 RETURN a + b')[0].message).toMatch(/Unknown table or variable b/);
  });

  it('hovers and signature help', () => {
    expect(ls.hover('[Total Sales]', 3)?.detail).toMatch(/Measure/);
    expect(ls.hover('DIVIDE(1, 2)', 2)?.title).toMatch(/^DIVIDE\(/);
    expect(ls.hover('Sales[Amount]', 8)?.detail).toMatch(/Column · number/);
    expect(ls.signatureHelp('DIVIDE(1, ', 10)).toMatchObject({ name: 'DIVIDE', activeParameter: 1 });
    expect(ls.signatureHelp('CALCULATE(SUM(Sales[Amount]', 27)).toMatchObject({ name: 'SUM', activeParameter: 0 });
  });

  it('formats DAX', () => {
    expect(formatDax('calculate(sum(Sales[Amount]),Products[Color]="Red")')).toBe('CALCULATE(SUM(Sales[Amount]), Products[Color] = "Red")');
    expect(formatDax('(1+2)*3')).toBe('(1 + 2) * 3');
    expect(formatDax('1-(2-3)')).toBe('1 - (2 - 3)');
    const long = formatDax('CALCULATE([Total Sales], FILTER(ALL(Products), Products[Color] = "Red" || Products[Color] = "Blue"), USERELATIONSHIP(Sales[ShipDate], Date[Date]))');
    expect(long.split('\n').length).toBeGreaterThan(2);
    expect(formatDax('VAR a=1 VAR b=2 RETURN a+b')).toBe('VAR a = 1\nVAR b = 2\nRETURN\n    a + b');
  });

  it('explains dependencies transitively', () => {
    const x = explainDax(m, '[Margin %]');
    expect(x.measures).toEqual(['Total Sales', 'Total Cost', 'Profit', 'Margin %']);
    expect(x.columns).toEqual(['Sales[Amount]', 'Sales[Cost]']);
    expect(x.functions).toEqual(['DIVIDE', 'SUM']);
  });

  it('every catalogued function is implemented', () => {
    for (const f of DAX_FUNCTIONS) {
      let msg = '';
      try {
        m.evaluate(`${f.name}()`);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, f.name).not.toMatch(/is not supported/);
    }
  });
});

afterEach(() => document.querySelectorAll('.pbi-report').forEach((n) => n.remove()));
