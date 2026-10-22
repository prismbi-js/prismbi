/**
 * Sunburst. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/sunburst';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { sunburst } from '../sunburst';

registerVisual(sunburst);

export { sunburst };
