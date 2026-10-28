import { describe, expect, it } from 'vitest';
import { DataModel, DaxSyntaxError, parseDax } from '../src/index';
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
    expect(ev('(1, "a") IN {(1, "a"), (2, "b")}')).toBe(true);
    expect(ev('(1, "x") IN {(1, "a"), (2, "b")}')).toBe(false);
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

  it('TIME and TIMEVALUE create and parse times', () => {
    const t = ev('TIME(14, 30, 45)') as Date;
    expect(t instanceof Date).toBe(true);
    expect(t.getHours()).toBe(14);
    expect(t.getMinutes()).toBe(30);
    expect(t.getSeconds()).toBe(45);
    expect(ev('HOUR(TIME(9, 15, 0))')).toBe(9);
    expect(ev('MINUTE(TIME(9, 15, 0))')).toBe(15);
    expect(ev('SECOND(TIME(9, 15, 23))')).toBe(23);

    const tv1 = ev('TIMEVALUE("16:45:10")') as Date;
    expect(tv1.getHours()).toBe(16);
    expect(tv1.getMinutes()).toBe(45);
    expect(tv1.getSeconds()).toBe(10);

    const tv2 = ev('TIMEVALUE("2:30 PM")') as Date;
    expect(tv2.getHours()).toBe(14);
    expect(tv2.getMinutes()).toBe(30);
  });

  it('CONTAINSSTRINGEXACT performs case-sensitive matching', () => {
    expect(ev('CONTAINSSTRING("Hello World", "world")')).toBe(true);
    expect(ev('CONTAINSSTRINGEXACT("Hello World", "world")')).toBe(false);
    expect(ev('CONTAINSSTRINGEXACT("Hello World", "World")')).toBe(true);
  });

  it('CALENDARAUTO generates dates based on model date columns', () => {
    const auto = m.evaluateTable('CALENDARAUTO()');
    expect(auto.columns).toEqual(['Date']);
    expect(auto.rows.length).toBeGreaterThan(365);
    const firstDate = auto.rows[0][0] as Date;
    const lastDate = auto.rows[auto.rows.length - 1][0] as Date;
    // Model fixtures have dates in 2024 and 2025
    expect(firstDate.getFullYear()).toBe(2024);
    expect(firstDate.getMonth()).toBe(0);
    expect(firstDate.getDate()).toBe(1);
    expect(lastDate.getFullYear()).toBe(2025);
    expect(lastDate.getMonth()).toBe(11);
    expect(lastDate.getDate()).toBe(31);

    // Fiscal year ending in June (month 6)
    const fiscal = m.evaluateTable('CALENDARAUTO(6)');
    const fiscalFirst = fiscal.rows[0][0] as Date;
    const fiscalLast = fiscal.rows[fiscal.rows.length - 1][0] as Date;
    expect(fiscalFirst.getMonth()).toBe(6); // July 1
    expect(fiscalFirst.getDate()).toBe(1);
    expect(fiscalLast.getMonth()).toBe(5); // June 30
    expect(fiscalLast.getDate()).toBe(30);
  });

  it('evaluates bitwise functions BITAND, BITOR, BITXOR, BITLSHIFT, BITRSHIFT', () => {
    expect(ev('BITAND(13, 7)')).toBe(5);
    expect(ev('BITAND(0, 5)')).toBe(0);
    expect(ev('BITOR(10, 3)')).toBe(11);
    expect(ev('BITOR(0, 0)')).toBe(0);
    expect(ev('BITXOR(10, 3)')).toBe(9);
    expect(ev('BITXOR(7, 7)')).toBe(0);
    expect(ev('BITLSHIFT(4, 2)')).toBe(16);
    expect(ev('BITLSHIFT(16, -2)')).toBe(4);
    expect(ev('BITRSHIFT(16, 2)')).toBe(4);
    expect(ev('BITRSHIFT(4, -2)')).toBe(16);
    expect(ev('BITAND(4294967295, 255)')).toBe(255);
  });

  it('evaluates financial functions XNPV and XIRR', () => {
    const m = new DataModel();
    m.addTable('CashFlows', [
      { Amount: -10000, Date: new Date(2020, 0, 1) },
      { Amount: 11000, Date: new Date(2021, 0, 1) },
    ]);

    const npv = m.evaluate('XNPV(CashFlows, CashFlows[Amount], CashFlows[Date], 0.1)') as number;
    expect(Math.abs(npv)).toBeLessThan(50);

    const irr = m.evaluate('XIRR(CashFlows, CashFlows[Amount], CashFlows[Date])') as number;
    expect(irr).toBeCloseTo(0.0997, 2);

    const npvCol = m.evaluate('XNPV(CashFlows[Amount], CashFlows[Date], 0.1)') as number;
    expect(npvCol).toBeCloseTo(npv, 4);

    const irrCol = m.evaluate('XIRR(CashFlows[Amount], CashFlows[Date])') as number;
    expect(irrCol).toBeCloseTo(irr, 4);
  });

  it('evaluates CONTAINSROW table and tuple presence', () => {
    expect(ev('CONTAINSROW({(1, "a"), (2, "b")}, 1, "a")')).toBe(true);
    expect(ev('CONTAINSROW({(1, "a"), (2, "b")}, 1, "x")')).toBe(false);
    expect(ev('CONTAINSROW(Products, 1, "Road Bike", "Bikes", "Red")')).toBe(true);
    expect(ev('CONTAINSROW(Products, 999, "Road Bike", "Bikes", "Red")')).toBe(false);
  });
});
