/**
 * Scorecard (goals). Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/scorecard';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { scorecard } from '../scorecard';

registerVisual(scorecard, ['goals']);

export { scorecard };
export { goalStatus } from '../scorecard';
