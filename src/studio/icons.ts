/** Tiny 20×20 line icons for the visualizations pane and the rail (currentColor). */
const svg = (body: string) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const COL = svg('<path d="M4 16V9M8 16V5M12 16v-6M16 16V7"/>');
const STACK = svg('<path d="M5 16V8M5 11h0M10 16V5M15 16v-6"/><path d="M3.5 11h3M8.5 9h3M13.5 13h3"/>');
const BAR = svg('<path d="M4 5h7M4 9h11M4 13h5M4 17h9"/>');
const LINE = svg('<path d="M3 15l4-5 3 3 7-8"/>');
const AREA = svg('<path d="M3 16l4-6 3 3 7-8v11z" fill="currentColor" fill-opacity=".18"/>');
const PIE = svg('<circle cx="10" cy="10" r="7"/><path d="M10 3v7h7"/>');
const DONUT = svg('<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3"/>');
const SCATTER = svg('<circle cx="6" cy="13" r="1.4"/><circle cx="10" cy="8" r="1.4"/><circle cx="14" cy="11" r="1.4"/><circle cx="15" cy="5" r="1.4"/>');
const CARD = svg('<rect x="3" y="5" width="14" height="10" rx="2"/><path d="M6 11h5"/>');
const TABLE = svg('<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 8h14M3 12h14M9 4v12"/>');
const MATRIX = svg('<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 8h14M7 4v12M12 4v12"/>');
const SLICER = svg('<path d="M4 6h12M7 10h6M9 14h2"/>');
const FUNNEL = svg('<path d="M3 4h14l-5 6v6l-4-2v-4z"/>');
const TREE = svg('<rect x="3" y="3" width="8" height="14"/><rect x="11" y="3" width="6" height="7"/><rect x="11" y="10" width="6" height="7"/>');
const GAUGE = svg('<path d="M3.5 14a6.5 6.5 0 0 1 13 0"/><path d="M10 14l3-4"/>');
const KPI = svg('<path d="M3 15l4-4 3 2 6-7"/><path d="M13 6h3v3"/>');
const TEXT = svg('<path d="M4 5h12M10 5v11M7 16h6"/>');
const WATERFALL = svg('<path d="M4 16v-5M8 11V6M12 6v5M16 11v5"/><path d="M4 11h4M8 6h4M12 11h4"/>');
const HEAT = svg('<rect x="3" y="3" width="6" height="6"/><rect x="11" y="3" width="6" height="6" fill="currentColor" fill-opacity=".3"/><rect x="3" y="11" width="6" height="6" fill="currentColor" fill-opacity=".6"/><rect x="11" y="11" width="6" height="6"/>');
const DECOMP = svg('<path d="M3 10h4M7 10l3-5h3M7 10l3 5h3M13 5h4M13 15h4"/>');
const HIST = svg('<path d="M3 16h14"/><path d="M4 16v-4h3v4M7 16V7h3v9M10 16V4h3v12M13 16v-6h3v6"/>');
const BOX = svg('<path d="M10 3v3M10 14v3M7 17h6M7 3h6"/><rect x="5" y="6" width="10" height="8" rx="1"/><path d="M5 10h10"/>');
const BULLET = svg('<rect x="3" y="7" width="14" height="6" rx="1"/><path d="M3 10h8M13 6v8"/>');
const RADAR = svg('<path d="M10 3l6.6 4.8-2.5 7.7H5.9L3.4 7.8z"/><path d="M10 7l3 2.5-1 3.5H8l-1-3.5z"/>');
const SANKEY = svg('<path d="M3 5c6 0 8 10 14 10M3 13c6 0 8-8 14-8"/>');
const RIBBON = svg('<path d="M4 15V8M16 15V5"/><path d="M5 9c4 0 6-3 10-3M5 13c4 0 6 1 10 1"/>');
const MAP = svg('<path d="M3 5l4-2 6 2 4-2v12l-4 2-6-2-4 2z"/><path d="M7 3v12M13 5v12"/>');
const SUNBURST = svg('<circle cx="10" cy="10" r="2.5"/><path d="M10 5.5a4.5 4.5 0 0 1 4.5 4.5M10 5.5a4.5 4.5 0 0 0-3.9 6.7"/><path d="M10 3a7 7 0 0 1 7 7M10 3a7 7 0 0 0-6.1 10.4M17 10a7 7 0 0 1-12.9 3.6"/>');
const COMBO = svg('<path d="M5 16v-5M10 16V8M15 16v-6"/><path d="M3 9l5-4 4 3 5-4"/>');

export const VISUAL_ICONS: Record<string, string> = {
  clusteredColumn: COL,
  stackedColumn: STACK,
  percentStackedColumn: STACK,
  clusteredBar: BAR,
  stackedBar: BAR,
  percentStackedBar: BAR,
  line: LINE,
  area: AREA,
  stackedArea: AREA,
  lineClusteredColumn: COMBO,
  ribbon: RIBBON,
  waterfall: WATERFALL,
  pie: PIE,
  donut: DONUT,
  treemap: TREE,
  sunburst: SUNBURST,
  funnel: FUNNEL,
  scatter: SCATTER,
  heatmap: HEAT,
  histogram: HIST,
  boxPlot: BOX,
  bullet: BULLET,
  radar: RADAR,
  sankey: SANKEY,
  map: MAP,
  filledMap: MAP,
  decompositionTree: DECOMP,
  card: CARD,
  multiRowCard: CARD,
  kpi: KPI,
  gauge: GAUGE,
  table: TABLE,
  matrix: MATRIX,
  slicer: SLICER,
  text: TEXT,
};

export const RAIL_ICONS = {
  report: svg('<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="11" y="3" width="6" height="9" rx="1"/><rect x="3" y="11" width="6" height="6" rx="1"/><rect x="11" y="14" width="6" height="3" rx="1"/>'),
  data: TABLE,
  model: svg('<rect x="2" y="3" width="6" height="5" rx="1"/><rect x="12" y="12" width="6" height="5" rx="1"/><rect x="12" y="3" width="6" height="5" rx="1"/><path d="M8 5.5h4M15 8v4"/>'),
};

/** Order of visual types in the visualizations pane. */
export const VISUAL_ORDER = [
  'clusteredColumn', 'stackedColumn', 'percentStackedColumn', 'clusteredBar', 'stackedBar', 'percentStackedBar',
  'line', 'area', 'stackedArea', 'lineClusteredColumn', 'ribbon', 'waterfall',
  'pie', 'donut', 'treemap', 'sunburst', 'funnel', 'scatter', 'heatmap', 'histogram', 'boxPlot', 'bullet', 'radar', 'sankey', 'map', 'filledMap', 'decompositionTree',
  'card', 'multiRowCard', 'kpi', 'gauge', 'table', 'matrix', 'slicer', 'text',
];

export const FALLBACK_ICON = svg('<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M8 10h4M10 8v4"/>');
