import { registerModel, type PrismReportElement } from 'prismbi/elements';
import { buildModel } from './model';

const report = document.getElementById('report') as PrismReportElement;
// objects go in as properties; everything else can be attributes
report.definition = {
  name: 'Embedded report',
  pages: [
    {
      name: 'Overview',
      visuals: [
        { id: 'year', type: 'slicer', title: 'Year', layout: { x: 0, y: 0, w: 4, h: 2 }, fields: { field: 'Date[Year]' }, format: { slicer: { style: 'tiles' } } },
        { id: 'cat', type: 'clusteredColumn', title: 'Sales by category', layout: { x: 0, y: 2, w: 6, h: 8 }, fields: { category: 'Product[Category]', values: 'Total Sales' } },
        { id: 'tbl', type: 'table', title: 'Top products', layout: { x: 6, y: 0, w: 6, h: 10 }, fields: { columns: ['Product[Name]', 'Total Sales', 'Margin %'] }, top: 15, sort: { field: 'Total Sales', direction: 'desc' } },
      ],
    },
  ],
};
report.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
report.addEventListener('dataPointClick', (e) => {
  const d = (e as CustomEvent).detail;
  document.getElementById('log')!.textContent = `dataPointClick → ${d.visualId}: ${d.keys.join(' · ')}`;
});
// registering the model mounts every element that names it
registerModel('sales', buildModel());
