/**
 * PrismBI core: model, DAX engine, query engine, report runtime and helpers, with no visuals registered.
 * Register only the visuals you use from `prismbi/visuals` for the smallest bundle.
 * @packageDocumentation
 */
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
export { baseFormat } from './visuals/format';
export type { ReferenceLine, VisualFormat } from './visuals/format';
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
export { wQuantile } from './visuals/distribution';
export type { GeoFeature, GeoFeatureCollection, MapFormat } from './visuals/map';
export { referenceValue, linearFit } from './visuals/analytics';
export { timeScale, logScale } from './render/scales';
export { buildPdf } from './report/pdf';

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
