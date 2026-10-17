/**
 * Text box. Importing this module registers it, so a build only includes the visuals it imports:
 *
 * ```ts
 * import { Report } from '@prismbi/prismbi/core';
 * import '@prismbi/prismbi/visuals/text';
 * ```
 * @packageDocumentation
 */
import { registerVisual } from '../registry';
import { textBox } from '../text';

registerVisual(textBox, ['textbox']);

export { textBox };
