import { describe, expect, it } from 'vitest';
import { DaxSyntaxError, parseDax } from '../src/index';
import { makeModel } from './fixtures';

const m = makeModel();
const ev = (e: string, f: Parameters<typeof m.evaluate>[1] = []) => m.evaluate(e, f);

describe('parser', () => {
  it('parses operators with precedence', () => {
    expect(ev('1 + 2 * 3 ^ 2')).toBe(19);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('-2 ^ 2')).toBe(4);
    expect(ev('"a" & "b" & 1')).toBe('ab1');
    expect(ev('1 < 2 && 3 >= 3 || FALSE')).toBe(true);
    expect(ev('NOT (1 = 2)')).toBe(true);
  });

  it('supports comments, quoted tables and IN lists', () => {
    expect(ev(`-- line comment
      COUNTROWS('Products') /* block */`)).toBe(5);
    expect(ev('3 IN {1, 2, 3}')).toBe(true);
  });

  it('reports syntax errors with position', () => {
    expect(() => parseDax('SUM(Sales[Amount]')).toThrow(DaxSyntaxError);
    expect(() => parseDax('1 +')).toThrow(/end of expression/);
  });
});

describe('BLANK semantics', () => {
  it('follows DAX blank arithmetic', () => {
    expect(ev('BLANK() + 1')).toBe(1);
    expect(ev('BLANK() * 5')).toBe(null);
    expect(ev('BLANK() = 0')).toBe(true);
    expect(ev('ISBLANK([Total Sales])', [{ target: 'Products[Name]', op: 'eq', value: 'Nope' }])).toBe(true);
    expect(ev('DIVIDE(1, 0)')).toBe(null);
    expect(ev('DIVIDE(1, 0, -1)')).toBe(-1);
  });
});

describe('aggregations & iterators', () => {
  it('aggregates columns', () => {
    expect(ev('SUM(Sales[Qty])')).toBe(28);
    expect(ev('AVERAGE(Sales[Amount])')).toBeCloseTo(843.75);
    expect(ev('MIN(Sales[Amount])')).toBe(50);
    expect(ev('MAX(Sales[OrderDate])')).toEqual(new Date(2025, 2, 1));
    expect(ev('DISTINCTCOUNT(Sales[ProductId])')).toBe(5);
    expect(ev('MEDIAN(Sales[Qty])')).toBe(2.5);
  });

  it('iterates with row context', () => {
    expect(ev('SUMX(Sales, Sales[Qty] * Sales[Amount])')).toBe(1000 + 6000 + 450 + 1000 + 800 + 4000 + 1250 + 50);
    expect(ev('MAXX(Products, LEN(Products[Name]))')).toBe(13);
    expect(ev('AVERAGEX(VALUES(Products[Category]), [Total Sales])')).toBeCloseTo(6750 / 3);
  });

  it('context transition in iterators', () => {
    // per-product sales, max over products
    expect(ev('MAXX(Products, [Total Sales])')).toBe(3000);
    expect(ev('COUNTROWS(FILTER(Products, [Total Sales] > 400))')).toBe(2);
  });

  it('CONCATENATEX with ordering', () => {
    expect(ev('CONCATENATEX(VALUES(Region[Name]), Region[Name], ", ")')).toBe('North, South');
    const ordered = String(ev('CONCATENATEX(Products, Products[Name], "|", [Total Sales], DESC)')).split('|');
    expect(ordered.slice(2)).toEqual(['Helmet', 'Jersey', 'Bottle']);
  });

  it('RANKX ranks within a table', () => {
    const r = ev('RANKX(ALL(Products[Name]), [Total Sales])', [{ target: 'Products[Name]', op: 'eq', value: 'Helmet' }]);
    expect(r).toBe(3);
  });
});

describe('CALCULATE', () => {
  it('overrides filters on the same column', () => {
    expect(ev('CALCULATE([Total Sales], Products[Category] = "Bikes")', [{ target: 'Products[Category]', op: 'eq', value: 'Clothing' }])).toBe(6000);
  });

  it('accepts complex boolean filters on one column', () => {
    expect(ev('CALCULATE([Total Sales], Products[Color] = "Red" || Products[Color] = "Blue")')).toBe(1000 + 150 + 100 + 200 + 2000 + 250 + 50);
    expect(ev('CALCULATE([Orders], Sales[Amount] >= 1000)')).toBe(3);
    expect(ev('CALCULATE([Orders], Products[Category] IN {"Bikes", "Clothing"})')).toBe(5);
  });

  it('removes filters with ALL / REMOVEFILTERS', () => {
    const f = [{ target: 'Products[Category]', op: 'eq' as const, value: 'Bikes' }];
    expect(ev('CALCULATE([Total Sales], ALL(Products))', f)).toBe(6750);
    expect(ev('CALCULATE([Total Sales], REMOVEFILTERS(Products[Category]))', f)).toBe(6750);
    expect(ev('DIVIDE([Total Sales], CALCULATE([Total Sales], ALL(Products)))', f)).toBeCloseTo(6000 / 6750);
  });

  it('ALLEXCEPT keeps the listed columns', () => {
    const f = [
      { target: 'Products[Category]', op: 'eq' as const, value: 'Bikes' },
      { target: 'Products[Color]', op: 'eq' as const, value: 'Red' },
    ];
    expect(ev('CALCULATE([Total Sales], ALLEXCEPT(Products, Products[Category]))', f)).toBe(6000);
  });

  it('KEEPFILTERS intersects instead of overriding', () => {
    const f = [{ target: 'Products[Category]', op: 'eq' as const, value: 'Clothing' }];
    expect(ev('CALCULATE([Total Sales], KEEPFILTERS(Products[Category] = "Bikes"))', f)).toBe(null);
  });

  it('ALLSELECTED removes only grouping filters', () => {
    const r = m.query({
      groupBy: ['Products[Category]'],
      values: [{ expression: 'DIVIDE([Total Sales], CALCULATE([Total Sales], ALLSELECTED(Products)))', name: 'Share' }],
      filters: [{ target: 'Products[Category]', op: 'in', values: ['Bikes', 'Clothing'] }],
    });
    const bikes = r.rows.find((x) => x.keys[0] === 'Bikes')!.values[0] as number;
    expect(bikes).toBeCloseTo(6000 / 6250);
  });

  it('accepts FILTER table arguments', () => {
    expect(ev('CALCULATE([Orders], FILTER(Sales, Sales[Qty] > 2))')).toBe(4);
  });
});

describe('VAR / RETURN, logic and text', () => {
  it('supports variables', () => {
    expect(ev('VAR s = [Total Sales] VAR c = [Total Cost] RETURN DIVIDE(s - c, s)')).toBeCloseTo((6750 - 4615) / 6750);
  });

  it('IF / SWITCH / COALESCE', () => {
    expect(ev('IF([Total Sales] > 1000, "big", "small")')).toBe('big');
    expect(ev('SWITCH(2, 1, "one", 2, "two", "other")')).toBe('two');
    expect(ev('SWITCH(TRUE(), 5 > 10, "a", 5 > 3, "b", "c")')).toBe('b');
    expect(ev('COALESCE(BLANK(), BLANK(), 7)')).toBe(7);
  });

  it('text and math functions', () => {
    expect(ev('UPPER(LEFT("prism", 3))')).toBe('PRI');
    expect(ev('SUBSTITUTE("a-b-c", "-", "+")')).toBe('a+b+c');
    expect(ev('ROUND(2.345, 2)')).toBe(2.35);
    expect(ev('ROUND(-2.5, 0)')).toBe(-3);
    expect(ev('FORMAT(0.256, "0.0%")')).toBe('25.6%');
    expect(ev('MOD(-7, 3)')).toBe(2);
  });

  it('SELECTEDVALUE / HASONEVALUE / ISFILTERED', () => {
    const f = [{ target: 'Products[Category]', op: 'eq' as const, value: 'Bikes' }];
    expect(ev('SELECTEDVALUE(Products[Category], "many")', f)).toBe('Bikes');
    expect(ev('SELECTEDVALUE(Products[Category], "many")')).toBe('many');
    expect(ev('HASONEVALUE(Products[Category])', f)).toBe(true);
    expect(ev('ISFILTERED(Products[Category])', f)).toBe(true);
    expect(ev('ISFILTERED(Region[Name])', f)).toBe(false);
  });

  it('date functions', () => {
    expect(ev('YEAR(DATE(2024, 7, 4))')).toBe(2024);
    expect(ev('DATEDIFF(DATE(2024,1,1), DATE(2024,3,1), MONTH)')).toBe(2);
    expect(ev('EOMONTH(DATE(2024,2,10), 0)')).toEqual(new Date(2024, 1, 29));
    expect(ev('DATE(2024,1,31) + 1')).toEqual(new Date(2024, 1, 1));
  });
});

describe('time intelligence', () => {
  const y2025 = [{ target: 'Date[Year]', op: 'eq' as const, value: 2025 }];
  it('SAMEPERIODLASTYEAR', () => {
    expect(ev('CALCULATE([Total Sales], SAMEPERIODLASTYEAR(Date[Date]))', y2025)).toBe(4450);
  });

  it('DATEADD by month and year', () => {
    const feb2024 = [
      { target: 'Date[Year]', op: 'eq' as const, value: 2024 },
      { target: 'Date[Month]', op: 'eq' as const, value: 'March' },
    ];
    expect(ev('CALCULATE([Total Sales], DATEADD(Date[Date], -1, MONTH))', feb2024)).toBe(3150);
    expect(ev('CALCULATE([Total Sales], DATEADD(Date[Date], -1, YEAR))', y2025)).toBe(4450);
  });

  it('TOTALYTD / DATESYTD', () => {
    const mar2024 = [
      { target: 'Date[Year]', op: 'eq' as const, value: 2024 },
      { target: 'Date[Month]', op: 'eq' as const, value: 'February' },
    ];
    expect(ev('TOTALYTD([Total Sales], Date[Date])', mar2024)).toBe(4150);
    expect(ev('CALCULATE([Total Sales], DATESYTD(Date[Date]))', mar2024)).toBe(4150);
  });

  it('PREVIOUSYEAR and DATESBETWEEN', () => {
    expect(ev('CALCULATE([Total Sales], PREVIOUSYEAR(Date[Date]))', y2025)).toBe(4450);
    expect(ev('CALCULATE([Total Sales], DATESBETWEEN(Date[Date], DATE(2024,2,1), DATE(2024,2,29)))')).toBe(3150);
  });
});

describe('errors', () => {
  it('detects circular measures', () => {
    const mm = makeModel().addMeasure('A', '[B] + 1').addMeasure('B', '[A] + 1');
    expect(() => mm.evaluate('[A]')).toThrow(/Circular/);
  });

  it('explains bare columns outside row context', () => {
    expect(() => ev('Sales[Amount] + 1')).toThrow(/single value/);
  });

  it('names unsupported functions', () => {
    expect(() => ev('NOTAFUNCTION(1, 2)')).toThrow(/not supported/);
  });
});

describe('found by importing a real Power BI project', () => {
  it('table constructors with row tuples, as field parameters use them', () => {
    const t = m.evaluateTable('{ ("Sales", NAMEOF([Total Sales]), 0), ("Region", NAMEOF(Sales[Region]), 1) }');
    expect(t.columns).toEqual(['Value1', 'Value2', 'Value3']);
    expect(t.rows).toEqual([['Sales', '[Total Sales]', 0], ['Region', "'Sales'[Region]", 1]]);
    expect(m.evaluateTable('{ 1, 2 }').columns).toEqual(['Value']);
    expect(ev('(1 + 2) * 3')).toBe(9); // a parenthesized expression is still an expression
    expect(() => m.evaluateTable('{ (1, 2), (3) }')).toThrow();
  });

  it('DATESINPERIOD: n intervals back from (or forward from) a date, within the column', async () => {
    const { buildModel } = await import('../examples/model');
    const model = buildModel();
    const dates = (expr: string) => model.evaluateTable(expr).rows.map((r) => (r[0] as Date).toISOString().slice(0, 10));
    const back = dates('DATESINPERIOD(Date[Date], DATE(2025, 3, 31), -3, MONTH)');
    expect(back[0]).toBe(new Date(2025, 0, 1).toISOString().slice(0, 10));
    expect(back[back.length - 1]).toBe(new Date(2025, 2, 31).toISOString().slice(0, 10));
    expect(back).toHaveLength(90);
    const fwd = dates('DATESINPERIOD(Date[Date], DATE(2025, 12, 30), 7, DAY)');
    expect(fwd).toHaveLength(2); // the column ends on Dec 31
    // a rolling 3-month measure, as in the sample project
    model.addMeasure('Sales 3M', 'CALCULATE([Total Sales], DATESINPERIOD(Date[Date], MAX(Date[Date]), -3, MONTH))');
    const q = model.query({ groupBy: ['Date[MonthNumber]'], values: ['Sales 3M', 'Total Sales'], filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }] });
    const march = q.rows.find((r) => r.keys[0] === 3)!;
    const q1 = q.rows.filter((r) => (r.keys[0] as number) <= 3).reduce((a, r) => a + (r.values[1] as number), 0);
    expect(march.values[0] as number).toBeCloseTo(q1, 6);
  });
});
