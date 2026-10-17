import { DataModel } from 'prismbi/core';
import type { Row } from 'prismbi/core';

/** Synthetic star schema shared by the scale demo page and its worker. */
let seed = 42;
// mulberry32: a plain LCG leaves visible stripes in the customer/order distribution
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const CATEGORIES = ['Bikes', 'Components', 'Clothing', 'Accessories', 'Services', 'Parts'];
const COUNTRIES = ['USA', 'Canada', 'Germany', 'France', 'UK', 'Australia'];
const SEGMENTS = ['Consumer', 'Small business', 'Enterprise'];
export const CUSTOMERS = 8000;

const products = Array.from({ length: 300 }, (_, i) => ({ ProductKey: i, Product: `P-${String(i).padStart(3, '0')}`, Category: CATEGORIES[i % CATEGORIES.length], Price: 5 + Math.round(rnd() * 1500) }));
const customers = Array.from({ length: CUSTOMERS }, (_, i) => ({ CustomerKey: i, Customer: `C-${String(i).padStart(5, '0')}`, Country: COUNTRIES[Math.floor(rnd() * COUNTRIES.length)], Segment: SEGMENTS[Math.floor(rnd() ** 1.6 * SEGMENTS.length)] }));

let tick = 0;
export function makeRows(n: number): Row[] {
  const out: Row[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = products[Math.floor(rnd() * products.length)];
    const c = Math.floor(rnd() ** 1.3 * CUSTOMERS);
    const qty = 1 + Math.floor(rnd() * 4);
    // a seasonal wave plus noise, so the dense line has visible shape
    const t = tick++;
    const wave = 1 + 0.35 * Math.sin(t / 4000) + 0.15 * Math.sin(t / 650);
    out[i] = { Tick: Math.floor(t / 50), OrderId: Math.floor(t / 3), ProductKey: p.ProductKey, CustomerKey: c, Quantity: qty, Amount: Math.round(p.Price * qty * wave * (0.8 + rnd() * 0.4) * 100) / 100 };
  }
  return out;
}

export function buildModel(n: number): DataModel {
  // fixed seed: the page and the worker build identical models
  seed = 1234;
  tick = 0;
  return new DataModel()
    .addTable('Sales', makeRows(n), { Amount: { format: '$#,0.00' }, ProductKey: { hidden: true }, CustomerKey: { hidden: true } })
    .addTable('Product', products, { ProductKey: { hidden: true }, Price: { format: '$#,0' } })
    .addTable('Customer', customers, { CustomerKey: { hidden: true } })
    .addRelationship({ from: 'Sales[ProductKey]', to: 'Product[ProductKey]' })
    .addRelationship({ from: 'Sales[CustomerKey]', to: 'Customer[CustomerKey]' })
    .addMeasure('Sales', 'SUM(Sales[Amount])', { format: '$#,0' })
    .addMeasure('Orders', 'DISTINCTCOUNT(Sales[OrderId])', { format: '#,0' })
    .addMeasure('Rows', 'COUNTROWS(Sales)', { format: '#,0' })
    .addMeasure('Avg Order', 'DIVIDE([Sales], [Orders])', { format: '$#,0.00' });
}

