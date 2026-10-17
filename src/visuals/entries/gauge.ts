/**
 * Gauge. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/gauge';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { gauge } from '../cards';

registerVisual(gauge);

export { gauge };
