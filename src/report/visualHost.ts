import type { CellValue } from '../data/types';
import { isColumnRefString, parseColumnRef, valueKey } from '../data/types';
import type { FilterSpec } from '../data/filters';
import type { FieldSpec, QueryField, QueryResult, QuerySpec } from '../data/query';
import { formatValue } from '../format/format';
import { h } from '../render/svg';
import { deepMerge } from '../utils';
import { baseFormat } from '../visuals/format';
import type { VisualFormat } from '../visuals/format';
import { getVisual } from '../visuals/registry';
import type { DataPointIdentity, RenderContext, RoleBinding, VisualDefinition, VisualHostApi, VisualSpec } from '../visuals/types';
import type { QueryEngine, ReportRuntime } from './runtime';

/** Engines receive filter specs; compiled filters (functions, row sets) stay on this thread. */
function portable(spec: QuerySpec): boolean {
  const ok = (fs: unknown[] | undefined) => !fs || fs.every((f) => !(f && typeof f === 'object' && 'kind' in f) || ((f as { kind: string }).kind === 'columns' && !!(f as { spec?: unknown }).spec));
  return ok(spec.filters) && ok(spec.highlight);
}
import { download, elementToSvg, svgToCanvas } from './snapshot';

const asArray = (f: FieldSpec | FieldSpec[] | undefined): FieldSpec[] => (f === undefined ? [] : Array.isArray(f) ? f : [f]);
const fieldRef = (f: FieldSpec) => (typeof f === 'string' ? f : (f.field ?? f.expression ?? ''));

export function identitiesToFilters(ids: DataPointIdentity[]): FilterSpec[] {
  if (!ids.length) return [];
  const cols = ids[0].columns;
  if (cols.length === 1) return [{ target: cols[0], op: 'in', values: ids.map((i) => i.values[0]) }];
  // same columns? → tuples filter; otherwise one filter per identity column set is ambiguous, use the first set
  const same = ids.filter((i) => i.columns.length === cols.length && i.columns.every((c, k) => c.table === cols[k].table && c.column === cols[k].column));
  return [{ targets: cols, op: 'tuples', tuples: same.map((i) => i.values) }];
}

function identityKey(id: DataPointIdentity): string {
  return JSON.stringify([id.columns.map((c) => `${c.table}[${c.column}]`), id.values.map(valueKey)]);
}

/** Does selected identity `sel` cover point `p`? (sel's columns must be a subset of p's) */
function covers(sel: DataPointIdentity, p: DataPointIdentity): boolean | null {
  let matchedAny = false;
  for (let i = 0; i < sel.columns.length; i++) {
    const c = sel.columns[i];
    const k = p.columns.findIndex((d) => d.table === c.table && d.column === c.column);
    if (k < 0) continue;
    matchedAny = true;
    if (valueKey(p.values[k]) !== valueKey(sel.values[i])) return false;
  }
  return matchedAny ? true : null;
}

/** One visual on a page: chrome (title, header icons), query, render, interactions. */
export class VisualHost {
  readonly id: string;
  readonly el: HTMLElement;
  private body: HTMLElement;
  private header: HTMLElement;
  private def: VisualDefinition;
  private data: QueryResult | null = null;
  private dataKey = '';
  private lastRenderedKey = '';
  private cleanup: (() => void) | void = undefined;
  private ro?: ResizeObserver;
  private showTable = false;
  private localState: Record<string, unknown>;
  private size = { w: 0, h: 0 };
  private destroyed = false;
  /** In-flight engine query (async mode). */
  private pending?: { key: string; ctrl: AbortController };

  constructor(
    private rt: ReportRuntime,
    public spec: VisualSpec,
  ) {
    this.id = spec.id!;
    this.def = getVisual(spec.type);
    this.localState = { ...(spec.state ?? {}) };
    this.el = h('section', { class: 'pbi-visual', 'data-visual-id': this.id, 'data-type': spec.type, 'aria-label': spec.title ?? this.def.displayName });
    this.header = h('div', { class: 'pbi-vh' });
    this.body = h('div', { class: 'pbi-vbody' });
    this.el.append(this.header, this.body);
    this.el.addEventListener('click', () => {
      this.rt.setActiveVisual(this.id);
      if (this.rt.selectionSource() === this.id) this.select(null);
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        const w = this.body.clientWidth;
        const hh = this.body.clientHeight;
        if (Math.abs(w - this.size.w) > 1 || Math.abs(hh - this.size.h) > 1) this.rt.schedule(this.id);
      });
      this.ro.observe(this.body);
    }
    this.applySpec();
  }

  get definition(): VisualDefinition {
    return this.def;
  }

  get lastResult(): QueryResult | null {
    return this.data;
  }

  /** Update the spec (merge) and re-render. */
  update(patch: Partial<VisualSpec>): void {
    if (patch !== this.spec) Object.assign(this.spec, patch);
    if (patch.type) this.def = getVisual(patch.type);
    this.dataKey = '';
    this.applySpec();
    this.rt.schedule(this.id);
  }

  format(): VisualFormat {
    const themeStyles = this.rt.theme.visualStyles ?? {};
    const f = deepMerge(baseFormat, this.def.defaultFormat as Partial<VisualFormat>, themeStyles['*'] as Partial<VisualFormat>, themeStyles[this.spec.type] as Partial<VisualFormat>, this.spec.format as Partial<VisualFormat>);
    if (this.spec.title !== undefined && !this.spec.format?.title?.text) f.title = { ...f.title, text: this.spec.title };
    return f;
  }

  private applySpec(): void {
    const l = this.spec.layout ?? { x: 0, y: 0, w: 4, h: 6 };
    const st = this.el.style;
    st.setProperty('--x', String(l.x));
    st.setProperty('--y', String(l.y));
    st.setProperty('--w', String(l.w));
    st.setProperty('--h', String(l.h));
    if (l.z !== undefined) st.setProperty('--z', String(l.z));
    const f = this.format();
    // only explicit format values become inline variables, so stylesheet overrides keep working
    const setVar = (name: string, value: string | null) => (value === null ? st.removeProperty(name) : st.setProperty(name, value));
    const bg = !f.background.show ? 'transparent' : (f.background.color ?? null);
    setVar('--pbi-v-bg', bg && f.background.transparency ? `color-mix(in srgb, ${bg} ${100 - f.background.transparency}%, transparent)` : f.background.transparency ? `color-mix(in srgb, var(--pbi-surface) ${100 - f.background.transparency}%, transparent)` : bg);
    setVar('--pbi-v-bw', !f.border.show ? '0px' : f.border.width !== 1 ? `${f.border.width}px` : null);
    setVar('--pbi-v-bc', f.border.color ?? null);
    setVar('--pbi-v-radius', f.border.radius !== undefined ? `${f.border.radius}px` : null);
    setVar('--pbi-v-pad', f.padding !== 12 ? `${f.padding}px` : null);
    this.el.classList.toggle('has-shadow', f.shadow.show);
    this.el.hidden = !!this.spec.hidden;
    this.el.className = `pbi-visual${f.shadow.show ? ' has-shadow' : ''}${this.spec.className ? ` ${this.spec.className}` : ''}`;
    if (this.spec.style) this.el.setAttribute('style', `${st.cssText};${this.spec.style}`);
  }

  // ------------------------------------------------------------ query

  fields(role: string): FieldSpec[] {
    // hierarchies expand to their levels; field parameters to the fields their slicer selected
    const out: FieldSpec[] = [];
    for (const f of asArray(this.spec.fields?.[role])) {
      const ref = typeof f === 'string' ? f : f.field;
      if (ref && isColumnRefString(ref)) {
        const levels = this.rt.model.resolveHierarchy(ref);
        if (levels) {
          out.push(...levels);
          continue;
        }
        // a slicer on a field parameter shows the parameter itself, everything else shows the picked fields
        const picked = this.def.isSlicer ? null : this.rt.model.resolveFieldParameter(ref, this.rt.filtersFor(this.id));
        if (picked) {
          out.push(...picked);
          continue;
        }
      }
      out.push(f);
    }
    return out;
  }

  private drillInfo() {
    const role = this.def.roles.find((r) => r.drillable);
    const levels = role ? this.fields(role.name).length : 0;
    const d = this.spec.drill ?? { level: 0, path: [] };
    return { role, levels, level: Math.min(d.level, Math.max(0, levels - 1)), path: d.path ?? [], skip: d.skip ?? [], expanded: !!d.expanded };
  }

  /** Build the query plus role → result-position bindings. */
  buildQuery(): { query: QuerySpec | null; roles: Map<string, RoleBinding> } {
    const roles = new Map<string, RoleBinding>();
    const groupBy: string[] = [];
    const values: FieldSpec[] = [];
    const drill = this.drillInfo();
    const drillFilters: FilterSpec[] = [];
    for (const r of this.def.roles) {
      let fs = this.fields(r.name);
      if (r.drillable && fs.length > 1) {
        // drill mode: parents filtered, one level shown; expand mode: levels path.length..level shown together
        const fixed = drill.expanded ? Math.min(drill.path.length, drill.level) : drill.level;
        fs.slice(0, fixed).forEach((f, i) => {
          if (!drill.skip.includes(i)) drillFilters.push({ target: fieldRef(f), op: 'eq', value: drill.path[i] ?? null });
        });
        fs = drill.expanded ? fs.slice(fixed, drill.level + 1) : [fs[drill.level]];
      }
      if (r.kind === 'any') continue;
      const isGroup = r.kind === 'grouping';
      const b: RoleBinding = { kind: isGroup ? 'group' : 'value', indices: [], fields: [] };
      for (const f of fs) {
        if (isGroup) {
          b.indices.push(groupBy.length);
          groupBy.push(fieldRef(f));
        } else {
          b.indices.push(values.length);
          values.push(f);
        }
      }
      roles.set(r.name, b);
    }
    const filters = [...this.rt.filtersFor(this.id), ...drillFilters];
    const highlight = this.rt.highlightFor(this.id);
    let orderBy: QuerySpec['orderBy'];
    if (this.spec.sort) orderBy = [{ field: this.spec.sort.field, direction: this.spec.sort.direction }];
    else if (this.def.defaultSort === 'value' && values.length) {
      const firstGroup = groupBy[0];
      const col = firstGroup && isColumnRefString(firstGroup) ? parseColumnRef(firstGroup) : null;
      const c = col ? this.rt.model.table(col.table).column(col.column) : null;
      // dates, numbers and "sort by column" fields keep their natural order
      if (!c || (c.type === 'string' && !c.sortBy)) orderBy = [{ field: { value: 0 }, direction: 'desc' }];
    }
    const base: QuerySpec = { groupBy, values, filters, highlight, orderBy, top: this.spec.top };
    const query = this.def.buildQuery
      ? this.def.buildQuery({ spec: this.spec, model: this.rt.model, fields: (r) => this.fields(r), drill: { level: drill.level, path: drill.path } }, base)
      : base;
    if (query && this.def.buildQuery) {
      query.filters ??= filters;
      if (query.highlight === undefined && this.def.supportsHighlight) query.highlight = highlight;
    }
    return { query, roles };
  }

  // ------------------------------------------------------------ render

  render(): void {
    if (this.destroyed) return;
    const t0 = performance.now();
    const f = this.format();
    this.renderHeader(f);
    const fixed = this.rt.measure?.(this.id);
    this.size = fixed ? { w: fixed.width, h: fixed.height } : { w: this.body.clientWidth, h: this.body.clientHeight };
    let roles: Map<string, RoleBinding>;
    try {
      const built = this.buildQuery();
      roles = built.roles;
      if (!built.query) {
        this.data = { groups: [], values: [], rows: [], truncated: false, baseFilters: [] };
      } else {
        const key = JSON.stringify(built.query, (_k, v) => (v instanceof Date ? `D${v.getTime()}` : v instanceof Set ? [...v] : v)) + this.rt.modelVersion;
        if (key !== this.dataKey || !this.data) {
          const engine = this.rt.engine;
          if (engine && !this.def.isSlicer && built.query.values?.length && portable(built.query)) {
            this.request(engine, built.query, key);
            if (!this.data) return this.renderLoading();
            // keep the previous result on screen, dimmed, until the new one arrives
            this.el.classList.add('is-busy');
            return;
          }
          this.data = this.rt.model.query(built.query);
          this.dataKey = key;
        }
      }
    } catch (err) {
      this.renderError(err as Error);
      return;
    }
    // role bindings for 'any' roles and roles the visual's custom query re-mapped
    const data = this.data!;
    const roleFn = (name: string): RoleBinding => {
      const b = roles.get(name);
      if (!b) return { kind: 'group', indices: [], fields: [] };
      return { ...b, fields: b.indices.map((i) => (b.kind === 'group' ? data.groups[i] : data.values[i])).filter(Boolean) };
    };
    if (typeof this.cleanup === 'function') this.cleanup();
    this.body.replaceChildren();
    const root = h('div', { class: 'pbi-vroot' });
    this.body.append(root);
    const width = Math.max(0, this.size.w || 300);
    const height = Math.max(0, this.size.h || 200);
    if (this.showTable) return this.renderDataTable(root, data);
    const animate = this.dataKey !== this.lastRenderedKey;
    this.lastRenderedKey = this.dataKey;
    const ctx: RenderContext = {
      root,
      width,
      height,
      spec: this.spec,
      format: f,
      theme: this.rt.theme,
      data,
      model: this.rt.model,
      role: roleFn,
      fields: (r) => this.fields(r),
      colorFor: (field, value, fallback) => this.colorFor(f, field, value, fallback),
      seriesColor: (name, i) => f.colors.series?.[name] ?? (i === 0 && f.colors.default ? f.colors.default : this.palette(f)[i] ?? this.rt.theme.otherColor),
      fmt: (field, v, opts) => formatValue(v, field?.format, { locale: this.rt.locale, ...opts }),
      host: this.api(),
      animate,
    };
    try {
      this.cleanup = this.def.render(ctx);
    } catch (err) {
      this.renderError(err as Error);
      return;
    }
    this.rt.emit('rendered', { visualId: this.id, ms: performance.now() - t0 });
  }

  private request(engine: QueryEngine, spec: QuerySpec, key: string): void {
    if (this.pending?.key === key) return;
    this.pending?.ctrl.abort();
    const ctrl = new AbortController();
    this.pending = { key, ctrl };
    engine.query(spec, ctrl.signal).then(
      (res) => {
        if (this.pending?.ctrl !== ctrl || this.destroyed) return;
        this.pending = undefined;
        this.data = res as QueryResult;
        this.dataKey = key;
        this.el.classList.remove('is-busy');
        this.render();
      },
      (err: Error) => {
        if (this.pending?.ctrl !== ctrl || this.destroyed || err?.name === 'AbortError') return;
        this.pending = undefined;
        this.el.classList.remove('is-busy');
        this.renderError(err);
      },
    );
  }

  private renderLoading(): void {
    if (typeof this.cleanup === 'function') this.cleanup();
    this.cleanup = undefined;
    const el = h('div', { class: 'pbi-loading', role: 'status', 'aria-label': 'Loading' });
    el.style.cssText = 'flex:1;height:100%;border-radius:6px';
    this.body.replaceChildren(el);
  }

  private palette(f: VisualFormat): string[] {
    return f.colors.palette ?? this.rt.theme.dataColors;
  }

  /** Colour follows the entity: index of the value in the column's full domain, never its rank. */
  private colorFor(f: VisualFormat, field: QueryField | undefined, value: CellValue, fallback = 0): string {
    const label = formatValue(value, field?.format);
    const fixed = f.colors.categories?.[label] ?? f.colors.series?.[label];
    if (fixed) return fixed;
    const pal = this.palette(f);
    if (!field?.column) return pal[fallback] ?? this.rt.theme.otherColor;
    const idx = this.rt.domainIndex(field.column.table, field.column.column, value);
    return pal[idx] ?? this.rt.theme.otherColor;
  }

  private renderError(err: Error): void {
    this.body.replaceChildren(h('div', { class: 'pbi-error', role: 'alert' }, `⚠ ${err.message}`));
    this.rt.emit('error', { visualId: this.id, error: err });
  }

  private renderHeader(f: VisualFormat): void {
    this.header.replaceChildren();
    const drill = this.drillInfo();
    const hasTitle = f.title.show && f.title.text;
    const icons = h('div', { class: 'pbi-icons' });
    const icon = (glyph: string, label: string, onClick: () => void, pressed?: boolean) => {
      const b = h('button', { type: 'button', class: 'pbi-icon', title: label, 'aria-label': label, 'aria-pressed': pressed === undefined ? undefined : String(pressed) }, glyph);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      icons.append(b);
    };
    if (f.header.show) {
      if (f.header.drill && drill.levels > 1) {
        icon('↑', 'Drill up', () => this.drillUp(), undefined);
        if (drill.level < drill.levels - 1) {
          icon('⇊', 'Go to next level', () => this.nextLevel());
          icon('⤓', 'Expand all down one level', () => this.expandAll());
        }
      }
      if (f.header.showAsTable && !this.def.static && !this.def.isSlicer) icon('▦', this.showTable ? 'Show visual' : 'Show as table', () => ((this.showTable = !this.showTable), this.render()), this.showTable);
      if (f.header.exportData && !this.def.static && !this.def.isSlicer)
        icons.append(this.exportButton());
      if (this.def.isSlicer && this.rt.slicerFilter(this.id)) icon('⌫', 'Clear selections', () => this.setFilter(null));
      if (f.header.focusMode) icon(this.rt.focused === this.id ? '✕' : '⤢', this.rt.focused === this.id ? 'Exit focus mode' : 'Focus mode', () => this.rt.toggleFocus(this.id));
    }
    if (!hasTitle && !icons.childElementCount) {
      this.header.hidden = true;
      return;
    }
    this.header.hidden = false;
    const text = h('div', { class: 'pbi-vh-text', style: `text-align:${f.title.align}` });
    if (hasTitle) {
      const title = h('div', { class: 'pbi-title', title: f.title.text! }, f.title.text!);
      if (f.title.fontSize) title.style.fontSize = `${f.title.fontSize}px`;
      if (f.title.color) title.style.color = f.title.color;
      if (!f.title.bold) title.style.fontWeight = '400';
      text.append(title);
    }
    if (f.title.subtitle) text.append(h('div', { class: 'pbi-subtitle' }, f.title.subtitle));
    const crumbLevels = drill.expanded ? Math.min(drill.path.length, drill.level) : drill.level;
    if (drill.levels > 1 && crumbLevels > 0) {
      const role = drill.role!;
      const names = this.fields(role.name).slice(0, crumbLevels);
      text.append(h('div', { class: 'pbi-drill-crumb' }, names.map((n, i) => `${fieldRef(n).replace(/^.*\[|\]$/g, '')}: ${formatValue(drill.path[i] ?? null)}`).join(' › ')));
    }
    this.header.append(text, icons);
  }

  private renderDataTable(root: HTMLElement, data: QueryResult): void {
    const fields = [...data.groups, ...data.values];
    const table = h('table', { class: 'pbi-table pbi-banded' });
    table.append(h('thead', {}, h('tr', {}, ...fields.map((f, i) => h('th', { class: i >= data.groups.length ? 'is-num' : '' }, f.name)))));
    const tb = h('tbody');
    for (const r of data.rows.slice(0, 2000))
      tb.append(h('tr', {}, ...r.keys.map((k, i) => h('td', {}, formatValue(k, data.groups[i].format))), ...r.values.map((v, i) => h('td', { class: 'is-num' }, formatValue(v, data.values[i].format)))));
    table.append(tb);
    root.append(h('div', { class: 'pbi-datatable-wrap' }, table));
  }

  /** CSV of the data currently shown by the visual. */
  toCsv(): string {
    const d = this.data;
    if (!d) return '';
    const esc = (v: CellValue) => {
      const s = v === null ? '' : v instanceof Date ? v.toISOString() : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = [...d.groups, ...d.values].map((f) => esc(f.name)).join(',');
    return [head, ...d.rows.map((r) => [...r.keys, ...r.values].map(esc).join(','))].join('\n');
  }

  exportCsv(filename = `${(this.format().title.text || this.spec.type).replace(/[^\w-]+/g, '_')}.csv`): void {
    const blob = new Blob([this.toCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------------------ interactions

  select(identity: DataPointIdentity | null, opts: { multi?: boolean } = {}): void {
    this.rt.setSelection(this.id, identity, !!opts.multi);
  }

  setFilter(filters: FilterSpec[] | null): void {
    this.rt.setSlicerFilter(this.id, filters);
  }

  drillDown(value: CellValue): void {
    const d = this.drillInfo();
    if (d.level >= d.levels - 1 || d.expanded) return;
    this.spec.drill = { level: d.level + 1, path: [...d.path.slice(0, d.level), value], skip: d.skip.filter((i) => i < d.level) };
    this.afterDrill();
  }

  drillUp(): void {
    const d = this.drillInfo();
    if (d.level === 0) return;
    if (d.expanded) {
      // collapse one expanded level; back to plain drill mode once a single level remains
      const level = d.level - 1;
      this.spec.drill = { level, path: d.path.slice(0, level), skip: d.skip.filter((i) => i < level), expanded: level > d.path.length };
      return this.afterDrill();
    }
    this.spec.drill = { level: d.level - 1, path: d.path.slice(0, d.level - 1), skip: d.skip.filter((i) => i < d.level - 1) };
    this.afterDrill();
  }

  /** Go to the next level for all members (no parent filter). */
  nextLevel(): void {
    const d = this.drillInfo();
    if (d.level >= d.levels - 1) return;
    // the current level stays unfiltered ("skip"): all members of the next level are shown
    this.spec.drill = { level: d.level + 1, path: [...d.path.slice(0, d.level), null], skip: [...d.skip.filter((i) => i < d.level), d.level] };
    this.afterDrill();
  }

  /** "Expand all down one level": show the next level for every member, combined with the current one. */
  expandAll(): void {
    const d = this.drillInfo();
    if (d.level >= d.levels - 1) return;
    const path = d.expanded ? d.path : d.path.slice(0, d.level);
    this.spec.drill = { level: d.level + 1, path, skip: d.skip.filter((i) => i < path.length), expanded: true };
    this.afterDrill();
  }

  private exportButton(): HTMLElement {
    const b = h('button', { type: 'button', class: 'pbi-icon', title: 'Export', 'aria-label': 'Export', 'aria-haspopup': 'menu' }, '⇩');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = b.getBoundingClientRect();
      this.rt.menu(r.left, r.bottom + 4, [
        { label: 'Export data', hint: 'CSV', onClick: () => this.exportCsv() },
        { label: 'Export image', hint: 'PNG', onClick: () => void this.exportImage('png') },
        { label: 'Export image', hint: 'SVG', onClick: () => void this.exportImage('svg') },
      ]);
    });
    return b;
  }

  /** Standalone SVG snapshot of the visual (HTML content embedded via foreignObject, styles inlined). */
  toSvg(): string {
    const w = Math.max(1, Math.round(this.el.offsetWidth || this.size.w + 24 || 600));
    const hh = Math.max(1, Math.round(this.el.offsetHeight || this.size.h + 60 || 400));
    return elementToSvg(this.el, this.rt.theme, w, hh);
  }

  /** Download the visual as PNG (2× resolution) or SVG. */
  async exportImage(type: 'png' | 'svg' = 'png', filename = `${(this.format().title.text || this.spec.type).replace(/[^\w-]+/g, '_')}.${type}`): Promise<void> {
    const svgText = this.toSvg();
    if (type === 'svg') return download(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }), filename);
    const canvas = await svgToCanvas(svgText, this.rt.theme.surface);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
    download(blob, filename);
  }

  private afterDrill(): void {
    this.rt.clearSelectionFrom(this.id);
    this.dataKey = '';
    this.rt.emit('drill', { visualId: this.id, level: this.spec.drill!.level, path: this.spec.drill!.path });
    this.rt.schedule(this.id);
  }

  private api(): VisualHostApi {
    const self = this;
    const selected = this.rt.selectionFor(this.id);
    const selKeys = new Set(selected.map(identityKey));
    return {
      select: (id, o) => self.select(id, o),
      isSelected(id) {
        if (!selected.length) return null;
        if (selKeys.has(identityKey(id))) return true;
        let any: boolean | null = null;
        for (const s of selected) {
          const c = covers(s, id);
          if (c === true) return true;
          if (c === false) any = false;
        }
        return any;
      },
      get selectionActive() {
        return selected.length > 0;
      },
      showTooltip: (e, items, title, identity) => {
        const page = self.format().tooltip.page;
        if (page && identity && identity.columns.length) self.rt.showReportTooltip(page, identity, self.id, e);
        else self.rt.tooltip.show(e, items, title);
      },
      hideTooltip: () => self.rt.tooltip.hide(),
      setFilter: (f) => self.setFilter(f),
      get currentFilter() {
        return self.rt.slicerFilter(self.id);
      },
      domain: (column) => self.rt.slicerDomain(self.id, column),
      domainTuples: (columns) => self.rt.slicerTuples(self.id, columns),
      contextMenu: (evt, identity) => self.rt.showContextMenu(self.id, identity, evt),
      drillDown: (v) => self.drillDown(v),
      drillUp: () => self.drillUp(),
      get drill() {
        const d = self.drillInfo();
        return { level: d.level, path: d.path, levels: d.expanded ? d.level + 1 : d.levels };
      },
      setState(patch) {
        Object.assign(self.localState, patch);
        self.persistState();
        self.rt.schedule(self.id);
      },
      get state() {
        return self.localState;
      },
      emit: (event, payload) => self.rt.emit(event, { visualId: self.id, keys: payload.keys, identity: payload.identity, event: payload.event }),
      rerender: () => self.rt.schedule(self.id),
    };
  }

  /** Copy durable visual state (keys not starting with "_") into the spec so it is saved with the report. */
  private persistState(): void {
    const durable = Object.fromEntries(Object.entries(this.localState).filter(([k, v]) => !k.startsWith('_') && v !== undefined));
    this.spec.state = Object.keys(durable).length ? durable : undefined;
  }

  /** Forget visual-local state (sorting, expansion, decomposition splits…). */
  resetState(): void {
    this.localState = {};
    this.spec.state = undefined;
  }

  invalidate(): void {
    this.dataKey = '';
  }

  destroy(): void {
    this.destroyed = true;
    if (typeof this.cleanup === 'function') this.cleanup();
    this.ro?.disconnect();
    this.el.remove();
  }
}
