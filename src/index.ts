/**
 * PrismBI – Power BI-style data modeling & interactive reports for the web.
 * @packageDocumentation
 */
import { registerBuiltinVisuals } from './visuals/index';

registerBuiltinVisuals();

// data & model
export { DataModel } from './data/model';
export type { FieldInfo, Measure, Relationship } from './data/model';
export { DataTable, inferType } from './data/table';
export type { Column } from './data/table';
export { generateDateTable } from './data/dates';
export type { DateTableOptions } from './data/dates';
export { compileFilter } from './data/filters';
export type { ColumnFilterSpec, Filter, FilterOp, FilterSpec, TopNFilterSpec, TupleFilterSpec } from './data/filters';
export type { Aggregation, FieldSpec, QueryField, QueryResult, QueryRow, QuerySpec } from './data/query';
export { columnRefToString, compareValues, parseColumnRef } from './data/types';
export type { CellValue, ColumnRef, ColumnSchema, DataType, MeasureDef, RelationshipDef, Row } from './data/types';

// expressions
export { parseDax, tokenize, DaxSyntaxError } from './dax/parser';
export { DaxError, Evaluator } from './dax/evaluator';
export type { Expr } from './dax/ast';

// formatting & theming
export { formatValue, formatDate, formatCompact, setDefaultLocale, FORMAT_PRESETS } from './format/format';
export type { DisplayUnits, FormatOptions } from './format/format';
export { createTheme, darkTheme, fromPowerBITheme, getTheme, lightTheme, registerTheme } from './theme/theme';
export type { PowerBIThemeJson, Theme } from './theme/theme';

// visuals
export { defineVisual, getVisual, hasVisual, listVisuals, registerVisual } from './visuals/registry';
export { builtinVisuals, registerBuiltinVisuals } from './visuals/index';
export { baseFormat } from './visuals/format';
export type { VisualFormat } from './visuals/format';
export type {
  DataPointIdentity,
  QueryBuildContext,
  RenderContext,
  RoleBinding,
  RoleDef,
  TooltipItem,
  VisualDefinition,
  VisualHostApi,
  VisualLayout,
  VisualSpec,
} from './visuals/types';
export * as chart from './visuals/common';
export { s as svg, h as html, barPath, arcPath, measureText, fitText } from './render/svg';
export { linearScale, bandScale, pointScale, niceStep } from './render/scales';
export { mix, ramp, textOn, contrastRatio, withAlpha } from './render/color';
export { relativeRange } from './visuals/slicer';
export type { SlicerFormat, SlicerStyle } from './visuals/slicer';
export type { ConditionalFormat, ConditionalRule } from './visuals/table';
export { squarify } from './visuals/parts';

// report runtime
export { Report, reviveDates } from './report/report';
export type { Bookmark, PageDefinition, PageLayout, ReportChrome, ReportDefinition, ReportOptions, VisualHandle } from './report/report';
export type { ReportEvents } from './report/events';
export { createVisual } from './report/standalone';
export type { StandaloneVisualOptions } from './report/standalone';
export { describeFilter } from './report/filterPane';
export { CSS as prismCss, injectStyles, themeVars } from './report/styles';
export type { TooltipRenderer } from './report/tooltip';

export type { DeepPartial } from './utils';
