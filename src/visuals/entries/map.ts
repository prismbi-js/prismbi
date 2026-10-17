/**
 * Bubble and filled (choropleth) maps. Importing this module registers them, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/map';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { bubbleMap, filledMap } from '../map';

registerVisual(bubbleMap, ['bubbleMap']);
registerVisual(filledMap, ['choropleth']);

export { bubbleMap, filledMap };
