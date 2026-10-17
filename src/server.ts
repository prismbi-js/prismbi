/**
 * PrismBI server: render visuals and reports without a browser, watch measures for alerts, and schedule report
 * jobs. Bring any DOM implementation (jsdom, linkedom, happy-dom); PrismBI adds no dependency.
 *
 * ```ts
 * import { JSDOM } from 'jsdom';
 * import { renderVisualSvg, watchMeasure } from '@prismbi/prismbi/server';
 * const { window } = new JSDOM();
 * const svg = renderVisualSvg(model, { type: 'line', fields: { category: 'Date[MonthYear]', values: 'Total Sales' } }, { window });
 * ```
 */
import { Report, prismCss } from '@prismbi/prismbi';
import type { CellValue, DataModel, DeepPartial, FieldSpec, FilterSpec, PageDefinition, ReportDefinition, Theme, VisualSpec } from '@prismbi/prismbi';

/** The parts of a DOM `window` PrismBI needs. */
export type DomWindow = { document: Document } & Record<string, unknown>;

const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'Element', 'Node', 'Text', 'getComputedStyle', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'XMLSerializer', 'DOMParser'];

/** Run `fn` with a DOM installed as globals, then restore whatever was there before. */
export function withDom<T>(window: DomWindow, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const saved = GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  for (const k of GLOBALS) {
    const v = k === 'window' ? window : window[k];
    if (v !== undefined) Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  }
  try {
    return fn();
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
}

export interface RenderOptions {
  window: DomWindow;
  theme?: string | Theme | DeepPartial<Theme>;
  locale?: string;
}

/** Standalone SVG wrapping HTML content (cards, tables) in a foreignObject with the report's styles. */
function htmlAsSvg(root: HTMLElement, content: string, width: number, height: number): string {
  const css = prismCss.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml" class="pbi-report pbi-export" data-mode="${root.getAttribute('data-mode') ?? 'light'}" style="${(root.getAttribute('style') ?? '').replace(/"/g, '&quot;')};height:${height}px"><style>${css}</style>${content}</div></foreignObject></svg>`;
}

/**
 * Render one visual to an SVG string. Charts come out as their own vector SVG; HTML visuals (cards, tables,
 * slicers) are wrapped in a foreignObject.
 */
export function renderVisualSvg(model: DataModel, spec: Omit<VisualSpec, 'layout'>, opts: RenderOptions & { width?: number; height?: number }): string {
  const width = opts.width ?? 640;
  const height = opts.height ?? 360;
  return withDom(opts.window, () => {
    const host = document.createElement('div');
    document.body.append(host);
    const report = new Report(host, {
      model,
      theme: opts.theme,
      locale: opts.locale,
      chrome: { toolbar: false, pageTabs: false, filterPane: false },
      measure: () => ({ width, height }),
      pages: [{ name: 'Visual', layout: { columns: 1, rowHeight: 10, gap: 0 }, visuals: [{ ...(spec as VisualSpec), id: 'v', layout: { x: 0, y: 0, w: 1, h: 1 } }] }],
    });
    try {
      report.flush();
      const visual = host.querySelector<HTMLElement>('[data-visual-id="v"]');
      const error = visual?.querySelector('.pbi-error');
      if (error) throw new Error(`Cannot render ${spec.type}: ${error.textContent}`);
      const svg = visual?.querySelector<SVGSVGElement>('svg.pbi-svg');
      if (svg && !visual!.querySelector('.pbi-card-value, table')) {
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${svg.getAttribute('width') ?? width} ${svg.getAttribute('height') ?? height}`);
        return svg.outerHTML;
      }
      return htmlAsSvg(report.root, visual?.querySelector('.pbi-vroot')?.outerHTML ?? '', width, height);
    } finally {
      report.destroy();
      host.remove();
    }
  });
}

export interface ReportHtmlOptions extends RenderOptions {
  /** Page id or name (default: the first visible page). */
  page?: string;
  /** Page width in pixels (default 1280). */
  width?: number;
  /** Document title (default: the report name). */
  title?: string;
}

/**
 * Render a report page to a self-contained HTML document (styles inlined, no scripts): for archives, emails
 * with an HTML body, or converting to PDF/PNG with any headless browser.
 */
export function renderReportHtml(model: DataModel, def: ReportDefinition, opts: ReportHtmlOptions): string {
  const width = opts.width ?? 1280;
  return withDom(opts.window, () => {
    const pageDef: PageDefinition | undefined = opts.page ? def.pages.find((p) => p.id === opts.page || p.name === opts.page) : def.pages.find((p) => !p.hidden && !p.tooltip);
    if (!pageDef) throw new Error(`Page "${opts.page}" not found`);
    const cols = pageDef.layout?.columns ?? 12;
    const rowH = pageDef.layout?.rowHeight ?? 44;
    const gap = 12;
    const colW = (width - gap * (cols + 1)) / cols;
    const box = (v: VisualSpec) => {
      const l = v.layout ?? { x: 0, y: 0, w: 4, h: 4 };
      return { left: gap + l.x * (colW + gap), top: gap + l.y * (rowH + gap), width: l.w * colW + (l.w - 1) * gap, height: l.h * rowH + (l.h - 1) * gap };
    };
    const boxes = new Map(pageDef.visuals.map((v, i) => [v.id ?? `v${i}`, box(v)]));
    const host = document.createElement('div');
    document.body.append(host);
    const report = new Report(host, {
      ...def,
      model,
      theme: opts.theme,
      locale: opts.locale,
      initialPage: pageDef.id ?? pageDef.name,
      chrome: { toolbar: false, pageTabs: false, filterPane: false },
      // the visual body sits inside the card's padding (12px) and below a title row when there is one
      measure: (id) => {
        const b = boxes.get(id);
        const spec = pageDef.visuals.find((v) => v.id === id);
        return b && { width: Math.max(40, b.width - 24), height: Math.max(40, b.height - 24 - (spec?.title ? 26 : 0)) };
      },
    });
    try {
      report.flush();
      const parts: string[] = [];
      for (const [id, b] of boxes) {
        const el = host.querySelector<HTMLElement>(`[data-visual-id="${id}"]`);
        if (!el) continue;
        el.querySelectorAll('.pbi-icons, .pbi-edit').forEach((x) => x.remove());
        el.style.cssText += `;position:absolute;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;grid-column:auto;grid-row:auto`;
        parts.push(el.outerHTML);
      }
      const height = Math.max(0, ...[...boxes.values()].map((b) => b.top + b.height)) + gap;
      const root = report.root;
      const title = (opts.title ?? def.name ?? 'Report').replace(/</g, '&lt;');
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${prismCss}\nbody{margin:0}</style></head><body><div class="pbi-report pbi-export" data-mode="${root.getAttribute('data-mode') ?? 'light'}" style="${(root.getAttribute('style') ?? '').replace(/"/g, '&quot;')}"><div style="position:relative;width:${width}px;height:${height}px">${parts.join('')}</div></div></body></html>`;
    } finally {
      report.destroy();
      host.remove();
    }
  });
}

// ---------------------------------------------------------------- alerts

export type AlertCondition = { above: number } | { below: number } | { changeBy: number } | ((value: number | null, previous: number | null) => boolean);

export interface AlertEvent {
  measure: string;
  value: number | null;
  previous: number | null;
  condition: string;
  at: Date;
}

export interface WatchOptions {
  measure: FieldSpec;
  filters?: FilterSpec[];
  when: AlertCondition;
  onAlert: (event: AlertEvent) => void;
  /** Wait this long after a change before re-evaluating (default 0; batches bursts of streamed rows). */
  debounceMs?: number;
}

const describeCondition = (c: AlertCondition) => (typeof c === 'function' ? 'custom' : 'above' in c ? `above ${c.above}` : 'below' in c ? `below ${c.below}` : `changes by ${c.changeBy * 100}%`);

/**
 * Alert when a measure crosses a threshold (edge-triggered: once per crossing) or moves by a share
 * (`{ changeBy: 0.1 }` = 10% from the last alert). Re-evaluates whenever the model changes, so it works with
 * `streamInto`, `scheduleRefresh` and `appendRows`. Returns a stop function.
 */
export function watchMeasure(model: DataModel, opts: WatchOptions): () => void {
  const measureName = typeof opts.measure === 'string' ? opts.measure : opts.measure.name ?? opts.measure.field ?? 'value';
  const read = (): number | null => {
    const v: CellValue | undefined = model.query({ values: [opts.measure], filters: opts.filters ?? [] }).rows[0]?.values[0];
    return typeof v === 'number' ? v : null;
  };
  const test = (v: number | null, prev: number | null): boolean => {
    const c = opts.when;
    if (typeof c === 'function') return c(v, prev);
    if (v === null) return false;
    if ('above' in c) return v > c.above;
    if ('below' in c) return v < c.below;
    return prev !== null && prev !== 0 && Math.abs((v - prev) / prev) >= c.changeBy;
  };
  const isChange = typeof opts.when === 'object' && 'changeBy' in opts.when;
  let last = read();
  let active = !isChange && test(last, null); // already over the threshold: no alert until it crosses again
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    timer = undefined;
    const v = read();
    const hit = test(v, last);
    if (isChange) {
      if (hit) {
        opts.onAlert({ measure: measureName, value: v, previous: last, condition: describeCondition(opts.when), at: new Date() });
        last = v;
      }
      return;
    }
    if (hit && !active) opts.onAlert({ measure: measureName, value: v, previous: last, condition: describeCondition(opts.when), at: new Date() });
    active = hit;
    last = v;
  };
  const off = model.onChange(() => {
    if (!opts.debounceMs) return check();
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, opts.debounceMs);
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
  };
}

// ---------------------------------------------------------------- scheduling

export interface ScheduleOptions {
  /** Milliseconds between runs, or `'daily@HH:MM'` (local time). */
  every: number | `daily@${string}`;
  /** The job: render, then send it however you like (email, Slack, storage…). */
  run: () => unknown | Promise<unknown>;
  onError?: (error: unknown) => void;
  /** Run once immediately as well (default false). */
  immediate?: boolean;
}

/** Milliseconds until the next `HH:MM` local time after `now`. */
export function msUntilDaily(time: string, now = new Date()): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) throw new Error(`Expected HH:MM, got "${time}"`);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Run a report job on an interval or daily at a time. Overlapping runs are skipped. Returns a stop function. */
export function scheduleReport(opts: ScheduleOptions): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await opts.run();
    } catch (e) {
      opts.onError?.(e);
    } finally {
      running = false;
    }
  };
  const next = () => {
    if (stopped) return;
    const delay = typeof opts.every === 'number' ? opts.every : msUntilDaily(opts.every.slice('daily@'.length));
    timer = setTimeout(async () => {
      await fire();
      next();
    }, delay);
  };
  if (opts.immediate) void fire();
  next();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
