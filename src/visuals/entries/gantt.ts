/**
 * Gantt chart. Importing this module registers it:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/gantt';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { gantt } from '../gantt';

registerVisual(gantt);

export { gantt };
export type { GanttFormat } from '../gantt';

