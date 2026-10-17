/**
 * Sankey diagram. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/sankey';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { sankey } from '../more';

registerVisual(sankey);

export { sankey };
