// Every built-in visual on one page, for screenshot (visual regression) tests: /gallery.html?theme=dark
import { createVisual, listVisuals } from '@prismbi/prismbi';
import type { VisualSpec } from '@prismbi/prismbi';
import { buildModel } from './model';

type Spec = Omit<VisualSpec, 'layout'> & { key?: string };
export const GALLERY: Spec[] = [
  { type: 'clusteredColumn', fields: { category: 'Product[Category]', values: 'Total Sales' }, format: { dataLabels: { show: true } } },
  { key: 'column-error-bars', type: 'clusteredColumn', fields: { category: 'Product[Category]', values: 'Total Sales', errorLower: 'Sales Low', errorUpper: 'Sales High' } },
  { type: 'stackedColumn', fields: { category: 'Product[Category]', legend: 'Sales[Channel]', values: 'Total Sales' } },
  { type: 'percentStackedColumn', fields: { category: 'Product[Category]', legend: 'Sales[Channel]', values: 'Total Sales' } },
  { type: 'clusteredBar', fields: { category: 'Region[Region]', values: 'Total Sales' } },
  { type: 'stackedBar', fields: { category: 'Region[Group]', legend: 'Product[Category]', values: 'Total Sales' } },
  { type: 'percentStackedBar', fields: { category: 'Region[Group]', legend: 'Product[Category]', values: 'Total Sales' } },
  { type: 'line', fields: { category: 'Date[MonthYear]', values: ['Total Sales', 'Sales LY'] } },
  { key: 'line-forecast', type: 'line', fields: { category: 'Date[Date]', values: 'Total Sales' }, filters: [{ target: 'Date[Date]', op: 'between', min: new Date(2025, 8, 1), max: new Date(2025, 11, 31) }], format: { analytics: { forecast: { periods: 21 } } } },
  { type: 'area', fields: { category: 'Date[MonthShort]', values: 'Total Sales' } },
  { type: 'stackedArea', fields: { category: 'Date[YearQuarter]', legend: 'Region[Group]', values: 'Total Sales' } },
  { type: 'lineClusteredColumn', fields: { category: 'Date[MonthShort]', values: 'Total Sales', lineValues: 'Margin %' } },
  { type: 'ribbon', fields: { category: 'Date[YearQuarter]', legend: 'Product[Category]', values: 'Total Sales' } },
  { type: 'waterfall', fields: { category: 'Product[Category]', values: 'Sales Change' } },
  { type: 'pie', fields: { legend: 'Sales[Channel]', values: 'Total Sales' } },
  { type: 'donut', fields: { legend: 'Region[Group]', values: 'Total Sales' } },
  { type: 'treemap', fields: { category: 'Product[Subcategory]', values: 'Total Sales' } },
  { type: 'funnel', fields: { category: 'Sales[Channel]', values: 'Total Sales' } },
  { type: 'scatter', fields: { details: 'Product[Name]', legend: 'Product[Category]', x: 'Total Sales', y: 'Margin %', size: 'Units' } },
  { type: 'histogram', fields: { values: 'Sales[SalesAmount]' } },
  { type: 'boxPlot', fields: { category: 'Product[Category]', values: 'Sales[SalesAmount]' } },
  { type: 'bullet', fields: { category: 'Region[Group]', value: 'Total Sales', target: 'Sales Target' } },
  { type: 'radar', fields: { category: 'Sales[Channel]', legend: 'Product[Category]', values: 'Total Sales' } },
  { type: 'sankey', fields: { source: 'Sales[Channel]', target: 'Product[Category]', values: 'Total Sales' } },
  { type: 'heatmap', fields: { rows: 'Region[Region]', columns: 'Date[MonthShort]', values: 'Total Sales' } },
  { type: 'calendar', fields: { date: 'Date[Date]', values: 'Total Sales' }, filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }] },
  { type: 'map', fields: { location: 'Region[Region]', legend: 'Region[Group]', latitude: 'Region[Lat]', longitude: 'Region[Lon]', size: 'Total Sales' } },
  { type: 'decompositionTree', fields: { values: 'Total Sales', explainBy: ['Product[Category]', 'Region[Group]', 'Sales[Channel]'] } },
  { type: 'card', fields: { value: 'Total Sales', delta: 'YoY %' } },
  { type: 'multiRowCard', fields: { category: 'Region[Group]', values: ['Total Sales', 'Orders'] } },
  { type: 'kpi', fields: { trend: 'Date[MonthYear]', value: 'Total Sales', target: 'Sales Target' } },
  { type: 'gauge', fields: { value: 'Margin %' } },
  { type: 'table', fields: { columns: ['Product[Category]', 'Total Sales', 'Margin %'] } },
  { type: 'matrix', fields: { rows: 'Product[Category]', columns: 'Date[Year]', values: 'Total Sales' } },
  { key: 'slicer-tiles', type: 'slicer', fields: { field: 'Region[Group]' }, format: { slicer: { style: 'tiles' } } },
  { key: 'slicer-list', type: 'slicer', fields: { field: 'Product[Category]' } },
  { key: 'slicer-range', type: 'slicer', fields: { field: 'Date[Date]' } },
  { type: 'text', fields: { values: ['Orders', 'Units'] }, format: { text: { content: '**{{Orders}}** orders · {{Units}} units' } } },
];

const dark = new URLSearchParams(location.search).get('theme') === 'dark';
document.body.classList.toggle('dark', dark);
const model = buildModel().addMeasure('Sales Low', '[Total Sales] * 0.85').addMeasure('Sales High', '[Total Sales] * 1.2');
const grid = document.getElementById('grid')!;
const known = new Set(listVisuals());
for (const spec of GALLERY) {
  if (!known.has(spec.type)) continue;
  const key = spec.key ?? spec.type;
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.dataset.key = key;
  const h = document.createElement('h2');
  h.textContent = key;
  const vis = document.createElement('div');
  vis.className = 'vis';
  cell.append(h, vis);
  grid.append(cell);
  const { key: _k, ...rest } = spec;
  createVisual(vis, { ...(rest as VisualSpec), model, theme: dark ? 'dark' : 'light', format: { ...(rest.format ?? {}), animation: { enabled: false } } }).flush();
}
document.body.dataset.ready = 'true';
