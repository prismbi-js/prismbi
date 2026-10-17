/**
 * Card and multi-row card. Importing this module registers them, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/card';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { card, multiRowCard } from '../cards';

registerVisual(card);
registerVisual(multiRowCard);

export { card, multiRowCard };
