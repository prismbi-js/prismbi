/**
 * Calendar heatmap. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/calendar';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { calendarHeatmap } from '../calendar';

registerVisual(calendarHeatmap);

export { calendarHeatmap };
