/**
 * Ribbon chart. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/ribbon';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { ribbon } from '../more';

registerVisual(ribbon);

export { ribbon };
