import { getVisual } from '../visuals/registry';

export type ControlType = 'boolean' | 'number' | 'text' | 'textarea' | 'color' | 'select' | 'json' | 'range';

export interface FormatControl {
  /** `format.*` path (e.g. `title.fontSize`) or `spec.*` path (e.g. `spec.top`). */
  path: string;
  label: string;
  type: ControlType;
  options?: { value: string | number | boolean; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export interface FormatSection {
  id: string;
  label: string;
  controls: FormatControl[];
}

const sel = (...vals: (string | [string | number | boolean, string])[]) => vals.map((v) => (Array.isArray(v) ? { value: v[0], label: v[1] } : { value: v, label: v[0].toUpperCase() + v.slice(1) }));
const UNITS = sel(['auto', 'Auto'], ['none', 'None'], ['thousands', 'Thousands'], ['millions', 'Millions'], ['billions', 'Billions']);
const ALIGN = sel('left', 'center', 'right');

export const COMMON_SECTIONS: Record<string, FormatSection> = {
  general: {
    id: 'general',
    label: 'General',
    controls: [
      { path: 'spec.title', label: 'Title text', type: 'text' },
      { path: 'title.subtitle', label: 'Subtitle', type: 'text' },
      { path: 'spec.top', label: 'Show top N', type: 'number', min: 1, placeholder: 'All' },
      { path: 'spec.interaction', label: 'Reacts to other visuals', type: 'select', options: sel(['', 'Default'], 'filter', 'highlight', 'none') },
      { path: 'spec.hidden', label: 'Hidden', type: 'boolean' },
    ],
  },
  layout: {
    id: 'layout',
    label: 'Size and position',
    controls: [
      { path: 'spec.layout.x', label: 'Column', type: 'number', min: 0 },
      { path: 'spec.layout.y', label: 'Row', type: 'number', min: 0 },
      { path: 'spec.layout.w', label: 'Width', type: 'number', min: 1 },
      { path: 'spec.layout.h', label: 'Height', type: 'number', min: 1 },
    ],
  },
  title: {
    id: 'title',
    label: 'Title',
    controls: [
      { path: 'title.show', label: 'Show', type: 'boolean' },
      { path: 'title.fontSize', label: 'Font size', type: 'number', min: 8, max: 48 },
      { path: 'title.color', label: 'Color', type: 'color' },
      { path: 'title.align', label: 'Alignment', type: 'select', options: ALIGN },
      { path: 'title.bold', label: 'Bold', type: 'boolean' },
    ],
  },
  background: {
    id: 'background',
    label: 'Background',
    controls: [
      { path: 'background.show', label: 'Show', type: 'boolean' },
      { path: 'background.color', label: 'Color', type: 'color' },
      { path: 'background.transparency', label: 'Transparency', type: 'range', min: 0, max: 100, step: 5 },
    ],
  },
  border: {
    id: 'border',
    label: 'Border & shadow',
    controls: [
      { path: 'border.show', label: 'Border', type: 'boolean' },
      { path: 'border.color', label: 'Border color', type: 'color' },
      { path: 'border.width', label: 'Border width', type: 'number', min: 0, max: 8 },
      { path: 'border.radius', label: 'Corner radius', type: 'number', min: 0, max: 32 },
      { path: 'shadow.show', label: 'Shadow', type: 'boolean' },
      { path: 'padding', label: 'Padding', type: 'number', min: 0, max: 48 },
    ],
  },
  header: {
    id: 'header',
    label: 'Header icons',
    controls: [
      { path: 'header.show', label: 'Show', type: 'boolean' },
      { path: 'header.focusMode', label: 'Focus mode', type: 'boolean' },
      { path: 'header.exportData', label: 'Export', type: 'boolean' },
      { path: 'header.showAsTable', label: 'Show as table', type: 'boolean' },
      { path: 'header.drill', label: 'Drill buttons', type: 'boolean' },
    ],
  },
  tooltip: {
    id: 'tooltip',
    label: 'Tooltip',
    controls: [
      { path: 'tooltip.show', label: 'Show', type: 'boolean' },
      { path: 'tooltip.page', label: 'Report page tooltip', type: 'select', options: [] /* filled with tooltip pages */ },
    ],
  },
  legend: {
    id: 'legend',
    label: 'Legend',
    controls: [
      { path: 'legend.show', label: 'Show', type: 'select', options: sel(['auto', 'Auto'], [true, 'On'], [false, 'Off']) },
      { path: 'legend.position', label: 'Position', type: 'select', options: sel('top', 'bottom', 'left', 'right') },
      { path: 'legend.fontSize', label: 'Font size', type: 'number', min: 8, max: 24 },
    ],
  },
  dataLabels: {
    id: 'dataLabels',
    label: 'Data labels',
    controls: [
      { path: 'dataLabels.show', label: 'Show', type: 'boolean' },
      { path: 'dataLabels.displayUnits', label: 'Display units', type: 'select', options: UNITS },
      { path: 'dataLabels.decimals', label: 'Decimals', type: 'number', min: 0, max: 6, placeholder: 'Auto' },
      { path: 'dataLabels.format', label: 'Format string', type: 'text', placeholder: 'e.g. $#,0' },
      { path: 'dataLabels.color', label: 'Color', type: 'color' },
    ],
  },
  categoryAxis: {
    id: 'categoryAxis',
    label: 'X axis',
    controls: [
      { path: 'categoryAxis.show', label: 'Show', type: 'boolean' },
      { path: 'categoryAxis.type', label: 'Type', type: 'select', options: sel('auto', 'categorical', 'continuous') },
      { path: 'categoryAxis.labelAngle', label: 'Label angle', type: 'select', options: sel(['auto', 'Auto'], [0, '0°'], [45, '45°'], [90, '90°']) },
      { path: 'categoryAxis.maxLabelWidth', label: 'Max label width', type: 'number', min: 20, max: 300 },
      { path: 'categoryAxis.scale', label: 'Scale (scatter)', type: 'select', options: sel('linear', 'log') },
    ],
  },
  valueAxis: {
    id: 'valueAxis',
    label: 'Y axis',
    controls: [
      { path: 'valueAxis.show', label: 'Show', type: 'boolean' },
      { path: 'valueAxis.displayUnits', label: 'Display units', type: 'select', options: UNITS },
      { path: 'valueAxis.decimals', label: 'Decimals', type: 'number', min: 0, max: 6, placeholder: 'Auto' },
      { path: 'valueAxis.min', label: 'Minimum', type: 'number', placeholder: 'Auto' },
      { path: 'valueAxis.max', label: 'Maximum', type: 'number', placeholder: 'Auto' },
      { path: 'valueAxis.gridlines', label: 'Gridlines', type: 'boolean' },
      { path: 'valueAxis.tickCount', label: 'Ticks', type: 'number', min: 2, max: 12 },
      { path: 'valueAxis.scale', label: 'Scale', type: 'select', options: sel('linear', 'log') },
    ],
  },
  colors: {
    id: 'colors',
    label: 'Colors',
    controls: [
      { path: 'colors.default', label: 'Single-series color', type: 'color' },
      { path: 'colors.gradient.min', label: 'Gradient low', type: 'color' },
      { path: 'colors.gradient.max', label: 'Gradient high', type: 'color' },
      { path: 'colors.series', label: 'Per series (JSON)', type: 'json', placeholder: '{ "Total Sales": "#2a78d6" }' },
      { path: 'colors.rules', label: 'Rules (JSON)', type: 'json', placeholder: '[{ "op": "<", "value": 0, "color": "#d03b3b" }]' },
    ],
  },
  bars: {
    id: 'bars',
    label: 'Bars',
    controls: [
      { path: 'bars.maxThickness', label: 'Max thickness', type: 'number', min: 4, max: 80 },
      { path: 'bars.radius', label: 'Corner radius', type: 'number', min: 0, max: 12 },
      { path: 'bars.gap', label: 'Gap', type: 'number', min: 0, max: 12 },
      { path: 'bars.categoryGap', label: 'Category gap', type: 'range', min: 0, max: 0.9, step: 0.05 },
    ],
  },
  lines: {
    id: 'lines',
    label: 'Lines',
    controls: [
      { path: 'lines.width', label: 'Width', type: 'number', min: 1, max: 8 },
      { path: 'lines.markers', label: 'Markers', type: 'select', options: sel(['auto', 'Auto'], [true, 'On'], [false, 'Off']) },
      { path: 'lines.smooth', label: 'Smooth', type: 'boolean' },
      { path: 'lines.area', label: 'Area fill', type: 'boolean' },
      { path: 'lines.endLabels', label: 'End labels', type: 'boolean' },
    ],
  },
  analytics: {
    id: 'analytics',
    label: 'Analytics',
    controls: [
      { path: 'analytics.trendLine', label: 'Trend line', type: 'boolean' },
      { path: 'analytics.referenceLines', label: 'Reference lines (JSON)', type: 'json', placeholder: '[{ "type": "average" }]' },
    ],
  },
  smallMultiples: {
    id: 'smallMultiples',
    label: 'Small multiples',
    controls: [
      { path: 'smallMultiples.columns', label: 'Columns', type: 'number', min: 1, max: 12, placeholder: 'Auto' },
      { path: 'smallMultiples.sharedAxis', label: 'Shared axis', type: 'boolean' },
    ],
  },
  animation: {
    id: 'animation',
    label: 'Animation',
    controls: [
      { path: 'animation.enabled', label: 'Enabled', type: 'boolean' },
      { path: 'animation.duration', label: 'Duration (ms)', type: 'number', min: 0, max: 2000, step: 20 },
    ],
  },
};

/** Visual-specific sections. */
export const TYPE_SECTIONS: Record<string, FormatSection[]> = {
  card: [
    {
      id: 'card',
      label: 'Callout',
      controls: [
        { path: 'card.labelPosition', label: 'Label position', type: 'select', options: sel('top', 'bottom') },
        { path: 'card.showLabel', label: 'Show label', type: 'boolean' },
        { path: 'card.align', label: 'Alignment', type: 'select', options: sel('left', 'center') },
        { path: 'card.valueFontSize', label: 'Value size', type: 'number', min: 12, max: 160, placeholder: 'Auto' },
        { path: 'card.upIsGood', label: 'Up is good', type: 'boolean' },
        { path: 'card.deltaLabel', label: 'Change label', type: 'text' },
      ],
    },
  ],
  kpi: [{ id: 'kpi', label: 'KPI', controls: [{ path: 'kpi.upIsGood', label: 'Up is good', type: 'boolean' }] }],
  pie: [{ id: 'pie', label: 'Slices', controls: [{ path: 'pie.maxSlices', label: 'Max slices', type: 'number', min: 2, max: 12 }] }],
  donut: [
    {
      id: 'donut',
      label: 'Donut',
      controls: [
        { path: 'pie.maxSlices', label: 'Max slices', type: 'number', min: 2, max: 12 },
        { path: 'donut.innerRadius', label: 'Inner radius', type: 'range', min: 0.2, max: 0.9, step: 0.02 },
        { path: 'donut.centerLabel', label: 'Center total', type: 'boolean' },
      ],
    },
  ],
  table: [
    {
      id: 'table',
      label: 'Table',
      controls: [
        { path: 'table.totals', label: 'Totals', type: 'boolean' },
        { path: 'table.rowBanding', label: 'Row banding', type: 'boolean' },
        { path: 'table.wrap', label: 'Wrap text', type: 'boolean' },
        { path: 'table.density', label: 'Density', type: 'select', options: sel('compact', 'normal', 'comfortable') },
        { path: 'table.conditional', label: 'Conditional formatting (JSON)', type: 'json', placeholder: '{ "Total Sales": { "dataBars": true } }' },
      ],
    },
  ],
  matrix: [
    {
      id: 'matrix',
      label: 'Matrix',
      controls: [
        { path: 'matrix.expandAll', label: 'Expand all', type: 'boolean' },
        { path: 'matrix.columnTotals', label: 'Column totals', type: 'boolean' },
        { path: 'matrix.conditional', label: 'Conditional formatting (JSON)', type: 'json' },
      ],
    },
  ],
  slicer: [
    {
      id: 'slicer',
      label: 'Slicer',
      controls: [
        { path: 'slicer.style', label: 'Style', type: 'select', options: sel(['', 'Auto'], 'list', 'dropdown', 'tiles', 'between', 'relative', 'slider') },
        { path: 'slicer.single', label: 'Single select', type: 'boolean' },
        { path: 'slicer.search', label: 'Search box', type: 'boolean' },
        { path: 'slicer.selectAll', label: '"Select all"', type: 'boolean' },
        { path: 'slicer.orientation', label: 'Tile orientation', type: 'select', options: sel('horizontal', 'vertical') },
        { path: 'slicer.syncGroup', label: 'Sync group', type: 'text', placeholder: 'e.g. year' },
      ],
    },
  ],
  text: [{ id: 'text', label: 'Text', controls: [{ path: 'text.content', label: 'Content (markdown, {{Measure}})', type: 'textarea' }] }],
  waterfall: [
    {
      id: 'waterfall',
      label: 'Waterfall',
      controls: [
        { path: 'waterfall.showTotal', label: 'Total bar', type: 'boolean' },
        { path: 'waterfall.totalLabel', label: 'Total label', type: 'text' },
        { path: 'waterfall.increaseColor', label: 'Increase', type: 'color' },
        { path: 'waterfall.decreaseColor', label: 'Decrease', type: 'color' },
        { path: 'waterfall.totalColor', label: 'Total', type: 'color' },
      ],
    },
  ],
  histogram: [
    {
      id: 'histogram',
      label: 'Bins',
      controls: [
        { path: 'histogram.bins', label: 'Bins', type: 'number', min: 2, max: 100, placeholder: 'Auto' },
        { path: 'histogram.binWidth', label: 'Bin width', type: 'number', placeholder: 'Auto' },
      ],
    },
  ],
  bullet: [
    {
      id: 'bullet',
      label: 'Bullet',
      controls: [
        { path: 'bullet.bands', label: 'Bands (JSON)', type: 'json', placeholder: '[0.6, 0.85, 1]' },
        { path: 'bullet.sharedScale', label: 'Shared scale', type: 'boolean' },
      ],
    },
  ],
  map: [
    {
      id: 'map',
      label: 'Map',
      controls: [
        { path: 'map.tiles', label: 'Tile URL', type: 'text', placeholder: 'https://…/{z}/{x}/{y}.png' },
        { path: 'map.attribution', label: 'Attribution', type: 'text' },
        { path: 'map.maxRadius', label: 'Max bubble radius', type: 'number', min: 4, max: 80 },
        { path: 'map.zoom', label: 'Zoom & pan', type: 'boolean' },
        { path: 'map.graticule', label: 'Lat/long grid', type: 'boolean' },
      ],
    },
  ],
  filledMap: [
    {
      id: 'map',
      label: 'Map',
      controls: [
        { path: 'map.featureKey', label: 'Feature key', type: 'text', placeholder: 'name' },
        { path: 'map.tiles', label: 'Tile URL', type: 'text' },
        { path: 'map.zoom', label: 'Zoom & pan', type: 'boolean' },
      ],
    },
  ],
  decompositionTree: [
    {
      id: 'decomposition',
      label: 'Decomposition',
      controls: [
        { path: 'decomposition.maxNodes', label: 'Nodes per level', type: 'number', min: 3, max: 50 },
        { path: 'decomposition.aiSplits', label: 'High/Low value splits', type: 'boolean' },
        { path: 'decomposition.columnWidth', label: 'Column width', type: 'number', min: 120, max: 400 },
      ],
    },
  ],
};

const CARTESIAN = new Set(['clusteredColumn', 'stackedColumn', 'percentStackedColumn', 'clusteredBar', 'stackedBar', 'percentStackedBar', 'line', 'area', 'stackedArea', 'lineClusteredColumn', 'waterfall', 'ribbon', 'boxPlot', 'histogram']);

/** Sections shown in the format pane for a visual type. */
export function sectionsFor(type: string): FormatSection[] {
  const def = getVisual(type);
  const c = COMMON_SECTIONS;
  const base = [c.general, c.layout, c.title];
  let out: FormatSection[];
  if (def.category === 'chart') {
    out = [...base, c.legend, c.dataLabels];
    if (CARTESIAN.has(type) || type === 'scatter') out.push(c.categoryAxis, c.valueAxis);
    out.push(c.colors);
    if (/Column|Bar|waterfall|ribbon/.test(type)) out.push(c.bars);
    if (/line|area|Area|lineClustered/.test(type)) out.push(c.lines);
    if (CARTESIAN.has(type) || type === 'scatter') out.push(c.analytics);
    if (def.roles.some((r) => r.name === 'smallMultiples')) out.push(c.smallMultiples);
    out.push(c.tooltip, c.animation);
  } else if (def.category === 'card') out = [...base, c.dataLabels, c.colors, c.tooltip];
  else out = [...base];
  out.push(...(TYPE_SECTIONS[type] ?? []), c.background, c.border, c.header);
  return out;
}
