import type { CellValue, ColumnRef } from '../data/types';
import type { FilterSpec } from '../data/filters';
import type { DataModel } from '../data/model';
import type { FieldSpec, QueryField, QueryResult, QuerySpec } from '../data/query';
import type { Theme } from '../theme/theme';
import type { DeepPartial } from '../utils';
import type { VisualFormat } from './format';
import type { FormatOptions } from '../format/format';

export interface VisualLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  z?: number;
}

/** Serialisable description of one visual on a page. */
export interface VisualSpec {
  /** Visuals sharing a group id are selected and moved together in edit mode. */
  group?: string;
  id?: string;
  type: string;
  /** Shorthand for `format.title.text`. */
  title?: string;
  layout?: VisualLayout;
  /** Data roles → fields, e.g. `{ category: 'Products[Category]', values: ['Total Sales'] }`. */
  fields?: Record<string, FieldSpec | FieldSpec[]>;
  /** Visual-level filters. */
  filters?: FilterSpec[];
  format?: DeepPartial<VisualFormat> & Record<string, unknown>;
  sort?: { field: string; direction?: 'asc' | 'desc' };
  /** Keep the first N groups after sorting. */
  top?: number;
  /** How this visual reacts to selections in other visuals. */
  interaction?: 'filter' | 'highlight' | 'none';
  /** Visual-specific per-type interaction override: `{ [otherVisualId]: 'filter' | 'highlight' | 'none' }`. */
  interactionsFrom?: Record<string, 'filter' | 'highlight' | 'none'>;
  /** Persisted drill state. */
  drill?: { level: number; path: CellValue[]; /** Levels shown for all members ("go to next level"). */ skip?: number[]; /** "Expand all down": show levels path.length..level together. */ expanded?: boolean };
  hidden?: boolean;
  /**
   * Show the visual only when a condition holds: a field is filtered or selected (`is` omitted or `'selected'`),
   * filtered to one of some values (`is: [...]`), not filtered (`'notSelected'`), and/or one of `roles` is active.
   */
  visibleWhen?: { field?: string; is?: CellValue[] | 'selected' | 'notSelected'; roles?: string[] };
  /** Durable visual-local UI state (sort, expansion, decomposition splits). Saved with the report. */
  state?: Record<string, unknown>;
  className?: string;
  /** Inline CSS for the visual container. */
  style?: string;
}

export interface RoleDef {
  name: string;
  displayName: string;
  kind: 'grouping' | 'measure' | 'any';
  multiple?: boolean;
  required?: boolean;
  /** Multiple fields form a drill hierarchy (only one level is shown at a time). */
  drillable?: boolean;
}

export interface DataPointIdentity {
  columns: ColumnRef[];
  values: CellValue[];
}

export interface TooltipItem {
  label: string;
  value: string;
  color?: string;
}

export interface VisualHostApi {
  /** Remember which data point holds the visual's tab stop (keyboard navigation). */
  markFocused?(index: number): void;
  /** Select a data point (cross-filter others). `null` clears. */
  select(identity: DataPointIdentity | null, opts?: { multi?: boolean }): void;
  /** `null` when nothing is selected in this visual. */
  isSelected(identity: DataPointIdentity): boolean | null;
  readonly selectionActive: boolean;
  /** Show the tooltip. Pass the data point's identity so report-page tooltips (`format.tooltip.page`) can render. */
  showTooltip(evt: MouseEvent | { clientX: number; clientY: number }, items: TooltipItem[], title?: string, identity?: DataPointIdentity): void;
  hideTooltip(): void;
  /** Slicers: set (or clear with `null`) the filter this visual contributes to the page. */
  setFilter(filters: FilterSpec[] | null): void;
  readonly currentFilter: FilterSpec[] | null;
  /** Domain for slicers: distinct values of a column under all *other* filters. */
  domain(column: string): CellValue[];
  /** Existing combinations of several columns under all *other* filters (hierarchy slicers). */
  domainTuples(columns: string[]): CellValue[][];
  /** Open the data-point context menu (Include / Exclude / Drill through). */
  contextMenu(evt: MouseEvent, identity: DataPointIdentity): void;
  drillDown(value: CellValue): void;
  drillUp(): void;
  readonly drill: { level: number; path: CellValue[]; levels: number };
  /** Persist visual-local UI state (e.g. matrix expansion) without a re-query. */
  setState(patch: Record<string, unknown>): void;
  readonly state: Record<string, unknown>;
  emit(event: 'dataPointClick', payload: { keys: CellValue[]; identity: DataPointIdentity; event: MouseEvent }): void;
  /** Re-render without re-querying (e.g. after local UI state change). */
  rerender(): void;
}

export interface RoleBinding {
  kind: 'group' | 'value';
  /** Positions in `data.groups` / `data.values`. */
  indices: number[];
  fields: QueryField[];
}

export interface RenderContext {
  root: HTMLElement;
  width: number;
  height: number;
  spec: VisualSpec;
  format: VisualFormat;
  theme: Theme;
  data: QueryResult;
  model: DataModel;
  role(name: string): RoleBinding;
  /** Fields bound to a role, with hierarchies and field parameters expanded. */
  fields(role: string): FieldSpec[];
  /** Stable colour for an entity (colour follows the entity, never its rank). */
  colorFor(field: QueryField | undefined, value: CellValue, fallbackIndex?: number): string;
  seriesColor(name: string, index: number): string;
  fmt(field: QueryField | undefined, v: CellValue, opts?: FormatOptions): string;
  host: VisualHostApi;
  /** Animate on first render / data change. */
  animate: boolean;
}

export interface QueryBuildContext {
  spec: VisualSpec;
  model: DataModel;
  /** Fields bound to a role (array, possibly empty). */
  fields(role: string): FieldSpec[];
  drill: { level: number; path: CellValue[] };
}

export interface VisualDefinition {
  type: string;
  displayName: string;
  category?: 'chart' | 'card' | 'table' | 'slicer' | 'other';
  roles: RoleDef[];
  /** Responds to other visuals' selections by highlighting instead of filtering. */
  supportsHighlight?: boolean;
  /** Slicers contribute filters instead of selections and are excluded from their own filter. */
  isSlicer?: boolean;
  /** Visual needs no query (textbox, image, shapes). */
  static?: boolean;
  defaultFormat?: DeepPartial<VisualFormat> & Record<string, unknown>;
  /** Default ordering when the spec has no `sort`: by first value desc, or by category key. */
  defaultSort?: 'value' | 'key';
  /** Override query generation (one query; for several, fetch more in render via ctx.model). */
  buildQuery?(ctx: QueryBuildContext, base: QuerySpec): QuerySpec | null;
  render(ctx: RenderContext): void | (() => void);
}
