/**
 * Table and matrix. Importing this module registers them, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/table';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { table, matrix } from '../table';

registerVisual(table);
registerVisual(matrix);

export { table, matrix };
