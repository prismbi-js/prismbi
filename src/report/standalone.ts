import type { DataModel } from '../data/model';
import type { Theme } from '../theme/theme';
import type { DeepPartial } from '../utils';
import type { VisualSpec } from '../visuals/types';
import type { ReportOptions } from './report';
import { Report } from './report';

export interface StandaloneVisualOptions extends Omit<VisualSpec, 'layout'> {
  model: DataModel;
  theme?: string | Theme | DeepPartial<Theme>;
  locale?: string;
  onEvent?: ReportOptions['onEvent'];
}

/**
 * Render a single visual into any element (no toolbar, tabs or filter pane).
 * Returns the underlying {@link Report} so you can update, filter or listen to it.
 */
export function createVisual(container: HTMLElement, opts: StandaloneVisualOptions): Report {
  const { model, theme, locale, onEvent, ...spec } = opts;
  const report = new Report(container, {
    model,
    theme,
    locale,
    onEvent,
    chrome: { toolbar: false, pageTabs: false, filterPane: false },
    pages: [{ name: 'Visual', layout: { columns: 1, rowHeight: 10, gap: 0 }, visuals: [{ ...spec, layout: { x: 0, y: 0, w: 1, h: 1 } }] }],
  });
  report.root.classList.add('pbi-standalone');
  return report;
}
