import { describe, expect, it } from 'vitest';
import { Studio } from '../src/studio/studio';
import { Report, autoMobileLayout } from '../src/report/report';
import { makeModel } from './fixtures';

describe('responsive views', () => {
  it('studio switches between report, data, and model views responsively', () => {
    const el = document.createElement('div');
    el.style.width = '375px'; // mobile phone portrait width
    el.style.height = '667px';
    document.body.append(el);

    const model = makeModel();
    const studio = new Studio(el, { model });

    // 1. Report view by default
    expect(el.querySelector('.pbs-canvas')).not.toBeNull();
    expect(el.querySelector('.pbs-top')).not.toBeNull();
    expect(el.querySelector('.pbs-rail')).not.toBeNull();
    expect(el.querySelector('.pbs-pages')).not.toBeNull();

    // Responsive properties panel toggle
    expect(el.querySelector('.pbs-props-btn')).not.toBeNull();
    studio.toggleProperties();
    expect(studio.root.classList.contains('is-panel-open')).toBe(true);
    studio.toggleProperties();
    expect(studio.root.classList.contains('is-panel-open')).toBe(false);

    // Active visual toggles responsive panel state
    const report = studio.report;
    const firstVisual = report.toJSON().pages[0]?.visuals[0];
    if (firstVisual?.id) {
      report.setActiveVisual(firstVisual.id);
      expect(studio.root.classList.contains('has-active-visual')).toBe(true);
      report.setActiveVisual(null);
      expect(studio.root.classList.contains('has-active-visual')).toBe(false);
    }

    // 2. Data view
    studio.setView('data');
    expect(el.querySelector('.pbs-data')).not.toBeNull();
    expect(el.querySelector('.pbs-data-list')).not.toBeNull();
    expect(el.querySelector('.pbs-data-main')).not.toBeNull();
    expect(el.querySelector('.pbs-grid table')).not.toBeNull();
    expect(el.querySelector('.pbs-data-bar')).not.toBeNull();

    // 3. Model view
    studio.setView('model');
    expect(el.querySelector('.pbs-model')).not.toBeNull();
    expect(el.querySelectorAll('.pbs-card').length).toBeGreaterThan(0);
    expect(el.querySelector('.pbs-model-svg')).not.toBeNull();

    // Switch back to report view
    studio.setView('report');
    expect(el.querySelector('.pbs-canvas')).not.toBeNull();

    studio.destroy();
    el.remove();
  });

  it('report supports mobile layout and auto phone layout stack', () => {
    const page = {
      id: 'p1',
      name: 'Overview',
      visuals: [
        { id: 'kpi1', type: 'kpi', layout: { x: 0, y: 0, w: 4, h: 3 }, fields: { value: 'Total Sales' } },
        { id: 'kpi2', type: 'kpi', layout: { x: 4, y: 0, w: 4, h: 3 }, fields: { value: 'Orders' } },
        { id: 'colChart', type: 'clusteredColumn', layout: { x: 0, y: 3, w: 12, h: 6 }, fields: { category: 'Products[Category]', values: 'Total Sales' } },
      ],
    };

    const auto = autoMobileLayout(page as never, 4);
    expect(auto.columns).toBe(4);
    expect(auto.visuals.length).toBe(3);
    // 2 KPIs share row
    expect(auto.visuals[0].layout.w).toBe(2);
    expect(auto.visuals[1].layout.w).toBe(2);
    // Column chart gets full width
    expect(auto.visuals[2].layout.w).toBe(4);

    const el = document.createElement('div');
    el.style.width = '390px';
    el.style.height = '800px';
    document.body.append(el);

    const r = new Report(el, { model: makeModel(), pages: [page as never], layoutMode: 'mobile' });
    r.flush();

    expect(r.isMobileLayout).toBe(true);
    const pageEl = el.querySelector('.pbi-page') as HTMLElement;
    expect(pageEl.classList.contains('is-mobile')).toBe(true);
    expect(pageEl.style.getPropertyValue('--pbi-cols')).toBe('4');

    // Filter pane responsive rendering inside .pbi-main
    expect(el.querySelector('.pbi-main')).not.toBeNull();
    expect(el.querySelector('.pbi-fpane')).not.toBeNull();

    r.destroy();
    el.remove();
  });
});
