/**
 * Radar chart. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/radar';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { radar } from '../more';

registerVisual(radar);

export { radar };
