/**
 * Decomposition tree. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/decomposition';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { decompositionTree } from '../decomposition';

registerVisual(decompositionTree, ['decomp']);

export { decompositionTree };
