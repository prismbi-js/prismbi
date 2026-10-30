import { hasVisual, registerVisual } from './registry';
import { clusteredBar, clusteredColumn, percentStackedBar, percentStackedColumn, stackedBar, stackedColumn } from './bar';
import { areaChart, comboChart, lineChart, stackedAreaChart } from './line';
import { donutChart, funnel, pieChart, treemap } from './parts';
import { scatter } from './scatter';
import { card, gauge, kpi, multiRowCard } from './cards';
import { matrix, table } from './table';
import { slicer } from './slicer';
import { textBox } from './text';
import { waterfall } from './waterfall';
import { heatmap } from './heatmap';
import { calendarHeatmap } from './calendar';
import { decompositionTree } from './decomposition';
import { boxPlot, histogram } from './distribution';
import { bullet, radar, ribbon, sankey } from './more';
import { bubbleMap, filledMap } from './map';
import { sunburst } from './sunburst';
import { scorecard } from './scorecard';
import { gantt } from './gantt';
import { candlestick } from './candlestick';

export const builtinVisuals = {
  clusteredColumn,
  stackedColumn,
  percentStackedColumn,
  clusteredBar,
  stackedBar,
  percentStackedBar,
  lineChart,
  areaChart,
  stackedAreaChart,
  comboChart,
  pieChart,
  donutChart,
  treemap,
  sunburst,
  funnel,
  scatter,
  card,
  multiRowCard,
  kpi,
  scorecard,
  gauge,
  table,
  matrix,
  slicer,
  textBox,
  waterfall,
  heatmap,
  calendarHeatmap,
  decompositionTree,
  histogram,
  boxPlot,
  bullet,
  radar,
  sankey,
  ribbon,
  bubbleMap,
  filledMap,
  gantt,
  candlestick,
};


/** Register every built-in visual (idempotent). Called automatically by the main entry. */
export function registerBuiltinVisuals(): void {
  if (hasVisual('clusteredColumn') && hasVisual('scorecard')) return;
  registerVisual(clusteredColumn, ['column']);
  registerVisual(stackedColumn);
  registerVisual(percentStackedColumn);
  registerVisual(clusteredBar, ['bar']);
  registerVisual(stackedBar);
  registerVisual(percentStackedBar);
  registerVisual(lineChart);
  registerVisual(areaChart);
  registerVisual(stackedAreaChart);
  registerVisual(comboChart, ['combo']);
  registerVisual(pieChart);
  registerVisual(donutChart);
  registerVisual(treemap);
  registerVisual(sunburst);
  registerVisual(funnel);
  registerVisual(scatter, ['bubble']);
  registerVisual(card);
  registerVisual(multiRowCard);
  registerVisual(kpi);
  registerVisual(scorecard, ['goals']);
  registerVisual(gauge);
  registerVisual(table);
  registerVisual(matrix);
  registerVisual(slicer);
  registerVisual(textBox, ['textbox']);
  registerVisual(waterfall);
  registerVisual(heatmap);
  registerVisual(calendarHeatmap);
  registerVisual(decompositionTree, ['decomp']);
  registerVisual(histogram);
  registerVisual(boxPlot, ['boxAndWhisker']);
  registerVisual(bullet);
  registerVisual(radar);
  registerVisual(sankey);
  registerVisual(ribbon);
  registerVisual(bubbleMap, ['bubbleMap']);
  registerVisual(filledMap, ['choropleth']);
  registerVisual(gantt);
  registerVisual(candlestick);
}
