import type { DataModel } from '../data/model';
import type { FieldSpec } from '../data/query';
import { columnRefToString } from '../data/types';
import type { PageDefinition } from '../report/report';
import type { VisualSpec } from '../visuals/types';

export interface AutoReportOptions {
  name?: string;
  /** Measures to feature (default: the first visible ones, or sums of numeric fact columns). */
  measures?: string[];
}

/**
 * Generate a sensible starter page from the model: KPI cards, a trend, category breakdowns,
 * a slicer and a detail table. Heuristics only look at metadata and distinct counts.
 */
export function autoReport(model: DataModel, opts: AutoReportOptions = {}): PageDefinition {
  const tables = model.tableNames().map((n) => model.table(n));
  const fact = [...tables].sort((a, b) => b.rowCount - a.rowCount)[0];
  // measures: explicit, else visible model measures, else implicit sums of the fact's numeric columns
  let measures: FieldSpec[] = opts.measures ?? model.measureList().filter((m) => !m.name.endsWith(' Value')).slice(0, 4).map((m) => m.name);
  if (!measures.length && fact)
    measures = [...fact.columns.values()]
      .filter((c) => c.type === 'number' && !c.hidden && !/id$|key$/i.test(c.name))
      .slice(0, 4)
      .map((c) => ({ field: columnRefToString({ table: fact.name, column: c.name }), aggregation: 'sum' as const }));
  const primary = measures[0];

  // a month-like column for the trend (date table first), else any date column
  const all = tables.flatMap((t) => [...t.columns.values()].map((c) => ({ t, c })));
  const month = all.find(({ c }) => /^(monthyear|yearmonth|month ?year)$/i.test(c.name)) ?? all.find(({ c }) => /month/i.test(c.name) && c.type === 'string');
  const dateCol = all.find(({ c }) => c.type === 'date');
  const trend = month ?? dateCol;
  const yearCol = all.find(({ c }) => /^year$/i.test(c.name));

  // categorical columns with a handful of members, preferring dimension tables
  const cats = all
    .filter(({ t, c }) => c.type === 'string' && !c.hidden && t !== fact && !/name$/i.test(c.name) && t.distinct(c.name).length >= 2 && t.distinct(c.name).length <= 24)
    .sort((a, b) => a.t.distinct(a.c.name).length - b.t.distinct(b.c.name).length);
  const catA = cats[1] ?? cats[0];
  const catB = cats.find((x) => x !== catA && x.t !== catA?.t) ?? cats.find((x) => x !== catA);
  const ref = (x?: { t: { name: string }; c: { name: string } }) => (x ? columnRefToString({ table: x.t.name, column: x.c.name }) : undefined);

  const visuals: VisualSpec[] = [];
  let y = 0;
  if (yearCol) {
    visuals.push({ type: 'slicer', title: yearCol.c.name, layout: { x: 0, y, w: 4, h: 2 }, fields: { field: ref(yearCol)! }, format: { slicer: { style: 'tiles' } } });
    if (catB) visuals.push({ type: 'slicer', title: catB.c.name, layout: { x: 4, y, w: 8, h: 2 }, fields: { field: ref(catB)! }, format: { slicer: { style: 'tiles' } } });
    y += 2;
  }
  measures.slice(0, 4).forEach((m, i, arr) => {
    const w = Math.floor(12 / arr.length);
    visuals.push({ type: 'card', layout: { x: i * w, y, w, h: 3 }, fields: { value: m } });
  });
  if (measures.length) y += 3;
  if (primary && trend) visuals.push({ type: 'line', title: `Trend by ${trend.c.name}`, layout: { x: 0, y, w: catA ? 7 : 12, h: 7 }, fields: { category: ref(trend)!, values: primary } });
  if (primary && catA) visuals.push({ type: 'clusteredBar', title: `By ${catA.c.name}`, layout: { x: trend ? 7 : 0, y, w: trend ? 5 : 12, h: 7 }, fields: { category: ref(catA)!, values: primary }, format: { dataLabels: { show: true } } });
  y += 7;
  if (primary && catB) visuals.push({ type: 'donut', title: `Share by ${catB.c.name}`, layout: { x: 0, y, w: 4, h: 7 }, fields: { legend: ref(catB)!, values: primary } });
  if (catA && measures.length)
    visuals.push({
      type: 'table',
      title: `${catA.c.name} details`,
      layout: { x: catB ? 4 : 0, y, w: catB ? 8 : 12, h: 7 },
      fields: { columns: [ref(catA)!, ...measures] },
      format: { table: { conditional: typeof primary === 'string' ? { [primary]: { dataBars: true } } : {} } },
    });
  return { name: opts.name ?? 'Overview', visuals };
}
