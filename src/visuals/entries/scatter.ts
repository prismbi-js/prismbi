/**
 * Scatter and bubble chart. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/scatter';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { scatter } from '../scatter';

registerVisual(scatter, ['bubble']);

export { scatter };
