/**
 * PrismBI Studio – a browser-based report editor (drag & drop canvas, fields / visualizations / build /
 * format / filters panes, measure & column editors, data and model views, undo/redo, autosave).
 *
 * ```ts
 * import { Studio } from '@prismbi/prismbi/studio';
 * new Studio(document.getElementById('app')!, { model, storageKey: 'my-report' });
 * ```
 * @packageDocumentation
 */
import { registerBuiltinVisuals } from './visuals/index';

registerBuiltinVisuals();

export { Studio, emptyModelState } from './studio/studio';
export type { StudioDocument, StudioEvents, StudioModelState, StudioOptions } from './studio/studio';
export { autoReport } from './studio/autoReport';
export type { AutoReportOptions } from './studio/autoReport';
export { assignField, autoVisualFor, defaultSize, fieldKind, removeField, retargetFields } from './studio/assign';
export type { FieldKind } from './studio/assign';
export { History } from './studio/history';
export { COMMON_SECTIONS, TYPE_SECTIONS, sectionsFor } from './studio/formatSchema';
export type { ControlType, FormatControl, FormatSection } from './studio/formatSchema';
export { ExpressionEditor } from './studio/expressionEditor';
export { STUDIO_CSS, injectStudioStyles } from './studio/styles';
export { REPORT_SCHEMA_VERSION, migrateReport } from './report/migrate';
