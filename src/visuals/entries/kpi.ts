/**
 * KPI. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/kpi';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { kpi } from '../cards';

registerVisual(kpi);

export { kpi };
