/**
 * Line, area, stacked area and combo charts. Importing this module registers them, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/line';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { lineChart, areaChart, stackedAreaChart, comboChart } from '../line';

registerVisual(lineChart);
registerVisual(areaChart);
registerVisual(stackedAreaChart);
registerVisual(comboChart, ['combo']);

export { lineChart, areaChart, stackedAreaChart, comboChart };
