import { describe, expect, it } from 'vitest';
import { Report } from '../src/index';
import type { ReportDefinition } from '../src/index';
import { makeModel } from './fixtures';

const def = (): ReportDefinition => ({
  name: 'Sales',
  pages: [
    {
      id: 'overview',
      name: 'Overview',
      visuals: [
        { id: 'cols', type: 'clusteredColumn', title: 'Sales by category', layout: { x: 0, y: 0, w: 8, h: 6 }, fields: { category: 'Products[Category]', values: 'Total Sales' } },
        { id: 'note', type: 'text', layout: { x: 8, y: 0, w: 4, h: 2 }, fields: {}, format: { text: { content: 'Hello' } } },
      ],
    },
    { id: 'details', name: 'Details', visuals: [] },
  ],
  translations: {
    fr: {
      pages: { overview: 'Aperçu' },
      visuals: { cols: { title: 'Ventes par catégorie' }, note: { text: 'Bonjour' } },
      fields: { 'Total Sales': 'Ventes totales', 'Products[Category]': 'Catégorie' },
    },
  },
});

describe('localization', () => {
  it('translates page names, titles, text and field names, with language fallback', () => {
    const el = document.createElement('div');
    el.style.height = '600px';
    document.body.append(el);
    const r = new Report(el, { model: makeModel(), ...def(), locale: 'fr-CA' });
    r.flush();
    expect(el.querySelector('.pbi-tab')?.textContent).toBe('Aperçu');
    expect(el.querySelector('[data-visual-id="cols"]')!.textContent).toContain('Ventes par catégorie');
    expect(el.querySelector('[data-visual-id="note"]')!.textContent).toContain('Bonjour');
    // field names drive legends, axis titles and narration
    expect(el.querySelector('[data-visual-id="cols"] [aria-description]')?.getAttribute('aria-description')).toMatch(/of Ventes totales by Catégorie/);
    expect(el.getAttribute('dir') ?? el.querySelector('.pbi-report')?.getAttribute('dir')).toBe('ltr');
    // switch at runtime
    r.setLocale('en-US');
    r.flush();
    expect(el.querySelector('.pbi-tab')?.textContent).toBe('Overview');
    expect(el.querySelector('[data-visual-id="cols"]')!.textContent).toContain('Sales by category');
    // right-to-left languages
    r.setLocale('ar-EG');
    expect(el.querySelector('.pbi-report')?.getAttribute('dir')).toBe('rtl');
    // translations travel with the definition
    expect(r.toJSON().translations?.fr.pages?.overview).toBe('Aperçu');
    r.destroy();
    el.remove();
  });
});

describe('schedules in the report definition', () => {
  it('keeps subscriptions and alerts through toJSON and load', () => {
    const el = document.createElement('div');
    document.body.append(el);
    const r = new Report(el, { model: makeModel(), pages: [{ id: 'p', name: 'P', visuals: [] }] });
    r.setSubscriptions([{ id: 's', name: 'Daily', page: 'p', schedule: 'daily@08:00', recipients: ['a@b.c'] }]);
    r.setAlerts([{ id: 'a', name: 'High', measure: 'Total Sales', when: { above: 100 } }]);
    const json = r.toJSON();
    expect(json.subscriptions?.[0].schedule).toBe('daily@08:00');
    r.load({ pages: [{ id: 'p', name: 'P', visuals: [] }] });
    expect(r.subscriptionList).toEqual([]);
    r.load(json);
    expect(r.alertList[0].name).toBe('High');
    r.destroy();
    el.remove();
  });
});
