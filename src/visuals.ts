/**
 * Individually importable built-in visuals. Register just what you need:
 *
 * ```ts
 * import { Report, registerVisual } from '@prismbi/prismbi/core';
 * import { clusteredColumn, card, slicer } from '@prismbi/prismbi/visuals';
 * [clusteredColumn, card, slicer].forEach((v) => registerVisual(v));
 * ```
 * @packageDocumentation
 */
export { clusteredBar, clusteredColumn, percentStackedBar, percentStackedColumn, stackedBar, stackedColumn } from './visuals/bar';
export { areaChart, comboChart, lineChart, stackedAreaChart } from './visuals/line';
export { donutChart, funnel, pieChart, treemap } from './visuals/parts';
export { sunburst } from './visuals/sunburst';
export { scatter } from './visuals/scatter';
export { card, gauge, kpi, multiRowCard } from './visuals/cards';
export { matrix, table } from './visuals/table';
export { slicer } from './visuals/slicer';
export { textBox } from './visuals/text';
export { waterfall } from './visuals/waterfall';
export { heatmap } from './visuals/heatmap';
export { calendarHeatmap } from './visuals/calendar';
export { decompositionTree } from './visuals/decomposition';
export { boxPlot, histogram } from './visuals/distribution';
export { bullet, radar, ribbon, sankey } from './visuals/more';
export { bubbleMap, filledMap } from './visuals/map';
