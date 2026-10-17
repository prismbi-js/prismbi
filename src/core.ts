/**
 * PrismBI core: model, DAX engine, query engine, report runtime and helpers, with no visuals registered.
 * Register only the visuals you use from `@prismbi/prismbi/visuals` for the smallest bundle.
 * @packageDocumentation
 */
// data & model
export { DataModel } from './data/model';
export { applySteps, applyStep, describeStep } from './data/transform';
export { lineage, impactOf, expressionRefs, renameInExpression, renameModelField } from './data/lineage';
export type { Lineage, LineageNode, LineageRef, Impact, RenameResult } from './data/lineage';
export type { TransformStep, TransformContext } from './data/transform';
export type { AppendOptions, CalculationGroup, CalculationGroupDef, CalculationItemDef, FieldInfo, FieldParameterDef, Measure, Relationship, WhatIfParameterDef } from './data/model';
export { setFastQuery } from './data/fastQuery';
export type { FastQueryMode } from './data/fastQuery';
export { DataTable, inferType } from './data/table';
export type { Column } from './data/table';
export { generateDateTable } from './data/dates';
export type { DateTableOptions } from './data/dates';
export { compileFilter } from './data/filters';
export type { ColumnFilterSpec, Filter, FilterOp, FilterSpec, RelFilter, TopNFilterSpec, TupleFilterSpec } from './data/filters';
export type { Aggregation, FieldSpec, QueryField, QueryResult, QueryRow, QuerySpec } from './data/query';
export { applyRefreshPolicy, periodStart } from './data/refreshPolicy';
export type { RefreshPolicy, IncrementalRefreshResult, PeriodUnit } from './data/refreshPolicy';
export { visualCalcPlan, resolveValueField, resolveGroupField } from './data/query';
export { columnRefToString, compareValues, parseColumnRef } from './data/types';
export type { CellValue, ColumnRef, ColumnSchema, DataType, MeasureDef, RelationshipDef, Row } from './data/types';

// expressions
export { parseDax, tokenize, DaxSyntaxError } from './dax/parser';
export { DaxError, Evaluator } from './dax/evaluator';
export type { Expr } from './dax/ast';
export { formatDax } from './dax/format';
export type { FormatDaxOptions } from './dax/format';
export { DAX_FUNCTIONS, DAX_KEYWORDS } from './dax/functions';
export type { DaxFunctionInfo } from './dax/functions';
export { DaxLanguageService, explainDax } from './dax/language';
export type { DaxCompletion, DaxDiagnostic, DaxExplanation, DaxHover, DaxSignatureHelp } from './dax/language';

// formatting & theming
export { formatValue, formatDate, formatCompact, setDefaultLocale, FORMAT_PRESETS } from './format/format';
export type { DisplayUnits, FormatOptions } from './format/format';
export { createTheme, darkTheme, fromPowerBITheme, getTheme, highContrastTheme, lightTheme, registerTheme } from './theme/theme';
export { narrate } from './report/narrate';
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
export { registerBoundaries, getBoundaries, featureCentroid, clusterPoints, quantileBreaks } from './visuals/map';
export { referenceValue, linearFit } from './visuals/analytics';
export { timeScale, logScale } from './render/scales';
export { buildPdf } from './report/pdf';

// report runtime
export { Report, reviveDates, registerMenuItems, autoMobileLayout } from './report/report';
export type { MobileLayout , ReportSubscription, ReportAlert, ReportTranslation } from './report/report';
export type { MenuContext, MenuProvider } from './report/report';
export type { MenuItem } from './report/contextMenu';
export type { Bookmark, PageDefinition, PageLayout, ReportChrome, ReportDefinition, ReportOptions, UsageEvent, VisualHandle } from './report/report';
export type { ReportEvents } from './report/events';
export { createVisual } from './report/standalone';
export type { StandaloneVisualOptions } from './report/standalone';
export { describeFilter } from './report/filterPane';
export { CSS as prismCss, injectStyles, themeVars } from './report/styles';
export type { TooltipRenderer } from './report/tooltip';

export type { DeepPartial } from './utils';
