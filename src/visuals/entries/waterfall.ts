/**
 * Waterfall chart. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/waterfall';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { waterfall } from '../waterfall';

registerVisual(waterfall);

export { waterfall };
