/** Deterministic sample data: a bike retailer with ~30k order lines over two years. */

let seed = 42;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T,>(xs: T[], w?: number[]) => {
  if (!w) return xs[Math.floor(rnd() * xs.length)];
  const total = w.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < xs.length; i++) if ((r -= w[i]) <= 0) return xs[i];
  return xs[xs.length - 1];
};

const catalog: [string, string, string, number, number][] = [
  // name, category, subcategory, price, margin
  ['Road-150', 'Bikes', 'Road Bikes', 3578, 0.24],
  ['Road-650', 'Bikes', 'Road Bikes', 1450, 0.2],
  ['Mountain-200', 'Bikes', 'Mountain Bikes', 2295, 0.26],
  ['Mountain-500', 'Bikes', 'Mountain Bikes', 565, 0.18],
  ['Touring-1000', 'Bikes', 'Touring Bikes', 2385, 0.22],
  ['Touring-3000', 'Bikes', 'Touring Bikes', 742, 0.17],
  ['HL Road Frame', 'Components', 'Frames', 1432, 0.31],
  ['ML Mountain Frame', 'Components', 'Frames', 348, 0.29],
  ['HL Crankset', 'Components', 'Cranksets', 405, 0.35],
  ['Road Tire Tube', 'Components', 'Tires', 4, 0.5],
  ['HL Mountain Tire', 'Components', 'Tires', 35, 0.42],
  ['Long-Sleeve Jersey', 'Clothing', 'Jerseys', 50, 0.44],
  ['Classic Vest', 'Clothing', 'Vests', 64, 0.46],
  ['Half-Finger Gloves', 'Clothing', 'Gloves', 24, 0.5],
  ['Cycling Cap', 'Clothing', 'Caps', 9, 0.55],
  ['Sport-100 Helmet', 'Accessories', 'Helmets', 35, 0.48],
  ['Water Bottle', 'Accessories', 'Bottles', 5, 0.6],
  ['Bike Wash', 'Accessories', 'Cleaners', 8, 0.58],
  ['Hydration Pack', 'Accessories', 'Hydration', 55, 0.45],
  ['All-Purpose Bike Stand', 'Accessories', 'Stands', 159, 0.38],
];

export const products = catalog.map(([Name, Category, Subcategory, Price, Margin], i) => ({ ProductKey: i + 1, Name, Category, Subcategory, ListPrice: Price, StdMargin: Margin }));

export const regions = [
  { RegionKey: 1, Region: 'Northwest', Country: 'United States', Group: 'North America', Lat: 47.61, Lon: -122.33 },
  { RegionKey: 2, Region: 'Southwest', Country: 'United States', Group: 'North America', Lat: 34.05, Lon: -118.24 },
  { RegionKey: 3, Region: 'Canada', Country: 'Canada', Group: 'North America', Lat: 43.65, Lon: -79.38 },
  { RegionKey: 4, Region: 'Germany', Country: 'Germany', Group: 'Europe', Lat: 50.11, Lon: 8.68 },
  { RegionKey: 5, Region: 'United Kingdom', Country: 'United Kingdom', Group: 'Europe', Lat: 51.51, Lon: -0.13 },
  { RegionKey: 6, Region: 'Australia', Country: 'Australia', Group: 'Pacific', Lat: -33.87, Lon: 151.21 },
];

const channels = ['Online', 'Reseller', 'Store'];
const season = [0.7, 0.72, 0.86, 0.95, 1.08, 1.18, 1.22, 1.15, 1.0, 0.94, 1.08, 1.32];

export function makeSales(): Record<string, unknown>[] {
  seed = 42;
  const rows: Record<string, unknown>[] = [];
  const start = new Date(2024, 0, 1);
  let order = 50000;
  for (let day = 0; day < 731; day++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day);
    const growth = 1 + day / 731 * 0.18;
    const n = Math.round(38 * season[d.getMonth()] * growth * (0.8 + rnd() * 0.4));
    for (let k = 0; k < n; k++) {
      const p = pick(products, products.map((x) => (x.Category === 'Bikes' ? 1.2 : x.Category === 'Accessories' ? 2.6 : 1.6)));
      const r = pick(regions, [1.4, 1.6, 0.9, 1.0, 1.0, 1.1]);
      const qty = p.ListPrice > 500 ? 1 : 1 + Math.floor(rnd() * 4);
      const discount = rnd() < 0.15 ? 0.1 : 0;
      const amount = Math.round(p.ListPrice * qty * (1 - discount) * 100) / 100;
      rows.push({
        OrderNumber: `SO${order++}`,
        OrderDate: d,
        ProductKey: p.ProductKey,
        RegionKey: r.RegionKey,
        Channel: pick(channels, [3, 2, 1]),
        Quantity: qty,
        SalesAmount: amount,
        TotalCost: Math.round(amount * (1 - p.StdMargin * (0.9 + rnd() * 0.2)) * 100) / 100,
      });
    }
  }
  return rows;
}
