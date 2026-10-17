import type { DataModel } from '../data/model';
import { schedulesDialog } from './schedules';
import { impactOf, renameModelField } from '../data/lineage';
import { transformDialog } from './transforms';
import type { TransformStep } from '../data/transform';
import type { MeasureDef, RelationshipDef } from '../data/types';
import { columnRefToString, parseColumnRef } from '../data/types';
import { h } from '../render/svg';
import { ContextMenu } from '../report/contextMenu';
import { FilterPane } from '../report/filterPane';
import { Report, reviveDates } from '../report/report';
import type { ReportDefinition } from '../report/report';
import { themeVars } from '../report/styles';
import { createTheme, darkTheme, lightTheme } from '../theme/theme';
import type { Theme } from '../theme/theme';
import { Emitter } from '../utils';
import type { DeepPartial } from '../utils';
import { getVisual } from '../visuals/registry';
import type { VisualSpec } from '../visuals/types';
import { assignField, autoVisualFor, defaultSize, retargetFields } from './assign';
import { autoReport } from './autoReport';
import type { StudioContext } from './context';
import { FIELD_MIME } from './context';
import type { CalcColumnDef } from './dialogs';
import { columnDialog, confirmDialog, measureDialog } from './dialogs';
import { renderFormat } from './formatPane';
import { History } from './history';
import { RAIL_ICONS } from './icons';
import { renderFields, renderVisualizations, renderWells } from './panes';
import { injectStudioStyles } from './styles';
import type { ModelViewState } from './views';
import { renderDataView, renderModelView } from './views';

/** Model changes made in the studio, relative to the model the studio was opened with. */
export interface StudioModelState {
  /** Measures added or edited in the studio. */
  measures: MeasureDef[];
  /** Original model measures deleted in the studio. */
  removedMeasures: string[];
  /** Calculated columns added in the studio. */
  columns: CalcColumnDef[];
  /** Relationships added in the studio. */
  relationships: RelationshipDef[];
  /** Original relationships deleted in the studio (by "from->to"). */
  removedRelationships: string[];
  /** Changes to original relationships. */
  relationshipEdits: { key: string; active: boolean; crossFilter: 'single' | 'both' }[];
  /** Power Query-style steps per table, added in the studio. */
  transforms?: Record<string, TransformStep[]>;
}

/** Everything the studio saves: the report, model changes, theme overrides and the diagram layout. */
export interface StudioDocument {
  version: 1;
  report: ReportDefinition;
  model: StudioModelState;
  theme?: Record<string, unknown>;
  diagram?: Record<string, { x: number; y: number }>;
}

export interface StudioOptions {
  model: DataModel;
  /** A saved document to open (takes precedence over storage). */
  document?: StudioDocument | string;
  /** Or just a report definition. */
  definition?: ReportDefinition;
  /** Autosave to localStorage under this key (and restore from it). */
  storageKey?: string;
  /** What a brand-new document starts with (default "auto": generated from the model). */
  starter?: 'auto' | 'blank';
  theme?: 'light' | 'dark' | DeepPartial<Theme>;
  locale?: string;
  /** Start in preview (view) mode. */
  preview?: boolean;
}

export interface StudioEvents {
  [key: string]: unknown;
  change: StudioDocument;
  selection: { visualId: string | null };
  save: StudioDocument;
}

type View = 'report' | 'data' | 'model';

const relKey = (from: string, to: string) => `${from}->${to}`;
const relRef = (t: string, c: string) => columnRefToString({ table: t, column: c });

/**
 * PrismBI Studio: a drag-and-drop report editor (fields, visualizations, build and format panes,
 * filters, pages, measures, model and data views, undo/redo, autosave).
 */
export class Studio implements StudioContext {
  readonly model: DataModel;
  readonly root: HTMLElement;
  readonly report!: Report;
  private emitter = new Emitter<StudioEvents>();
  // the diagram layout is saved with the document but moving tables is not an undo step
  private history = new History<StudioDocument>(200, (d) => JSON.stringify({ ...d, diagram: undefined }), (s) => JSON.parse(s, reviveDates) as StudioDocument);
  private baselineMeasureDefs = new Map<string, MeasureDef>();
  private baseline: { measures: Map<string, string>; columns: Set<string>; rels: Map<string, { active: boolean; crossFilter: 'single' | 'both' }> };
  private theme: Record<string, unknown> = {};
  private diagram: ModelViewState = { positions: {} };
  private view: View = 'report';
  private preview = false;
  private applying = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private clipboard: VisualSpec | null = null;
  private menu: ContextMenu;
  private filterPane: FilterPane;
  private openSections = new Set<string>(['general']);
  private fieldQuery = '';
  private showHidden = false;
  private rightTab: 'build' | 'format' | 'filters' = 'build';
  private dataState = { table: undefined as string | undefined, limit: 200 };
  private els: Record<string, HTMLElement> = {};
  private storageKey?: string;
  private dirty = false;
  private offs: (() => void)[] = [];

  constructor(
    readonly container: HTMLElement,
    opts: StudioOptions,
  ) {
    injectStudioStyles(container.ownerDocument);
    this.model = opts.model;
    this.storageKey = opts.storageKey;
    this.baseline = this.captureBaseline();
    this.root = h('div', { class: 'pbs', tabindex: -1 });
    this.menu = new ContextMenu(this.root);
    this.filterPane = new FilterPane(this.model, () => this.setRightTab('build'));
    this.buildShell();
    container.replaceChildren(this.root);

    // initial document: explicit > stored > definition > starter
    let doc: StudioDocument | null = null;
    if (opts.document) doc = typeof opts.document === 'string' ? (JSON.parse(opts.document, reviveDates) as StudioDocument) : opts.document;
    else if (this.storageKey) {
      try {
        const saved = localStorage.getItem(this.storageKey);
        if (saved) doc = JSON.parse(saved, reviveDates) as StudioDocument;
      } catch {
        /* storage unavailable */
      }
    }
    const definition: ReportDefinition = doc?.report ?? opts.definition ?? { name: 'New report', pages: [opts.starter === 'blank' || !this.model.tableNames().length ? { name: 'Page 1', visuals: [] } : autoReport(this.model)] };
    if (opts.theme) this.theme = typeof opts.theme === 'string' ? { mode: opts.theme } : (opts.theme as Record<string, unknown>);
    if (doc?.theme) this.theme = doc.theme;
    (this as { report: Report }).report = new Report(this.els.canvas, {
      model: this.model,
      ...definition,
      theme: this.resolvedTheme(),
      locale: opts.locale,
      chrome: { toolbar: false, pageTabs: false, filterPane: false },
    });
    if (doc) {
      this.applyModelState(doc.model);
      this.diagram.positions = doc.diagram ?? {};
    }
    this.applyThemeVars();
    this.report.setEditMode(!opts.preview);
    this.preview = !!opts.preview;
    this.root.classList.toggle('is-preview', this.preview);

    this.offs.push(
      this.report.on('definitionChanged', () => {
        if (this.applying) return;
        this.renderPages();
        this.scheduleCommit();
      }),
      this.report.on('visualSelected', () => this.syncArrange()),
      this.report.on('visualSelected', ({ visualId }) => {
        if (visualId && this.rightTab === 'filters') this.renderRight();
        this.refreshPanes(true);
        this.emitter.emit('selection', { visualId });
      }),
      this.report.on('pageChanged', () => {
        this.renderPages();
        this.refreshPanes(true);
      }),
    );
    this.history.reset(this.document);
    this.refreshAll();
  }

  // ================================================================= public API

  /** The current document (report + model changes + theme + diagram). */
  get document(): StudioDocument {
    return {
      version: 1,
      report: this.report.toJSON(),
      model: this.modelState(),
      theme: Object.keys(this.theme).length ? { ...this.theme } : undefined,
      diagram: Object.keys(this.diagram.positions).length ? { ...this.diagram.positions } : undefined,
    };
  }

  /** Open a saved document. */
  load(doc: StudioDocument | string): void {
    const d = typeof doc === 'string' ? (JSON.parse(doc, reviveDates) as StudioDocument) : doc;
    this.applyDocument(d, true);
    this.history.reset(this.document);
    this.markSaved(false);
  }

  on<K extends keyof StudioEvents>(event: K, fn: (payload: StudioEvents[K]) => void): () => void {
    return this.emitter.on(event, fn);
  }

  undo(): void {
    this.flushCommit();
    const d = this.history.undo();
    if (d) this.applyDocument(d);
  }

  redo(): void {
    this.flushCommit();
    const d = this.history.redo();
    if (d) this.applyDocument(d);
  }

  /** Replace the current document as one undo step (unlike `load`, history is kept). */
  restore(doc: StudioDocument | string): void {
    const d = typeof doc === 'string' ? (JSON.parse(doc, reviveDates) as StudioDocument) : doc;
    this.flushCommit();
    this.applyDocument(d);
    this.commit();
  }

  /** Add a button to the Studio top bar (after the status area); returns it. Used by add-ons such as the AI agent panel. */
  addToolbarButton(label: string, onClick: () => void, attrs: Record<string, string> = {}): HTMLButtonElement {
    const b = h('button', { type: 'button', class: 'pbs-btn', ...attrs }, label) as HTMLButtonElement;
    b.addEventListener('click', onClick);
    this.els.top.insertBefore(b, this.els.schedBtn);
    return b;
  }

  get canUndo(): boolean {
    return this.history.canUndo || this.commitPending;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /** True when there are changes not yet saved. */
  get isDirty(): boolean {
    return this.dirty;
  }

  selected(): string | null {
    return this.report.selectedVisual;
  }

  select(id: string | null): void {
    this.report.setActiveVisual(id);
  }

  /** Add a visual of a type at the first free spot; returns its id. */
  addVisual(type: string, fields?: VisualSpec['fields']): string {
    const { w, h: hh } = defaultSize(type);
    const pos = this.report.findFreeSpot(w, hh);
    const id = this.report.addVisual({ type, layout: { ...pos, w, h: hh }, fields });
    this.select(id);
    this.flushCommit();
    return id;
  }

  setVisualType(type: string): void {
    const sel = this.selected();
    if (!sel) return;
    const spec = this.report.visual(sel).spec;
    if (spec.type === type) return;
    this.report.updateVisual(sel, { type, fields: retargetFields(this.model, spec, type) });
    this.flushCommit();
  }

  addField(ref: string): void {
    const sel = this.selected();
    if (sel && getVisual(this.report.visual(sel).spec.type).roles.length) return this.assign(sel, ref);
    const auto = autoVisualFor(this.model, ref);
    const pos = this.report.findFreeSpot(auto.w, auto.h);
    const id = this.report.addVisual({ type: auto.type, fields: auto.fields, layout: { ...pos, w: auto.w, h: auto.h } });
    this.select(id);
    this.flushCommit();
  }

  assign(visualId: string, ref: string, role?: string, index?: number): void {
    const spec = this.report.visual(visualId).spec;
    this.report.updateVisual(visualId, { fields: assignField(this.model, spec, ref, role, index) });
    this.flushCommit();
  }

  /** Switch between the report canvas, the data view and the model view. */
  setView(view: View): void {
    this.view = view;
    this.els.canvasWrap.hidden = view !== 'report';
    this.els.viewHost.hidden = view === 'report';
    this.root.classList.toggle('no-right', view !== 'report');
    for (const [v, b] of Object.entries(this.els).filter(([k]) => k.startsWith('rail-'))) b.setAttribute('aria-pressed', String(v === `rail-${view}`));
    this.renderView();
  }

  /** Preview hides the editing chrome and lets you interact with the report like a viewer. */
  setPreview(on: boolean): void {
    this.preview = on;
    this.root.classList.toggle('is-preview', on);
    this.report.setEditMode(!on);
    if (on) this.setView('report');
    this.els.previewBtn.setAttribute('aria-pressed', String(on));
    this.els.previewBtn.textContent = on ? 'Edit' : 'Preview';
  }

  /** Write the document to storage now. */
  save(): void {
    this.flushCommit();
    const doc = this.document;
    if (this.storageKey) {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(doc));
      } catch {
        this.toast('Could not save to this browser (storage blocked or full)');
        return;
      }
    }
    this.markSaved(true);
    this.emitter.emit('save', doc);
  }

  /** Serialized document (download it, store it server-side, version it). */
  exportJSON(): string {
    this.flushCommit();
    return JSON.stringify(this.document, null, 2);
  }

  destroy(): void {
    this.stopAlerts?.();
    this.flushCommit();
    for (const off of this.offs) off();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.report.destroy();
    this.menu.destroy();
    this.root.remove();
  }

  // ================================================================= StudioContext

  commit(): void {
    this.flushCommit();
  }

  editMeasure(name?: string): void {
    const existing = name ? (({ ast: _a, ...m }) => m)(this.model.measure(name)) : null;
    measureDialog(this.root, this.model, existing, (def, previous) => {
      // a rename also rewrites other measures, calculated columns and visual fields that use the measure
      if (previous && previous !== def.name && this.model.hasMeasure(previous)) {
        const res = renameModelField(this.model, { kind: 'measure', name: previous }, def.name, this.report.toJSON());
        if (res.report) this.report.load(res.report);
        if (res.measures.length || res.columns.length) this.toast(`Updated ${res.measures.length + res.columns.length} dependent expression(s)`);
      } else if (previous && previous !== def.name) this.model.removeMeasure(previous);
      this.model.addMeasure(def);
      this.commit();
      this.toast(existing ? `Saved measure ${def.name}` : `Created measure ${def.name}`);
    });
  }

  deleteMeasure(name: string): void {
    const uses = this.measureUsage(name);
    const imp = impactOf(this.model, { kind: 'measure', name }, this.report.toJSON());
    const parts = [imp.measures.length && `${imp.measures.length} measure(s) (${imp.measures.slice(0, 3).join(', ')}${imp.measures.length > 3 ? ', …' : ''})`, imp.columns.length && `${imp.columns.length} calculated column(s)`, (imp.visuals.length || uses) && `${Math.max(imp.visuals.length, uses)} visual(s)`].filter(Boolean);
    confirmDialog(this.root, 'Delete measure', parts.length ? `"${name}" is used by ${parts.join(', ')}. They will show an error until you replace it.` : `Delete "${name}"?`, 'Delete', () => {
      this.model.removeMeasure(name);
      this.commit();
    });
  }

  /** Open the Power Query-style step editor for a table. */
  editTransforms(table?: string): void {
    const t = table ?? this.dataState.table ?? this.model.tableNames()[0];
    if (!t) return;
    transformDialog(this.root, this.model, t, (steps) => {
      try {
        this.model.transformTable(t, steps);
        this.commit();
        this.toast(steps.length ? `Applied ${steps.length} step${steps.length === 1 ? '' : 's'} to ${t}` : `Removed the steps from ${t}`);
      } catch (e) {
        this.toast(`Transform failed: ${(e as Error).message}`);
      }
    });
  }

  /** Edit scheduled sends and measure alerts. */
  editSchedules(): void {
    schedulesDialog(this.root, this.model, this.report, (subs, alerts) => {
      this.report.setSubscriptions(subs);
      this.report.setAlerts(alerts);
      this.commit();
      this.watchAlertsLive();
      this.toast(`Saved ${subs.length} subscription(s) and ${alerts.length} alert(s)`);
    });
  }

  private stopAlerts?: () => void;

  /** Alerts fire as toasts while editing, so authors can check their thresholds. */
  private watchAlertsLive(): void {
    this.stopAlerts?.();
    const alerts = this.report.alertList.filter((a) => a.enabled !== false);
    const offs = alerts.map((a) => {
      const read = () => {
        const v = this.model.query({ values: [a.measure], filters: a.filters ?? [] }).rows[0]?.values[0];
        return typeof v === 'number' ? v : null;
      };
      let last = read();
      const over = (v: number | null, prev: number | null) => v !== null && ('above' in a.when ? v > a.when.above : 'below' in a.when ? v < a.when.below : prev !== null && prev !== 0 && Math.abs((v - prev) / prev) >= a.when.changeBy);
      let active = !('changeBy' in a.when) && over(last, null);
      return this.model.onChange(() => {
        const v = read();
        const hit = over(v, last);
        if (hit && (!active || 'changeBy' in a.when)) this.toast(`🔔 ${a.name}: ${a.measure} is ${v}`);
        active = hit;
        last = v;
      });
    });
    this.stopAlerts = () => offs.forEach((off) => off());
  }

  /** Run an Arrange menu action on the selected visuals. */
  arrangeSelection(action: string): void {
    const ids = this.report.selectedVisuals;
    const [kind, arg] = action.split(':');
    if (kind === 'align') this.report.alignVisuals(arg as never, ids);
    else if (kind === 'distribute') this.report.distributeVisuals(arg as never, ids);
    else if (kind === 'group') {
      if (!this.report.groupVisuals(ids)) return this.toast('Select two or more visuals to group them');
    } else if (kind === 'ungroup') this.report.ungroupVisuals(ids);
    else if (kind === 'order') for (const id of ids) this.report.arrange(id, arg as never);
    else return;
    this.commit();
    this.syncArrange();
    if (this.layersOpen) this.renderLayers();
  }

  /** Enable Arrange actions that fit the current selection size. */
  private syncArrange(): void {
    const sel = this.report.selectedVisuals.length;
    const menu = this.els.arrange as HTMLSelectElement | undefined;
    if (!menu) return;
    menu.disabled = sel === 0;
    for (const o of menu.querySelectorAll('option[data-min]')) (o as HTMLOptionElement).disabled = sel < Number((o as HTMLOptionElement).dataset.min);
    if (this.layersOpen) this.renderLayers();
  }

  private layersOpen = false;

  private toggleLayers(): void {
    this.layersOpen = !this.layersOpen;
    this.els.layersBtn?.setAttribute('aria-expanded', String(this.layersOpen));
    if (this.layersOpen) this.renderLayers();
    else this.root.querySelector('.pbs-layers')?.remove();
  }

  /** Selection pane: the page's visuals front to back; click selects (Ctrl/Shift-click adds), arrows reorder. */
  private renderLayers(): void {
    this.root.querySelector('.pbs-layers')?.remove();
    const page = this.report.pageDefinition();
    const sel = this.report.selectedVisuals;
    const list = h('ol', { class: 'pbs-layers', 'aria-label': 'Layers' });
    const sorted = [...page.visuals].sort((a, b) => (b.layout?.z ?? 0) - (a.layout?.z ?? 0));
    for (const v of sorted) {
      // untitled visuals read by their main field: "Total Sales · card"
      const first = Object.values(v.fields ?? {}).flat()[0] as string | { name?: string; field?: string } | undefined;
      const fieldName = typeof first === 'string' ? first.replace(/^.*\[|\]$/g, '') : (first?.name ?? first?.field);
      const label = h('button', { type: 'button', class: 'pbs-layer-name', 'aria-pressed': String(sel.includes(v.id!)) }, `${v.title ?? (fieldName ? `${fieldName} · ${v.type}` : v.type)}${v.group ? ' ⧉' : ''}`);
      label.addEventListener('click', (e) => (e.ctrlKey || e.shiftKey || e.metaKey ? this.report.toggleVisualSelection(v.id!) : this.report.setActiveVisual(v.id!)));
      const up = h('button', { type: 'button', class: 'pbs-icon-btn', 'aria-label': 'Bring forward', title: 'Bring forward' }, '↑');
      const down = h('button', { type: 'button', class: 'pbs-icon-btn', 'aria-label': 'Send backward', title: 'Send backward' }, '↓');
      up.addEventListener('click', () => (this.report.arrange(v.id!, 'forward'), this.commit(), this.renderLayers()));
      down.addEventListener('click', () => (this.report.arrange(v.id!, 'backward'), this.commit(), this.renderLayers()));
      list.append(h('li', {}, label, up, down));
    }
    this.root.append(list);
  }

  /** Is the canvas showing (and editing) the phone layout? */
  private phone = false;

  /** Toggle phone layout editing: a phone-width canvas where moves and resizes edit the page's phone layout. */
  setPhoneLayout(on: boolean): void {
    this.phone = on;
    const els = this.els;
    els.phoneBtn?.setAttribute('aria-pressed', String(on));
    if (els.phoneReset) els.phoneReset.hidden = !on;
    this.root.classList.toggle('is-phone', on);
    this.report.setLayoutMode(on ? 'mobile' : 'auto');
    if (on) this.toast('Phone layout: drag and resize to arrange this page for phones');
  }

  editColumn(table?: string, name?: string): void {
    const existing = table && name ? this.studioColumns().find((c) => c.table === table && c.name === name) ?? null : null;
    columnDialog(this.root, this.model, existing, table ?? this.dataState.table, (def, previous) => {
      try {
        if (previous && previous.table === def.table && previous.name !== def.name && this.model.table(def.table).hasColumn(previous.name)) {
          // renamed: rewrite what refers to it, then apply the edited expression
          const res = renameModelField(this.model, { kind: 'column', table: def.table, name: previous.name }, def.name, this.report.toJSON());
          if (res.report) this.report.load(res.report);
          this.model.removeColumn(def.table, def.name);
        } else if (previous) this.model.removeColumn(previous.table, previous.name);
        this.model.addCalculatedColumn(def.table, def.name, def.expression, { format: def.format });
        this.commit();
        this.toast(`${previous ? 'Saved' : 'Created'} column ${def.table}[${def.name}]`);
      } catch (e) {
        this.toast(`Column failed: ${(e as Error).message}`);
      }
    });
  }

  deleteColumn(table: string, name: string): void {
    confirmDialog(this.root, 'Delete column', `Delete ${table}[${name}]? Visuals using it will show an error.`, 'Delete', () => {
      this.model.removeColumn(table, name);
      this.commit();
    });
  }

  isStudioColumn(table: string, name: string): boolean {
    return !this.baseline.columns.has(`${table}|${name}`) && !!this.model.table(table).columns.get(name)?.expression;
  }

  themeOverrides(): Record<string, unknown> {
    return this.theme;
  }

  setThemeOverrides(patch: Record<string, unknown>): void {
    this.theme = patch.__reset ? {} : { ...this.theme, ...patch };
    this.report.setTheme(this.resolvedTheme());
    this.applyThemeVars();
    this.commit();
    this.renderRight();
  }

  toast(message: string): void {
    this.root.querySelector('.pbs-toast')?.remove();
    const t = h('div', { class: 'pbs-toast', role: 'status' }, message);
    this.els.center.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ================================================================= document / history internals

  private resolvedTheme(): Theme {
    const o = this.theme as DeepPartial<Theme>;
    return createTheme(o, o.mode === 'dark' ? darkTheme : lightTheme);
  }

  private applyThemeVars(): void {
    const t = this.report?.theme ?? this.resolvedTheme();
    for (const [k, v] of Object.entries(themeVars(t))) this.root.style.setProperty(k, v);
    this.root.dataset.mode = t.mode;
  }

  /** Coalesce the events of one synchronous burst (e.g. duplicate page = add + move) into one undo step. */
  private scheduleCommit(): void {
    if (this.applying || this.commitPending) return;
    this.commitPending = true;
    queueMicrotask(() => this.commitPending && this.flushCommit());
  }

  private commitPending = false;

  private flushCommit(): void {
    this.commitPending = false;
    if (this.applying) return;
    const doc = this.document;
    if (this.history.push(doc)) {
      this.markSaved(false);
      this.emitter.emit('change', doc);
      if (this.storageKey) {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), 600);
      }
    }
    this.refreshPanes(false);
    this.updateUndoButtons();
  }

  private applyDocument(d: StudioDocument, restoreDiagram = false): void {
    this.applying = true;
    try {
      this.applyModelState(d.model ?? emptyModelState());
      this.theme = d.theme ?? {};
      this.report.setTheme(this.resolvedTheme());
      this.applyThemeVars();
      this.report.load(d.report);
      if (restoreDiagram) this.diagram.positions = d.diagram ?? {};
    } finally {
      this.applying = false;
    }
    this.refreshAll();
    this.watchAlertsLive();
  }

  private captureBaseline() {
    const measures = new Map(this.model.measureList().map((m) => [m.name, JSON.stringify({ e: m.expression, f: m.format, t: m.table, d: m.folder })]));
    for (const { ast: _a, ...def } of this.model.measureList()) this.baselineMeasureDefs.set(def.name, def);
    const columns = new Set<string>();
    for (const t of this.model.tableNames()) for (const c of this.model.table(t).columns.keys()) columns.add(`${t}|${c}`);
    const rels = new Map(this.model.relationships().map((r) => [relKey(relRef(r.fromTable, r.fromColumn), relRef(r.toTable, r.toColumn)), { active: r.active, crossFilter: r.crossFilter }]));
    return { measures, columns, rels };
  }


  private studioColumns(): CalcColumnDef[] {
    const out: CalcColumnDef[] = [];
    for (const t of this.model.tableNames())
      for (const c of this.model.table(t).columns.values()) if (c.expression && !this.baseline.columns.has(`${t}|${c.name}`)) out.push({ table: t, name: c.name, expression: c.expression, format: c.format });
    return out;
  }

  /** Diff of the live model against the baseline. */
  private modelState(): StudioModelState {
    const measures: MeasureDef[] = [];
    for (const m of this.model.measureList()) {
      const sig = JSON.stringify({ e: m.expression, f: m.format, t: m.table, d: m.folder });
      if (this.baseline.measures.get(m.name) !== sig) {
        const { ast: _a, ...def } = m;
        measures.push(def);
      }
    }
    const removedMeasures = [...this.baseline.measures.keys()].filter((n) => !this.model.hasMeasure(n));
    const current = new Map(this.model.relationships().map((r) => [relKey(relRef(r.fromTable, r.fromColumn), relRef(r.toTable, r.toColumn)), r]));
    const relationships: RelationshipDef[] = [];
    const relationshipEdits: StudioModelState['relationshipEdits'] = [];
    for (const [key, r] of current) {
      const base = this.baseline.rels.get(key);
      if (!base) relationships.push({ from: relRef(r.fromTable, r.fromColumn), to: relRef(r.toTable, r.toColumn), active: r.active, crossFilter: r.crossFilter, cardinality: r.cardinality });
      else if (base.active !== r.active || base.crossFilter !== r.crossFilter) relationshipEdits.push({ key, active: r.active, crossFilter: r.crossFilter });
    }
    const removedRelationships = [...this.baseline.rels.keys()].filter((k) => !current.has(k));
    const transforms: Record<string, TransformStep[]> = {};
    for (const t of this.model.tableNames()) {
      const steps = this.model.transformsOf(t);
      if (steps?.length) transforms[t] = steps;
    }
    return { measures, removedMeasures, columns: this.studioColumns(), relationships, removedRelationships, relationshipEdits, ...(Object.keys(transforms).length ? { transforms } : {}) };
  }

  /** Bring the live model to baseline + `state`. */
  private applyModelState(state: StudioModelState): void {
    const m = this.model;
    // transforms first: they rebuild table rows (calculated columns are recomputed on top)
    for (const t of m.tableNames()) {
      const want = state.transforms?.[t] ?? [];
      if (JSON.stringify(m.transformsOf(t) ?? []) !== JSON.stringify(want)) {
        try {
          m.transformTable(t, want);
        } catch {
          /* steps no longer apply to this data */
        }
      }
    }
    const wanted = new Map(state.measures.map((d) => [d.name, d]));
    for (const def of m.measureList()) {
      if (wanted.has(def.name)) continue;
      const base = this.baselineMeasureDefs.get(def.name);
      if (!this.baseline.measures.has(def.name)) m.removeMeasure(def.name);
      else if (base && JSON.stringify({ e: def.expression, f: def.format, t: def.table, d: def.folder }) !== this.baseline.measures.get(def.name)) m.addMeasure(base);
    }
    for (const n of this.baseline.measures.keys()) if (!m.hasMeasure(n) && !state.removedMeasures.includes(n) && this.baselineMeasureDefs.has(n)) m.addMeasure(this.baselineMeasureDefs.get(n)!);
    for (const d of state.measures) m.addMeasure(d);
    for (const n of state.removedMeasures) if (m.hasMeasure(n)) m.removeMeasure(n);
    // calculated columns
    const wantCols = new Map(state.columns.map((c) => [`${c.table}|${c.name}`, c]));
    for (const c of this.studioColumns()) {
      const w = wantCols.get(`${c.table}|${c.name}`);
      if (!w || w.expression !== c.expression || w.format !== c.format) m.removeColumn(c.table, c.name);
    }
    for (const c of state.columns) if (m.hasTable(c.table) && !m.table(c.table).hasColumn(c.name)) {
      try {
        m.addCalculatedColumn(c.table, c.name, c.expression, { format: c.format });
      } catch {
        /* column can't be rebuilt (missing dependency) */
      }
    }
    // relationships: remove extras (highest index first), restore removed baseline ones, add wanted
    const wantRels = new Set(state.relationships.map((r) => relKey(typeof r.from === 'string' ? r.from : relRef(r.from.table, r.from.column), typeof r.to === 'string' ? r.to : relRef(r.to.table, r.to.column))));
    const live = m.relationships().map((r) => ({ key: relKey(relRef(r.fromTable, r.fromColumn), relRef(r.toTable, r.toColumn)), index: r.index }));
    for (const r of [...live].reverse()) {
      const isBase = this.baseline.rels.has(r.key);
      if ((isBase && state.removedRelationships.includes(r.key)) || (!isBase && !wantRels.has(r.key))) m.removeRelationship(r.index);
    }
    const liveKeys = new Set(m.relationships().map((r) => relKey(relRef(r.fromTable, r.fromColumn), relRef(r.toTable, r.toColumn))));
    for (const r of state.relationships) {
      const key = relKey(typeof r.from === 'string' ? r.from : relRef(r.from.table, r.from.column), typeof r.to === 'string' ? r.to : relRef(r.to.table, r.to.column));
      if (!liveKeys.has(key)) {
        try {
          m.addRelationship(r);
        } catch {
          /* no longer valid */
        }
      }
    }
    for (const [key, base] of this.baseline.rels) {
      if (state.removedRelationships.includes(key)) continue;
      if (!liveKeys.has(key) && !m.relationships().some((r) => relKey(relRef(r.fromTable, r.fromColumn), relRef(r.toTable, r.toColumn)) === key)) {
        const [from, to] = key.split('->');
        try {
          m.addRelationship({ from, to, ...base });
        } catch {
          /* ignore */
        }
      }
    }
    for (const r of m.relationships()) {
      const key = relKey(relRef(r.fromTable, r.fromColumn), relRef(r.toTable, r.toColumn));
      const edit = state.relationshipEdits.find((e) => e.key === key);
      const base = this.baseline.rels.get(key);
      const target = edit ?? base;
      if (target && (r.active !== target.active || r.crossFilter !== target.crossFilter)) m.updateRelationship(r.index, { active: target.active, crossFilter: target.crossFilter });
    }
  }

  private measureUsage(name: string): number {
    let n = 0;
    for (const p of this.report.pageList)
      for (const v of this.report.pageDefinition(p.id).visuals)
        for (const f of Object.values(v.fields ?? {})) for (const x of ([] as unknown[]).concat(f)) if (x === name || (typeof x === 'object' && x && (x as { field?: string }).field === name)) n++;
    return n;
  }

  private markSaved(saved: boolean): void {
    this.dirty = !saved;
    if (this.els.status) this.els.status.textContent = saved ? (this.storageKey ? 'All changes saved' : 'Saved') : this.storageKey ? 'Saving…' : 'Unsaved changes';
  }

  // ================================================================= shell

  private buildShell(): void {
    const btn = (label: string, onClick: () => void, extra: Record<string, string> = {}) => {
      const b = h('button', { type: 'button', class: 'pbs-btn', ...extra }, label);
      b.addEventListener('click', onClick);
      return b;
    };
    // top bar
    const undo = btn('↶', () => this.undo(), { title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', class: 'pbs-btn pbs-icon' });
    const redo = btn('↷', () => this.redo(), { title: 'Redo (Ctrl+Y)', 'aria-label': 'Redo', class: 'pbs-btn pbs-icon' });
    const previewBtn = btn('Preview', () => this.setPreview(!this.preview), { 'aria-pressed': 'false', title: 'Preview the report as a viewer' });
    const arrange = h('select', { class: 'pbs-btn pbs-arrange', 'aria-label': 'Arrange selected visuals', title: 'Align, distribute, group and order the selected visuals' },
      h('option', { value: '' }, 'Arrange…'),
      h('optgroup', { label: 'Align (2+ selected)' }, ...['left', 'center', 'right', 'top', 'middle', 'bottom'].map((v) => h('option', { value: `align:${v}`, 'data-min': '2' }, `Align ${v}`))),
      h('optgroup', { label: 'Distribute (3+ selected)' }, h('option', { value: 'distribute:horizontal', 'data-min': '3' }, 'Distribute horizontally'), h('option', { value: 'distribute:vertical', 'data-min': '3' }, 'Distribute vertically')),
      h('optgroup', { label: 'Group' }, h('option', { value: 'group', 'data-min': '2' }, 'Group (Ctrl+G)'), h('option', { value: 'ungroup', 'data-min': '1' }, 'Ungroup (Ctrl+Shift+G)')),
      h('optgroup', { label: 'Order' }, ...[['front', 'Bring to front'], ['forward', 'Bring forward'], ['backward', 'Send backward'], ['back', 'Send to back']].map(([v, l]) => h('option', { value: `order:${v}`, 'data-min': '1' }, l))),
    ) as HTMLSelectElement;
    arrange.addEventListener('change', () => {
      const v = arrange.value;
      arrange.value = '';
      if (v) this.arrangeSelection(v);
    });
    const schedBtn = btn('⏰ Schedules', () => this.editSchedules(), { title: 'Scheduled sends and measure alerts' });
    const layersBtn = btn('Layers', () => this.toggleLayers(), { title: 'All visuals on this page, front to back', 'aria-expanded': 'false' });
    const phoneBtn = btn('📱 Phone', () => this.setPhoneLayout(!this.phone), { 'aria-pressed': 'false', title: 'Edit the phone layout of this page' });
    const phoneReset = btn('Reset phone layout', () => {
      this.report.autoMobileLayout();
      this.commit();
      this.toast('Phone layout regenerated from the desktop layout');
    }, { title: 'Stack this page’s visuals for phones' });
    phoneReset.hidden = true;
    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Import report' }) as HTMLInputElement;
    fileInput.hidden = true;
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const text = await f.text();
        const parsed = JSON.parse(text, reviveDates) as StudioDocument | ReportDefinition;
        const doc: StudioDocument = 'report' in parsed ? (parsed as StudioDocument) : { version: 1, report: parsed as ReportDefinition, model: emptyModelState() };
        this.applyDocument(doc, true);
        this.commit();
        this.toast(`Opened ${f.name}`);
      } catch (e) {
        this.toast(`Could not open file: ${(e as Error).message}`);
      }
      fileInput.value = '';
    });
    const status = h('span', { class: 'pbs-status', role: 'status' });
    this.els.status = status;
    this.els.undo = undo;
    this.els.redo = redo;
    this.els.previewBtn = previewBtn;
    this.els.phoneBtn = phoneBtn;
    this.els.arrange = arrange;
    this.els.layersBtn = layersBtn;
    this.els.phoneReset = phoneReset;
    const top = h(
      'div',
      { class: 'pbs-top', role: 'toolbar', 'aria-label': 'Studio' },
      h('span', { class: 'pbs-brand' }, 'PrismBI Studio'),
      undo,
      redo,
      h('span', { class: 'pbs-sep' }),
      btn('New measure', () => this.editMeasure()),
      btn('New column', () => this.editColumn()),
      btn('Auto page', () => {
        const id = this.report.addPage(autoReport(this.model, { name: `Overview ${this.report.pageList.length + 1}` }));
        this.report.goToPage(id);
        this.toast('Generated a page from the model');
      }, { title: 'Generate a starter page from the model' }),
      h('span', { class: 'pbs-sep' }),
      btn('Export', () => this.download(), { title: 'Download the report document (JSON)' }),
      btn('Import', () => fileInput.click(), { title: 'Open a report document (JSON)' }),
      fileInput,
      h('span', { class: 'pbs-spacer' }),
      status,
      schedBtn,
      arrange,
      layersBtn,
      phoneReset,
      phoneBtn,
      previewBtn,
    );
    this.els.top = top;
    this.els.schedBtn = schedBtn;
    // rail
    const rail = h('nav', { class: 'pbs-rail', 'aria-label': 'Views' });
    for (const v of ['report', 'data', 'model'] as View[]) {
      const b = h('button', { type: 'button', title: `${v[0].toUpperCase()}${v.slice(1)} view`, 'aria-label': `${v} view`, 'aria-pressed': String(v === 'report') });
      b.innerHTML = RAIL_ICONS[v];
      b.addEventListener('click', () => this.setView(v));
      this.els[`rail-${v}`] = b;
      rail.append(b);
    }
    // left: fields
    const search = h('input', { type: 'search', class: 'pbs-search', placeholder: 'Search fields', 'aria-label': 'Search fields' }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.fieldQuery = search.value;
      this.renderFieldsPane();
    });
    const hiddenToggle = h('button', { type: 'button', class: 'pbs-btn pbs-icon', title: 'Show hidden fields', 'aria-label': 'Show hidden fields', 'aria-pressed': 'false' }, '◌');
    hiddenToggle.addEventListener('click', () => {
      this.showHidden = !this.showHidden;
      hiddenToggle.setAttribute('aria-pressed', String(this.showHidden));
      this.renderFieldsPane();
    });
    const fields = h('div', { class: 'pbs-scroll', role: 'tree', 'aria-label': 'Fields' });
    this.els.fields = fields;
    const left = h('aside', { class: 'pbs-left', 'aria-label': 'Fields pane' }, h('div', { class: 'pbs-pane-h' }, h('span', {}, 'Fields'), hiddenToggle), search, fields);
    // center
    const canvas = h('div', { class: 'pbs-canvas' });
    const pages = h('nav', { class: 'pbs-pages', role: 'tablist', 'aria-label': 'Pages' });
    const canvasWrap = h('div', { class: 'pbs-center', style: 'flex:1;min-height:0' }, canvas, pages);
    const viewHost = h('div', { class: 'pbs-center', style: 'flex:1;min-height:0;overflow:hidden' });
    viewHost.hidden = true;
    const center = h('main', { class: 'pbs-center' }, canvasWrap, viewHost);
    this.els.canvas = canvas;
    this.els.pages = pages;
    this.els.canvasWrap = canvasWrap;
    this.els.viewHost = viewHost;
    this.els.center = center;
    this.wireCanvasDrop(canvas);
    // right: build / format / filters
    const tabs = h('div', { class: 'pbs-tabs', role: 'tablist' });
    for (const [id, label] of [['build', 'Build'], ['format', 'Format'], ['filters', 'Filters']] as const) {
      const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(id === 'build'), 'data-tab': id }, label);
      b.addEventListener('click', () => this.setRightTab(id));
      tabs.append(b);
    }
    const rightBody = h('div', { class: 'pbs-scroll' });
    this.els.tabs = tabs;
    this.els.rightBody = rightBody;
    const right = h('aside', { class: 'pbs-right', 'aria-label': 'Properties' }, tabs, rightBody);
    this.root.append(top, rail, left, center, right);
    this.root.addEventListener('keydown', (e) => this.onKey(e));
  }

  private setRightTab(tab: 'build' | 'format' | 'filters'): void {
    this.rightTab = tab;
    this.els.tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    this.renderRight();
  }

  private refreshAll(): void {
    this.renderPages();
    this.renderFieldsPane();
    this.renderRight();
    this.renderView();
    this.updateUndoButtons();
  }

  /** Re-render panes after a change. `selectionChanged` re-renders the format pane even if it has focus. */
  private refreshPanes(selectionChanged: boolean): void {
    this.renderFieldsPane();
    this.renderPages();
    const focusInRight = this.els.rightBody.contains(document.activeElement);
    if (selectionChanged || !focusInRight || this.rightTab === 'build') this.renderRight();
    if (this.view !== 'report') this.renderView();
  }

  private renderFieldsPane(): void {
    renderFields(this, this.els.fields, { query: this.fieldQuery, showHidden: this.showHidden, menu: this.menu });
  }

  private renderRight(): void {
    const body = this.els.rightBody;
    if (!this.report) return;
    if (this.rightTab === 'build') {
      const viz = h('div');
      const wells = h('div');
      renderVisualizations(this, viz);
      renderWells(this, wells);
      body.replaceChildren(viz, wells);
    } else if (this.rightTab === 'format') {
      const f = h('div');
      renderFormat(this, f, this.openSections);
      body.replaceChildren(f);
    } else {
      const sel = this.selected();
      const r = this.report;
      const page = r.currentPage.id;
      const sections = [];
      if (sel) sections.push({ scope: 'visual' as const, title: 'Filters on this visual', filters: r.visual(sel).spec.filters ?? [], set: (f: never[]) => r.setVisualFilters(sel, f) });
      sections.push({ scope: 'page' as const, title: 'Filters on this page', filters: r.getFilters().page, set: (f: never[]) => r.setPageFilters(page, f) });
      sections.push({ scope: 'report' as const, title: 'Filters on all pages', filters: r.getFilters().report, set: (f: never[]) => r.setReportFilters(f) });
      this.filterPane.render(sections);
      body.replaceChildren(this.filterPane.el);
    }
  }

  private renderView(): void {
    if (this.view === 'data') renderDataView(this, this.els.viewHost, this.dataState, () => this.renderView());
    else if (this.view === 'model') renderModelView(this, this.els.viewHost, this.diagram, () => this.commit());
  }

  private updateUndoButtons(): void {
    (this.els.undo as HTMLButtonElement).disabled = !this.canUndo;
    (this.els.redo as HTMLButtonElement).disabled = !this.canRedo;
  }

  // ---- pages bar

  private renderPages(): void {
    const bar = this.els.pages;
    if (!bar || !this.report) return;
    bar.replaceChildren();
    const current = this.report.currentPage.id;
    this.report.pageList.forEach((p, i) => {
      const def = this.report.pageDefinition(p.id);
      const tab = h('button', { type: 'button', class: 'pbs-page', role: 'tab', 'aria-selected': String(p.id === current), 'data-page': p.id }, h('span', {}, p.name));
      if (def.tooltip) tab.append(h('small', {}, 'tooltip'));
      else if (def.drillthrough) tab.append(h('small', {}, 'drill-through'));
      else if (p.hidden) tab.append(h('small', {}, 'hidden'));
      tab.addEventListener('click', () => p.id !== this.report.currentPage.id && this.report.goToPage(p.id));
      tab.addEventListener('dblclick', () => this.renamePage(tab, p.id, p.name));
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.menu.show(e.clientX, e.clientY, [
          { label: 'Rename', onClick: () => this.renamePage(tab, p.id, p.name) },
          { label: 'Duplicate', onClick: () => this.report.goToPage(this.report.duplicatePage(p.id)) },
          { label: p.hidden ? 'Show page' : 'Hide page', onClick: () => this.report.updatePage(p.id, { hidden: !p.hidden || undefined }) },
          { label: 'Move left', disabled: i === 0, onClick: () => this.report.movePage(p.id, i - 1) },
          { label: 'Move right', disabled: i === this.report.pageList.length - 1, onClick: () => this.report.movePage(p.id, i + 1) },
          {
            label: 'Delete page',
            separator: true,
            disabled: this.report.pageList.length === 1,
            onClick: () => {
              const n = def.visuals.length;
              const go = () => this.report.removePage(p.id);
              if (n) confirmDialog(this.root, 'Delete page', `Delete "${p.name}" and its ${n} visual(s)? You can undo this.`, 'Delete', go);
              else go();
            },
          },
        ]);
      });
      bar.append(tab);
    });
    const add = h('button', { type: 'button', class: 'pbs-addpage', title: 'New page', 'aria-label': 'New page' }, '+');
    add.addEventListener('click', () => {
      const n = this.report.pageList.length + 1;
      this.report.addPage({ name: `Page ${n}`, visuals: [] });
      this.flushCommit();
    });
    bar.append(add);
  }

  private renamePage(tab: HTMLElement, id: string, name: string): void {
    const input = h('input', { type: 'text', value: name, 'aria-label': 'Page name' }) as HTMLInputElement;
    tab.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v && v !== name) {
        this.report.updatePage(id, { name: v });
        this.flushCommit();
      } else this.renderPages();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit(true);
      if (e.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // ---- canvas drop

  private wireCanvasDrop(canvas: HTMLElement): void {
    canvas.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(FIELD_MIME) || this.preview) return;
      e.preventDefault();
      canvas.classList.add('is-drop');
    });
    canvas.addEventListener('dragleave', (e) => {
      if (!canvas.contains(e.relatedTarget as Node)) canvas.classList.remove('is-drop');
    });
    canvas.addEventListener('drop', (e) => {
      canvas.classList.remove('is-drop');
      const ref = e.dataTransfer?.getData(FIELD_MIME);
      if (!ref) return;
      e.preventDefault();
      const target = (e.target as HTMLElement).closest('[data-edit-for]') as HTMLElement | null;
      if (target) {
        const id = target.dataset.editFor!;
        this.select(id);
        if (getVisual(this.report.visual(id).spec.type).roles.length) return this.assign(id, ref);
      }
      // empty canvas: a new visual where it was dropped (if that spot is free)
      const auto = autoVisualFor(this.model, ref);
      const cell = this.cellAt(e.clientX, e.clientY);
      const spec = this.report.pageDefinition();
      const cols = spec.layout?.columns ?? 12;
      const free = cell && !spec.visuals.some((v) => {
        const l = v.layout ?? { x: 0, y: 0, w: 4, h: 6 };
        return cell.x < l.x + l.w && cell.x + auto.w > l.x && cell.y < l.y + l.h && cell.y + auto.h > l.y;
      });
      const pos = free && cell ? { x: Math.min(cell.x, cols - auto.w), y: cell.y } : this.report.findFreeSpot(auto.w, auto.h);
      const id = this.report.addVisual({ type: auto.type, fields: auto.fields, layout: { ...pos, w: auto.w, h: auto.h } });
      this.select(id);
    });
  }

  /** Grid cell under a viewport point (current page). */
  private cellAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const pageEl = this.els.canvas.querySelector('.pbi-page:not([hidden])') as HTMLElement | null;
    if (!pageEl) return null;
    const def = this.report.pageDefinition();
    const l = def.layout ?? {};
    const gap = l.gap ?? 12;
    const cols = l.columns ?? 12;
    const r = pageEl.getBoundingClientRect();
    if (!r.width) return null;
    const colStep = (r.width - gap * 2 + gap) / cols;
    const rowStep = (l.rowHeight ?? 44) + gap;
    return { x: Math.max(0, Math.floor((clientX - r.left - gap) / colStep)), y: Math.max(0, Math.floor((clientY - r.top - gap) / rowStep)) };
  }

  // ---- keyboard

  private onKey(e: KeyboardEvent): void {
    this.handleKey(e);
    if (this.commitPending) this.flushCommit();
  }

  private handleKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    const typing = t.closest('input, textarea, select, [contenteditable=true]') !== null;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'g' && !typing && !this.preview) {
      e.preventDefault();
      this.arrangeSelection(e.shiftKey ? 'ungroup' : 'group');
      return;
    }
    if (mod && e.key.toLowerCase() === 'a' && !typing && !this.preview && this.report.editMode) {
      e.preventDefault();
      this.report.selectVisuals(this.report.visualIds());
      return;
    }
    if (mod && e.key.toLowerCase() === 'z' && !typing) {
      e.preventDefault();
      return e.shiftKey ? this.redo() : this.undo();
    }
    if (mod && e.key.toLowerCase() === 'y' && !typing) {
      e.preventDefault();
      return this.redo();
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      return this.save();
    }
    if (typing || this.preview || this.view !== 'report') return;
    const sel = this.selected();
    if (mod && e.key.toLowerCase() === 'v' && this.clipboard) {
      e.preventDefault();
      const copy = JSON.parse(JSON.stringify(this.clipboard), reviveDates) as VisualSpec;
      delete copy.id;
      const l = copy.layout ?? { x: 0, y: 0, w: 4, h: 6 };
      copy.layout = { ...l, ...this.report.findFreeSpot(l.w, l.h) };
      this.select(this.report.addVisual(copy));
      return;
    }
    if (!sel) return;
    const spec = this.report.visual(sel).spec;
    const l = spec.layout ?? { x: 0, y: 0, w: 4, h: 6 };
    const cols = this.report.pageDefinition().layout?.columns ?? 12;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.report.removeVisual(sel);
    } else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.select(this.report.duplicateVisual(sel));
    } else if (mod && e.key.toLowerCase() === 'c') {
      this.clipboard = JSON.parse(JSON.stringify(spec), reviveDates) as VisualSpec;
      this.toast('Visual copied');
    } else if (e.key === 'Escape') this.select(null);
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      const next = e.shiftKey ? { ...l, w: Math.max(1, Math.min(cols - l.x, l.w + dx)), h: Math.max(1, l.h + dy) } : { ...l, x: Math.max(0, Math.min(cols - l.w, l.x + dx)), y: Math.max(0, l.y + dy) };
      this.report.updateVisual(sel, { layout: next });
    } else if (e.key === ']' && mod) this.report.arrange(sel, 'front');
    else if (e.key === '[' && mod) this.report.arrange(sel, 'back');
  }

  private download(): void {
    const blob = new Blob([this.exportJSON()], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${(this.report.name || 'report').replace(/[^\w-]+/g, '_')}.prismbi.json` });
    document.body.append(a);
    a.click();
    a.remove();
  }
}

export function emptyModelState(): StudioModelState {
  return { measures: [], removedMeasures: [], columns: [], relationships: [], removedRelationships: [], relationshipEdits: [] };
}

void parseColumnRef;
