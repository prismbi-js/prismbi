/**
 * Histogram and box plot. Importing this module registers them, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/distribution';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { histogram, boxPlot } from '../distribution';

registerVisual(histogram);
registerVisual(boxPlot, ['boxAndWhisker']);

export { histogram, boxPlot };
