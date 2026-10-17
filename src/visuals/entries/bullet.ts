/**
 * Bullet chart. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/bullet';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { bullet } from '../more';

registerVisual(bullet);

export { bullet };
