/**
 * Column and bar charts: clustered, stacked and 100% stacked. Importing this module registers them, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/bar';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { clusteredColumn, stackedColumn, percentStackedColumn, clusteredBar, stackedBar, percentStackedBar } from '../bar';

registerVisual(clusteredColumn, ['column']);
registerVisual(stackedColumn);
registerVisual(percentStackedColumn);
registerVisual(clusteredBar, ['bar']);
registerVisual(stackedBar);
registerVisual(percentStackedBar);

export { clusteredColumn, stackedColumn, percentStackedColumn, clusteredBar, stackedBar, percentStackedBar };
