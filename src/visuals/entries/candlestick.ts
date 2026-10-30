/**
 * Candlestick financial chart. Importing this module registers it:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/candlestick';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { candlestick } from '../candlestick';

registerVisual(candlestick);

export { candlestick };
export type { CandlestickFormat } from '../candlestick';

