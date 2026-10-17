/**
 * Treemap. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/treemap';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { treemap } from '../parts';

registerVisual(treemap);

export { treemap };
