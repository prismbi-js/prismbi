/**
 * Slicer. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/slicer';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { slicer } from '../slicer';

registerVisual(slicer);

export { slicer };
