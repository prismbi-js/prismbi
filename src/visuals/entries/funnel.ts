/**
 * Funnel. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/funnel';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { funnel } from '../parts';

registerVisual(funnel);

export { funnel };
