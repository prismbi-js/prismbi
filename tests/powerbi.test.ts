import { describe, expect, it } from 'vitest';
import { buildModelFrom, importPowerBI, parseModelBim, parseTmdl } from '@prismbi/prismbi/powerbi';
import { Report } from '../src/index';

const salesTmdl = `table Sales
	lineageTag: 1

	measure 'Total Sales' = SUM(Sales[Amount])
		formatString: \\$#,0
		displayFolder: KPIs

	measure Margin =
			DIVIDE(
				[Total Profit],
				[Total Sales]
			)
		formatString: 0.0%

	measure 'Total Profit' = ${'```'}
			SUMX(Sales, Sales[Amount] - Sales[Cost])
			${'```'}

	measure Fancy = PATHCONTAINS("a|b", "c") + NOTAFUNCTION(1)

	column Amount
		dataType: decimal
		formatString: \\$#,0.00
		summarizeBy: sum
		sourceColumn: Amount

	column Cost
		dataType: decimal
		isHidden

	column ProductKey
		dataType: int64
		isHidden

	column OrderDate
		dataType: dateTime

	column 'Big Order' = IF(Sales[Amount] > 100, "Yes", "No")
		dataType: string

	partition Sales = m
		mode: import
		source =
				let Source = Csv.Document(...)
				in Source
`;
const productTmdl = `table Product

	column ProductKey
		dataType: int64

	column Category
		dataType: string
`;
const relTmdl = `relationship 7d2f
	fromColumn: Sales.ProductKey
	toColumn: Product.ProductKey

relationship 8a1c
	fromColumn: Sales.OrderDate
	toColumn: 'Missing Table'.Date
	isActive: false
`;

const visual = (name: string, type: string, queryState: Record<string, unknown>, pos: object, title?: string) =>
  JSON.stringify({ name, position: pos, visual: { visualType: type, query: { queryState }, ...(title ? { visualContainerObjects: { title: [{ properties: { text: { expr: { Literal: { Value: `'${title}'` } } } } }] } } : {}) } });
const col = (entity: string, prop: string) => ({ field: { Column: { Expression: { SourceRef: { Entity: entity } }, Property: prop } } });
const measure = (entity: string, prop: string) => ({ field: { Measure: { Expression: { SourceRef: { Entity: entity } }, Property: prop } } });

const project = (): Record<string, string> => ({
  'Shop.SemanticModel/definition/tables/Sales.tmdl': salesTmdl,
  'Shop.SemanticModel/definition/tables/Product.tmdl': productTmdl,
  'Shop.SemanticModel/definition/relationships.tmdl': relTmdl,
  'Shop.Report/definition/pages/pages.json': JSON.stringify({ pageOrder: ['p1'] }),
  'Shop.Report/definition/pages/p1/page.json': JSON.stringify({ name: 'p1', displayName: 'Overview', width: 1280, height: 720 }),
  'Shop.Report/definition/pages/p1/visuals/v1/visual.json': visual('v1', 'clusteredColumnChart', { Category: { projections: [col('Product', 'Category')] }, Y: { projections: [measure('Sales', 'Total Sales')] } }, { x: 0, y: 0, width: 640, height: 336 }),
  'Shop.Report/definition/pages/p1/visuals/v2/visual.json': visual('v2', 'card', { Values: { projections: [measure('Sales', 'Margin')] } }, { x: 640, y: 0, width: 320, height: 168 }, 'Margin'),
  'Shop.Report/definition/pages/p1/visuals/v3/visual.json': visual('v3', 'lineClusteredColumnComboChart', { Category: { projections: [col('Product', 'Category')] }, Y: { projections: [{ field: { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Amount' } }, Function: 1 } } }] }, Y2: { projections: [measure('Sales', 'Total Profit')] } }, { x: 0, y: 336, width: 1280, height: 384 }),
  'Shop.Report/definition/pages/p1/visuals/v4/visual.json': visual('v4', 'someCustomVisual123', {}, { x: 960, y: 0, width: 320, height: 168 }),
});

const data = {
  Sales: [
    { Amount: 120, Cost: 70, ProductKey: 1, OrderDate: '2025-01-03' },
    { Amount: 80, Cost: 50, ProductKey: 2, OrderDate: '2025-01-04' },
    { Amount: 200, Cost: 90, ProductKey: 1, OrderDate: '2025-02-01' },
  ],
  Product: [
    { ProductKey: 1, Category: 'Bikes' },
    { ProductKey: 2, Category: 'Helmets' },
  ],
};

describe('Power BI import', () => {
  it('parses TMDL: measures (multi-line and fenced), columns, calculated columns, relationships', () => {
    const pm = parseTmdl([salesTmdl, productTmdl, relTmdl]);
    const sales = pm.tables.find((t) => t.name === 'Sales')!;
    expect(sales.measures.map((m) => m.name)).toEqual(['Total Sales', 'Margin', 'Total Profit', 'Fancy']);
    expect(sales.measures[0]).toMatchObject({ expression: 'SUM(Sales[Amount])', formatString: '\\$#,0', displayFolder: 'KPIs' });
    expect(sales.measures[1].expression.replace(/\s+/g, ' ')).toBe('DIVIDE( [Total Profit], [Total Sales] )');
    expect(sales.measures[2].expression).toBe('SUMX(Sales, Sales[Amount] - Sales[Cost])');
    expect(sales.columns.find((c) => c.name === 'Cost')).toMatchObject({ dataType: 'decimal', isHidden: true });
    expect(sales.columns.find((c) => c.name === 'Big Order')?.expression).toBe('IF(Sales[Amount] > 100, "Yes", "No")');
    expect(pm.relationships[0]).toMatchObject({ fromTable: 'Sales', fromColumn: 'ProductKey', toTable: 'Product', toColumn: 'ProductKey' });
    expect(pm.relationships[1]).toMatchObject({ toTable: 'Missing Table', isActive: false });
  });

  it('imports a .pbip project into a working model and report, with clear warnings', () => {
    const { model, report, warnings } = importPowerBI(project(), { data });
    expect(model.evaluate('[Total Sales]')).toBe(400);
    expect(model.evaluate('[Margin]')).toBeCloseTo(190 / 400, 9);
    expect(model.measure('Total Sales').format).toBe('$#,0');
    expect(model.table('Sales').column('Big Order').values).toEqual(['Yes', 'No', 'Yes']);
    expect(model.table('Sales').column('OrderDate').type).toBe('date');
    expect(model.query({ groupBy: ['Product[Category]'], values: ['Total Sales'] }).rows.map((r) => r.values[0])).toEqual([320, 80]);
    // report: pages, mapped visuals and grid positions
    expect(report.pages[0].name).toBe('Overview');
    const [v1, v2, v3] = report.pages[0].visuals;
    expect(v1).toMatchObject({ type: 'clusteredColumn', layout: { x: 0, y: 0, w: 6, h: 6 }, fields: { category: ['Product[Category]'], values: ['Total Sales'] } });
    expect(v2).toMatchObject({ type: 'card', title: 'Margin', fields: { value: 'Margin' }, layout: { x: 6, w: 3 } });
    expect(v3).toMatchObject({ type: 'lineClusteredColumn', fields: { values: [{ field: 'Sales[Amount]', aggregation: 'avg' }], lineValues: ['Total Profit'] } });
    expect(report.pages[0].visuals).toHaveLength(3);
    expect(warnings.join('\n')).toMatch(/someCustomVisual123 is not supported/);
    expect(warnings.join('\n')).toMatch(/Measure \[Fancy\]/);
    expect(warnings.join('\n')).toMatch(/Relationship Sales\[OrderDate\] → Missing Table\[Date\]/);
    // and it renders
    const el = document.createElement('div');
    el.style.height = '700px';
    document.body.append(el);
    const r = new Report(el, { model, ...report });
    r.flush();
    expect(el.querySelectorAll('.pbi-error')).toHaveLength(0);
    expect(el.querySelector('[data-visual-id="v2"] .pbi-card-value')?.textContent).toBe('47.5%');
    r.destroy();
    el.remove();
  });

  it('creates empty typed tables without data, and reads model.bim and legacy report.json', () => {
    const empty = importPowerBI(project());
    expect(empty.model.table('Sales').rowCount).toBe(0);
    expect(empty.model.table('Sales').column('Amount').type).toBe('number');
    expect(empty.warnings.some((w) => /No data for table "Sales"/.test(w))).toBe(true);

    const bim = {
      model: {
        tables: [
          { name: 'Sales', columns: [{ name: 'Amount', dataType: 'double' }, { name: 'Region', dataType: 'string' }], measures: [{ name: 'Revenue', expression: ['SUM(', 'Sales[Amount])'], formatString: '#,0' }] },
        ],
        relationships: [],
      },
    };
    const layout = {
      sections: [
        {
          name: 'ReportSection1',
          displayName: 'Page 1',
          width: 1280,
          visualContainers: [
            {
              x: 0,
              y: 0,
              width: 640,
              height: 360,
              config: JSON.stringify({
                name: 'pie1',
                singleVisual: {
                  visualType: 'pieChart',
                  projections: { Category: [{ queryRef: 'Sales.Region' }], Y: [{ queryRef: 'Sales.Revenue' }] },
                  prototypeQuery: { From: [{ Name: 's', Entity: 'Sales' }], Select: [{ Column: { Expression: { SourceRef: { Source: 's' } }, Property: 'Region' }, Name: 'Sales.Region' }, { Measure: { Expression: { SourceRef: { Source: 's' } }, Property: 'Revenue' }, Name: 'Sales.Revenue' }] },
                },
              }),
            },
          ],
        },
      ],
    };
    const res = importPowerBI({ 'Old.Dataset/model.bim': JSON.stringify(bim), 'Old.Report/report.json': JSON.stringify(layout) }, { data: { Sales: [{ Amount: 5, Region: 'N' }, { Amount: 7, Region: 'S' }] } });
    expect(res.model.evaluate('[Revenue]')).toBe(12);
    expect(res.report.pages[0].visuals[0]).toMatchObject({ id: 'pie1', type: 'pie', fields: { legend: ['Sales[Region]'], values: ['Revenue'] } });
    expect(res.warnings).toEqual([]);
  });
});

describe('Power BI calculation groups', () => {
  const tiTmdl = `table 'Time Intelligence'
	lineageTag: 9

	calculationGroup
		precedence: 2

		calculationItem Current = SELECTEDMEASURE()

		calculationItem 'Double' =
				SELECTEDMEASURE() * 2
			ordinal: 2

		calculationItem Share = DIVIDE(SELECTEDMEASURE(), CALCULATE(SELECTEDMEASURE(), ALL(Product)))
			formatStringDefinition = "0.0%"
			ordinal: 1

		calculationItem Labelled = SELECTEDMEASURE()
			formatStringDefinition = SELECTEDMEASUREFORMATSTRING() & " (x)"
			ordinal: 3

	column 'Time Calc'
		dataType: string
		sourceColumn: Name
		sortByColumn: Ordinal

	column Ordinal
		dataType: int64
		isHidden
		sourceColumn: Ordinal
`;

  it('parses TMDL calculation groups and builds them with formats', () => {
    const pm = parseTmdl([salesTmdl, productTmdl, relTmdl, tiTmdl]);
    const ti = pm.tables.find((t) => t.name === 'Time Intelligence')!;
    expect(ti.calculationGroup).toMatchObject({ precedence: 2 });
    expect(ti.calculationGroup!.items.map((i) => [i.name, i.ordinal, i.formatStringDefinition])).toEqual([
      ['Current', undefined, undefined],
      ['Double', 2, undefined],
      ['Share', 1, '"0.0%"'],
      ['Labelled', 3, 'SELECTEDMEASUREFORMATSTRING() & " (x)"'],
    ]);
    expect(ti.calculationGroup!.items[1].expression).toBe('SELECTEDMEASURE() * 2');
    const { model, warnings } = importPowerBI({ ...project(), 'Shop.SemanticModel/definition/tables/Time Intelligence.tmdl': tiTmdl }, { data });
    expect(warnings.filter((w) => /Time Intelligence/.test(w))).toEqual([]);
    const group = model.calculationGroups().find((g) => g.table === 'Time Intelligence')!;
    expect(group.column).toBe('Time Calc');
    expect(model.table('Time Intelligence').distinct('Time Calc')).toEqual(['Current', 'Share', 'Double', 'Labelled']); // by ordinal
    const pick = (item: string) => [{ target: "'Time Intelligence'[Time Calc]", op: 'eq' as const, value: item }];
    expect(model.evaluate('[Total Sales]', pick('Double'))).toBe(800);
    const share = model.query({ groupBy: ['Product[Category]'], values: ['Total Sales'], filters: pick('Share') });
    expect(share.values[0].format).toBe('0.0%');
    expect(share.rows.find((r) => r.keys[0] === 'Bikes')!.values[0]).toBeCloseTo(0.8, 6);
    expect(model.query({ values: ['Total Sales'], filters: pick('Labelled') }).values[0].format).toBe('$#,0 (x)');
  });

  it('reads calculation groups from model.bim', async () => {
    const { parseModelBim } = await import('@prismbi/prismbi/powerbi');
    const pm = parseModelBim({ model: { tables: [{ name: 'TI', calculationGroup: { precedence: 1, calculationItems: [{ name: 'YoY %', expression: ['SELECTEDMEASURE()'], ordinal: 0, formatStringDefinition: { expression: '"0%"' } }] }, columns: [{ name: 'Name', dataType: 'string' }] }] } });
    expect(pm.tables[0].calculationGroup).toEqual({ precedence: 1, items: [{ name: 'YoY %', expression: 'SELECTEDMEASURE()', ordinal: 0, formatStringDefinition: '"0%"' }] });
  });
});

describe('aggregation tables (alternateOf)', () => {
  const aggTmdl = `table SalesAgg
	isHidden

	column ProductKey
		dataType: int64
		alternateOf
			baseColumn: Sales.ProductKey
			summarization: groupBy

	column Amount
		dataType: decimal
		alternateOf
			baseColumn: Sales.Amount
			summarization: sum

	column Rows
		dataType: int64
		alternateOf
			baseTable: Sales
			summarization: count
`;
  const aggRel = `relationship 9e3a
	fromColumn: SalesAgg.ProductKey
	toColumn: Product.ProductKey
`;
  const data = {
    Sales: [{ Amount: 5, Cost: 1, ProductKey: 1, OrderDate: new Date(2025, 0, 1) }, { Amount: 7, Cost: 2, ProductKey: 2, OrderDate: new Date(2025, 0, 2) }, { Amount: 3, Cost: 1, ProductKey: 1, OrderDate: new Date(2025, 0, 3) }],
    Product: [{ ProductKey: 1, Category: 'Bikes' }, { ProductKey: 2, Category: 'Helmets' }],
    SalesAgg: [{ ProductKey: 1, Amount: 8, Rows: 2 }, { ProductKey: 2, Amount: 7, Rows: 1 }],
  };

  it('reads TMDL alternateOf into an aggregation that answers covered queries', () => {
    const pm = parseTmdl([salesTmdl, productTmdl, relTmdl, aggTmdl, aggRel]);
    expect(pm.tables.find((t) => t.name === 'SalesAgg')!.columns.map((c) => c.alternateOf)).toEqual([
      { baseColumn: 'Sales.ProductKey', summarization: 'groupBy' },
      { baseColumn: 'Sales.Amount', summarization: 'sum' },
      { baseTable: 'Sales', summarization: 'count' },
    ]);
    const warnings: string[] = [];
    const model = buildModelFrom(pm, { data }, (w) => warnings.push(w));
    expect(warnings.filter((w) => /Aggregation/.test(w))).toEqual([]);
    expect(model.aggregations()).toEqual([{ table: 'SalesAgg', detail: 'Sales', groupBy: { ProductKey: 'ProductKey' }, columns: { Amount: { sum: 'Amount' } }, rows: 'Rows' }]);
    const r = model.query({ groupBy: ['Product[Category]'], values: ['Total Sales', { name: 'n', expression: 'COUNTROWS(Sales)' }] });
    expect(r.aggregation).toBe('SalesAgg');
    expect(r.rows.map((x) => [x.keys[0], ...x.values])).toEqual([['Bikes', 8, 2], ['Helmets', 7, 1]]);
    // by date: not covered, answered from Sales
    expect(model.query({ groupBy: ['Sales[OrderDate]'], values: ['Total Sales'] }).aggregation).toBeUndefined();
  });

  it('reads model.bim alternateOf', () => {
    const pm = parseModelBim({ model: { tables: [{ name: 'Agg', columns: [{ name: 'Amt', dataType: 'double', alternateOf: { baseColumn: { table: 'Sales', column: 'Amount' }, summarization: 'sum' } }, { name: 'N', dataType: 'int64', alternateOf: { baseTable: 'Sales', summarization: 'count' } }] }] } });
    expect(pm.tables[0].columns.map((c) => c.alternateOf)).toEqual([
      { baseColumn: 'Sales.Amount', baseTable: undefined, summarization: 'sum' },
      { baseColumn: undefined, baseTable: 'Sales', summarization: 'count' },
    ]);
  });
});
