import type { CellValue } from '../data/types';
import { parseColumnRef, valueKey } from '../data/types';
import type { ColumnRef } from '../data/types';
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
import type { DataPointIdentity, VisualLayout, VisualSpec } from '../visuals/types';
import type { VisualFormat } from '../visuals/format';
import type { ReportEvents } from './events';
import { FilterPane } from './filterPane';
import type { ReportRuntime, QueryEngine } from './runtime';
import { injectStyles, themeVars } from './styles';
import { Tooltip } from './tooltip';
import { ContextMenu } from './contextMenu';
import { EditController, findFreeSpot } from './editing';
import { REPORT_SCHEMA_VERSION, migrateReport } from './migrate';
import type { MenuItem } from './contextMenu';
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
  /**
   * Make this a drill-through target: right-clicking a data point that carries one of these
   * fields offers "Drill through: <page>". Typically combined with `hidden: true`.
   */
  drillthrough?: { fields: string[]; /** Carry the source visual's filters along (default true). */ keepAllFilters?: boolean };
  /** Make this a report-tooltip page: rendered inside the tooltip when a visual sets `format.tooltip.page`. Never shown as a tab. */
  tooltip?: { width?: number; height?: number };
  /**
   * Phone layout: which visuals show on narrow screens and where, on its own grid (default 4 columns).
   * Used below `ReportOptions.mobileBreakpoint`; visuals not listed are hidden on phones.
   */
  mobile?: MobileLayout;
}

export interface MobileLayout {
  columns?: number;
  rowHeight?: number;
  visuals: { id: string; layout: VisualLayout }[];
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
  /** Schema version (see migrateReport). */
  version?: number;
  name?: string;
  pages: PageDefinition[];
  /** Filters on all pages. */
  filters?: FilterSpec[];
  bookmarks?: Bookmark[];
  /**
   * Text per locale (`'fr'`, `'fr-CA'`…): page names, visual titles, text-box content and field display names
   * (axis titles, legends, tooltips). The report's `locale` picks one, falling back from `fr-CA` to `fr`.
   */
  translations?: Record<string, ReportTranslation>;
  /** Scheduled sends of a page (run by `runSubscriptions` from `@prismbi/prismbi/server`). */
  subscriptions?: ReportSubscription[];
  /** Measure alerts (run by `watchAlerts` from `@prismbi/prismbi/server`; works in browsers too). */
  alerts?: ReportAlert[];
}

export interface ReportSubscription {
  id: string;
  name: string;
  /** Page id or name to send. */
  page: string;
  /** `'daily@08:00'` (local time) or an interval in ms. */
  schedule: string | number;
  /** Who receives it (email addresses, channel ids…; interpreted by your sender). */
  recipients: string[];
  enabled?: boolean;
}

export interface ReportAlert {
  id: string;
  name: string;
  /** Measure name. */
  measure: string;
  filters?: FilterSpec[];
  /** A threshold, a relative change, or `{ anomaly: true }` for unusual spikes and dips (server `watchAlerts`). */
  when: { above: number } | { below: number } | { changeBy: number } | { anomaly: true; kinds?: ('anomaly' | 'trend' | 'mover' | 'outlier' | 'concentration')[] };
  recipients?: string[];
  enabled?: boolean;
}

export interface ReportTranslation {
  /** Page id → name. */
  pages?: Record<string, string>;
  /** Visual id → title and/or text-box content. */
  visuals?: Record<string, { title?: string; text?: string }>;
  /** Measure name or `Table[Column]` → display name. */
  fields?: Record<string, string>;
  /** Report name. */
  name?: string;
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
  /**
   * Run visual queries on another engine, e.g. `createWorkerEngine(worker)` from `@prismbi/prismbi/worker` serving the same
   * model. Visuals render asynchronously; slicers and metadata still use `model`.
   */
  engine?: QueryEngine;
  /** Text direction; `'auto'` (default) is right-to-left for Arabic, Hebrew, Persian and Urdu locales. */
  direction?: 'ltr' | 'rtl' | 'auto';
  /** `'auto'` (default) uses a page's phone layout below `mobileBreakpoint`; `'desktop'` / `'mobile'` force one. */
  layoutMode?: 'auto' | 'desktop' | 'mobile';
  /** Width in px below which phone layouts apply (default 640). */
  mobileBreakpoint?: number;
  /** Usage analytics: page views and interactions (select, drill, drill-through, filter, bookmark), for any analytics sink. */
  onUsage?: (e: UsageEvent) => void;
  /** Explicit pixel size per visual body, for rendering without layout (e.g. `@prismbi/prismbi/server`). */
  measure?: (visualId: string) => { width: number; height: number } | undefined;
}

/** One usage record passed to `ReportOptions.onUsage`. */
export interface UsageEvent {
  type: 'pageView' | 'interaction';
  /** For interactions: what the viewer did. */
  action?: 'select' | 'drill' | 'drillThrough' | 'filter' | 'bookmark';
  report: string;
  pageId: string;
  page: string;
  visualId?: string;
  /** Milliseconds since the epoch. */
  at: number;
  detail?: Record<string, unknown>;
}

interface PageState {
  def: PageDefinition;
  el: HTMLElement | null;
  hosts: Map<string, VisualHost>;
  slicers: Map<string, FilterSpec[]>;
  selection: { visualId: string; identities: DataPointIdentity[] } | null;
  /** Filters applied by a drill-through into this page, and where to go back to. */
  drillState: { filters: FilterSpec[]; from: number } | null;
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
  /** Plain-language summary of what the visual shows (the same text screen readers get). */
  describe(): string;
  drillUp(): void;
  drillDown(value: CellValue): void;
  /** "Expand all down one level". */
  expandAll(): void;
  /** Standalone SVG snapshot. */
  toSvg(): string;
  /** Download as PNG or SVG. */
  exportImage(type?: 'png' | 'svg', filename?: string): Promise<void>;
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

/** Context for menu items contributed by plugins (see {@link registerMenuItems}). */
export interface MenuContext {
  report: Report;
  visualId: string;
  spec: VisualSpec;
  identity: DataPointIdentity;
  /** Filters in effect for the visual (report, page, slicers, other visuals' selections, its own). */
  filters: FilterSpec[];
  event: MouseEvent;
}

export type MenuProvider = (ctx: MenuContext) => MenuItem[];

const MENU_KEY = Symbol.for('prismbi.menuProviders');
const menuProviders = (): Set<MenuProvider> => ((globalThis as Record<symbol, Set<MenuProvider>>)[MENU_KEY] ??= new Set());

/** Add items to every data point's context menu (e.g. "Explain this"). Returns an unregister function. */
export function registerMenuItems(provider: MenuProvider): () => void {
  menuProviders().add(provider);
  return () => menuProviders().delete(provider);
}

/** Phone height for a visual: compact for slicers and cards, taller for charts. */
function phoneHeight(spec: VisualSpec | undefined): number {
  if (!spec) return 6;
  if (spec.type === 'slicer') return 2;
  if (/card|kpi|gauge|text/i.test(spec.type)) return 3;
  return Math.max(5, Math.min(8, spec.layout?.h ?? 6));
}

/** Stack a page's visuals full-width in reading order (top to bottom, left to right). */
export function autoMobileLayout(page: PageDefinition, columns = 4): MobileLayout {
  const order = [...page.visuals].filter((v) => v.id).sort((a, b) => (a.layout?.y ?? 0) - (b.layout?.y ?? 0) || (a.layout?.x ?? 0) - (b.layout?.x ?? 0));
  let y = 0;
  const visuals: MobileLayout['visuals'] = [];
  for (let i = 0; i < order.length; i++) {
    const v = order[i];
    // small neighbours on one row (two cards side by side) share it
    const next = order[i + 1];
    const small = (s: VisualSpec) => /card|kpi|gauge/i.test(s.type);
    if (next && small(v) && small(next) && (next.layout?.y ?? 0) === (v.layout?.y ?? 0)) {
      const h = phoneHeight(v);
      visuals.push({ id: v.id!, layout: { x: 0, y, w: columns / 2, h } }, { id: next.id!, layout: { x: columns / 2, y, w: columns / 2, h } });
      y += h;
      i++;
      continue;
    }
    const h = phoneHeight(v);
    visuals.push({ id: v.id!, layout: { x: 0, y, w: columns, h } });
    y += h;
  }
  return { columns, visuals };
}

/** Visuals within this many pixels of the viewport render eagerly; the rest wait until scrolled into view. */
const LAZY_MARGIN = 300;

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
  /** Off-screen visuals whose render was skipped; they render when scrolled into view (or on `flush()`). */
  private deferred = new Set<string>();
  /** Last known viewport intersection per visual element. */
  private onScreen = new WeakMap<Element, boolean>();
  private io?: IntersectionObserver;
  private frame = false;
  private _focused: string | null = null;
  private active: string | null = null;
  private _modelVersion = 0;
  private domainCache = new Map<string, Map<unknown, number>>();
  private pageScroll: HTMLElement;
  private tabs: HTMLElement;
  private toolbar: HTMLElement;
  private pane: FilterPane;
  private ctxMenu: ContextMenu;
  private editor: EditController | null = null;
  private paneOpen: boolean;
  private chrome: Required<ReportChrome>;
  private unsubModel: () => void;
  private offResize: () => void = () => {};
  private onEvent?: ReportOptions['onEvent'];
  private onUsage?: ReportOptions['onUsage'];
  private destroyed = false;

  constructor(
    readonly container: HTMLElement,
    opts: ReportOptions,
  ) {
    injectStyles(container.ownerDocument);
    this.model = opts.model;
    this.engine = opts.engine;
    this.measure = opts.measure;
    this._layoutMode = opts.layoutMode ?? 'auto';
    this.mobileBreakpoint = opts.mobileBreakpoint ?? 640;
    this.locale = opts.locale;
    this.translations = opts.translations ?? {};
    this.subscriptions = opts.subscriptions ?? [];
    this.alerts = opts.alerts ?? [];
    this.direction = opts.direction ?? 'auto';
    this.name = opts.name ?? 'Report';
    this._theme = getTheme(opts.theme);
    this.reportFilters = opts.filters ?? [];
    this.bookmarks = opts.bookmarks ?? [];
    this.onEvent = opts.onEvent;
    this.onUsage = opts.onUsage;
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
    this.ctxMenu = new ContextMenu(this.root);
    this.root.addEventListener('click', () => this.clearSelection());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this._focused) this.toggleFocus(this._focused);
        else this.clearSelection();
      }
    });
    const onResize = () => {
      this.refreshLayoutMode();
      if (this._focused) this.layoutFocus();
    };
    window.addEventListener('resize', onResize);
    this.offResize = () => window.removeEventListener('resize', onResize);
    this.unsubModel = this.model.onChange((change) => {
      this.domainCache.clear();
      if (change) {
        // only rows changed (streaming, appends): re-query just the visuals that read those tables, on every page
        const tables = new Set(change.tables);
        for (const p of this.pages)
          for (const host of p.hosts.values())
            if (host.dependsOn(tables)) {
              host.dataChanged();
              if (p === this.page) this.schedule(host.id);
            }
        return;
      }
      this._modelVersion++;
      this.schedule();
    });

    for (const p of opts.pages ?? []) this.addPage(p, false);
    if (!this.pages.length) this.addPage({ name: 'Page 1', visuals: [] }, false);
    const initial = opts.initialPage ? this.pageIndex(opts.initialPage) : 0;
    this.applyTheme();
    this.applyDirection();
    this.showPage(Math.max(0, initial), false);
    this.usage('pageView');
  }

  // ================================================================= runtime (used by visuals)

  get theme(): Theme {
    return this._theme;
  }
  /** Engine running visual queries (see `ReportOptions.engine`). */
  readonly engine?: QueryEngine;
  readonly measure?: (visualId: string) => { width: number; height: number } | undefined;
  private translations: Record<string, ReportTranslation> = {};
  private subscriptions: ReportSubscription[] = [];
  private alerts: ReportAlert[] = [];

  /** Scheduled page sends defined on this report. */
  get subscriptionList(): ReportSubscription[] {
    return this.subscriptions.map((s) => ({ ...s, recipients: [...s.recipients] }));
  }

  /** Measure alerts defined on this report. */
  get alertList(): ReportAlert[] {
    return this.alerts.map((a) => ({ ...a }));
  }

  /** Replace the subscriptions (one undoable edit). */
  setSubscriptions(list: ReportSubscription[]): void {
    this.subscriptions = list.map((s) => ({ ...s, recipients: [...s.recipients] }));
    this.changedDefinition('subscriptions');
  }

  /** Replace the alerts (one undoable edit). */
  setAlerts(list: ReportAlert[]): void {
    this.alerts = list.map((a) => ({ ...a }));
    this.changedDefinition('alerts');
  }
  private direction: 'ltr' | 'rtl' | 'auto' = 'auto';

  /** The translation for the current locale (exact, then language only), if any. */
  private activeTranslation(): ReportTranslation | undefined {
    const loc = this.locale;
    if (!loc) return undefined;
    return this.translations[loc] ?? this.translations[loc.split('-')[0]];
  }

  /** Translated text for a page, visual title, text-box or field, or the fallback. */
  translate(kind: 'page' | 'title' | 'text' | 'field', key: string, fallback: string): string {
    const t = this.activeTranslation();
    if (!t) return fallback;
    if (kind === 'page') return t.pages?.[key] ?? fallback;
    if (kind === 'field') return t.fields?.[key] ?? t.fields?.[key.replace(/^\[|\]$/g, '')] ?? fallback;
    const v = t.visuals?.[key];
    return (kind === 'title' ? v?.title : v?.text) ?? fallback;
  }

  /** Switch language and number/date locale at runtime (re-renders; direction follows in `'auto'`). */
  setLocale(locale: string | undefined): void {
    this.locale = locale;
    this.applyDirection();
    this._modelVersion++; // visual caches include the version, so labels and formats refresh
    this.renderTabs();
    this.renderToolbar();
    for (const p of this.pages) {
      p.el?.setAttribute('aria-label', this.translate('page', p.def.id!, p.def.name));
      for (const host of p.hosts.values()) host.update(host.spec);
    }
    this.schedule();
  }

  private applyDirection(): void {
    const rtl = this.direction === 'rtl' || (this.direction === 'auto' && /^(ar|he|fa|ur|yi|ps|sd|ug)\b/i.test(this.locale ?? ''));
    this.root.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  }

  private _layoutMode: 'auto' | 'desktop' | 'mobile' = 'auto';
  private mobileBreakpoint = 640;
  private phoneActive = false;

  /** Is the current page showing its phone layout? */
  get isMobileLayout(): boolean {
    return this.phoneActive;
  }

  get layoutMode(): 'auto' | 'desktop' | 'mobile' {
    return this._layoutMode;
  }

  /** Switch between automatic, desktop and phone layouts (the studio uses `'mobile'` to edit phone layouts). */
  setLayoutMode(mode: 'auto' | 'desktop' | 'mobile'): void {
    this._layoutMode = mode;
    this.refreshLayoutMode(true);
  }

  private wantsPhone(): boolean {
    const p = this.page;
    if (!p) return false;
    if (this._layoutMode === 'mobile') return true;
    if (this._layoutMode === 'desktop' || !p.def.mobile) return false;
    const w = this.root.clientWidth;
    return w > 0 && w < this.mobileBreakpoint;
  }

  /** Re-evaluate phone vs desktop layout for the current page; re-lay out visuals when it changes. */
  private refreshLayoutMode(force = false): void {
    const p = this.page;
    if (!p?.el) return;
    const phone = this.wantsPhone();
    if (phone === this.phoneActive && !force) return;
    this.phoneActive = phone;
    if (phone && !p.def.mobile) p.def.mobile = autoMobileLayout(p.def);
    this.applyPageLayout(p);
    for (const host of p.hosts.values()) host.relayout();
    if (this.editor) {
      for (const host of p.hosts.values()) this.editor.decorate(host.id, host.el);
      this.editor.paintGrid();
    }
    this.schedule();
  }

  /** Phone position of a visual on the current page (`null` = hidden on phones), or undefined for desktop. */
  layoutFor(visualId: string): VisualLayout | null | undefined {
    if (!this.phoneActive) return undefined;
    const m = this.page?.def.mobile;
    if (!m) return undefined;
    return m.visuals.find((v) => v.id === visualId)?.layout ?? null;
  }

  /** Generate (or regenerate) the phone layout of a page from its desktop layout: visuals stacked in reading order. */
  autoMobileLayout(pageIdOrName?: string): MobileLayout {
    const p = pageIdOrName ? this.pages[this.pageIndex(pageIdOrName)] : this.page;
    if (!p) throw new Error(`Page "${pageIdOrName}" not found`);
    p.def.mobile = autoMobileLayout(p.def);
    this.refreshLayoutMode(true);
    this.changedDefinition('mobileLayout');
    return p.def.mobile;
  }

  /** Show or hide a visual on phones (it is appended at the bottom when shown). */
  setMobileVisibility(visualId: string, visible: boolean, pageIdOrName?: string): void {
    const p = pageIdOrName ? this.pages[this.pageIndex(pageIdOrName)] : this.page;
    if (!p) return;
    const m = (p.def.mobile ??= autoMobileLayout(p.def));
    const i = m.visuals.findIndex((v) => v.id === visualId);
    if (!visible && i >= 0) m.visuals.splice(i, 1);
    if (visible && i < 0) {
      const y = Math.max(0, ...m.visuals.map((v) => v.layout.y + v.layout.h));
      const spec = p.def.visuals.find((v) => v.id === visualId);
      m.visuals.push({ id: visualId, layout: { x: 0, y, w: m.columns ?? 4, h: phoneHeight(spec) } });
    }
    this.refreshLayoutMode(true);
    this.changedDefinition('mobileLayout');
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
    const out: FilterSpec[] = [...this.reportFilters, ...(page.def.filters ?? []), ...(page.drillState?.filters ?? []), ...(spec.filters ?? [])];
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
    const apply = (pg: PageState, id: string) => {
      if (filters && filters.length) pg.slicers.set(id, filters);
      else pg.slicers.delete(id);
    };
    apply(page, visualId);
    // slicers in the same sync group (on any page) share one selection
    const group = (this.findVisual(visualId)!.spec.format?.slicer as { syncGroup?: string } | undefined)?.syncGroup;
    if (group)
      for (const pg of this.pages)
        for (const v of pg.def.visuals)
          if (v.id !== visualId && (v.format?.slicer as { syncGroup?: string } | undefined)?.syncGroup === group) apply(pg, v.id!);
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

  /** Edit-mode selection (the active visual plus any added with Ctrl/Shift-click, and group members). */
  private selection: string[] = [];

  /** Ids of the visuals selected in edit mode (the active one first). */
  get selectedVisuals(): string[] {
    return [...this.selection];
  }

  /** A visual and the other members of its group. */
  private groupOf(id: string): string[] {
    const found = this.findVisual(id);
    const g = found?.spec.group;
    if (!found || !g) return [id];
    return [id, ...found.page.def.visuals.filter((v) => v.group === g && v.id !== id).map((v) => v.id!)];
  }

  /** Add or remove a visual (and its group) from the edit selection, as Ctrl/Shift-click does. */
  toggleVisualSelection(visualId: string): void {
    const ids = this.groupOf(visualId);
    if (this.selection.includes(visualId)) this.selection = this.selection.filter((x) => !ids.includes(x));
    else this.selection = [...this.selection.filter((x) => !ids.includes(x)), ...ids];
    this.active = this.selection.includes(visualId) ? visualId : (this.selection[0] ?? null);
    this.markActive();
    this.emit('visualSelected', { visualId: this.active });
  }

  /** Select exactly these visuals (the first becomes active). */
  selectVisuals(ids: string[]): void {
    this.selection = [...new Set(ids.flatMap((id) => this.groupOf(id)))];
    this.active = this.selection[0] ?? null;
    this.markActive();
    this.emit('visualSelected', { visualId: this.active });
  }

  private markActive(): void {
    for (const host of this.page.hosts.values()) host.el.classList.toggle('is-active', this.selection.includes(host.id));
    this.editor?.markSelection();
    this.renderPane();
    this.renderInteractionOverlays();
  }

  setActiveVisual(visualId: string | null): void {
    const sel = visualId ? this.groupOf(visualId) : [];
    if (this.active === visualId && sel.length === this.selection.length && sel.every((x) => this.selection.includes(x))) return;
    this.selection = sel;
    this.active = visualId;
    for (const host of this.page.hosts.values()) host.el.classList.toggle('is-active', this.selection.includes(host.id));
    this.editor?.markSelection();
    this.renderPane();
    this.renderInteractionOverlays();
    this.emit('visualSelected', { visualId });
  }

  /** The active (selected) visual on the current page. */
  get selectedVisual(): string | null {
    return this.active;
  }

  // ================================================================= edit mode

  /** Design mode: select, drag and resize visuals on the grid (visual content is not interactive). */
  setEditMode(on: boolean): void {
    if (on === !!this.editor) return;
    if (on) {
      this.editor = new EditController({
        page: () => this.editPageInfo(),
        select: (id) => this.setActiveVisual(id),
        selected: () => this.active,
        commitLayout: (id, layout) => (this.phoneActive && this.page.def.mobile ? this.setMobileLayout(id, layout) : this.updateVisual(id, { layout })),
        commitLayouts: (updates) => this.commitLayouts(updates),
        selection: () => this.selectedVisuals,
        toggle: (id) => this.toggleVisualSelection(id),
      });
      this.root.classList.add('is-editing');
      for (const p of this.pages) for (const host of p.hosts.values()) this.editor.decorate(host.id, host.el);
      this.editor.paintGrid();
    } else {
      for (const p of this.pages) for (const host of p.hosts.values()) this.editor!.undecorate(host.el);
      this.editor = null;
      this.root.classList.remove('is-editing');
    }
    this.schedule();
  }

  get editMode(): boolean {
    return !!this.editor;
  }

  private editPageInfo() {
    const p = this.page;
    if (!p?.el) return null;
    const l = p.def.layout ?? {};
    if (this.phoneActive && p.def.mobile) {
      const m = p.def.mobile;
      const specs = m.visuals.map((mv) => ({ ...(p.def.visuals.find((v) => v.id === mv.id) as VisualSpec), layout: mv.layout })).filter((v) => v.type);
      return { el: p.el, cols: m.columns ?? 4, rowHeight: m.rowHeight ?? l.rowHeight ?? 44, gap: l.gap ?? 12, visuals: new Map([...p.hosts].filter(([id]) => m.visuals.some((v) => v.id === id)).map(([id, hst]) => [id, hst.el])), specs };
    }
    return { el: p.el, cols: l.columns ?? 12, rowHeight: l.rowHeight ?? 44, gap: l.gap ?? 12, visuals: new Map([...p.hosts].map(([id, hst]) => [id, hst.el])), specs: p.def.visuals };
  }

  /** Merged format (defaults ← theme ← spec) of a visual, as the format pane shows it. */
  visualFormat(id: string): VisualFormat {
    const found = this.findVisual(id);
    if (!found) throw new Error(`Visual "${id}" not found`);
    const host = found.page.hosts.get(id) ?? new VisualHost(this, found.spec);
    const f = host.format();
    if (!found.page.hosts.has(id)) host.destroy();
    return f;
  }

  /** Grid position where a w×h visual fits on a page. */
  findFreeSpot(w: number, h: number, pageId?: string): { x: number; y: number } {
    const p = pageId ? this.pages[this.pageIndex(pageId)] : this.page;
    return findFreeSpot(p.def.visuals, p.def.layout?.columns ?? 12, w, h);
  }

  /** Copy a visual (offset into free space). Returns the new id. */
  duplicateVisual(id: string): string {
    const found = this.findVisual(id);
    if (!found) throw new Error(`Visual "${id}" not found`);
    const copy = JSON.parse(JSON.stringify(toPlain(found.spec)), reviveDates) as VisualSpec;
    delete copy.id;
    const l = copy.layout ?? { x: 0, y: 0, w: 4, h: 6 };
    copy.layout = { ...l, ...findFreeSpot(found.page.def.visuals, found.page.def.layout?.columns ?? 12, l.w, l.h) };
    return this.addVisual(copy, found.page.def.id);
  }

  /** Bring a visual to the front or send it to the back (layout.z). */
  arrange(id: string, where: 'front' | 'back' | 'forward' | 'backward'): void {
    const found = this.findVisual(id);
    if (!found) return;
    const zs = found.page.def.visuals.map((v) => v.layout?.z ?? 0);
    const l = found.spec.layout ?? { x: 0, y: 0, w: 4, h: 6 };
    const cur = l.z ?? 0;
    const z = where === 'front' ? Math.max(0, ...zs) + 1 : where === 'back' ? Math.min(0, ...zs) - 1 : where === 'forward' ? cur + 1 : cur - 1;
    this.updateVisual(id, { layout: { ...l, z } });
  }

  /** Layout of a visual in the layout being shown (phone or desktop). */
  layoutOf(id: string): VisualLayout {
    const phone = this.layoutFor(id);
    return { ...(phone ?? this.findVisual(id)?.spec.layout ?? { x: 0, y: 0, w: 4, h: 6 }) };
  }

  /** Apply several layout changes as one edit (one undo step), in the layout being shown. */
  commitLayouts(updates: { id: string; layout: VisualLayout }[]): void {
    if (!updates.length) return;
    this.suppressChanges++;
    try {
      for (const u of updates) {
        if (this.phoneActive && this.page.def.mobile) this.setMobileLayout(u.id, u.layout);
        else this.updateVisual(u.id, { layout: u.layout });
      }
    } finally {
      this.suppressChanges--;
    }
    this.changedDefinition('layout');
  }

  /** Align visuals (default: the edit selection) to their shared bounding box. */
  alignVisuals(how: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom', ids = this.selectedVisuals): void {
    if (ids.length < 2) return;
    const ls = ids.map((id) => ({ id, l: this.layoutOf(id) }));
    const minX = Math.min(...ls.map((v) => v.l.x));
    const maxX = Math.max(...ls.map((v) => v.l.x + v.l.w));
    const minY = Math.min(...ls.map((v) => v.l.y));
    const maxY = Math.max(...ls.map((v) => v.l.y + v.l.h));
    this.commitLayouts(
      ls.map(({ id, l }) => {
        const n = { ...l };
        if (how === 'left') n.x = minX;
        if (how === 'right') n.x = maxX - l.w;
        if (how === 'center') n.x = Math.max(0, Math.round((minX + maxX) / 2 - l.w / 2));
        if (how === 'top') n.y = minY;
        if (how === 'bottom') n.y = maxY - l.h;
        if (how === 'middle') n.y = Math.max(0, Math.round((minY + maxY) / 2 - l.h / 2));
        return { id, layout: n };
      }),
    );
  }

  /** Spread visuals (default: the selection, at least three) with equal gaps across their bounding box. */
  distributeVisuals(axis: 'horizontal' | 'vertical', ids = this.selectedVisuals): void {
    if (ids.length < 3) return;
    const h = axis === 'horizontal';
    const ls = ids.map((id) => ({ id, l: this.layoutOf(id) })).sort((a, b) => (h ? a.l.x - b.l.x : a.l.y - b.l.y));
    const start = h ? ls[0].l.x : ls[0].l.y;
    const end = Math.max(...ls.map((v) => (h ? v.l.x + v.l.w : v.l.y + v.l.h)));
    const total = ls.reduce((s, v) => s + (h ? v.l.w : v.l.h), 0);
    const gap = Math.max(0, (end - start - total) / (ls.length - 1));
    let pos = start;
    this.commitLayouts(
      ls.map(({ id, l }) => {
        const n = { ...l };
        if (h) n.x = Math.round(pos);
        else n.y = Math.round(pos);
        pos += (h ? l.w : l.h) + gap;
        return { id, layout: n };
      }),
    );
  }

  /** Group visuals (default: the selection) so they select and move together. Returns the group id. */
  groupVisuals(ids = this.selectedVisuals): string | null {
    if (ids.length < 2) return null;
    const g = `group-${Math.random().toString(36).slice(2, 8)}`;
    this.suppressChanges++;
    try {
      for (const id of ids) this.updateVisual(id, { group: g });
    } finally {
      this.suppressChanges--;
    }
    this.changedDefinition('group');
    return g;
  }

  /** Remove visuals (default: the selection) from their groups. */
  ungroupVisuals(ids = this.selectedVisuals): void {
    this.suppressChanges++;
    try {
      for (const id of ids) if (this.findVisual(id)?.spec.group) this.updateVisual(id, { group: undefined });
    } finally {
      this.suppressChanges--;
    }
    this.changedDefinition('ungroup');
  }

  toggleFocus(visualId: string): void {
    const host = this.page.hosts.get(visualId);
    if (!host) return;
    this._focused = this._focused === visualId ? null : visualId;
    for (const hst of this.page.hosts.values()) hst.el.classList.toggle('is-focus', hst.id === this._focused);
    this.layoutFocus();
    this.schedule(visualId);
  }

  /** Pin the focused visual to the visible page area (not the whole scrollable page). */
  private layoutFocus(): void {
    const focused = this._focused ? this.page.hosts.get(this._focused) : undefined;
    this.pageScroll.classList.toggle('is-focusing', !!focused);
    for (const hst of this.page.hosts.values()) {
      if (hst === focused) continue;
      for (const k of ['position', 'left', 'top', 'width', 'height']) hst.el.style.removeProperty(k);
    }
    if (!focused) return;
    const r = this.pageScroll.getBoundingClientRect();
    if (!r.width || !r.height) return; // not laid out (e.g. jsdom): CSS absolute fallback applies
    const gap = this.page.def.layout?.gap ?? 12;
    const st = focused.el.style;
    st.position = 'fixed';
    st.left = `${r.left + gap}px`;
    st.top = `${r.top + gap}px`;
    st.width = `${Math.max(0, r.width - gap * 2)}px`;
    st.height = `${Math.max(0, r.height - gap * 2)}px`;
  }

  slicerTuples(visualId: string, columns: string[]): CellValue[][] {
    const filters = this.filtersFor(visualId).filter((f) => f.op !== 'topN');
    return this.model.query({ groupBy: columns, values: [], filters }).rows.map((r) => r.keys);
  }

  menu(x: number, y: number, items: MenuItem[]): void {
    this.tooltip.hide();
    this.ctxMenu.show(x, y, items);
  }

  /** Right-click menu for a data point: Include / Exclude / Drill through. */
  showContextMenu(visualId: string, identity: DataPointIdentity, evt: MouseEvent): void {
    const found = this.findVisual(visualId);
    if (!found) return;
    const items: MenuItem[] = [];
    const def = getVisual(found.spec.type);
    if (!def.isSlicer && identity.columns.length) {
      items.push({ label: 'Include', hint: 'keep only this', onClick: () => this.setVisualFilters(visualId, [...(found.spec.filters ?? []), identityFilter(identity, false)]) });
      items.push({ label: 'Exclude', hint: 'remove this', onClick: () => this.setVisualFilters(visualId, [...(found.spec.filters ?? []), identityFilter(identity, true)]) });
    }
    const targets = this.pages.filter((p) => p !== found.page && p.def.drillthrough?.fields.some((f) => identity.columns.some((c) => sameRef(c, f))));
    targets.forEach((p, i) => items.push({ label: `Drill through: ${this.translate('page', p.def.id!, p.def.name)}`, separator: i === 0 && items.length > 0, onClick: () => this.drillThrough(p.def.id!, identity, visualId) }));
    for (const provider of menuProviders()) {
      let extra: MenuItem[] = [];
      try {
        extra = provider({ report: this, visualId, spec: found.spec, identity, filters: this.filtersFor(visualId), event: evt });
      } catch (error) {
        this.emit('error', { visualId, error: error as Error });
      }
      extra.forEach((it, i) => items.push(i === 0 && items.length ? { ...it, separator: true } : it));
    }
    if (found.page.selection) items.push({ label: 'Clear selection', separator: true, onClick: () => this.clearSelection() });
    if (found.spec.filters?.length) items.push({ label: 'Clear visual filters', onClick: () => this.setVisualFilters(visualId, []) });
    this.menu(evt.clientX, evt.clientY, items);
  }

  /**
   * Navigate to a drill-through page, filtered to the data point (or to explicit filters).
   * The target page shows a Back button.
   */
  drillThrough(pageIdOrName: string, target: DataPointIdentity | FilterSpec[], sourceVisualId?: string): void {
    const ti = this.pageIndex(pageIdOrName);
    if (ti < 0) throw new Error(`Page "${pageIdOrName}" not found`);
    const page = this.pages[ti];
    const dt = page.def.drillthrough;
    let filters: FilterSpec[];
    if (Array.isArray(target)) filters = target;
    else {
      filters = [];
      const fields = dt?.fields ?? target.columns.map((c) => `'${c.table}'[${c.column}]`);
      for (const f of fields) {
        const k = target.columns.findIndex((c) => sameRef(c, f));
        if (k >= 0) filters.push({ target: f, op: 'eq', value: target.values[k] });
      }
    }
    if (sourceVisualId && dt?.keepAllFilters !== false) {
      // carry the source context, minus report filters (already everywhere) and anything on the drill fields
      const onDrillField = (f: FilterSpec) => f.op !== 'tuples' && filters.some((d) => d.op !== 'tuples' && sameRef(d.target, f.target));
      const carried = this.filtersFor(sourceVisualId).filter((f) => !this.reportFilters.includes(f) && !onDrillField(f));
      filters = [...carried, ...filters];
    }
    const from = this.current;
    page.drillState = { filters, from };
    for (const host of page.hosts.values()) host.invalidate();
    if (ti !== this.current) this.showPage(ti);
    else this.schedule();
    this.emit('drillThrough', { fromPageId: this.pages[from].def.id!, toPageId: page.def.id!, visualId: sourceVisualId, filters });
  }

  /** Leave a drill-through page and return to where it was opened from. */
  back(): void {
    const p = this.page;
    if (!p.drillState) return;
    const from = p.drillState.from;
    p.drillState = null;
    for (const host of p.hosts.values()) host.invalidate();
    this.showPage(Math.min(from, this.pages.length - 1));
  }

  // ---------------------------------------------------------------- report tooltips

  private tooltipKey = '';

  /** Render a tooltip page inside the tooltip, filtered to the hovered data point (+ the source visual's filters). */
  showReportTooltip(pageIdOrName: string, identity: DataPointIdentity, sourceVisualId: string, evt: { clientX: number; clientY: number }): void {
    const ti = this.pageIndex(pageIdOrName);
    if (ti < 0) return;
    const page = this.pages[ti];
    const key = JSON.stringify([page.def.id, identity.columns, identity.values.map(valueKey)]);
    const size = page.def.tooltip ?? {};
    const width = size.width ?? 320;
    const height = size.height ?? 220;
    if (key === this.tooltipKey && page.el && this.tooltip.isShowingElement(page.el)) return this.tooltip.move(evt);
    this.tooltipKey = key;
    const pointFilters: FilterSpec[] = identity.columns.map((c, i) => ({ target: c, op: 'eq', value: identity.values[i] }));
    const carried = this.filtersFor(sourceVisualId).filter((f) => !this.reportFilters.includes(f) && !(f.op !== 'tuples' && f.op !== 'topN' && pointFilters.some((d) => d.op === 'eq' && sameRef(d.target, f.target))));
    page.drillState = { filters: [...carried, ...pointFilters], from: this.current };
    if (!page.el) this.mountPage(page, this.root);
    this.applyPageLayout(page);
    const el = page.el!;
    el.hidden = false;
    el.classList.add('pbi-tooltip-page');
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    this.tooltip.showElement(el, evt);
    for (const host of page.hosts.values()) {
      host.invalidate();
      host.render();
    }
    this.tooltip.move(evt);
  }

  // ---------------------------------------------------------------- edit interactions

  private editingInteractions = false;

  /** Toggle "edit interactions": select a visual, then choose how every other visual reacts to it. */
  toggleEditInteractions(on = !this.editingInteractions): void {
    this.editingInteractions = on;
    this.renderToolbar();
    this.renderInteractionOverlays();
  }

  /** Set how `targetId` reacts to selections in `sourceId`. */
  setInteraction(sourceId: string, targetId: string, mode: 'filter' | 'highlight' | 'none'): void {
    const target = this.findVisual(targetId);
    if (!target) throw new Error(`Visual "${targetId}" not found`);
    target.spec.interactionsFrom = { ...(target.spec.interactionsFrom ?? {}), [sourceId]: mode };
    target.page.hosts.get(targetId)?.invalidate();
    this.schedule(targetId);
    this.renderInteractionOverlays();
    this.changedDefinition('interaction');
  }

  private renderInteractionOverlays(): void {
    for (const p of this.pages) for (const host of p.hosts.values()) host.el.querySelector(':scope > .pbi-ei')?.remove();
    if (!this.editingInteractions || !this.active) return;
    const source = this.page.def.visuals.find((v) => v.id === this.active);
    if (!source || getVisual(source.type).static) return;
    for (const host of this.page.hosts.values()) {
      if (host.id === this.active) continue;
      const def = host.definition;
      if (def.static) continue;
      const current = this.interactionMode(host.spec, this.active);
      const bar = h('div', { class: 'pbi-ei', role: 'group', 'aria-label': `How this visual reacts to ${source.title ?? source.type}` });
      const modes: ('filter' | 'highlight' | 'none')[] = def.supportsHighlight ? ['filter', 'highlight', 'none'] : ['filter', 'none'];
      for (const m of modes) {
        const b = h('button', { type: 'button', 'aria-pressed': String(current === m), title: m[0].toUpperCase() + m.slice(1) }, m === 'filter' ? 'Filter' : m === 'highlight' ? 'Highlight' : 'None');
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this.setInteraction(this.active!, host.id, m);
        });
        bar.append(b);
      }
      host.el.append(bar);
    }
  }

  // ---------------------------------------------------------------- PDF export

  /** Export the current page (or every visible page) as a PDF, one page per report page. */
  async exportPdf(opts: { pages?: 'current' | 'all'; filename?: string } = {}): Promise<void> {
    const { elementToSvg, svgToCanvas, download } = await import('./snapshot');
    const { buildPdf, dataUrlToBytes } = await import('./pdf');
    const start = this.current;
    const targets = opts.pages === 'all' ? this.pages.map((_, i) => i).filter((i) => !this.pages[i].def.hidden && !this.pages[i].def.tooltip) : [start];
    const out = [];
    for (const i of targets) {
      if (i !== this.current) this.showPage(i, false);
      this.flush();
      const el = this.page.el!;
      const w = Math.max(1, el.scrollWidth || el.offsetWidth || 1200);
      const hh = Math.max(1, el.scrollHeight || el.offsetHeight || 800);
      const svg = elementToSvg(el, this._theme, w, hh);
      const canvas = await svgToCanvas(svg, this._theme.background, 2);
      out.push({ jpeg: dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.92)), pixelWidth: canvas.width, pixelHeight: canvas.height, width: w, height: hh });
    }
    if (this.current !== start) this.showPage(start, false);
    const pdf = buildPdf(out, this.name);
    download(new Blob([pdf], { type: 'application/pdf' }), opts.filename ?? `${this.name.replace(/[^\w-]+/g, '_')}.pdf`);
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
    if (this.onUsage) this.trackUsage(String(event), payload as Record<string, unknown>);
  }

  private trackUsage(event: string, p: Record<string, unknown>): void {
    const visualId = p.visualId as string | undefined;
    if (event === 'pageChanged') this.usage('pageView');
    else if (event === 'selectionChanged') this.usage('interaction', 'select', visualId, { filters: p.filters });
    else if (event === 'drill') this.usage('interaction', 'drill', visualId, { level: p.level, path: p.path });
    else if (event === 'drillThrough') this.usage('interaction', 'drillThrough', visualId, { from: p.fromPageId, filters: p.filters });
    else if (event === 'filtersChanged') this.usage('interaction', 'filter', visualId, { scope: p.scope, filters: p.filters });
    else if (event === 'bookmarkApplied') this.usage('interaction', 'bookmark', undefined, { name: p.name });
  }

  private usage(type: UsageEvent['type'], action?: UsageEvent['action'], visualId?: string, detail?: Record<string, unknown>): void {
    if (!this.onUsage || !this.page) return;
    const e: UsageEvent = { type, report: this.name, pageId: this.page.def.id!, page: this.page.def.name, at: Date.now() };
    if (action) e.action = action;
    if (visualId) e.visualId = visualId;
    if (detail) e.detail = detail;
    try {
      this.onUsage(e);
    } catch (error) {
      console.error('onUsage handler failed', error);
    }
  }

  /** Whether a visual's `visibleWhen` condition holds (always true in edit mode, so authors can see it). */
  isVisualVisible(visualId: string): boolean {
    const found = this.findVisual(visualId);
    const cond = found?.spec.visibleWhen;
    if (!cond || this.editor) return true;
    if (cond.roles?.length && !this.model.activeRoleNames.some((r) => cond.roles!.includes(r))) return false;
    if (!cond.field) return true;
    const field = cond.field;
    let filtered = false;
    const values: CellValue[] = [];
    let known = true;
    for (const f of this.filtersFor(visualId)) {
      if (f.op === 'tuples') {
        const i = f.targets.findIndex((t) => sameRef(t, field));
        if (i < 0) continue;
        filtered = true;
        if (f.exclude) known = false;
        else values.push(...f.tuples.map((t) => t[i]));
      } else if (f.op !== 'topN' && sameRef(f.target, field)) {
        filtered = true;
        if (f.op === 'eq') values.push(f.value ?? null);
        else if (f.op === 'in') values.push(...(f.values ?? []));
        else known = false;
      }
    }
    const is = cond.is ?? 'selected';
    if (is === 'selected') return filtered;
    if (is === 'notSelected') return !filtered;
    if (!filtered || !known) return false;
    const want = new Set(is.map(valueKey));
    return values.some((v) => want.has(valueKey(v)));
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
    raf(() => this.flush(true));
  }

  /**
   * Render everything pending right now (useful in tests, exports and SSR snapshots). Scheduled renders pass
   * `visibleOnly`, which skips visuals scrolled well out of view until they come back.
   */
  flush(visibleOnly = false): void {
    this.frame = false;
    if (this.destroyed) return;
    const hosts = this.page.hosts;
    const ids = this.pendingAll ? [...hosts.keys()] : [...this.pending];
    this.pending.clear();
    this.pendingAll = false;
    if (!visibleOnly) {
      for (const id of this.deferred) if (!ids.includes(id)) ids.push(id);
      this.deferred.clear();
    }
    for (const id of ids) {
      const host = hosts.get(id);
      if (!host) continue;
      if (visibleOnly && !this.isOnScreen(host.el)) {
        this.deferred.add(id);
        continue;
      }
      this.deferred.delete(id);
      host.render();
    }
  }

  /** Is a visual on (or near) the screen? Unknown and unmeasurable elements count as visible. */
  private isOnScreen(el: HTMLElement): boolean {
    if (typeof IntersectionObserver === 'undefined') return true;
    if (!this.io) {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            this.onScreen.set(e.target, e.isIntersecting);
            const id = (e.target as HTMLElement).dataset.visualId;
            if (e.isIntersecting && id && this.deferred.has(id) && this.page.hosts.get(id)?.el === e.target) this.schedule(id);
          }
        },
        { rootMargin: `${LAZY_MARGIN}px` },
      );
    }
    const known = this.onScreen.get(el);
    if (known !== undefined) return known;
    this.io.observe(el);
    // first sighting: measure now (the observer reports asynchronously)
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return true;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (!vw || !vh) return true;
    const visible = r.bottom >= -LAZY_MARGIN && r.top <= vh + LAZY_MARGIN && r.right >= -LAZY_MARGIN && r.left <= vw + LAZY_MARGIN;
    this.onScreen.set(el, visible);
    return visible;
  }

  // ================================================================= pages

  private pageIndex(idOrName: string): number {
    return this.pages.findIndex((p) => p.def.id === idOrName || p.def.name === idOrName);
  }

  addPage(def: PageDefinition, show = true): string {
    const d: PageDefinition = { ...def, id: def.id ?? uid('page'), visuals: def.visuals.map((v) => ({ ...v, id: v.id ?? uid('visual') })) };
    this.pages.push({ def: d, el: null, hosts: new Map(), slicers: new Map(), selection: null, drillState: null });
    this.renderTabs();
    if (show) this.showPage(this.pages.length - 1);
    this.changedDefinition('addPage');
    return d.id!;
  }

  /** Change a page's name, layout, background, visibility, drill-through or tooltip settings. */
  updatePage(idOrName: string, patch: Partial<Omit<PageDefinition, 'id' | 'visuals'>>): void {
    const p = this.pages[this.pageIndex(idOrName)];
    if (!p) throw new Error(`Page "${idOrName}" not found`);
    Object.assign(p.def, patch);
    if (p.el) {
      this.applyPageLayout(p);
      p.el.setAttribute('aria-label', this.translate('page', p.def.id!, p.def.name));
      for (const host of p.hosts.values()) host.invalidate();
      this.editor?.paintGrid();
    }
    this.renderTabs();
    this.schedule();
    this.changedDefinition('updatePage');
  }

  /** Move a page to a new position in the tab order. */
  movePage(idOrName: string, toIndex: number): void {
    const i = this.pageIndex(idOrName);
    if (i < 0) return;
    const currentId = this.page.def.id;
    const [p] = this.pages.splice(i, 1);
    this.pages.splice(Math.max(0, Math.min(this.pages.length, toIndex)), 0, p);
    this.current = this.pages.findIndex((x) => x.def.id === currentId);
    this.renderTabs();
    this.changedDefinition('movePage');
  }

  /** Copy a page with all its visuals. Returns the new page id. */
  duplicatePage(idOrName: string): string {
    const p = this.pages[this.pageIndex(idOrName)];
    if (!p) throw new Error(`Page "${idOrName}" not found`);
    const copy = JSON.parse(JSON.stringify(toPlain(p.def)), reviveDates) as PageDefinition;
    delete copy.id;
    copy.name = `${p.def.name} (copy)`;
    copy.visuals = copy.visuals.map(({ id: _id, ...v }) => v);
    const id = this.addPage(copy, false);
    this.movePage(id, this.pageIndex(p.def.id!) + 1);
    return id;
  }

  /** Replace the whole definition (used by undo/redo and "open report"). Theme and listeners are kept. */
  load(input: ReportDefinition | string): void {
    const def = migrateReport(input, reviveDates);
    const keepPage = this.page?.def.id;
    for (const p of this.pages) {
      for (const host of p.hosts.values()) host.destroy();
      p.el?.remove();
    }
    this.pages = [];
    this.active = null;
    this._focused = null;
    this.name = def.name ?? this.name;
    this.reportFilters = def.filters ?? [];
    this.bookmarks = def.bookmarks ?? [];
    if (def.translations) this.translations = def.translations;
    this.subscriptions = def.subscriptions ?? [];
    this.alerts = def.alerts ?? [];
    for (const p of def.pages) this.addPage(p, false);
    if (!this.pages.length) this.addPage({ name: 'Page 1', visuals: [] }, false);
    const idx = keepPage ? this.pageIndex(keepPage) : -1;
    this.showPage(idx >= 0 ? idx : 0, false);
    this.emit('visualSelected', { visualId: null });
  }

  private suppressChanges = 0;

  /** Notify listeners (studio history, autosave) that the definition changed. */
  private changedDefinition(reason: string): void {
    if (this.suppressChanges) return;
    this.emit('definitionChanged', { reason });
  }

  removePage(idOrName: string): void {
    const i = this.pageIndex(idOrName);
    if (i < 0) return;
    const [p] = this.pages.splice(i, 1);
    for (const host of p.hosts.values()) host.destroy();
    p.el?.remove();
    if (!this.pages.length) this.addPage({ name: 'Page 1', visuals: [] }, false);
    this.showPage(Math.min(this.current, this.pages.length - 1), false);
    this.changedDefinition('removePage');
  }

  goToPage(idOrName: string): void {
    const i = this.pageIndex(idOrName);
    if (i < 0) throw new Error(`Page "${idOrName}" not found`);
    this.showPage(i);
  }

  get currentPage(): { id: string; name: string } {
    return { id: this.page.def.id!, name: this.page.def.name };
  }

  /** Report-level filters (a copy). */
  get reportFilterList(): FilterSpec[] {
    return [...this.reportFilters];
  }

  /** The cross-filter selection on the current page, if any. */
  get currentSelection(): { visualId: string; identities: DataPointIdentity[] } | null {
    return this.page.selection ? { visualId: this.page.selection.visualId, identities: [...this.page.selection.identities] } : null;
  }

  /** The definition object of a page (current page by default). Change it through updatePage(). */
  pageDefinition(idOrName?: string): PageDefinition {
    const p = idOrName ? this.pages[this.pageIndex(idOrName)] : this.page;
    if (!p) throw new Error(`Page "${idOrName}" not found`);
    return p.def;
  }

  get pageList(): { id: string; name: string; hidden: boolean }[] {
    return this.pages.map((p) => ({ id: p.def.id!, name: p.def.name, hidden: !!p.def.hidden }));
  }

  private showPage(i: number, emit = true): void {
    if (this.page?.el) this.page.el.hidden = true;
    if (this._focused) {
      this._focused = null;
      for (const hst of this.page.hosts.values()) hst.el.classList.remove('is-focus');
      this.layoutFocus();
    }
    this.active = null;
    this.current = i;
    const p = this.page;
    if (!p.el) this.mountPage(p, this.pageScroll);
    else if (p.el.parentElement !== this.pageScroll) this.pageScroll.append(p.el);
    this.applyPageLayout(p);
    p.el!.hidden = false;
    this.editor?.paintGrid();
    this.renderTabs();
    this.renderToolbar();
    this.renderPane();
    this.schedule();
    if (emit) this.emit('pageChanged', { pageId: p.def.id!, name: p.def.name });
    this.refreshLayoutMode(true);
  }

  private mountPage(p: PageState, parent: HTMLElement): void {
    p.el = h('div', { class: 'pbi-page', role: 'tabpanel', 'aria-label': this.translate('page', p.def.id!, p.def.name) });
    p.el.addEventListener('pointerdown', (e) => {
      if (this.editor && e.target === p.el) this.setActiveVisual(null);
    });
    parent.append(p.el);
    for (const spec of p.def.visuals) this.mountVisual(p, spec);
  }

  private applyPageLayout(p: PageState): void {
    const l = p.def.layout ?? {};
    const phone = this.phoneActive && p === this.page && !!p.def.mobile;
    p.el!.classList.toggle('is-mobile', phone);
    p.el!.style.setProperty('--pbi-cols', String(phone ? (p.def.mobile!.columns ?? 4) : (l.columns ?? 12)));
    p.el!.style.setProperty('--pbi-row', `${phone ? (p.def.mobile!.rowHeight ?? l.rowHeight ?? 44) : (l.rowHeight ?? 44)}px`);
    p.el!.style.setProperty('--pbi-gap', `${l.gap ?? 12}px`);
    p.el!.style.background = p.def.background ?? '';
  }

  private mountVisual(p: PageState, spec: VisualSpec): VisualHost {
    const host = new VisualHost(this, spec);
    p.hosts.set(host.id, host);
    p.el!.append(host.el);
    this.editor?.decorate(host.id, host.el);
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
    this.changedDefinition('addVisual');
    return s.id;
  }

  /** Move or resize a visual in the current page's phone layout. */
  setMobileLayout(id: string, layout: VisualLayout): void {
    const p = this.page;
    const m = (p.def.mobile ??= autoMobileLayout(p.def));
    const entry = m.visuals.find((v) => v.id === id);
    if (entry) entry.layout = { ...layout };
    else m.visuals.push({ id, layout: { ...layout } });
    p.hosts.get(id)?.relayout();
    if (this.editor) {
      const host = p.hosts.get(id);
      if (host) this.editor.decorate(id, host.el);
    }
    this.schedule();
    this.changedDefinition('mobileLayout');
  }

  updateVisual(id: string, patch: Partial<VisualSpec>): void {
    const found = this.findVisual(id);
    if (!found) throw new Error(`Visual "${id}" not found`);
    Object.assign(found.spec, patch);
    const host = found.page.hosts.get(id);
    if (host) {
      host.update(found.spec);
      if (this.editor) this.editor.decorate(id, host.el);
      this.schedule();
    }
    this.changedDefinition('updateVisual');
  }

  removeVisual(id: string): void {
    const found = this.findVisual(id);
    if (!found) return;
    found.page.def.visuals = found.page.def.visuals.filter((v) => v.id !== id);
    found.page.hosts.get(id)?.destroy();
    found.page.hosts.delete(id);
    found.page.slicers.delete(id);
    if (found.page.selection?.visualId === id) found.page.selection = null;
    if (this.active === id) this.setActiveVisual(null);
    this.schedule();
    this.changedDefinition('removeVisual');
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
      describe: () => getHost().describe(),
      drillUp: () => getHost().drillUp(),
      drillDown: (v) => getHost().drillDown(v),
      expandAll: () => getHost().expandAll(),
      toSvg: () => getHost().toSvg(),
      exportImage: (type, name) => getHost().exportImage(type, name),
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
    this.changedDefinition('filters');
  }

  /** Clear slicers, selection, drill state and pane filters on the current page. */
  reset(): void {
    const p = this.page;
    p.slicers.clear();
    p.selection = null;
    for (const v of p.def.visuals) {
      v.drill = undefined;
      const host = p.hosts.get(v.id!);
      host?.resetState();
      host?.invalidate();
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
    if (p.drillState) {
      const ds = p.drillState;
      sections.push({
        scope: 'page' as const,
        title: 'Drill through',
        filters: ds.filters,
        set: (f: FilterSpec[]) => {
          ds.filters = f;
          for (const host of p.hosts.values()) host.invalidate();
          this.schedule();
          this.renderPane();
        },
      });
    }
    sections.push({ scope: 'page' as const, title: 'Filters on this page', filters: p.def.filters ?? [], set: (f: FilterSpec[]) => this.setPageFilters(p.def.id!, f) });
    sections.push({ scope: 'report' as const, title: 'Filters on all pages', filters: this.reportFilters, set: (f: FilterSpec[]) => this.setReportFilters(f) });
    this.pane.render(sections);
  }

  private renderToolbar(): void {
    this.toolbar.hidden = !this.chrome.toolbar;
    if (this.toolbar.hidden) return;
    this.toolbar.replaceChildren();
    const ds = this.page.drillState;
    if (ds) {
      const fromName = this.pages[ds.from]?.def.name ?? 'Back';
      const back = h('button', { type: 'button', class: 'pbi-btn pbi-back', 'aria-label': `Back to ${fromName}` }, `← ${fromName}`);
      back.addEventListener('click', (e) => {
        e.stopPropagation();
        this.back();
      });
      this.toolbar.append(back);
    }
    this.toolbar.append(h('div', { class: 'pbi-toolbar-title' }, this.name));
    const btn = (label: string, onClick: () => void, pressed?: boolean) => {
      const b = h('button', { type: 'button', class: 'pbi-btn', 'aria-pressed': pressed === undefined ? undefined : String(pressed) }, label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      this.toolbar.append(b);
    };
    btn('Reset', () => this.reset());
    btn('Edit interactions', () => this.toggleEditInteractions(), this.editingInteractions);
    btn('Export PDF', () => void this.exportPdf());
    if (this.chrome.filterPane) btn('Filters', () => this.toggleFilterPane(), this.paneOpen);
  }

  private renderTabs(): void {
    const visible = this.pages.filter((p) => !p.def.hidden && !p.def.tooltip);
    const show = this.chrome.pageTabs === true || (this.chrome.pageTabs === 'auto' && visible.length > 1);
    this.tabs.hidden = !show;
    if (!show) return;
    this.tabs.replaceChildren();
    this.pages.forEach((p, i) => {
      if (p.def.hidden || p.def.tooltip) return;
      // roving tabindex: Tab reaches the current page's tab, arrow keys move between tabs
      const b = h('button', { type: 'button', class: 'pbi-tab', role: 'tab', 'aria-selected': String(i === this.current), tabindex: i === this.current ? 0 : -1, 'data-page': p.def.id! }, this.translate('page', p.def.id!, p.def.name));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (i !== this.current) this.showPage(i);
      });
      b.addEventListener('keydown', (e) => {
        const tabs = [...this.tabs.querySelectorAll<HTMLButtonElement>('.pbi-tab')];
        const at = tabs.indexOf(b);
        const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (at + 1) % tabs.length : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
        if (to < 0) return;
        e.preventDefault();
        const id = tabs[to].dataset.page!;
        this.goToPage(id);
        this.tabs.querySelector<HTMLButtonElement>(`.pbi-tab[data-page="${id.replace(/"/g, '\\"')}"]`)?.focus();
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
    return toPlain({ version: REPORT_SCHEMA_VERSION, name: this.name, pages: this.pages.map((p) => p.def), filters: this.reportFilters, bookmarks: this.bookmarks, ...(Object.keys(this.translations).length ? { translations: this.translations } : {}), ...(this.subscriptions.length ? { subscriptions: this.subscriptions } : {}), ...(this.alerts.length ? { alerts: this.alerts } : {}) }) as ReportDefinition;
  }

  /** Parse a JSON string produced from {@link Report.toJSON}. */
  static parse(json: string): ReportDefinition {
    return migrateReport(json, reviveDates);
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
    this.offResize();
    this.io?.disconnect();
    for (const p of this.pages) for (const host of p.hosts.values()) host.destroy();
    this.tooltip.destroy();
    this.ctxMenu.destroy();
    this.root.remove();
  }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(toPlain(v)), reviveDates) as T;
}

function sameRef(a: ColumnRef | string, b: ColumnRef | string): boolean {
  const x = typeof a === 'string' ? parseColumnRef(a) : a;
  const y = typeof b === 'string' ? parseColumnRef(b) : b;
  return x.table === y.table && x.column === y.column;
}

/** Filter that keeps (or removes) exactly one data point. */
export function identityFilter(identity: DataPointIdentity, exclude: boolean): FilterSpec {
  if (identity.columns.length === 1) return { target: identity.columns[0], op: exclude ? 'notIn' : 'in', values: [identity.values[0]] };
  return { targets: identity.columns, op: 'tuples', tuples: [identity.values], exclude };
}
