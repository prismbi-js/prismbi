import { describe, expect, it } from 'vitest';
import { expressionRefs, impactOf, lineage, renameInExpression, renameModelField } from '../src/index';
import type { ReportDefinition } from '../src/index';
import { buildModel } from '../examples/model';

const report = (): ReportDefinition => ({
  pages: [
    {
      id: 'p',
      name: 'Overview',
      visuals: [
        { id: 'k', type: 'card', title: 'Sales', layout: { x: 0, y: 0, w: 3, h: 2 }, fields: { value: 'Total Sales' } },
        { id: 'm', type: 'card', layout: { x: 3, y: 0, w: 3, h: 2 }, fields: { value: 'Margin %' } },
        { id: 'c', type: 'clusteredColumn', layout: { x: 0, y: 2, w: 6, h: 6 }, fields: { category: 'Product[Category]', values: [{ field: 'Sales[SalesAmount]', aggregation: 'avg' }] } },
      ],
      filters: [{ target: 'Sales[SalesAmount]', op: 'gt', value: 0 }],
    },
  ],
});

describe('lineage and impact', () => {
  it('finds what expressions refer to', () => {
    const m = buildModel();
    expect(expressionRefs(m, 'DIVIDE([Total Profit], [Total Sales])').map((r) => r.name)).toEqual(['Total Profit', 'Total Sales']);
    expect(expressionRefs(m, 'SUMX(Sales, Sales[Quantity] * RELATED(Product[ListPrice]))').map((r) => `${r.kind}:${'table' in r ? r.table + '.' : ''}${r.name}`)).toEqual(['table:Sales', 'column:Sales.Quantity', 'column:Product.ListPrice']);
    const g = lineage(m, report());
    expect(g.edges).toContainEqual(['measure:Margin %', 'measure:Total Sales']);
    expect(g.edges).toContainEqual(['visual:p/k', 'measure:Total Sales']);
  });

  it('computes transitive impact up to visuals', () => {
    const m = buildModel();
    const imp = impactOf(m, { kind: 'column', table: 'Sales', name: 'SalesAmount' }, report());
    expect(imp.measures).toEqual(expect.arrayContaining(['Total Sales', 'Margin %', 'Sales YTD', 'Avg Order Value']));
    expect(imp.columns).toContain('Sales[Profit]'); // calculated column built on SalesAmount
    expect(imp.visuals.map((v) => v.visualId).sort()).toEqual(['c', 'k', 'm']);
    expect(impactOf(m, { kind: 'measure', name: 'Margin %' }, report()).visuals.map((v) => v.visualId)).toEqual(['m']);
  });

  it('rewrites references token by token (strings and other tables untouched)', () => {
    const m = buildModel();
    const src = 'IF([Total Sales] > 0, "[Total Sales] is positive", BLANK()) + Product[Total Sales]';
    expect(renameInExpression(src, { kind: 'measure', name: 'Total Sales' }, 'Revenue', m)).toBe('IF([Revenue] > 0, "[Total Sales] is positive", BLANK()) + Product[Revenue]');
    expect(renameInExpression('SUM(Sales[SalesAmount]) + SUM(Product[SalesAmount])', { kind: 'column', table: 'Sales', name: 'SalesAmount' }, 'Amount', m)).toBe('SUM(Sales[Amount]) + SUM(Product[SalesAmount])');
  });

  it('renames a measure and keeps dependents and the report working', () => {
    const m = buildModel();
    const before = m.evaluate('[Margin %]');
    const res = renameModelField(m, { kind: 'measure', name: 'Total Sales' }, 'Revenue', report());
    expect(m.hasMeasure('Total Sales')).toBe(false);
    expect(m.measure('Margin %').expression).toContain('[Revenue]');
    expect(m.evaluate('[Margin %]')).toBe(before);
    expect(res.measures).toEqual(expect.arrayContaining(['Margin %', 'Avg Order Value']));
    expect(res.report!.pages[0].visuals[0].fields).toEqual({ value: 'Revenue' });
    expect(() => renameModelField(m, { kind: 'measure', name: 'Revenue' }, 'Orders')).toThrow(/already exists/);
  });

  it('renames a column across measures, calculated columns, relationships and the report', () => {
    const m = buildModel();
    const total = m.evaluate('[Total Sales]');
    const res = renameModelField(m, { kind: 'column', table: 'Sales', name: 'SalesAmount' }, 'Amount', report());
    expect(m.table('Sales').hasColumn('SalesAmount')).toBe(false);
    expect(m.measure('Total Sales').expression).toBe('SUM(Sales[Amount])');
    expect(m.evaluate('[Total Sales]')).toBe(total);
    expect(m.table('Sales').column('Profit').expression).toContain('Sales[Amount]');
    expect(res.report!.pages[0].visuals[2].fields).toMatchObject({ values: [{ field: 'Sales[Amount]', aggregation: 'avg' }] });
    expect(res.report!.pages[0].filters).toEqual([{ target: 'Sales[Amount]', op: 'gt', value: 0 }]);
    // relationships follow a renamed key column
    renameModelField(m, { kind: 'column', table: 'Sales', name: 'ProductKey' }, 'ProdKey');
    expect(m.relationships().some((r) => r.fromColumn === 'ProdKey')).toBe(true);
    expect(m.query({ groupBy: ['Product[Category]'], values: ['Total Sales'] }).rows).toHaveLength(4);
  });
});
