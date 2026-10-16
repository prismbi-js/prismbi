import type { CellValue } from '../data/types';
import { valueKey } from '../data/types';
import type { FilterSpec } from '../data/filters';
import type { QueryResult } from '../data/query';
import type { DataModel } from '../data/model';
import { compileFilter } from '../data/filters';
import type { Theme } from '../theme/theme';
import { getTheme } from '../theme/theme';
import { h } from '../render/svg';
import type { DeepPartial } from '../utils';
import { Emitter, uid } from '../utils';
import { getVisual } from '../visuals/registry';
import type { DataPointIdentity, VisualSpec } from '../visuals/types';
import type { ReportEvents } from './events';
import { FilterPane } from './filterPane';
import type { ReportRuntime } from './runtime';
import { injectStyles, themeVars } from './styles';
import { Tooltip } from './tooltip';
import type { TooltipRenderer } from './tooltip';
import { VisualHost, identitiesToFilters } from './visualHost';

export interface PageLayout {
  /** Grid columns (default 12). */
  columns?: number;
  /** Row height in px (default 44). */
  rowHeight?: number;
  /** Gap in px (default 12). */
  gap?: number;
}

export interface PageDefinition {
  id?: string;
  name: string;
  visuals: VisualSpec[];
  filters?: FilterSpec[];
  layout?: PageLayout;
  /** CSS background for the page plane. */
  background?: string;
  hidden?: boolean;
}

export interface Bookmark {
  name: string;
  pageId: string;
  reportFilters: FilterSpec[];
  pageFilters: Record<string, FilterSpec[]>;
  slicers: Record<string, Record<string, FilterSpec[]>>;
  selection: { visualId: string; identities: DataPointIdentity[] } | null;
  drill: Record<string, VisualSpec['drill']>;
}

export interface ReportDefinition {
  name?: string;
  pages: PageDefinition[];
  /** Filters on all pages. */
  filters?: FilterSpec[];
  bookmarks?: Bookmark[];
}

export interface ReportChrome {
  toolbar?: boolean;
  pageTabs?: boolean | 'auto';
  /** `true`/`'closed'` adds a toggle; `'open'` starts open. */
  filterPane?: boolean | 'open' | 'closed';
}

export interface ReportOptions extends Partial<ReportDefinition> {
  model: DataModel;
  theme?: string | Theme | DeepPartial<Theme>;
  locale?: string;
  chrome?: ReportChrome;
  initialPage?: string;
  /** Custom tooltip content. Return undefined to use the default. */
  tooltip?: TooltipRenderer;
  /** Called for every event (handy for frameworks). */
  onEvent?: <K extends keyof ReportEvents>(event: K, payload: ReportEvents[K]) => void;
}

interface PageState {
  def: PageDefinition;
  el: HTMLElement | null;
  hosts: Map<string, VisualHost>;
  slicers: Map<string, FilterSpec[]>;
  selection: { visualId: string; identities: DataPointIdentity[] } | null;
}

/** Public handle to one visual. */
export interface VisualHandle {
  readonly id: string;
  readonly spec: VisualSpec;
  update(patch: Partial<VisualSpec>): void;
  toCsv(): string;
  exportCsv(filename?: string): void;
  /** Current query result. */
  data(): QueryResult | null;
  drillUp(): void;
  drillDown(value: CellValue): void;
}

const DATE_TAG = '$date';

function toPlain(value: unknown): unknown {
  if (value instanceof Date) return { [DATE_TAG]: value.toISOString() };
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined && typeof v !== 'function') out[k] = toPlain(v);
    return out;
  }
  return value;
}

export function reviveDates(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && DATE_TAG in (v as object) && Object.keys(v as object).length === 1) return new Date((v as Record<string, string>)[DATE_TAG]);
  return v;
}

const raf: (cb: () => void) => void = typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 0);

/**
 * An interactive, multi-page report rendered into a container element.
 *
 * ```ts
 * const report = new Report(el, { model, pages: [{ name: 'Overview', visuals: [...] }] });
 * ```
 */
export class Report implements ReportRuntime {
  readonly model: DataModel;
  readonly root: HTMLElement;
  readonly tooltip: Tooltip;
  locale?: string;
  name: string;
  private _theme: Theme;
  private pages: PageState[] = [];
  private current = 0;
  private reportFilters: FilterSpec[];
  private bookmarks: Bookmark[];
  private emitter = new Emitter<ReportEvents>();
  private pending = new Set<string>();
  private pendingAll = false;
  private frame = false;
  private _focused: string | null = null;
  private active: string | null = null;
  private _modelVersion = 0;
  private domainCache = new Map<string, Map<unknown, number>>();
  private pageScroll: HTMLElement;
  private tabs: HTMLElement;
  private toolbar: HTMLElement;
  private pane: FilterPane;
  private paneOpen: boolean;
  private chrome: Required<ReportChrome>;
  private unsubModel: () => void;
  private onEvent?: ReportOptions['onEvent'];
  private destroyed = false;

  constructor(
    readonly container: HTMLElement,
    opts: ReportOptions,
  ) {
    injectStyles(container.ownerDocument);
    this.model = opts.model;
    this.locale = opts.locale;
    this.name = opts.name ?? 'Report';
    this._theme = getTheme(opts.theme);
    this.reportFilters = opts.filters ?? [];
    this.bookmarks = opts.bookmarks ?? [];
    this.onEvent = opts.onEvent;
    this.chrome = { toolbar: opts.chrome?.toolbar ?? true, pageTabs: opts.chrome?.pageTabs ?? 'auto', filterPane: opts.chrome?.filterPane ?? true };
    this.paneOpen = this.chrome.filterPane === 'open';

    this.root = h('div', { class: 'pbi-report' });
    this.toolbar = h('div', { class: 'pbi-toolbar' });
    this.pageScroll = h('div', { class: 'pbi-page-scroll' });
    this.pane = new FilterPane(this.model, () => this.toggleFilterPane(false));
    const main = h('div', { class: 'pbi-main' }, this.pageScroll, this.pane.el);
    this.tabs = h('nav', { class: 'pbi-tabs', role: 'tablist', 'aria-label': 'Pages' });
    this.root.append(this.toolbar, main, this.tabs);
    container.replaceChildren(this.root);
    this.tooltip = new Tooltip(this.root);
    this.tooltip.renderer = opts.tooltip;
    this.root.addEventListener('click', () => this.clearSelection());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this._focused) this.toggleFocus(this._focused);
        else this.clearSelection();
      }
    });
    this.unsubModel = this.model.onChange(() => {
      this._modelVersion++;
      this.domainCache.clear();
      this.schedule();
    });

    for (const p of opts.pages ?? []) this.addPage(p, false);
    if (!this.pages.length) this.addPage({ name: 'Page 1', visuals: [] }, false);
    const initial = opts.initialPage ? this.pageIndex(opts.initialPage) : 0;
    this.applyTheme();
    this.showPage(Math.max(0, initial), false);
  }

  // ================================================================= runtime (used by visuals)

  get theme(): Theme {
    return this._theme;
  }
  get modelVersion(): number {
    return this._modelVersion;
  }
  get focused(): string | null {
    return this._focused;
  }

  private get page(): PageState {
    return this.pages[this.current];
  }

  private findVisual(id: string): { page: PageState; spec: VisualSpec } | undefined {
    for (const p of this.pages) {
      const spec = p.def.visuals.find((v) => v.id === id);
      if (spec) return { page: p, spec };
    }
    return undefined;
  }

  private interactionMode(target: VisualSpec, sourceId: string): 'filter' | 'highlight' | 'none' {
    const def = getVisual(target.type);
    const mode = target.interactionsFrom?.[sourceId] ?? target.interaction ?? (def.supportsHighlight ? 'highlight' : 'filter');
    return mode === 'highlight' && !def.supportsHighlight ? 'filter' : mode;
  }

  filtersFor(visualId: string): FilterSpec[] {
    const found = this.findVisual(visualId);
    if (!found) return [];
    const { page, spec } = found;
    const out: FilterSpec[] = [...this.reportFilters, ...(page.def.filters ?? []), ...(spec.filters ?? [])];
    for (const [sid, f] of page.slicers) if (sid !== visualId) out.push(...f);
    const sel = page.selection;
    if (sel && sel.visualId !== visualId && this.interactionMode(spec, sel.visualId) === 'filter') out.push(...identitiesToFilters(sel.identities));
    // inactive pane cards ("is (All)") are no-ops
    return out.filter((f) => !(f.op === 'notIn' && !(f.values ?? []).length));
  }

  highlightFor(visualId: string): FilterSpec[] | undefined {
    const found = this.findVisual(visualId);
    const sel = found?.page.selection;
    if (!found || !sel || sel.visualId === visualId) return undefined;
    return this.interactionMode(found.spec, sel.visualId) === 'highlight' ? identitiesToFilters(sel.identities) : undefined;
  }

  selectionFor(visualId: string): DataPointIdentity[] {
    const sel = this.findVisual(visualId)?.page.selection;
    return sel && sel.visualId === visualId ? sel.identities : [];
  }

  selectionSource(): string | null {
    return this.page.selection?.visualId ?? null;
  }

  setSelection(visualId: string, identity: DataPointIdentity | null, multi: boolean): void {
    const page = this.findVisual(visualId)?.page ?? this.page;
    const key = (i: DataPointIdentity) => JSON.stringify([i.columns, i.values.map(valueKey)]);
    let ids: DataPointIdentity[] = [];
    if (identity) {
      const cur = page.selection?.visualId === visualId ? page.selection.identities : [];
      const k = key(identity);
      const has = cur.some((c) => key(c) === k);
      if (multi) ids = has ? cur.filter((c) => key(c) !== k) : [...cur, identity];
      else ids = has && cur.length === 1 ? [] : [identity];
    }
    page.selection = ids.length ? { visualId, identities: ids } : null;
    this.schedule();
    this.emit('selectionChanged', { pageId: page.def.id!, visualId: ids.length ? visualId : null, identities: ids, filters: identitiesToFilters(ids) });
  }

  clearSelectionFrom(visualId: string): void {
    const page = this.findVisual(visualId)?.page;
    if (page?.selection?.visualId === visualId) this.setSelection(visualId, null, false);
  }

  /** Clear the selection on the current page. */
  clearSelection(): void {
    if (this.page.selection) this.setSelection(this.page.selection.visualId, null, false);
  }

  slicerFilter(visualId: string): FilterSpec[] | null {
    return this.findVisual(visualId)?.page.slicers.get(visualId) ?? null;
  }

  setSlicerFilter(visualId: string, filters: FilterSpec[] | null): void {
    const page = this.findVisual(visualId)?.page;
    if (!page) throw new Error(`Visual "${visualId}" not found`);
    if (filters && filters.length) page.slicers.set(visualId, filters);
    else page.slicers.delete(visualId);
    this.schedule();
    this.renderPane();
    this.emit('filtersChanged', { pageId: page.def.id!, scope: 'slicer', visualId, filters: filters ?? [] });
  }

  slicerDomain(visualId: string, column: string): CellValue[] {
    const filters = this.filtersFor(visualId).filter((f) => f.op !== 'topN');
    const ctx = this.model.toContext(filters as never[]);
    const ref = column.includes('[') ? column : column;
    const m = /^(.*)\[(.*)\]$/.exec(ref.trim());
    if (!m) throw new Error(`Slicer field must be a column reference, got "${column}"`);
    const table = m[1].replace(/^'|'$/g, '');
    return this.model.valuesOf({ table, column: m[2] }, ctx);
  }

  setActiveVisual(visualId: string | null): void {
    if (this.active === visualId) return;
    this.active = visualId;
    for (const host of this.page.hosts.values()) host.el.classList.toggle('is-active', host.id === visualId);
    this.renderPane();
  }

  toggleFocus(visualId: string): void {
    const host = this.page.hosts.get(visualId);
    if (!host) return;
    this._focused = this._focused === visualId ? null : visualId;
    for (const hst of this.page.hosts.values()) hst.el.classList.toggle('is-focus', hst.id === this._focused);
    this.schedule(visualId);
  }

  domainIndex(table: string, column: string, value: CellValue): number {
    const k = `${table}[${column}]`;
    let m = this.domainCache.get(k);
    if (!m) {
      m = new Map();
      this.model
        .table(table)
        .distinct(column)
        .forEach((v, i) => m!.set(valueKey(v), i));
      this.domainCache.set(k, m);
    }
    return m.get(valueKey(value)) ?? 0;
  }

  emit<K extends keyof ReportEvents>(event: K, payload: ReportEvents[K]): void {
    this.emitter.emit(event, payload);
    this.onEvent?.(event, payload);
  }

  /** Subscribe to an event; returns an unsubscribe function. */
  on<K extends keyof ReportEvents>(event: K, fn: (payload: ReportEvents[K]) => void): () => void {
    return this.emitter.on(event, fn);
  }

  off<K extends keyof ReportEvents>(event: K, fn: (payload: ReportEvents[K]) => void): void {
    this.emitter.off(event, fn);
  }

  /** Re-render a visual (or all) on the next animation frame. */
  schedule(visualId?: string): void {
    if (this.destroyed) return;
    if (visualId) this.pending.add(visualId);
    else this.pendingAll = true;
    if (this.frame) return;
    this.frame = true;
    raf(() => this.flush());
  }

  /** Render everything pending right now (useful in tests and SSR snapshots). */
  flush(): void {
    this.frame = false;
    if (this.destroyed) return;
    const hosts = this.page.hosts;
    const ids = this.pendingAll ? [...hosts.keys()] : [...this.pending];
    this.pending.clear();
    this.pendingAll = false;
    for (const id of ids) hosts.get(id)?.render();
  }

  // ================================================================= pages

  private pageIndex(idOrName: string): number {
    return this.pages.findIndex((p) => p.def.id === idOrName || p.def.name === idOrName);
  }

  addPage(def: PageDefinition, show = true): string {
    const d: PageDefinition = { ...def, id: def.id ?? uid('page'), visuals: def.visuals.map((v) => ({ ...v, id: v.id ?? uid('visual') })) };
    this.pages.push({ def: d, el: null, hosts: new Map(), slicers: new Map(), selection: null });
    this.renderTabs();
    if (show) this.showPage(this.pages.length - 1);
    return d.id!;
  }

  removePage(idOrName: string): void {
    const i = this.pageIndex(idOrName);
    if (i < 0) return;
    const [p] = this.pages.splice(i, 1);
    for (const host of p.hosts.values()) host.destroy();
    p.el?.remove();
    if (!this.pages.length) this.addPage({ name: 'Page 1', visuals: [] }, false);
    this.showPage(Math.min(this.current, this.pages.length - 1), false);
  }

  goToPage(idOrName: string): void {
    const i = this.pageIndex(idOrName);
    if (i < 0) throw new Error(`Page "${idOrName}" not found`);
    this.showPage(i);
  }

  get currentPage(): { id: string; name: string } {
    return { id: this.page.def.id!, name: this.page.def.name };
  }

  get pageList(): { id: string; name: string; hidden: boolean }[] {
    return this.pages.map((p) => ({ id: p.def.id!, name: p.def.name, hidden: !!p.def.hidden }));
  }

  private showPage(i: number, emit = true): void {
    if (this.page?.el) this.page.el.hidden = true;
    this._focused = null;
    this.active = null;
    this.current = i;
    const p = this.page;
    if (!p.el) {
      p.el = h('div', { class: 'pbi-page', role: 'tabpanel', 'aria-label': p.def.name });
      this.pageScroll.append(p.el);
      for (const spec of p.def.visuals) this.mountVisual(p, spec);
    }
    this.applyPageLayout(p);
    p.el.hidden = false;
    this.renderTabs();
    this.renderToolbar();
    this.renderPane();
    this.schedule();
    if (emit) this.emit('pageChanged', { pageId: p.def.id!, name: p.def.name });
  }

  private applyPageLayout(p: PageState): void {
    const l = p.def.layout ?? {};
    p.el!.style.setProperty('--pbi-cols', String(l.columns ?? 12));
    p.el!.style.setProperty('--pbi-row', `${l.rowHeight ?? 44}px`);
    p.el!.style.setProperty('--pbi-gap', `${l.gap ?? 12}px`);
    p.el!.style.background = p.def.background ?? '';
  }

  private mountVisual(p: PageState, spec: VisualSpec): VisualHost {
    const host = new VisualHost(this, spec);
    p.hosts.set(host.id, host);
    p.el!.append(host.el);
    return host;
  }

  // ================================================================= visuals

  /** Add a visual to a page (current page by default). Returns its id. */
  addVisual(spec: VisualSpec, pageId?: string): string {
    const p = pageId ? this.pages[this.pageIndex(pageId)] : this.page;
    if (!p) throw new Error(`Page "${pageId}" not found`);
    const s = { ...spec, id: spec.id ?? uid('visual') };
    getVisual(s.type);
    p.def.visuals.push(s);
    if (p.el) {
      this.mountVisual(p, s);
      this.schedule(s.id);
    }
    return s.id;
  }

  updateVisual(id: string, patch: Partial<VisualSpec>): void {
    const found = this.findVisual(id);
    if (!found) throw new Error(`Visual "${id}" not found`);
    Object.assign(found.spec, patch);
    const host = found.page.hosts.get(id);
    if (host) {
      host.update(found.spec);
      this.schedule();
    }
  }

  removeVisual(id: string): void {
    const found = this.findVisual(id);
    if (!found) return;
    found.page.def.visuals = found.page.def.visuals.filter((v) => v.id !== id);
    found.page.hosts.get(id)?.destroy();
    found.page.hosts.delete(id);
    found.page.slicers.delete(id);
    if (found.page.selection?.visualId === id) found.page.selection = null;
    this.schedule();
  }

  visual(id: string): VisualHandle {
    const found = this.findVisual(id);
    if (!found) throw new Error(`Visual "${id}" not found`);
    const getHost = () => {
      const host = found.page.hosts.get(id);
      if (!host) throw new Error(`Visual "${id}" is on a page that has not been shown yet`);
      return host;
    };
    return {
      id,
      get spec() {
        return found.spec;
      },
      update: (patch) => this.updateVisual(id, patch),
      toCsv: () => getHost().toCsv(),
      exportCsv: (name) => getHost().exportCsv(name),
      data: () => getHost().lastResult,
      drillUp: () => getHost().drillUp(),
      drillDown: (v) => getHost().drillDown(v),
    };
  }

  visualIds(pageId?: string): string[] {
    const p = pageId ? this.pages[this.pageIndex(pageId)] : this.page;
    return p ? p.def.visuals.map((v) => v.id!) : [];
  }

  // ================================================================= filters

  setReportFilters(filters: FilterSpec[]): void {
    this.reportFilters = filters;
    this.validate(filters);
    this.afterFilterChange('report');
  }

  setPageFilters(pageId: string, filters: FilterSpec[]): void {
    const p = this.pages[this.pageIndex(pageId)];
    if (!p) throw new Error(`Page "${pageId}" not found`);
    this.validate(filters);
    p.def.filters = filters;
    this.afterFilterChange('page', undefined, p);
  }

  setVisualFilters(visualId: string, filters: FilterSpec[]): void {
    const found = this.findVisual(visualId);
    if (!found) throw new Error(`Visual "${visualId}" not found`);
    this.validate(filters);
    found.spec.filters = filters;
    this.afterFilterChange('visual', visualId, found.page);
  }

  /** Programmatically set a slicer's selection (same as the user clicking it). */
  setSlicerSelection(visualId: string, filters: FilterSpec[] | null): void {
    this.setSlicerFilter(visualId, filters);
  }

  getFilters(): { report: FilterSpec[]; page: FilterSpec[]; slicers: Record<string, FilterSpec[]> } {
    return { report: this.reportFilters, page: this.page.def.filters ?? [], slicers: Object.fromEntries(this.page.slicers) };
  }

  private validate(filters: FilterSpec[]): void {
    for (const f of filters) if (f.op !== 'topN') compileFilter(f);
  }

  private afterFilterChange(scope: 'report' | 'page' | 'visual', visualId?: string, page: PageState = this.page): void {
    this.schedule();
    this.renderPane();
    const filters = scope === 'report' ? this.reportFilters : scope === 'page' ? (page.def.filters ?? []) : (this.findVisual(visualId!)?.spec.filters ?? []);
    this.emit('filtersChanged', { pageId: page.def.id!, scope, visualId, filters });
  }

  /** Clear slicers, selection, drill state and pane filters on the current page. */
  reset(): void {
    const p = this.page;
    p.slicers.clear();
    p.selection = null;
    for (const v of p.def.visuals) {
      v.drill = undefined;
      p.hosts.get(v.id!)?.invalidate();
    }
    this.schedule();
    this.renderPane();
    this.emit('filtersChanged', { pageId: p.def.id!, scope: 'slicer', filters: [] });
  }

  // ================================================================= chrome

  toggleFilterPane(open = !this.paneOpen): void {
    this.paneOpen = open;
    this.renderPane();
    this.renderToolbar();
  }

  private renderPane(): void {
    this.pane.el.hidden = !this.chrome.filterPane || !this.paneOpen;
    if (this.pane.el.hidden) return;
    const p = this.page;
    const sections = [];
    const activeSpec = this.active ? p.def.visuals.find((v) => v.id === this.active) : undefined;
    if (activeSpec && !getVisual(activeSpec.type).static)
      sections.push({ scope: 'visual' as const, title: 'Filters on this visual', filters: activeSpec.filters ?? [], set: (f: FilterSpec[]) => this.setVisualFilters(activeSpec.id!, f) });
    sections.push({ scope: 'page' as const, title: 'Filters on this page', filters: p.def.filters ?? [], set: (f: FilterSpec[]) => this.setPageFilters(p.def.id!, f) });
    sections.push({ scope: 'report' as const, title: 'Filters on all pages', filters: this.reportFilters, set: (f: FilterSpec[]) => this.setReportFilters(f) });
    this.pane.render(sections);
  }

  private renderToolbar(): void {
    this.toolbar.hidden = !this.chrome.toolbar;
    if (this.toolbar.hidden) return;
    this.toolbar.replaceChildren(h('div', { class: 'pbi-toolbar-title' }, this.name));
    const btn = (label: string, onClick: () => void, pressed?: boolean) => {
      const b = h('button', { type: 'button', class: 'pbi-btn', 'aria-pressed': pressed === undefined ? undefined : String(pressed) }, label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      this.toolbar.append(b);
    };
    btn('Reset', () => this.reset());
    if (this.chrome.filterPane) btn('Filters', () => this.toggleFilterPane(), this.paneOpen);
  }

  private renderTabs(): void {
    const visible = this.pages.filter((p) => !p.def.hidden);
    const show = this.chrome.pageTabs === true || (this.chrome.pageTabs === 'auto' && visible.length > 1);
    this.tabs.hidden = !show;
    if (!show) return;
    this.tabs.replaceChildren();
    this.pages.forEach((p, i) => {
      if (p.def.hidden) return;
      const b = h('button', { type: 'button', class: 'pbi-tab', role: 'tab', 'aria-selected': String(i === this.current) }, p.def.name);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (i !== this.current) this.showPage(i);
      });
      this.tabs.append(b);
    });
  }

  // ================================================================= theme

  setTheme(theme: string | Theme | DeepPartial<Theme>): void {
    this._theme = getTheme(theme);
    this.applyTheme();
    for (const p of this.pages) for (const host of p.hosts.values()) host.update({});
    this.schedule();
    this.emit('themeChanged', { name: this._theme.name });
  }

  private applyTheme(): void {
    for (const [k, v] of Object.entries(themeVars(this._theme))) this.root.style.setProperty(k, v);
    this.root.dataset.mode = this._theme.mode;
  }

  // ================================================================= bookmarks & persistence

  captureBookmark(name: string): Bookmark {
    const b: Bookmark = {
      name,
      pageId: this.page.def.id!,
      reportFilters: structuredCloneSafe(this.reportFilters),
      pageFilters: Object.fromEntries(this.pages.map((p) => [p.def.id!, structuredCloneSafe(p.def.filters ?? [])])),
      slicers: Object.fromEntries(this.pages.map((p) => [p.def.id!, Object.fromEntries([...p.slicers].map(([k, v]) => [k, structuredCloneSafe(v)]))])),
      selection: this.page.selection ? structuredCloneSafe(this.page.selection) : null,
      drill: Object.fromEntries(this.pages.flatMap((p) => p.def.visuals.filter((v) => v.drill).map((v) => [v.id!, structuredCloneSafe(v.drill)]))),
    };
    this.bookmarks = [...this.bookmarks.filter((x) => x.name !== name), b];
    return b;
  }

  applyBookmark(b: Bookmark | string): void {
    const bm = typeof b === 'string' ? this.bookmarks.find((x) => x.name === b) : b;
    if (!bm) throw new Error(`Bookmark "${b}" not found`);
    this.reportFilters = structuredCloneSafe(bm.reportFilters);
    for (const p of this.pages) {
      p.def.filters = structuredCloneSafe(bm.pageFilters[p.def.id!] ?? []);
      p.slicers = new Map(Object.entries(structuredCloneSafe(bm.slicers[p.def.id!] ?? {})));
      p.selection = null;
      for (const v of p.def.visuals) {
        v.drill = bm.drill[v.id!] ? structuredCloneSafe(bm.drill[v.id!]) : undefined;
        p.hosts.get(v.id!)?.invalidate();
      }
    }
    const i = this.pageIndex(bm.pageId);
    if (i >= 0 && i !== this.current) this.showPage(i);
    if (bm.selection) this.page.selection = structuredCloneSafe(bm.selection);
    this.schedule();
    this.renderPane();
    this.emit('bookmarkApplied', { name: bm.name });
  }

  bookmarkList(): Bookmark[] {
    return this.bookmarks;
  }

  /** Serialisable report definition (pages, visuals, filters, bookmarks). Dates are tagged and revived by {@link Report.parse}. */
  toJSON(): ReportDefinition {
    return toPlain({ name: this.name, pages: this.pages.map((p) => p.def), filters: this.reportFilters, bookmarks: this.bookmarks }) as ReportDefinition;
  }

  /** Parse a JSON string produced from {@link Report.toJSON}. */
  static parse(json: string): ReportDefinition {
    return JSON.parse(json, reviveDates) as ReportDefinition;
  }

  /** Force every visual to re-query (e.g. after mutating data in place). */
  refresh(): void {
    for (const p of this.pages) for (const host of p.hosts.values()) host.invalidate();
    this.domainCache.clear();
    this.schedule();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubModel();
    for (const p of this.pages) for (const host of p.hosts.values()) host.destroy();
    this.tooltip.destroy();
    this.root.remove();
  }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(toPlain(v)), reviveDates) as T;
}
