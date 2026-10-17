/**
 * Heatmap. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/heatmap';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { heatmap } from '../heatmap';

registerVisual(heatmap);

export { heatmap };
