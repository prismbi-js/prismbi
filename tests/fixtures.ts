import { DataModel } from '../src/index';

export const products = [
  { Id: 1, Name: 'Road Bike', Category: 'Bikes', Color: 'Red' },
  { Id: 2, Name: 'Mountain Bike', Category: 'Bikes', Color: 'Black' },
  { Id: 3, Name: 'Helmet', Category: 'Accessories', Color: 'Red' },
  { Id: 4, Name: 'Bottle', Category: 'Accessories', Color: 'Blue' },
  { Id: 5, Name: 'Jersey', Category: 'Clothing', Color: 'Blue' },
];

export const regions = [
  { Id: 10, Name: 'North' },
  { Id: 20, Name: 'South' },
];

// Amount / Cost / Qty per order line
export const sales = [
  { OrderId: 1, ProductId: 1, RegionId: 10, OrderDate: '2024-01-15', Qty: 1, Amount: 1000, Cost: 700 },
  { OrderId: 2, ProductId: 2, RegionId: 10, OrderDate: '2024-02-10', Qty: 2, Amount: 3000, Cost: 2200 },
  { OrderId: 3, ProductId: 3, RegionId: 20, OrderDate: '2024-02-20', Qty: 3, Amount: 150, Cost: 60 },
  { OrderId: 4, ProductId: 4, RegionId: 20, OrderDate: '2024-03-05', Qty: 10, Amount: 100, Cost: 40 },
  { OrderId: 5, ProductId: 5, RegionId: 10, OrderDate: '2024-03-28', Qty: 4, Amount: 200, Cost: 90 },
  { OrderId: 6, ProductId: 1, RegionId: 20, OrderDate: '2025-01-20', Qty: 2, Amount: 2000, Cost: 1400 },
  { OrderId: 7, ProductId: 3, RegionId: 10, OrderDate: '2025-02-14', Qty: 5, Amount: 250, Cost: 100 },
  { OrderId: 8, ProductId: 5, RegionId: 20, OrderDate: '2025-03-01', Qty: 1, Amount: 50, Cost: 25 },
];

export function makeModel(): DataModel {
  return new DataModel()
    .addTable('Sales', sales)
    .addTable('Products', products)
    .addTable('Region', regions)
    .addDateTable('Date', '2024-01-01', '2025-12-31')
    .addRelationship({ from: 'Sales[ProductId]', to: 'Products[Id]' })
    .addRelationship({ from: 'Sales[RegionId]', to: 'Region[Id]' })
    .addRelationship({ from: 'Sales[OrderDate]', to: 'Date[Date]' })
    .addMeasure('Total Sales', 'SUM(Sales[Amount])', { format: '$#,0' })
    .addMeasure('Total Cost', 'SUM(Sales[Cost])')
    .addMeasure('Profit', '[Total Sales] - [Total Cost]')
    .addMeasure('Margin %', 'DIVIDE([Profit], [Total Sales])', { format: '0.0%' })
    .addMeasure('Orders', 'COUNTROWS(Sales)');
}
