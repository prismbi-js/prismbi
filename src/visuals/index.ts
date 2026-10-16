import { registerVisual } from './registry';
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
import { decompositionTree } from './decomposition';

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
  funnel,
  scatter,
  card,
  multiRowCard,
  kpi,
  gauge,
  table,
  matrix,
  slicer,
  textBox,
  waterfall,
  heatmap,
  decompositionTree,
};

let registered = false;

/** Register every built-in visual (idempotent). Called automatically by the main entry. */
export function registerBuiltinVisuals(): void {
  if (registered) return;
  registered = true;
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
  registerVisual(funnel);
  registerVisual(scatter, ['bubble']);
  registerVisual(card);
  registerVisual(multiRowCard);
  registerVisual(kpi);
  registerVisual(gauge);
  registerVisual(table);
  registerVisual(matrix);
  registerVisual(slicer);
  registerVisual(textBox, ['textbox']);
  registerVisual(waterfall);
  registerVisual(heatmap);
  registerVisual(decompositionTree, ['decomp']);
}
