import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Report } from '../src/index';
import { History, Studio, assignField, autoReport, autoVisualFor, migrateReport, retargetFields } from '../src/studio';
import { createRelationship } from '../src/studio/views';
import { makeModel } from './fixtures';

let el: HTMLElement;
beforeEach(() => {
  el = document.createElement('div');
  el.style.height = '800px';
  document.body.append(el);
  localStorage.clear();
});
afterEach(() => {
  el.remove();
  document.querySelectorAll('.pbs, .pbi-report').forEach((n) => n.remove());
});

const q = <T extends Element = Element>(sel: string, root: ParentNode = el) => root.querySelector<T>(sel);
const qa = <T extends Element = Element>(sel: string, root: ParentNode = el) => [...root.querySelectorAll<T>(sel)];
const key = (k: string, opts: KeyboardEventInit = {}) => q('.pbs')!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));

describe('history', () => {
  it('undoes, redoes and coalesces identical states', () => {
    const hst = new History<{ n: number }>();
    hst.reset({ n: 0 });
    expect(hst.push({ n: 1 })).toBe(true);
    expect(hst.push({ n: 1 })).toBe(false);
    hst.push({ n: 2 });
    expect(hst.undo()).toEqual({ n: 1 });
    expect(hst.undo()).toEqual({ n: 0 });
    expect(hst.undo()).toBeUndefined();
    expect(hst.redo()).toEqual({ n: 1 });
    hst.push({ n: 9 });
    expect(hst.canRedo).toBe(false);
  });
});

describe('field assignment', () => {
  const m = makeModel();
  it('routes measures to value wells and columns to grouping wells', () => {
    let spec = { type: 'clusteredColumn', fields: {} } as const as { type: string; fields: Record<string, unknown> };
    spec = { ...spec, fields: assignField(m, spec as never, 'Total Sales') as never };
    spec = { ...spec, fields: assignField(m, spec as never, 'Products[Category]') as never };
    spec = { ...spec, fields: assignField(m, spec as never, 'Region[Name]') as never };
    expect(spec.fields).toEqual({ values: ['Total Sales'], category: ['Products[Category]'], legend: 'Region[Name]' });
  });

  it('aggregates numeric columns dropped into value wells', () => {
    const f = assignField(m, { type: 'card', fields: {} }, 'Sales[Amount]');
    expect(f).toEqual({ value: { field: 'Sales[Amount]', aggregation: 'sum' } });
  });

  it('keeps fields when changing visual type', () => {
    const f = retargetFields(m, { type: 'clusteredColumn', fields: { category: 'Products[Category]', values: ['Total Sales'] } }, 'donut');
    expect(f).toEqual({ legend: ['Products[Category]'], values: 'Total Sales' });
  });

  it('suggests a visual for a lone field', () => {
    expect(autoVisualFor(m, 'Total Sales').type).toBe('card');
    expect(autoVisualFor(m, 'Products[Category]').type).toBe('table');
    expect(autoVisualFor(m, 'Sales[OrderDate]').type).toBe('slicer');
  });
});

describe('auto report & migrations', () => {
  it('generates a page that renders without errors', () => {
    const page = autoReport(makeModel());
    expect(page.visuals.map((v) => v.type)).toEqual(expect.arrayContaining(['card', 'line', 'clusteredBar', 'table']));
    const r = new Report(el, { model: makeModel(), pages: [page] });
    r.flush();
    expect(q('.pbi-error')).toBeNull();
  });

  it('upgrades old definitions and refuses newer ones', () => {
    const def = migrateReport({ pages: [{ name: 'P', visuals: [{ type: 'slicer', format: { style: 'tiles' } }, { type: 'line', fields: { axis: 'Date[Month]' } }] }] });
    expect(def.version).toBe(1);
    expect(def.pages[0].visuals[0].format).toEqual({ slicer: { style: 'tiles' } });
    expect(def.pages[0].visuals[1].fields).toEqual({ category: 'Date[Month]' });
    expect(() => migrateReport({ version: 99, pages: [] })).toThrow(/newer/);
  });
});

describe('report edit APIs', () => {
  it('duplicates, moves and reloads pages', () => {
    const r = new Report(el, { model: makeModel(), pages: [{ id: 'a', name: 'A', visuals: [{ type: 'card', layout: { x: 0, y: 0, w: 3, h: 3 }, fields: { value: 'Total Sales' } }] }] });
    const changes: string[] = [];
    r.on('definitionChanged', (e) => changes.push(e.reason));
    const copy = r.duplicatePage('a');
    expect(r.pageList.map((p) => p.name)).toEqual(['A', 'A (copy)']);
    r.movePage(copy, 0);
    expect(r.pageList[0].id).toBe(copy);
    expect(r.findFreeSpot(3, 3, 'a')).toEqual({ x: 3, y: 0 });
    const json = r.toJSON();
    r.load({ pages: [{ name: 'Only', visuals: [] }] });
    expect(r.pageList.map((p) => p.name)).toEqual(['Only']);
    r.load(json);
    expect(r.pageList).toHaveLength(2);
    expect(changes).toContain('addPage');
    expect(changes).toContain('movePage');
  });
});

describe('studio', () => {
  const open = (extra: Partial<ConstructorParameters<typeof Studio>[1]> = {}) => new Studio(el, { model: makeModel(), ...extra });

  it('opens with a generated page in edit mode', () => {
    const st = open();
    st.report.flush();
    expect(q('.pbs-brand')?.textContent).toBe('PrismBI Studio');
    expect(qa('.pbi-visual').length).toBeGreaterThan(3);
    expect(qa('.pbi-edit').length).toBe(qa('.pbi-visual').length);
    expect(qa('.pbs-field').length).toBeGreaterThan(10);
    st.destroy();
  });

  it('builds visuals from fields, changes type, undoes and redoes', () => {
    const st = open({ starter: 'blank' });
    const id = st.addVisual('card');
    expect(st.selected()).toBe(id);
    expect(qa('.pbs-well-h span').map((s) => s.textContent)).toEqual(['Value *', 'Change']);
    st.addField('Total Sales');
    st.report.flush();
    expect(q(`[data-visual-id="${id}"] .pbi-card-value`)?.textContent).toBe('$6,750');
    st.setVisualType('gauge');
    expect(st.report.visual(id).spec.type).toBe('gauge');
    st.undo();
    expect(st.report.visual(id).spec.type).toBe('card');
    st.redo();
    expect(st.report.visual(id).spec.type).toBe('gauge');
    st.destroy();
  });

  it('clicking a field with nothing selected creates a visual for it', () => {
    const st = open({ starter: 'blank' });
    const field = qa<HTMLElement>('.pbs-field').find((f) => f.dataset.ref === 'Total Sales')!;
    field.click();
    const id = st.selected()!;
    expect(st.report.visual(id).spec).toMatchObject({ type: 'card', fields: { value: 'Total Sales' } });
    st.destroy();
  });

  it('edits format through the format pane', () => {
    const st = open({ starter: 'blank' });
    const id = st.addVisual('clusteredColumn', { category: 'Products[Category]', values: 'Total Sales' });
    qa<HTMLButtonElement>('.pbs-tabs button').find((b) => b.textContent === 'Format')!.click();
    const sec = q<HTMLDetailsElement>('.pbs-sec[data-sec="dataLabels"]')!;
    const show = sec.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    show.checked = true;
    show.dispatchEvent(new Event('change'));
    expect(st.report.visual(id).spec.format).toEqual({ dataLabels: { show: true } });
    const title = q<HTMLInputElement>('.pbs-sec[data-sec="general"] input[type="text"]')!;
    title.value = 'Sales by category';
    title.dispatchEvent(new Event('change'));
    expect(st.report.visual(id).spec.title).toBe('Sales by category');
    st.destroy();
  });

  it('keyboard: nudge, duplicate, delete, undo', () => {
    const st = open({ starter: 'blank' });
    const id = st.addVisual('card');
    const x0 = st.report.visual(id).spec.layout!.x;
    key('ArrowRight');
    expect(st.report.visual(id).spec.layout!.x).toBe(x0 + 1);
    key('ArrowDown', { shiftKey: true });
    expect(st.report.visual(id).spec.layout!.h).toBe(4);
    key('d', { ctrlKey: true });
    const dup = st.selected()!;
    expect(dup).not.toBe(id);
    key('Delete');
    expect(st.report.visualIds()).toEqual([id]);
    key('z', { ctrlKey: true });
    expect(st.report.visualIds()).toHaveLength(2);
    st.destroy();
  });

  it('drags a visual on the grid', () => {
    const st = open({ starter: 'blank' });
    const id = st.addVisual('card');
    const overlay = q(`[data-edit-for="${id}"]`)!;
    const start = st.report.visual(id).spec.layout!;
    overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, button: 0 }));
    overlay.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 260, clientY: 100 }));
    overlay.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 260, clientY: 100 }));
    expect(st.report.visual(id).spec.layout).toMatchObject({ x: start.x + 2, y: start.y });
    // resize from the south-east handle
    const se = overlay.querySelector('.pbi-handle-se')!;
    se.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }));
    overlay.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 112 }));
    overlay.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(st.report.visual(id).spec.layout).toMatchObject({ w: start.w + 1, h: start.h + 2 });
    st.destroy();
  });

  it('tracks model edits in the document and undoes them', () => {
    const st = open({ starter: 'blank' });
    st.model.addMeasure('Big Orders', 'CALCULATE([Orders], Sales[Amount] >= 1000)');
    st.commit();
    expect(st.document.model.measures.map((m) => m.name)).toEqual(['Big Orders']);
    st.model.addCalculatedColumn('Sales', 'Double', 'Sales[Amount] * 2');
    st.commit();
    expect(st.document.model.columns).toEqual([{ table: 'Sales', name: 'Double', expression: 'Sales[Amount] * 2', format: undefined }]);
    st.model.removeMeasure('Margin %');
    st.commit();
    expect(st.document.model.removedMeasures).toEqual(['Margin %']);
    st.undo();
    expect(st.model.hasMeasure('Margin %')).toBe(true);
    st.undo();
    expect(st.model.table('Sales').hasColumn('Double')).toBe(false);
    st.undo();
    expect(st.model.hasMeasure('Big Orders')).toBe(false);
    st.redo();
    expect(st.model.hasMeasure('Big Orders')).toBe(true);
    st.destroy();
  });

  it('creates and edits relationships from the model view', () => {
    const st = open({ starter: 'blank' });
    st.model.addTable('Targets', [{ Region: 'North', Target: 5000 }, { Region: 'South', Target: 2000 }]);
    expect(createRelationship(st, 'Targets|Region', 'Region|Name')).toBe(true);
    expect(st.document.model.relationships).toHaveLength(1);
    expect(st.model.evaluate('SUM(Targets[Target])', [{ target: 'Region[Name]', op: 'eq', value: 'North' }])).toBe(5000);
    st.setView('model');
    expect(qa('.pbs-card').map((c) => c.getAttribute('data-table'))).toContain('Targets');
    expect(qa('path.pbs-rel').length).toBe(st.model.relationships().length);
    st.undo();
    expect(st.model.relationships().some((r) => r.fromTable === 'Targets')).toBe(false);
    st.setView('data');
    expect(q('.pbs-grid table')).toBeTruthy();
    st.destroy();
  });

  it('manages pages from the tab bar', () => {
    const st = open({ starter: 'blank' });
    q<HTMLButtonElement>('.pbs-addpage')!.click();
    expect(st.report.pageList.map((p) => p.name)).toEqual(['Page 1', 'Page 2']);
    expect(qa('.pbs-page').map((t) => t.textContent)).toEqual(['Page 1', 'Page 2']);
    st.report.updatePage(st.report.currentPage.id, { name: 'Details' });
    expect(qa('.pbs-page').map((t) => t.textContent)).toContain('Details');
    st.undo();
    expect(st.report.pageList.map((p) => p.name)).toEqual(['Page 1', 'Page 2']);
    st.destroy();
  });

  it('theme overrides, preview mode and autosave', () => {
    const st = open({ starter: 'blank', storageKey: 'studio-test' });
    st.setThemeOverrides({ mode: 'dark', accent: '#ff8800' });
    expect(st.report.theme.mode).toBe('dark');
    expect(st.report.theme.accent).toBe('#ff8800');
    st.addVisual('card', { value: 'Orders' });
    st.save();
    st.setPreview(true);
    expect(st.report.editMode).toBe(false);
    expect(q('.pbs')!.classList.contains('is-preview')).toBe(true);
    st.destroy();
    const again = open({ storageKey: 'studio-test' });
    expect(again.report.visualIds()).toHaveLength(1);
    expect(again.report.theme.mode).toBe('dark');
    again.undo(); // nothing to undo after a fresh load
    expect(again.report.visualIds()).toHaveLength(1);
    again.destroy();
  });

  it('quick measures creates template DAX measures', () => {
    const st = open({ starter: 'blank' });
    st.quickMeasure();
    const modal = q('.pbs-modal');
    expect(modal).toBeTruthy();
    const nameInput = q<HTMLInputElement>('input[aria-label="Measure name"]', modal!)!;
    expect(nameInput.value).toContain('YoY %');
    const createBtn = qa<HTMLButtonElement>('.pbs-btn', modal!).find((b) => b.textContent === 'Create')!;
    createBtn.click();
    expect(st.model.hasMeasure(nameInput.value)).toBe(true);
    expect(modal?.parentElement).toBeNull(); // modal closed
    st.destroy();
  });

  it('layers panel allows toggling visual visibility', () => {
    const st = open({ starter: 'blank' });
    const id = st.addVisual('card', { value: 'Total Sales' });
    const layersBtn = qa<HTMLButtonElement>('.pbs-top .pbs-btn').find((b) => b.textContent?.includes('Layers'))!;
    layersBtn.click();
    const layersList = q('.pbs-layers');
    expect(layersList).toBeTruthy();
    const hideBtn = qa<HTMLButtonElement>('.pbs-layers .pbs-icon-btn').find((b) => b.title.includes('Hide'))!;
    expect(hideBtn).toBeTruthy();
    hideBtn.click();
    expect(st.report.visual(id).spec.hidden).toBe(true);
    st.destroy();
  });

  it('data view virtualizes large tables', () => {
    const st = open({ starter: 'blank' });
    st.model.addTable('BigTable', Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Item ${i}` })));
    st.dataState.table = 'BigTable';
    st.setView('data');
    const grid = q('.pbs-grid');
    expect(grid).toBeTruthy();
    const rows = qa('tbody tr', grid!);
    expect(rows.length).toBeLessThan(100);
    expect(q('.pbi-spacer', grid!)).toBeTruthy();
    st.destroy();
  });
});
