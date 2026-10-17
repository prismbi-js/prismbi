import { DataModel } from '@prismbi/prismbi';
import { makeSales, products, regions } from './data';

/** The demo's semantic model (shared by the report demo and the studio demo). */
export function buildModel(sales: Record<string, unknown>[] = makeSales()): DataModel {
  return new DataModel()
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
    .addMeasure('Sales Change', '[Total Sales] - [Sales LY]', { format: '$#,0' })
    .addMeasure('Share of Category', 'DIVIDE([Total Sales], CALCULATE([Total Sales], ALLSELECTED(Product)))', { format: '0.0%' })
    // ---- Phase 3 modeling
    .addCalculatedColumn('Sales', 'ShipDate', 'Sales[OrderDate] + 3', { type: 'date' })
    .addRelationship({ from: 'Sales[ShipDate]', to: 'Date[Date]', active: false })
    .addMeasure('Sales by Ship Date', 'CALCULATE([Total Sales], USERELATIONSHIP(Sales[ShipDate], Date[Date]))', { format: '$#,0' })
    .addHierarchy('Product', 'Product Hierarchy', ['Category', 'Subcategory', 'Name'])
    .addHierarchy('Date', 'Calendar', ['Year', 'YearQuarter', 'MonthYear'])
    .addFieldParameter('Metric', [
      { label: 'Sales', field: 'Total Sales' },
      { label: 'Profit', field: 'Total Profit' },
      { label: 'Orders', field: 'Orders' },
      { label: 'Units', field: 'Units' },
    ])
    .addCalculationGroup({
      name: 'Time Calc',
      column: 'Calculation',
      items: [
        { name: 'Current', expression: 'SELECTEDMEASURE()' },
        { name: 'Prior year', expression: 'CALCULATE(SELECTEDMEASURE(), SAMEPERIODLASTYEAR(Date[Date]))' },
        { name: 'YoY %', expression: 'VAR py = CALCULATE(SELECTEDMEASURE(), SAMEPERIODLASTYEAR(Date[Date])) RETURN IF(ISBLANK(py), BLANK(), FORMAT(DIVIDE(SELECTEDMEASURE() - py, py), "+0.0%;-0.0%"))' },
        { name: 'YTD', expression: 'TOTALYTD(SELECTEDMEASURE(), Date[Date])' },
      ],
    })
    .addWhatIfParameter('Price Change', { min: -0.2, max: 0.2, step: 0.05, default: 0, format: '0%' })
    .addMeasure('Projected Sales', '[Total Sales] * (1 + [Price Change Value])', { format: '$#,0' })
    .addRole('Europe', { Region: 'Region[Group] = "Europe"' })
    .addRole('Region manager', { Region: 'Region[Region] = USERNAME()' });
}
