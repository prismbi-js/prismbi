/**
 * PrismBI – Power BI-style data modeling & interactive reports for the web.
 * Batteries included: every built-in visual is registered. For lean builds use `@prismbi/prismbi/core` + `@prismbi/prismbi/visuals`.
 * @packageDocumentation
 */
import { registerBuiltinVisuals } from './visuals/index';

registerBuiltinVisuals();

export * from './core';
export { builtinVisuals, registerBuiltinVisuals } from './visuals/index';
