import { DataModel, Report } from 'prismbi';
import type { Bookmark } from 'prismbi';
import { makeSales, products, regions } from './data';

// ---------------------------------------------------------------- model
const t0 = performance.now();
const sales = makeSales();

const model = new DataModel()
  .addTable('Sales', sales, { SalesAmount: { format: '$#,0.00' }, TotalCost: { format: '$#,0.00' }, ProductKey: { hidden: true }, RegionKey: { hidden: true } })
  .addTable('Product', products, { ProductKey: { hidden: true }, ListPrice: { format: '$#,0' } })
  .addTable('Region', regions, { RegionKey: { hidden: true } })
  .addDateTable('Date', '2024-01-01', '2025-12-31')
  .addRelationship({ from: 'Sales[ProductKey]', to: 'Product[ProductKey]' })
  .addRelationship({ from: 'Sales[RegionKey]', to: 'Region[RegionKey]' })
  .addRelationship({ from: 'Sales[OrderDate]', to: 'Date[Date]' })
  .addCalculatedColumn('Sales', 'Profit', 'Sales[SalesAmount] - Sales[TotalCost]', { format: '$#,0' })
  .addMeasure('Total Sales', 'SUM(Sales[SalesAmount])', { format: '$#,0' })
  .addMeasure('Total Profit', 'SUM(Sales[Profit])', { format: '$#,0' })
  .addMeasure('Margin %', 'DIVIDE([Total Profit], [Total Sales])', { format: '0.0%' })
  .addMeasure('Orders', 'DISTINCTCOUNT(Sales[OrderNumber])', { format: '#,0' })
  .addMeasure('Units', 'SUM(Sales[Quantity])', { format: '#,0' })
  .addMeasure('Avg Order Value', 'DIVIDE([Total Sales], [Orders])', { format: '$#,0.00' })
  .addMeasure('Sales LY', 'CALCULATE([Total Sales], SAMEPERIODLASTYEAR(Date[Date]))', { format: '$#,0' })
  .addMeasure('YoY %', 'IF(ISBLANK([Sales LY]), BLANK(), DIVIDE([Total Sales] - [Sales LY], [Sales LY]))', { format: '0.0%' })
  .addMeasure('Sales YTD', 'TOTALYTD([Total Sales], Date[Date])', { format: '$#,0' })
  .addMeasure('Sales Target', '[Sales LY] * 1.1', { format: '$#,0' })
  .addMeasure('Share of Category', 'DIVIDE([Total Sales], CALCULATE([Total Sales], ALLSELECTED(Product)))', { format: '0.0%' });
const modelMs = performance.now() - t0;

// ---------------------------------------------------------------- report
const report = new Report(document.getElementById('app')!, {
  model,
  name: 'Adventure Sales',
  chrome: { filterPane: 'closed' },
  filters: [],
  pages: [
    {
      id: 'overview',
      name: 'Overview',
      layout: { columns: 12, rowHeight: 40 },
      visuals: [
        { id: 'year', type: 'slicer', title: 'Year', layout: { x: 0, y: 0, w: 3, h: 2 }, fields: { field: 'Date[Year]' }, format: { slicer: { style: 'tiles', single: true } } },
        { id: 'region', type: 'slicer', title: 'Region', layout: { x: 3, y: 0, w: 6, h: 2 }, fields: { field: 'Region[Region]' }, format: { slicer: { style: 'tiles' } } },
        { id: 'channel', type: 'slicer', title: 'Channel', layout: { x: 9, y: 0, w: 3, h: 2 }, fields: { field: 'Sales[Channel]' }, format: { slicer: { style: 'dropdown' } } },

        { id: 'k-sales', type: 'card', title: 'Total sales', layout: { x: 0, y: 2, w: 3, h: 3 }, fields: { value: 'Total Sales', delta: 'YoY %' }, format: { card: { deltaLabel: 'vs last year' } } },
        { id: 'k-profit', type: 'card', title: 'Profit', layout: { x: 3, y: 2, w: 3, h: 3 }, fields: { value: 'Total Profit' } },
        { id: 'k-margin', type: 'card', title: 'Margin', layout: { x: 6, y: 2, w: 3, h: 3 }, fields: { value: 'Margin %' } },
        { id: 'k-aov', type: 'card', title: 'Avg order value', layout: { x: 9, y: 2, w: 3, h: 3 }, fields: { value: 'Avg Order Value' } },

        {
          id: 'by-cat',
          type: 'clusteredColumn',
          title: 'Sales by category',
          layout: { x: 0, y: 5, w: 5, h: 7 },
          fields: { category: ['Product[Category]', 'Product[Subcategory]', 'Product[Name]'], values: 'Total Sales' },
          format: { title: { subtitle: 'Double-click a column to drill down' }, dataLabels: { show: true } },
        },
        {
          id: 'trend',
          type: 'line',
          title: 'Monthly sales vs last year',
          layout: { x: 5, y: 5, w: 7, h: 7 },
          fields: { category: ['Date[MonthShort]'], values: ['Total Sales', 'Sales LY'] },
        },
        { id: 'by-region', type: 'donut', title: 'Sales by region group', layout: { x: 0, y: 12, w: 4, h: 7 }, fields: { legend: 'Region[Group]', values: 'Total Sales' } },
        {
          id: 'detail',
          type: 'table',
          title: 'Category details',
          layout: { x: 4, y: 12, w: 8, h: 7 },
          fields: { columns: ['Product[Category]', 'Total Sales', 'Total Profit', 'Margin %', 'YoY %', 'Share of Category'] },
          format: { table: { conditional: { 'Total Sales': { dataBars: true }, 'YoY %': { icons: true }, 'Margin %': { background: true } } } },
        },
      ],
    },
    {
      id: 'products',
      name: 'Products',
      layout: { columns: 12, rowHeight: 40 },
      visuals: [
        { id: 'p-cat', type: 'slicer', title: 'Category', layout: { x: 0, y: 0, w: 3, h: 6 }, fields: { field: 'Product[Category]' } },
        { id: 'p-date', type: 'slicer', title: 'Order date', layout: { x: 0, y: 6, w: 3, h: 3 }, fields: { field: 'Date[Date]' }, format: { slicer: { style: 'between' } } },
        { id: 'p-top', type: 'clusteredBar', title: 'Top 10 products', layout: { x: 3, y: 0, w: 5, h: 9 }, fields: { category: 'Product[Name]', values: 'Total Sales' }, top: 10, format: { dataLabels: { show: true } } },
        { id: 'p-scatter', type: 'scatter', title: 'Margin vs sales', layout: { x: 8, y: 0, w: 4, h: 9 }, fields: { details: 'Product[Name]', legend: 'Product[Category]', x: 'Total Sales', y: 'Margin %', size: 'Units' } },
        { id: 'p-tree', type: 'treemap', title: 'Sales by subcategory', layout: { x: 0, y: 9, w: 6, h: 7 }, fields: { category: 'Product[Subcategory]', values: 'Total Sales' } },
        { id: 'p-stack', type: 'stackedColumn', title: 'Channel mix by category', layout: { x: 6, y: 9, w: 6, h: 7 }, fields: { category: 'Product[Category]', legend: 'Sales[Channel]', values: 'Total Sales' } },
      ],
    },
    {
      id: 'analysis',
      name: 'Analysis',
      layout: { columns: 12, rowHeight: 40 },
      visuals: [
        { id: 'a-rel', type: 'slicer', title: 'Order date (relative)', layout: { x: 0, y: 0, w: 4, h: 2 }, fields: { field: 'Date[Date]' }, format: { slicer: { style: 'relative', relative: { anchor: 'last', n: 6, unit: 'months' } } } },
        { id: 'a-kpi', type: 'kpi', title: 'Sales vs target', layout: { x: 4, y: 0, w: 4, h: 4 }, fields: { trend: 'Date[MonthYear]', value: 'Total Sales', target: 'Sales Target' } },
        { id: 'a-gauge', type: 'gauge', title: 'Margin', layout: { x: 8, y: 0, w: 4, h: 4 }, fields: { value: 'Margin %' }, format: { title: { show: true } } },
        { id: 'a-text', type: 'text', layout: { x: 0, y: 2, w: 4, h: 2 }, fields: { values: ['Orders', 'Units'] }, format: { text: { content: '**{{Orders}}** orders · **{{Units}}** units in the current selection.' } } },
        {
          id: 'a-matrix',
          type: 'matrix',
          title: 'Sales by category and year',
          layout: { x: 0, y: 4, w: 8, h: 9 },
          fields: { rows: ['Product[Category]', 'Product[Subcategory]', 'Product[Name]'], columns: 'Date[Year]', values: ['Total Sales', 'Margin %'] },
          format: { matrix: { conditional: { 'Total Sales': { dataBars: true } } } },
        },
        { id: 'a-funnel', type: 'funnel', title: 'Sales by channel', layout: { x: 8, y: 4, w: 4, h: 4 }, fields: { category: 'Sales[Channel]', values: 'Total Sales' } },
        { id: 'a-area', type: 'stackedArea', title: 'Sales by region group', layout: { x: 8, y: 8, w: 4, h: 5 }, fields: { category: 'Date[YearQuarter]', legend: 'Region[Group]', values: 'Total Sales' } },
      ],
    },
  ],
});

// ---------------------------------------------------------------- demo chrome
const stats = document.getElementById('stats')!;
let renders = 0;
let renderMs = 0;
report.on('rendered', (e) => {
  renders++;
  renderMs += e.ms;
  stats.textContent = `${sales.length.toLocaleString()} rows · model ${modelMs.toFixed(0)} ms · last frame ${renders} visuals in ${renderMs.toFixed(0)} ms`;
  queueMicrotask(() => {
    renders = 0;
    renderMs = 0;
  });
});
report.on('selectionChanged', (e) => console.log('selection', e.filters));
report.on('filtersChanged', (e) => console.log('filters', e.scope, e.filters));
report.on('error', (e) => console.error(e.visualId, e.error));

let dark = matchMedia('(prefers-color-scheme: dark)').matches;
const applyTheme = () => {
  report.setTheme(dark ? 'dark' : 'light');
  document.body.classList.toggle('dark', dark);
};
applyTheme();
document.getElementById('theme')!.addEventListener('click', () => {
  dark = !dark;
  applyTheme();
});

let saved: Bookmark | null = null;
const restore = document.getElementById('restore') as HTMLButtonElement;
document.getElementById('bookmark')!.addEventListener('click', () => {
  saved = report.captureBookmark('My view');
  restore.disabled = false;
});
restore.addEventListener('click', () => saved && report.applyBookmark(saved));
document.getElementById('json')!.addEventListener('click', () => console.log(JSON.stringify(report.toJSON(), null, 2)));

Object.assign(window, { report, model });

// open on the latest year so "vs last year" comparisons are meaningful
report.setSlicerSelection('year', [{ target: 'Date[Year]', op: 'in', values: [2025] }]);
