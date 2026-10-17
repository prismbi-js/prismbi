/**
 * Pie and donut charts. Importing this module registers them, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/pie';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { pieChart, donutChart } from '../parts';

registerVisual(pieChart);
registerVisual(donutChart);

export { pieChart, donutChart };
