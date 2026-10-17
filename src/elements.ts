/**
 * PrismBI web components: `<prism-report>` and `<prism-visual>`. They work in plain HTML and in any framework
 * (Vue, Svelte, Angular, Solid, Lit…) because frameworks bind DOM properties and listen to DOM events natively.
 * Importing this module defines the elements.
 *
 * ```html
 * <prism-report src="/reports/sales.json" model="sales" theme="dark" style="height: 720px"></prism-report>
 * <script type="module">
 *   import { registerModel } from '@prismbi/prismbi/elements';
 *   registerModel('sales', buildModel());
 * </script>
 * ```
 */
import { Report, createVisual } from '@prismbi/prismbi';
import type { DataModel, DeepPartial, FilterSpec, ReportChrome, ReportDefinition, ReportEvents, Theme, VisualSpec } from '@prismbi/prismbi';

type ThemeValue = string | Theme | DeepPartial<Theme>;

const models = new Map<string, DataModel>();
const waiting = new Map<string, Set<() => void>>();

/** Name a model so elements can refer to it with the `model="name"` attribute. */
export function registerModel(name: string, model: DataModel): void {
  models.set(name, model);
  for (const fn of waiting.get(name) ?? []) fn();
  waiting.delete(name);
}

function whenModel(name: string, fn: () => void): () => void {
  let set = waiting.get(name);
  if (!set) waiting.set(name, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

/** For framework configs that must be told about custom elements (e.g. Vue's `isCustomElement`). */
export const isPrismElement = (tag: string): boolean => tag.startsWith('prism-');

const Base: typeof HTMLElement = typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

abstract class PrismElement extends Base {
  protected _report: Report | null = null;
  protected _model: DataModel | null = null;
  protected _theme: ThemeValue | undefined;
  private queued = false;
  private stopWaiting?: () => void;

  /** The underlying {@link Report} (imperative API), once mounted. */
  get report(): Report | null {
    return this._report;
  }

  get model(): DataModel | null {
    return this._model ?? models.get(this.getAttribute('model') ?? '') ?? null;
  }
  set model(m: DataModel | null) {
    this._model = m;
    this.rebuild();
  }

  get theme(): ThemeValue | undefined {
    return this._theme ?? this.getAttribute('theme') ?? undefined;
  }
  set theme(t: ThemeValue | undefined) {
    this._theme = t;
    if (this._report && t) this._report.setTheme(t);
  }

  connectedCallback(): void {
    if (!this.style.display) this.style.display = 'block';
    this.rebuild();
  }

  disconnectedCallback(): void {
    this.stopWaiting?.();
    // frameworks may move elements: tear down after the current task unless re-attached
    queueMicrotask(() => {
      if (!this.isConnected) this.teardown();
    });
  }

  protected teardown(): void {
    this._report?.destroy();
    this._report = null;
  }

  /** Batch property and attribute changes into one rebuild. */
  protected rebuild(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (!this.isConnected) return;
      const model = this.model;
      if (!model) {
        const name = this.getAttribute('model');
        this.stopWaiting?.();
        if (name) this.stopWaiting = whenModel(name, () => this.rebuild());
        return;
      }
      this.mount(model);
    });
  }

  protected abstract mount(model: DataModel): void;

  /** Report events become DOM events with the same name (`selectionChanged`, `dataPointClick`, …). */
  protected forward = <K extends keyof ReportEvents>(event: K, payload: ReportEvents[K]): void => {
    this.dispatchEvent(new CustomEvent(String(event), { detail: payload, bubbles: true, composed: true }));
  };
}

/**
 * `<prism-report>`: a full interactive report.
 *
 * Properties: `model`, `definition`, `theme`, `filters`, `chrome`, `report` (read-only).
 * Attributes: `src` (URL of a report JSON), `model` (name given to {@link registerModel}), `theme`, `locale`, `page`.
 */
export class PrismReportElement extends PrismElement {
  static observedAttributes = ['src', 'model', 'theme', 'locale', 'page'];
  private _definition: ReportDefinition | null = null;
  private _filters: FilterSpec[] | undefined;
  private _chrome: ReportChrome | undefined;
  private mounted: { model: DataModel; definition: ReportDefinition; locale: string | null } | null = null;
  private loading?: AbortController;

  get definition(): ReportDefinition | null {
    return this._definition;
  }
  set definition(d: ReportDefinition | string | null) {
    this._definition = typeof d === 'string' ? Report.parse(d) : d;
    this.rebuild();
  }

  get filters(): FilterSpec[] | undefined {
    return this._filters;
  }
  set filters(f: FilterSpec[] | undefined) {
    this._filters = f;
    if (this._report && f) this._report.setReportFilters(f);
  }

  get chrome(): ReportChrome | undefined {
    return this._chrome;
  }
  set chrome(c: ReportChrome | undefined) {
    this._chrome = c;
    this.mounted = null;
    this.rebuild();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (old === value) return;
    if (name === 'theme' && this._report && value && !this._theme) return this._report.setTheme(value);
    if (name === 'page' && this._report && value) return this._report.goToPage(value);
    if (name === 'src') return this.fetchDefinition(value);
    if (name === 'locale') this.mounted = null;
    this.rebuild();
  }

  private fetchDefinition(url: string | null): void {
    this.loading?.abort();
    if (!url) return;
    const ctrl = new AbortController();
    this.loading = ctrl;
    fetch(url, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
        return r.text();
      })
      .then((text) => {
        if (!ctrl.signal.aborted) this.definition = text;
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') this.dispatchEvent(new CustomEvent('error', { detail: { visualId: '', error } }));
      });
  }

  protected mount(model: DataModel): void {
    const definition = this._definition;
    if (!definition) return;
    const locale = this.getAttribute('locale');
    const m = this.mounted;
    if (this._report && m && m.model === model && m.locale === locale) {
      if (m.definition !== definition) {
        this._report.load(definition);
        this.mounted = { ...m, definition };
      }
      return;
    }
    this.teardown();
    this._report = new Report(this, {
      ...definition,
      model,
      theme: this.theme,
      locale: locale ?? undefined,
      chrome: this._chrome,
      initialPage: this.getAttribute('page') ?? undefined,
      ...(this._filters ? { filters: this._filters } : {}),
      onEvent: this.forward,
    });
    this.mounted = { model, definition, locale };
  }

  protected override teardown(): void {
    super.teardown();
    this.mounted = null;
  }
}

/**
 * `<prism-visual>`: one visual for your own layout.
 *
 * Properties: `model`, `spec` ({ type, fields, format, filters, … }), `theme`, `report` (read-only).
 * Attributes: `type`, `fields` (JSON), `format` (JSON), `title`, `model` (registered name), `theme`, `locale`.
 */
export class PrismVisualElement extends PrismElement {
  static observedAttributes = ['type', 'fields', 'format', 'title', 'model', 'theme', 'locale'];
  private _spec: Partial<Omit<VisualSpec, 'layout'>> | null = null;

  get spec(): Partial<Omit<VisualSpec, 'layout'>> | null {
    return this._spec;
  }
  set spec(s: Partial<Omit<VisualSpec, 'layout'>> | null) {
    this._spec = s;
    this.rebuild();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (old === value) return;
    if (name === 'theme' && this._report && value && !this._theme) return this._report.setTheme(value);
    this.rebuild();
  }

  private json(name: string): Record<string, unknown> | undefined {
    const v = this.getAttribute(name);
    if (!v) return undefined;
    try {
      return JSON.parse(v);
    } catch {
      throw new Error(`<prism-visual> ${name} attribute is not valid JSON: ${v}`);
    }
  }

  protected mount(model: DataModel): void {
    const spec: Partial<VisualSpec> = { ...this._spec };
    spec.type ??= this.getAttribute('type') ?? undefined;
    spec.fields ??= this.json('fields') as VisualSpec['fields'];
    spec.format ??= this.json('format') as VisualSpec['format'];
    spec.title ??= this.getAttribute('title') ?? undefined;
    if (!spec.type || !spec.fields) return;
    this.teardown();
    if (!this.style.height && !this.style.minHeight) this.style.minHeight = '240px';
    this._report = createVisual(this, { ...(spec as VisualSpec), model, theme: this.theme, locale: this.getAttribute('locale') ?? undefined, onEvent: this.forward });
  }
}

/** Define the elements (done on import; call again with other names to avoid clashes). */
export function defineElements(names: { report?: string; visual?: string } = {}): void {
  if (typeof customElements === 'undefined') return;
  const r = names.report ?? 'prism-report';
  const v = names.visual ?? 'prism-visual';
  if (!customElements.get(r)) customElements.define(r, class extends PrismReportElement {});
  if (!customElements.get(v)) customElements.define(v, class extends PrismVisualElement {});
}

defineElements();

// ---------------------------------------------------------------- Svelte actions (framework-free)

export interface ReportActionParams {
  model: DataModel;
  definition: ReportDefinition;
  theme?: ThemeValue;
  filters?: FilterSpec[];
  /** Event handlers by report event name. */
  on?: { [K in keyof ReportEvents as string extends K ? never : K]?: (payload: ReportEvents[K]) => void };
}

/** `<div use:prismReport={{ model, definition }} />` in Svelte (or call it yourself on any element). */
export function prismReport(node: HTMLElement, params: ReportActionParams) {
  let p = params;
  const make = () => new Report(node, { ...p.definition, model: p.model, theme: p.theme, ...(p.filters ? { filters: p.filters } : {}), onEvent: (e, payload) => (p.on?.[e as keyof NonNullable<ReportActionParams['on']>] as ((x: unknown) => void) | undefined)?.(payload) });
  let report = make();
  return {
    update(next: ReportActionParams) {
      const rebuild = next.model !== p.model;
      const reload = next.definition !== p.definition;
      p = next;
      if (rebuild) {
        report.destroy();
        report = make();
        return;
      }
      if (reload) report.load(next.definition);
      if (next.theme) report.setTheme(next.theme);
      if (next.filters) report.setReportFilters(next.filters);
    },
    destroy() {
      report.destroy();
    },
  };
}

export interface VisualActionParams extends Omit<VisualSpec, 'layout' | 'id'> {
  model: DataModel;
  theme?: ThemeValue;
}

/** `<div use:prismVisual={{ model, type: 'line', fields: { … } }} />` in Svelte. */
export function prismVisual(node: HTMLElement, params: VisualActionParams) {
  const make = (q: VisualActionParams) => createVisual(node, q);
  let report = make(params);
  return {
    update(next: VisualActionParams) {
      report.destroy();
      report = make(next);
    },
    destroy() {
      report.destroy();
    },
  };
}
