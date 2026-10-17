import { h } from '../render/svg';
import { darkTheme, lightTheme } from '../theme/theme';
import type { VisualSpec } from '../visuals/types';
import type { StudioContext } from './context';
import type { FormatControl, FormatSection } from './formatSchema';
import { sectionsFor } from './formatSchema';

type Obj = Record<string, unknown>;

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Obj)[k] : undefined), obj);
}

/** Immutable deep set; `undefined` deletes the key (and empty parents). */
export function setPath<T extends Obj>(obj: T | undefined, path: string, value: unknown): T {
  const keys = path.split('.');
  const root: Obj = { ...(obj ?? {}) };
  let cur = root;
  const parents: [Obj, string][] = [];
  keys.forEach((k, i) => {
    if (i === keys.length - 1) {
      if (value === undefined) delete cur[k];
      else cur[k] = value;
      return;
    }
    const next = cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k]) ? { ...(cur[k] as Obj) } : {};
    cur[k] = next;
    parents.push([cur, k]);
    cur = next;
  });
  for (let i = parents.length - 1; i >= 0; i--) {
    const [p, k] = parents[i];
    if (p[k] && typeof p[k] === 'object' && !Object.keys(p[k] as Obj).length) delete p[k];
  }
  return root as T;
}

const encode = (v: unknown) => JSON.stringify(v ?? '');

/** One control bound to a getter/setter. */
function control(c: FormatControl, value: unknown, set: (v: unknown) => void): HTMLElement {
  const id = `pbs-${Math.random().toString(36).slice(2, 9)}`;
  const lab = h('label', { for: id }, c.label);
  let input: HTMLElement;
  const err = h('div', { class: 'pbs-err', role: 'alert' });
  err.hidden = true;
  switch (c.type) {
    case 'boolean': {
      const el = h('input', { id, type: 'checkbox', checked: !!value }) as HTMLInputElement;
      el.addEventListener('change', () => set(el.checked));
      input = el;
      break;
    }
    case 'number': {
      const el = h('input', { id, type: 'number', value: (value as number | undefined) ?? '', min: c.min, max: c.max, step: c.step ?? 'any', placeholder: c.placeholder ?? '' }) as HTMLInputElement;
      el.addEventListener('change', () => set(el.value === '' ? undefined : Number(el.value)));
      input = el;
      break;
    }
    case 'range': {
      const el = h('input', { id, type: 'range', value: (value as number | undefined) ?? c.min ?? 0, min: c.min ?? 0, max: c.max ?? 100, step: c.step ?? 1 }) as HTMLInputElement;
      el.addEventListener('change', () => set(Number(el.value)));
      input = el;
      break;
    }
    case 'color': {
      const hex = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
      const el = h('input', { id, type: 'color', value: hex, title: typeof value === 'string' ? value : 'Theme default' }) as HTMLInputElement;
      el.addEventListener('change', () => set(el.value));
      input = el;
      break;
    }
    case 'select': {
      const el = h('select', { id }) as HTMLSelectElement;
      for (const o of c.options ?? []) el.append(h('option', { value: encode(o.value), selected: encode(o.value) === encode(value ?? '') }, o.label));
      el.addEventListener('change', () => {
        const v = JSON.parse(el.value) as unknown;
        set(v === '' ? undefined : v);
      });
      input = el;
      break;
    }
    case 'textarea':
    case 'json': {
      const text = c.type === 'json' ? (value === undefined || value === null ? '' : JSON.stringify(value)) : String(value ?? '');
      const el = h('textarea', { id, placeholder: c.placeholder ?? '' }) as HTMLTextAreaElement;
      el.value = text;
      el.addEventListener('change', () => {
        if (c.type === 'textarea') return set(el.value || undefined);
        if (!el.value.trim()) return set(undefined);
        try {
          set(JSON.parse(el.value));
          err.hidden = true;
        } catch (e) {
          err.textContent = `Invalid JSON: ${(e as Error).message}`;
          err.hidden = false;
        }
      });
      input = el;
      break;
    }
    default: {
      const el = h('input', { id, type: 'text', value: (value as string | undefined) ?? '', placeholder: c.placeholder ?? '' }) as HTMLInputElement;
      el.addEventListener('change', () => set(el.value === '' ? undefined : el.value));
      input = el;
    }
  }
  const wide = c.type === 'textarea' || c.type === 'json';
  return h('div', { class: `pbs-ctl${wide ? ' is-wide' : ''}` }, lab, input, err);
}

function section(sec: FormatSection, open: boolean, body: HTMLElement[], onReset?: () => void): HTMLElement {
  const summary = h('summary', {}, h('span', {}, sec.label));
  if (onReset) {
    const reset = h('button', { type: 'button', class: 'pbs-reset', title: 'Back to defaults' }, 'Reset');
    reset.addEventListener('click', (e) => {
      e.preventDefault();
      onReset();
    });
    summary.append(reset);
  }
  return h('details', { class: 'pbs-sec', open, 'data-sec': sec.id }, summary, ...body);
}

/** Format pane for the selected visual, or page / report / theme settings when nothing is selected. */
export function renderFormat(ctx: StudioContext, container: HTMLElement, openSections: Set<string>): void {
  const keepOpen = (el: HTMLElement) => el.addEventListener('toggle', () => ((el as HTMLDetailsElement).open ? openSections.add(el.dataset.sec!) : openSections.delete(el.dataset.sec!)));
  container.replaceChildren();
  const sel = ctx.selected();
  if (sel) {
    const handle = ctx.report.visual(sel);
    const spec = handle.spec;
    const merged = ctx.report.visualFormat(sel);
    const tooltipPages = ctx.report.pageList.filter((p) => ctx.report.pageDefinition(p.id).tooltip);
    for (const sec of sectionsFor(spec.type)) {
      const controls = sec.controls.map((c) => {
        const cc = c.path === 'tooltip.page' ? { ...c, options: [{ value: '', label: 'None' }, ...tooltipPages.map((p) => ({ value: p.id, label: p.name }))] } : c;
        const isSpec = c.path.startsWith('spec.');
        const value = isSpec ? getPath(spec, c.path.slice(5)) : getPath(merged, c.path);
        return control(cc, value, (v) => {
          if (isSpec) {
            const p = c.path.slice(5);
            if (p.startsWith('layout.')) ctx.report.updateVisual(sel, { layout: { ...(spec.layout ?? { x: 0, y: 0, w: 4, h: 6 }), [p.slice(7)]: v } } as Partial<VisualSpec>);
            else ctx.report.updateVisual(sel, { [p]: v } as Partial<VisualSpec>);
          } else ctx.report.updateVisual(sel, { format: setPath(spec.format as Obj, c.path, v) });
        });
      });
      const resettable = !sec.controls.every((c) => c.path.startsWith('spec.'));
      const sectionKeys = [...new Set(sec.controls.filter((c) => !c.path.startsWith('spec.')).map((c) => c.path.split('.')[0]))];
      const el = section(sec, openSections.has(sec.id), controls, resettable ? () => ctx.report.updateVisual(sel, { format: sectionKeys.reduce((f, k) => setPath(f, k, undefined), spec.format as Obj) }) : undefined);
      keepOpen(el);
      container.append(el);
    }
    return;
  }

  // ---- page settings
  const page = ctx.report.pageDefinition();
  const pid = page.id!;
  const l = page.layout ?? {};
  const pageSec: FormatSection = { id: 'page', label: 'Page', controls: [] };
  const upd = (patch: Parameters<typeof ctx.report.updatePage>[1]) => ctx.report.updatePage(pid, patch);
  const pageControls = [
    control({ path: 'name', label: 'Name', type: 'text' }, page.name, (v) => upd({ name: String(v ?? 'Page') })),
    control({ path: 'columns', label: 'Grid columns', type: 'number', min: 1, max: 48 }, l.columns ?? 12, (v) => upd({ layout: { ...l, columns: v as number | undefined } })),
    control({ path: 'rowHeight', label: 'Row height (px)', type: 'number', min: 8, max: 200 }, l.rowHeight ?? 44, (v) => upd({ layout: { ...l, rowHeight: v as number | undefined } })),
    control({ path: 'gap', label: 'Gap (px)', type: 'number', min: 0, max: 48 }, l.gap ?? 12, (v) => upd({ layout: { ...l, gap: v as number | undefined } })),
    control({ path: 'background', label: 'Background', type: 'color' }, page.background, (v) => upd({ background: v as string | undefined })),
    control({ path: 'hidden', label: 'Hidden page', type: 'boolean' }, page.hidden, (v) => upd({ hidden: !!v || undefined })),
    control({ path: 'drillthrough', label: 'Drill-through fields (comma separated)', type: 'text', placeholder: "Product[Category], 'Sales Data'[Region]" }, page.drillthrough?.fields.join(', '), (v) =>
      upd({ drillthrough: v ? { ...(page.drillthrough ?? {}), fields: String(v).split(/,(?![^[]*\])/).map((s) => s.trim()).filter(Boolean) } : undefined }),
    ),
    control({ path: 'tooltip', label: 'Use as tooltip page', type: 'boolean' }, !!page.tooltip, (v) => upd({ tooltip: v ? { width: 320, height: 220 } : undefined })),
  ];
  const ps = section(pageSec, openSections.has('page') || !openSections.size, pageControls);
  keepOpen(ps);
  container.append(ps);

  // ---- report + theme
  const theme = ctx.themeOverrides();
  const mode = (theme.mode as string) ?? ctx.report.theme.mode;
  const base = mode === 'dark' ? darkTheme : lightTheme;
  const tset = (patch: Record<string, unknown>) => ctx.setThemeOverrides(patch);
  const reportControls = [
    control({ path: 'name', label: 'Report name', type: 'text' }, ctx.report.name, (v) => {
      ctx.report.name = String(v ?? 'Report');
      ctx.commit();
    }),
  ];
  const rs = section({ id: 'report', label: 'Report', controls: [] }, openSections.has('report'), reportControls);
  keepOpen(rs);
  container.append(rs);

  const colors = (theme.dataColors as string[] | undefined) ?? ctx.report.theme.dataColors;
  const swatches = h('div', { class: 'pbs-colors' });
  colors.slice(0, 8).forEach((c, i) => {
    const inp = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(c) ? c : '#888888', 'aria-label': `Data color ${i + 1}` }) as HTMLInputElement;
    inp.addEventListener('change', () => {
      const next = colors.slice(0, 8);
      next[i] = inp.value;
      tset({ dataColors: next });
    });
    swatches.append(inp);
  });
  const themeControls = [
    control({ path: 'mode', label: 'Mode', type: 'select', options: [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] }, mode, (v) => tset({ mode: v ?? 'light' })),
    control({ path: 'accent', label: 'Accent', type: 'color' }, theme.accent ?? base.accent, (v) => tset({ accent: v })),
    control({ path: 'background', label: 'Page background', type: 'color' }, theme.background ?? base.background, (v) => tset({ background: v })),
    control({ path: 'surface', label: 'Visual background', type: 'color' }, theme.surface ?? base.surface, (v) => tset({ surface: v })),
    control({ path: 'foreground', label: 'Text', type: 'color' }, theme.foreground ?? base.foreground, (v) => tset({ foreground: v })),
    control({ path: 'fontFamily', label: 'Font family', type: 'text', placeholder: base.fontFamily }, theme.fontFamily, (v) => tset({ fontFamily: v })),
    control({ path: 'radius', label: 'Corner radius', type: 'number', min: 0, max: 24 }, theme.radius ?? base.radius, (v) => tset({ radius: v })),
    h('div', { class: 'pbs-ctl is-wide' }, h('label', {}, 'Data colors (fixed order)'), swatches),
  ];
  const resetTheme = () => ctx.setThemeOverrides({ __reset: true });
  const ts = section({ id: 'theme', label: 'Theme', controls: [] }, openSections.has('theme'), themeControls, resetTheme);
  keepOpen(ts);
  container.append(ts);
}
