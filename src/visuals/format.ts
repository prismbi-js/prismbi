import type { DisplayUnits } from '../format/format';
import type { AnomalyOptions } from './anomaly';
import type { NetworkFormat } from './network';
import type { SmallMultiplesFormat } from './multiples';

export interface SecondaryValueAxisFormat {
  /** Show secondary value axis (default: true in combo charts). */
  show?: boolean;
  /** Axis title text or true for field name. */
  title?: string | boolean;
  /** Explicit format string (e.g. `0.0%` or `$#,0`). */
  format?: string;
  /** Display units (`auto`, `none`, `thousands`, `millions`, `billions`, `trillions`). */
  displayUnits?: DisplayUnits;
  /** Number of decimal places. */
  decimals?: number;
  /** Custom minimum value. */
  min?: number;
  /** Custom maximum value. */
  max?: number;
  /** Approximate number of ticks (default: 5). */
  tickCount?: number;
  /** Force secondary axis on/off in combo charts (default: 'auto'). */
  mode?: 'auto' | 'on' | 'off';
}

export interface ReferenceLine {
  type: 'constant' | 'average' | 'median' | 'min' | 'max' | 'percentile';
  /** For `constant`. */
  value?: number;
  /** 0–100 for `percentile`. */
  percentile?: number;
  /** Label text; `{value}` is replaced by the formatted value. Default: type + value. */
  label?: string | false;
  color?: string;
  dash?: boolean;
  /** Line style: 'dashed' (default when dash !== false), 'dotted', or 'solid'. */
  style?: 'dashed' | 'dotted' | 'solid';
  /** Label alignment along the reference line: 'left' | 'right' | 'center' (or 'top' | 'bottom'). */
  labelPosition?: 'left' | 'right' | 'center' | 'top' | 'bottom';
  /** Custom label font color. */
  labelColor?: string;
  /** Shading between the reference line and an edge / baseline. */
  shade?: 'above' | 'below' | 'to-zero';
  shadeColor?: string;
  shadeOpacity?: number;
}

export type IconSet = 'kpi-shapes' | 'arrows' | 'flags' | 'stars' | 'traffic-lights';

export interface IconRule {
  op: '>' | '>=' | '<' | '<=' | '=' | '<>' | 'between';
  value: number;
  value2?: number;
  icon?: string;
  color?: string;
}

export interface IconOptions {
  set?: IconSet;
  rules?: IconRule[];
  align?: 'left' | 'right' | 'iconOnly';
}

export interface ReferenceBand {
  from: number;
  to: number;
  label?: string;
  color?: string;
  opacity?: number;
  axis?: 'x' | 'y';
}

export interface DataLabelRule {
  min?: number;
  max?: number;
  color: string;
}

export interface SyncSlicerConfig {
  syncGroup?: string;
  syncPages?: string[] | 'all';
}

export interface DataLabelsFormat {
  show: boolean;
  format?: string;
  displayUnits: DisplayUnits;
  decimals?: number;
  fontSize?: number;
  color?: string;
  position: 'auto' | 'inside' | 'outside' | 'insideEnd' | 'insideCenter' | 'insideBase' | 'outsideEnd';
  orientation?: 'horizontal' | 'vertical';
  showBackground?: boolean;
  backgroundColor?: string;
  backgroundOpacity?: number;
  contrastColor?: boolean;
  rules?: DataLabelRule[];
}

export interface GaugeThreshold {
  value: number;
  color: string;
}

export interface GaugeFormat {
  thresholds?: GaugeThreshold[];
  needle?: boolean;
  targetLabel?: string;
  needleColor?: string;
  needleCapColor?: string;
  showTarget?: boolean;
}

export interface CardFormat {
  labelPosition?: 'top' | 'bottom';
  showLabel?: boolean;
  align?: 'left' | 'center';
  valueFontSize?: number;
  labelFontSize?: number;
  labelColor?: string;
  upIsGood?: boolean;
  deltaLabel?: string;
  prefix?: string;
  suffix?: string;
  color?: string;
  rules?: { min?: number; max?: number; color: string }[];
  orientation?: 'vertical' | 'horizontal';
}

export interface MultiRowCardFormat {
  columns?: number;
  showAccentBar?: boolean;
  accentColor?: string;
  cardPadding?: number;
  valueFontSize?: number;
  labelFontSize?: number;
  labelColor?: string;
}

export type PieLabelContents = 'category' | 'value' | 'percent' | 'category, percent' | 'value, percent' | 'all';

export interface PieFormat {
  maxSlices?: number;
  labelContents?: PieLabelContents;
}

export interface DonutFormat extends PieFormat {
  innerRadius?: number;
  centerLabel?: boolean;
  centerTitle?: string;
}

export interface FunnelFormat {
  percentOfFirst?: boolean;
  percentOfPrevious?: boolean;
  colorByStep?: boolean;
}

export interface KpiFormat {
  upIsGood?: boolean;
  showGoal?: boolean;
  goalLabel?: string;
  statusColor?: boolean;
  sparklineColor?: string;
}

export interface QuadrantsFormat {
  show?: boolean;
  x?: number;
  y?: number;
  lineColor?: string;
  lineStyle?: 'dashed' | 'dotted' | 'solid';
  labels?: [string, string, string, string];
  labelColor?: string;
}

export interface TreemapFormat {
  maxTiles?: number;
  tileGap?: number;
  cornerRadius?: number;
  showValues?: boolean;
}

export interface SunburstFormat {
  innerRadius?: number;
  maxDepth?: number;
}

export interface RadarFormat {
  /** Render circular concentric rings instead of polygon web (default: false). */
  circularGrid?: boolean;
  /** Series polygon fill opacity between 0 and 1 (default: 0.1). */
  fillOpacity?: number;
  /** Series polygon line stroke width (default: 2). */
  lineWidth?: number;
  /** Show data point vertex dots (default: true). */
  showDots?: boolean;
  /** Radius of data point vertex dots (default: 4). */
  dotRadius?: number;
}

export interface WaterfallFormat {
  showTotal?: boolean;
  totalLabel?: string;
  increaseColor?: string;
  decreaseColor?: string;
  totalColor?: string;
  /** Show connector bridge lines between steps (default: true). */
  showConnectors?: boolean;
  /** Connector line color (default: theme.axis). */
  connectorColor?: string;
  /** Connector stroke width (default: 1). */
  connectorWidth?: number;
  /** Connector line style: 'solid' | 'dashed' | 'dotted' (default: 'solid'). */
  connectorStyle?: 'solid' | 'dashed' | 'dotted';
}

export interface BulletFormat {
  bands?: number[];
  sharedScale?: boolean;
  /** Custom qualitative band colors (e.g. ['#fee2e2', '#fef3c7', '#dcfce7']). */
  bandColors?: string[];
  /** Target indicator line stroke color (default: theme.foreground). */
  targetColor?: string;
  /** Target indicator line stroke width (default: 2.5). */
  targetWidth?: number;
}

export interface CandlestickFormat {
  upColor?: string;
  downColor?: string;
  showVolume?: boolean;
  /** Wick stroke line width (default: 1.5). */
  wickWidth?: number;
  /** Hollow bullish candles: transparent body with colored stroke (default: false). */
  hollow?: boolean;
  /** Custom volume bar fill color override. */
  volumeColor?: string;
}

export interface GanttFormat {
  /** Whether to render progress fill and percentage text (default: true). */
  showProgress?: boolean;
  /** Task bar height cap in pixels. */
  barHeight?: number;
  /** Base task bar color override. */
  barColor?: string;
  /** Task progress fill color override. */
  progressColor?: string;
  /** Milestone diamond marker color override. */
  milestoneColor?: string;
  /** Task bar corner radius (default: 3). */
  cornerRadius?: number;
}

export interface BoxPlotFormat {
  /** Show mean center point indicator circle (default: true). */
  showMean?: boolean;
  /** Show statistical outlier dots beyond 1.5× IQR whiskers (default: true). */
  showOutliers?: boolean;
  /** Fill opacity of the quartile box (default: 0.25). */
  boxOpacity?: number;
  /** Stroke width of whisker lines and caps (default: 1.5). */
  whiskerWidth?: number;
}

export interface ChordFormat {
  /** Angular gap between outer arc segments in radians (default: 0.04). */
  padAngle?: number;
  /** Inner radius ratio or outer arc band thickness in pixels (default: 14). */
  arcWidth?: number;
  /** Flow ribbon fill opacity between 0 and 1 (default: 0.45). */
  ribbonOpacity?: number;
  /** Whether to render outer perimeter category text labels (default: true). */
  showLabels?: boolean;
}

export interface SankeyFormat {
  /** Width of node rectangles in pixels (default: 12). */
  nodeWidth?: number;
  /** Vertical padding between nodes in pixels (default: 8). */
  nodePadding?: number;
  /** Flow link curve fill opacity between 0 and 1 (default: 0.35). */
  linkOpacity?: number;
  /** Whether to render node text labels (default: true). */
  showLabels?: boolean;
}

export interface HistogramFormat {
  /** Explicit number of bins (default: Sturges' formula). */
  bins?: number;
  /** Fixed bin numeric width interval (overrides bins). */
  binWidth?: number;
  /** Bar column fill color override. */
  barColor?: string;
  /** Bar corner rounding radius in pixels (default: 0). */
  cornerRadius?: number;
}

/** Every visual's format pane. Visual-specific sections live alongside (index signature). */
export interface VisualFormat {
  title: {
    show: boolean;
    text?: string;
    subtitle?: string | { text?: string; fontSize?: number; color?: string; italic?: boolean };
    badge?: string | { text: string; color?: string; background?: string };
    fontSize?: number;
    color?: string;
    align: 'left' | 'center' | 'right';
    bold: boolean;
    divider?: boolean | { color?: string; width?: number; margin?: number };
    tooltip?: string;
  };
  background: { show: boolean; color?: string; transparency: number };
  border: { show: boolean; color?: string; width: number; radius?: number };
  shadow: { show: boolean; color?: string; blur?: number; spread?: number; x?: number; y?: number };
  padding: number;
  header: { show: boolean; focusMode: boolean; exportData: boolean; showAsTable: boolean; drill: boolean; tooltip?: string };
  tooltip: {
    show: boolean;
    /** Id or name of a tooltip page (`page.tooltip`) rendered on hover, filtered to the hovered data point. */
    page?: string;
  };
  legend: { show: boolean | 'auto'; position: 'top' | 'bottom' | 'left' | 'right'; fontSize?: number };
  dataLabels: DataLabelsFormat;
  categoryAxis: {
    show: boolean;
    title?: string | boolean;
    fontSize?: number;
    maxLabelWidth: number;
    labelAngle: 'auto' | 0 | 45 | 90;
    gridlines: boolean;
    /** `auto`: continuous for date/number fields on line, area and scatter charts. */
    type: 'auto' | 'categorical' | 'continuous';
    /** Show a range slider under line and area charts to zoom into part of the axis. */
    zoom?: boolean;
    /** Scatter x-axis scale. */
    scale?: 'linear' | 'log';
  };
  valueAxis: {
    show: boolean;
    title?: string | boolean;
    format?: string;
    displayUnits: DisplayUnits;
    decimals?: number;
    min?: number;
    max?: number;
    gridlines: boolean;
    gridlineColor?: string;
    gridlineWidth?: number;
    gridlineStyle?: 'solid' | 'dashed' | 'dotted';
    tickCount: number;
    /** `log` applies to line and scatter charts (positive values only). */
    scale?: 'linear' | 'log';
    /** Show a hint when clustered measures differ by more than 100× (default true). */
    scaleWarning?: boolean;
  };
  secondaryValueAxis?: SecondaryValueAxisFormat;
  colors: {
    /** Fixed colour per series name (measure name or legend value). */
    series?: Record<string, string>;
    /** Fixed colour per category value. */
    categories?: Record<string, string>;
    /** Colour for single-series charts. */
    default?: string;
    /** Replace the theme palette for this visual. */
    palette?: string[];
    /** Conditional colours by value (single-series charts). First matching rule wins. */
    rules?: { op: '>' | '>=' | '<' | '<=' | '=' | '<>' | 'between'; value: number; value2?: number; color: string }[];
    /** Colour scale by value (single-series charts): min → (mid) → max. */
    gradient?: { min?: string; mid?: string; max?: string };
  };
  analytics: {
    referenceLines: ReferenceLine[];
    referenceBands?: ReferenceBand[];
    /** Linear trend line per series (column, bar, line, area, scatter). */
    trendLine: boolean | { color?: string };
    /** Forecast on line/area charts with a date or number axis: `{ periods: 6, confidence: 0.95, seasonality: 'auto' }`. */
    forecast?: false | { periods: number; confidence?: number; seasonality?: number | 'auto' | 'none' };
    /** Statistical anomaly detection: `{ enabled: true, sensitivity?: 1.5, method?: 'iqr' | 'zscore' }`. */
    anomalies?: false | AnomalyOptions;
    /** Show vertical hover crosshair on cartesian line/area charts (default true). */
    crosshair?: boolean;
  };
  bars: { maxThickness: number; radius: number; gap: number; categoryGap: number };
  lines: { width: number; markers: boolean | 'auto'; smooth: boolean; area: boolean; areaOpacity: number; endLabels: boolean };
  animation: { enabled: boolean; duration: number };
  network?: NetworkFormat;
  smallMultiples?: SmallMultiplesFormat;
  gauge?: GaugeFormat;
  card?: CardFormat;
  multiRowCard?: MultiRowCardFormat;
  pie?: PieFormat;
  donut?: DonutFormat;
  funnel?: FunnelFormat;
  kpi?: KpiFormat;
  quadrants?: QuadrantsFormat;
  treemap?: TreemapFormat;
  sunburst?: SunburstFormat;
  radar?: RadarFormat;
  waterfall?: WaterfallFormat;
  bullet?: BulletFormat;
  candlestick?: CandlestickFormat;
  gantt?: GanttFormat;
  boxPlot?: BoxPlotFormat;
  chord?: ChordFormat;
  sankey?: SankeyFormat;
  histogram?: HistogramFormat;
  [section: string]: unknown;
}

export const baseFormat: VisualFormat = {
  title: { show: true, align: 'left', bold: true },
  background: { show: true, transparency: 0 },
  border: { show: true, width: 1 },
  shadow: { show: false },
  padding: 12,
  header: { show: true, focusMode: true, exportData: true, showAsTable: true, drill: true },
  tooltip: { show: true },
  legend: { show: 'auto', position: 'top' },
  dataLabels: { show: false, displayUnits: 'auto', position: 'auto' },
  categoryAxis: { show: true, maxLabelWidth: 120, labelAngle: 'auto', gridlines: false, type: 'auto' },
  valueAxis: { show: true, displayUnits: 'auto', gridlines: true, tickCount: 5 },
  secondaryValueAxis: { show: true, displayUnits: 'auto', tickCount: 5, mode: 'auto' },
  colors: {},
  analytics: { referenceLines: [], trendLine: false, forecast: false, anomalies: false, crosshair: true },
  bars: { maxThickness: 24, radius: 4, gap: 2, categoryGap: 0.35 },
  lines: { width: 2, markers: 'auto', smooth: false, area: false, areaOpacity: 0.1, endLabels: true },
  animation: { enabled: true, duration: 280 },
};
