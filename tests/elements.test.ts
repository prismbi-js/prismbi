import { describe, expect, it, vi } from 'vitest';
import { prismReport, registerModel, type PrismReportElement, type PrismVisualElement } from 'prismbi/elements';
import type { ReportDefinition } from '../src/index';
import { makeModel } from './fixtures';

const tick = () => new Promise((r) => setTimeout(r, 0));
const definition = (): ReportDefinition => ({
  name: 'Sales',
  pages: [
    {
      id: 'p',
      name: 'P',
      visuals: [
        { id: 'slicer', type: 'slicer', layout: { x: 0, y: 0, w: 12, h: 2 }, fields: { field: 'Region[Name]' }, format: { slicer: { style: 'tiles' } } },
        { id: 'card', type: 'card', layout: { x: 0, y: 2, w: 4, h: 2 }, fields: { value: 'Total Sales' } },
      ],
    },
  ],
});
const cardText = (root: Element) => root.querySelector('[data-visual-id="card"] .pbi-card-value')?.textContent;

describe('web components', () => {
  it('<prism-report> mounts from properties, forwards events and tears down', async () => {
    const el = document.createElement('prism-report') as PrismReportElement;
    el.style.height = '600px';
    el.model = makeModel();
    el.definition = definition();
    document.body.append(el);
    await tick();
    el.report!.flush();
    expect(cardText(el)).toBe('$6,750');
    const seen: unknown[] = [];
    el.addEventListener('filtersChanged', (e) => seen.push((e as CustomEvent).detail));
    el.report!.setSlicerSelection('slicer', [{ target: 'Region[Name]', op: 'in', values: ['South'] }]);
    el.report!.flush();
    expect(cardText(el)).toBe('$2,300');
    expect(seen.length).toBeGreaterThan(0);
    // a new definition reloads the same report instance
    const r = el.report;
    const next = definition();
    next.pages[0].visuals[1].fields = { value: 'Margin %' };
    el.definition = next;
    await tick();
    expect(el.report).toBe(r);
    el.remove();
    await tick();
    expect(el.report).toBeNull();
  });

  it('<prism-report> works from attributes: a registered model and a fetched src', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(definition())));
    try {
      document.body.insertAdjacentHTML('beforeend', '<prism-report id="r2" model="sales-el" src="/sales.json" theme="dark" style="height:600px"></prism-report>');
      const el = document.getElementById('r2') as PrismReportElement;
      await tick();
      expect(el.report).toBeNull(); // model not registered yet
      registerModel('sales-el', makeModel());
      await tick();
      await tick();
      expect(fetchMock).toHaveBeenCalledWith('/sales.json', expect.anything());
      el.report!.flush();
      expect(cardText(el)).toBe('$6,750');
      expect(el.querySelector('.pbi-report')!.getAttribute('data-mode')).toBe('dark');
      el.setAttribute('theme', 'light');
      expect(el.querySelector('.pbi-report')!.getAttribute('data-mode')).toBe('light');
      el.remove();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('<prism-visual> renders from JSON attributes', async () => {
    registerModel('sales-v', makeModel());
    document.body.insertAdjacentHTML('beforeend', `<prism-visual id="v1" model="sales-v" type="clusteredColumn" fields='{"category":"Products[Category]","values":"Total Sales"}'></prism-visual>`);
    const el = document.getElementById('v1') as PrismVisualElement;
    await tick();
    el.report!.flush();
    expect(el.querySelectorAll('path.pbi-mark')).toHaveLength(3);
    el.setAttribute('type', 'donut');
    el.setAttribute('fields', '{"legend":"Products[Category]","values":"Total Sales"}');
    await tick();
    el.report!.flush();
    expect(el.querySelectorAll('path.pbi-mark').length).toBeGreaterThan(0);
    el.remove();
  });

  it('Svelte-style action', () => {
    const node = document.createElement('div');
    node.style.height = '600px';
    document.body.append(node);
    const changes: unknown[] = [];
    const action = prismReport(node, { model: makeModel(), definition: definition(), on: { pageChanged: (e) => changes.push(e) } });
    expect(node.querySelector('.pbi-report')).not.toBeNull();
    action.update({ model: makeModel(), definition: definition(), theme: 'dark' });
    expect(node.querySelector('.pbi-report')!.getAttribute('data-mode')).toBe('dark');
    action.destroy();
    node.remove();
  });
});
