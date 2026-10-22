import { createVisual, defineVisual, getVisual, registerMenuItems, registerVisual } from '@prismbi/prismbi';
import type { FieldSpec, FilterSpec, MenuContext, Report, RenderContext, VisualSpec } from '@prismbi/prismbi';
import { askSync, suggestQuestions, type AskOptions } from './ask';
import { explain, type Explanation } from './explain';
import { findInsights, type Insight } from './insights';
import { writeNarrative, type NarrativePart } from './narrative';
import { keyInfluencers, type InfluencerOptions, type KeyInfluencers } from './influencers';

// ---------------------------------------------------------------- styles

const CSS = `
.pbi-ai{display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;font-size:12px}
.pbi-ai-ask{display:flex;gap:6px}
.pbi-ai-ask input{flex:1;min-width:0;font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--pbi-border);border-radius:8px;background:var(--pbi-bg);color:var(--pbi-fg)}
.pbi-ai-ask input:focus-visible{outline:2px solid var(--pbi-accent);outline-offset:0}
.pbi-ai-ask button,.pbi-ai-btn{font:inherit;padding:6px 12px;border:1px solid var(--pbi-accent);border-radius:8px;background:var(--pbi-accent);color:#fff;cursor:pointer}
.pbi-ai-chips{display:flex;flex-wrap:wrap;gap:6px}
.pbi-ai-chip{font:inherit;font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid var(--pbi-border);background:transparent;color:var(--pbi-fg-2);cursor:pointer}
.pbi-ai-chip[data-kind=measure]{border-color:var(--pbi-accent);color:var(--pbi-accent)}
.pbi-ai-chip[data-kind=filter]{border-style:dashed}
.pbi-ai-note{color:var(--pbi-fg-3)}
.pbi-ai-result{flex:1;min-height:0;position:relative}
.pbi-ai-result>.pbi-report{height:100%}
.pbi-ai-list{display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;flex:1}
.pbi-ai-item{display:grid;grid-template-columns:20px 1fr;gap:2px 8px;padding:8px 10px;border:1px solid var(--pbi-border);border-radius:8px;cursor:pointer;background:transparent;text-align:left;font:inherit;color:inherit}
.pbi-ai-item:hover{border-color:var(--pbi-accent)}
.pbi-ai-item b{font-weight:600}
.pbi-ai-item span{grid-column:2;color:var(--pbi-fg-2)}
.pbi-ai-icon{grid-row:span 2;font-size:14px;line-height:1.2;color:var(--pbi-accent)}
.pbi-ai-mini{grid-column:1/-1;height:200px;margin-top:6px}
.pbi-ai-panel{position:fixed;z-index:1100;width:min(380px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 24px));overflow:auto;padding:12px 14px;background:var(--pbi-surface);color:var(--pbi-fg);border:1px solid var(--pbi-border);border-radius:10px;box-shadow:0 12px 40px rgb(0 0 0/.22);font:12px/1.5 var(--pbi-font)}
.pbi-ai-panel h3{margin:0 0 6px;font-size:13px}
.pbi-ai-bar{display:grid;grid-template-columns:minmax(0,1fr) 120px auto;gap:8px;align-items:center;margin:4px 0}
.pbi-ai-bar i{display:block;height:8px;border-radius:4px;background:var(--pbi-accent)}
.pbi-ai-bar i.neg{background:var(--pbi-bad)}
.pbi-ai-bar em{font-style:normal;font-variant-numeric:tabular-nums;color:var(--pbi-fg-2)}
.pbi-ai-panel .pbi-ai-mini{height:220px}
.pbi-ai-narrative{height:100%;overflow:auto;font-size:var(--pbi-narrative-size,14px);line-height:1.6}
.pbi-ai-narrative p{margin:0 0 .6em}
.pbi-ai-narrative strong{color:var(--pbi-accent);font-weight:600}
.pbi-ai-narrative small{display:block;color:var(--pbi-fg-3);font-size:11px}
.pbi-ai-ki{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;height:100%;min-height:0}
.pbi-ai-ki>div{display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0}
.pbi-ai-ki h4{margin:0;font-size:12px;font-weight:600;color:var(--pbi-fg-2)}
.pbi-ai-item[aria-pressed=true]{border-color:var(--pbi-accent);background:color-mix(in srgb,var(--pbi-accent) 8%,transparent)}
.pbi-ai-bar.is-on b{color:var(--pbi-accent)}
.pbi-ai-bar{cursor:pointer}
@container (max-width:420px){.pbi-ai-ki{grid-template-columns:1fr}}
.pbi-ai-close{position:absolute;top:6px;right:8px;border:0;background:none;color:var(--pbi-fg-3);font-size:16px;cursor:pointer}
`;

let styled = false;
function injectStyles(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.setAttribute('data-prismbi-ai', '');
  s.textContent = CSS;
  document.head.append(s);
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

/** Mount a nested visual for a spec, inheriting the outer filters; returns its cleanup. */
function mountSpec(ctx: { model: RenderContext['model']; theme: RenderContext['theme'] }, host: HTMLElement, spec: Omit<VisualSpec, 'layout'>, filters: FilterSpec[]): () => void {
  const r = createVisual(host, { ...(spec as VisualSpec), model: ctx.model, theme: ctx.theme, filters: [...filters, ...(spec.filters ?? [])] });
  return () => r.destroy();
}

// ---------------------------------------------------------------- Q&A visual

interface QnaFormat {
  synonyms?: AskOptions['synonyms'];
  placeholder?: string;
  /** Example questions shown before anything is asked (default: generated from the model). */
  suggestions?: string[];
  question?: string;
}

/** Power BI-style Q&A: type a question, get a visual. Page filters apply to the answer. */
export const qnaVisual = /* @__PURE__ */ defineVisual({
  type: 'qna',
  displayName: 'Q&A',
  category: 'other',
  roles: [],
  // no grouping or values: the query only carries the page's filters through to render
  buildQuery: (_ctx, base) => ({ ...base, groupBy: [], values: [] }),
  render(ctx) {
    injectStyles();
    const f = ((ctx.format as Record<string, unknown>).qna ?? {}) as QnaFormat;
    const state = ctx.host.state as { question?: string };
    // compiled page filters: the model accepts them anywhere a filter spec goes
    const filters = [...ctx.data.baseFilters] as unknown as FilterSpec[];
    let cleanup: (() => void) | undefined;
    const input = el('input', { type: 'search', placeholder: f.placeholder ?? 'Ask a question about your data', 'aria-label': 'Question' });
    input.value = state.question ?? f.question ?? '';
    const form = el('form', { class: 'pbi-ai-ask' }, input, el('button', { type: 'submit' }, 'Ask'));
    const chips = el('div', { class: 'pbi-ai-chips' });
    const result = el('div', { class: 'pbi-ai-result' });
    const root = el('div', { class: 'pbi-ai' }, form, chips, result);
    const show = (q: string) => {
      cleanup?.();
      cleanup = undefined;
      chips.replaceChildren();
      result.replaceChildren();
      if (!q.trim()) {
        for (const s of f.suggestions ?? suggestQuestions(ctx.model)) {
          const b = el('button', { type: 'button', class: 'pbi-ai-chip' }, s);
          b.addEventListener('click', () => {
            input.value = s;
            ctx.host.setState({ question: s });
            show(s);
          });
          chips.append(b);
        }
        return;
      }
      const r = askSync(ctx.model, q, { synonyms: f.synonyms });
      for (const i of r.interpretation) chips.append(el('span', { class: 'pbi-ai-chip', 'data-kind': i.kind }, i.text));
      if (r.unmatched.length) chips.append(el('span', { class: 'pbi-ai-note' }, `not understood: ${r.unmatched.join(', ')}`));
      if (!r.spec) {
        result.append(el('div', { class: 'pbi-empty' }, "I couldn't match that to the data. Try naming a measure and a field, like “" + (suggestQuestions(ctx.model, 1)[0] ?? 'sales by category') + '”.'));
        return;
      }
      cleanup = mountSpec(ctx, result, r.spec, filters);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      ctx.host.setState({ question: input.value });
      show(input.value);
    });
    ctx.root.replaceChildren(root);
    show(input.value);
    return () => cleanup?.();
  },
});

// ---------------------------------------------------------------- Insights visual

const ICON: Record<Insight['kind'], string> = { anomaly: '⚠', trend: '↗', mover: '⇅', concentration: '◔', outlier: '★' };
const insightCache = new WeakMap<object, Map<string, Insight[]>>();

/** Automatic insights for the bound measure, recomputed when the page's filters change. Click one to see it. */
export const insightsVisual = /* @__PURE__ */ defineVisual({
  type: 'insights',
  displayName: 'Insights',
  category: 'other',
  roles: [
    { name: 'values', displayName: 'Measure', kind: 'measure', required: true },
    { name: 'dimensions', displayName: 'Look in (optional)', kind: 'grouping', multiple: true },
  ],
  buildQuery: (_ctx, base) => ({ ...base, groupBy: [], values: (base.values ?? []).slice(0, 1) }),
  render(ctx) {
    injectStyles();
    const measure = ctx.fields('values')[0];
    if (!measure) return;
    const dims = ctx.fields('dimensions').map((d) => (typeof d === 'string' ? d : (d.field ?? ''))).filter(Boolean);
    // compiled page filters: the model accepts them anywhere a filter spec goes
    const filters = [...ctx.data.baseFilters] as unknown as FilterSpec[];
    const key = JSON.stringify([measure, dims, filters], (_k, v) => (typeof v === 'function' ? undefined : v instanceof Set ? [...v] : v));
    let cache = insightCache.get(ctx.model);
    if (!cache) insightCache.set(ctx.model, (cache = new Map()));
    let list = cache.get(key);
    if (!list) {
      list = findInsights(ctx.model, { measure, filters, dimensions: dims.length ? dims : undefined, max: (ctx.format as { insights?: { max?: number } }).insights?.max ?? 6 });
      if (cache.size > 50) cache.clear();
      cache.set(key, list);
    }
    const cleanups: (() => void)[] = [];
    const listEl = el('div', { class: 'pbi-ai-list', role: 'list' });
    if (!list.length) listEl.append(el('div', { class: 'pbi-empty' }, 'Nothing unusual found for the current selection.'));
    for (const ins of list) {
      const item = el('button', { type: 'button', class: 'pbi-ai-item', role: 'listitem', 'aria-expanded': 'false' }, el('div', { class: 'pbi-ai-icon', 'aria-hidden': 'true' }, ICON[ins.kind]), el('b', {}, ins.title), el('span', {}, ins.detail));
      let mini: HTMLElement | null = null;
      let off: (() => void) | undefined;
      item.addEventListener('click', () => {
        if (mini) {
          off?.();
          mini.remove();
          mini = null;
          item.setAttribute('aria-expanded', 'false');
          return;
        }
        if (!ins.spec) return;
        mini = el('div', { class: 'pbi-ai-mini' });
        item.append(mini);
        off = mountSpec(ctx, mini, ins.spec, []);
        cleanups.push(() => off?.());
        item.setAttribute('aria-expanded', 'true');
      });
      listEl.append(item);
    }
    ctx.root.replaceChildren(el('div', { class: 'pbi-ai' }, listEl));
    return () => cleanups.forEach((c) => c());
  },
});

// ---------------------------------------------------------------- Narrative visual

/** Rewrites the rule-based facts in natural language (e.g. with your LLM endpoint). */
export type NarrativeWriter = (facts: string, info: { measures: string[]; filters: FilterSpec[] }) => Promise<string>;

let narrativeWriter: NarrativeWriter | null = null;
const narrativeCache = new Map<string, string | Promise<string>>();

/** Let narrative visuals reword their summary with a language model (`null` turns it off). Results are cached per filter state. */
export function setNarrativeWriter(fn: NarrativeWriter | null): void {
  narrativeWriter = fn;
  narrativeCache.clear();
}

// model data changes invalidate cached narratives
const modelEpoch = new WeakMap<object, { n: number }>();
function epochOf(model: RenderContext['model']): number {
  let e = modelEpoch.get(model);
  if (!e) {
    const box = { n: 0 };
    model.onChange(() => void box.n++);
    modelEpoch.set(model, (e = box));
  }
  return e.n;
}

interface NarrativeFormat {
  /** Custom text with `{[Measure]}` values and `{summary}` (the automatic summary). */
  text?: string;
  /** Insights appended to the summary (default 2). */
  insights?: number;
  /** Use the narrative writer when one is set (default true). */
  llm?: boolean;
  fontSize?: number;
}

const partsToNodes = (parts: NarrativePart[]) => parts.map((p) => (typeof p === 'string' ? p : el('strong', {}, p.value)));

/** Smart narrative: a plain-language summary of the bound measures that updates with filters and selections. */
export const narrativeVisual = /* @__PURE__ */ defineVisual({
  type: 'narrative',
  displayName: 'Narrative',
  category: 'other',
  roles: [
    { name: 'values', displayName: 'Measures', kind: 'measure', multiple: true, required: true },
    { name: 'category', displayName: 'Breakdown (optional)', kind: 'grouping' },
  ],
  // the breakdown query: the first measure by the category (the summary runs its own queries)
  buildQuery: (_ctx, base) => ({ ...base, values: (base.values ?? []).slice(0, 1) }),
  render(ctx) {
    injectStyles();
    const measures = ctx.fields('values');
    if (!measures.length) return;
    const nf = ((ctx.format as { narrative?: NarrativeFormat }).narrative ?? {}) as NarrativeFormat;
    const filters = [...ctx.data.baseFilters] as unknown as FilterSpec[];
    const key = JSON.stringify([measures, filters, nf.text, nf.insights, epochOf(ctx.model), ctx.data.rows.length], (_k, v) => (typeof v === 'function' ? undefined : v instanceof Set ? [...v] : v));
    const n = writeNarrative(ctx.model, { measures, filters, breakdown: ctx.data.groups.length ? ctx.data : undefined, insights: nf.insights, template: nf.text });
    const box = el('div', { class: 'pbi-ai-narrative', 'aria-live': 'polite' });
    if (nf.fontSize) box.style.setProperty('--pbi-narrative-size', `${nf.fontSize}px`);
    box.dataset.key = key;
    const paras = nf.text ? n.sentences : [n.sentences.flatMap((s, i) => (i ? [' ', ...s] : s))];
    const showRules = () => box.replaceChildren(...paras.map((p) => el('p', {}, ...partsToNodes(p))));
    const showLlm = (text: string) => box.replaceChildren(...text.split(/\n{2,}/).map((p) => el('p', {}, p.trim())), el('small', {}, 'AI-written from the current figures'));
    showRules();
    const writer = narrativeWriter;
    if (writer && nf.llm !== false && !nf.text) {
      const hit = narrativeCache.get(key);
      if (typeof hit === 'string') showLlm(hit);
      else {
        const job = hit ?? writer(n.text, { measures: measures.map((m) => (typeof m === 'string' ? m : (m.field ?? ''))), filters });
        if (!hit) {
          if (narrativeCache.size > 100) narrativeCache.clear();
          narrativeCache.set(key, job);
          job.then((t) => narrativeCache.set(key, t), () => narrativeCache.delete(key));
        }
        job.then((t) => box.isConnected && box.dataset.key === key && showLlm(t)).catch(() => {});
      }
    }
    ctx.root.replaceChildren(box);
  },
});

// ---------------------------------------------------------------- Explain this

let openPanel: HTMLElement | null = null;

function closePanel(): void {
  openPanel?.dispatchEvent(new Event('pbi-close'));
  openPanel?.remove();
  openPanel = null;
}

/** Floating panel near the pointer (closes on Escape or outside click). */
export function showPanel(x: number, y: number, content: HTMLElement, container: HTMLElement = document.body): HTMLElement {
  injectStyles();
  closePanel();
  // inside the report root the theme's CSS variables apply
  const panel = el('div', { class: 'pbi-ai-panel', role: 'dialog', 'aria-label': 'Explanation' });
  const close = el('button', { class: 'pbi-ai-close', type: 'button', 'aria-label': 'Close' }, '×');
  close.addEventListener('click', closePanel);
  panel.append(close, content);
  container.append(panel);
  const w = panel.offsetWidth || 380;
  const h = panel.offsetHeight || 300;
  panel.style.left = `${Math.max(12, Math.min(x, innerWidth - w - 12))}px`;
  panel.style.top = `${Math.max(12, Math.min(y, innerHeight - h - 12))}px`;
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closePanel();
  const onDown = (e: MouseEvent) => !panel.contains(e.target as Node) && closePanel();
  setTimeout(() => {
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
  });
  panel.addEventListener('pbi-close', () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onDown);
  });
  openPanel = panel;
  return panel;
}

/** First measure bound to a visual (the value an explanation is about). */
function visualMeasure(spec: VisualSpec): FieldSpec | undefined {
  const def = getVisual(spec.type);
  for (const role of def.roles) {
    if (role.kind !== 'measure') continue;
    const f = spec.fields?.[role.name];
    const first = Array.isArray(f) ? f[0] : f;
    if (first) return first;
  }
  return undefined;
}

export function renderExplanation(x: Explanation, theme?: { model: RenderContext['model']; theme: RenderContext['theme'] }): HTMLElement {
  const box = el('div', {}, el('h3', {}, x.mode === 'change' ? `Why ${x.measure} changed` : `What makes up ${x.measure}`), el('p', {}, x.summary));
  const max = Math.max(...x.drivers.map((d) => Math.abs(d.delta)), 1);
  for (const d of x.drivers) {
    const bar = el('i', { class: d.delta < 0 ? 'neg' : '' });
    bar.style.width = `${Math.max(4, (Math.abs(d.delta) / max) * 120)}px`;
    const col = /\[([^\]]+)\]$/.exec(d.column)?.[1] ?? d.column;
    box.append(el('div', { class: 'pbi-ai-bar' }, el('span', { title: col }, `${/^name$/i.test(col) ? '' : `${col}: `}${String(d.value)}`), bar, el('em', {}, `${Math.round(Math.abs(d.share) * 100)}%`)));
  }
  if (x.spec && theme) {
    const mini = el('div', { class: 'pbi-ai-mini' });
    box.append(mini);
    const off = mountSpec(theme, mini, x.spec, []);
    box.addEventListener('pbi-detach', off);
  }
  return box;
}

let unregisterExplain: (() => void) | null = null;

/** Add "Explain this" to every data point's context menu (on by default when importing `@prismbi/prismbi/ai`). */
export function enableExplain(enabled = true): void {
  unregisterExplain?.();
  unregisterExplain = null;
  if (!enabled) return;
  unregisterExplain = registerMenuItems((c: MenuContext) => {
    const measure = visualMeasure(c.spec);
    if (!measure || !c.identity.columns.length) return [];
    return [
      {
        label: 'Explain this',
        hint: 'AI',
        onClick: () => {
          const pointFilters: FilterSpec[] = c.identity.columns.map((col, i) => ({ target: `'${col.table}'[${col.column}]`, op: 'eq', value: c.identity.values[i] }));
          const result = explain(c.report.model, { measure, filters: [...c.filters, ...pointFilters] });
          const panel = showPanel(c.event.clientX + 8, c.event.clientY + 8, renderExplanation(result, { model: c.report.model, theme: (c.report as Report & { theme: RenderContext['theme'] }).theme }), c.report.root);
          panel.addEventListener('pbi-close', () => panel.querySelector('div')?.dispatchEvent(new Event('pbi-detach')));
        },
      },
    ];
  });
}

/** Register the Q&A and Insights visuals and the "Explain this" menu item. Called on import. */
const kiCache = new WeakMap<object, Map<string, KeyInfluencers>>();

/** Key influencers: which column values move a measure most, with the chosen column's breakdown against the average. */
export const keyInfluencersVisual = /* @__PURE__ */ defineVisual({
  type: 'keyInfluencers',
  displayName: 'Key influencers',
  category: 'other',
  roles: [
    { name: 'values', displayName: 'Analyze', kind: 'measure', required: true },
    { name: 'explainBy', displayName: 'Explain by (optional)', kind: 'grouping', multiple: true },
  ],
  buildQuery: (_ctx, base) => ({ ...base, groupBy: [], values: (base.values ?? []).slice(0, 1) }),
  render(ctx) {
    injectStyles();
    const measure = ctx.fields('values')[0];
    if (!measure) return;
    const explainBy = ctx.fields('explainBy').map((d) => (typeof d === 'string' ? d : (d.field ?? ''))).filter(Boolean);
    const filters = [...ctx.data.baseFilters] as unknown as FilterSpec[];
    const fo = ((ctx.format as { keyInfluencers?: Partial<InfluencerOptions> }).keyInfluencers ?? {}) as Partial<InfluencerOptions>;
    const key = JSON.stringify([measure, explainBy, filters, fo], (_k, v) => (typeof v === 'function' ? undefined : v instanceof Set ? [...v] : v));
    let cache = kiCache.get(ctx.model);
    if (!cache) kiCache.set(ctx.model, (cache = new Map()));
    let ki = cache.get(key);
    if (!ki) {
      ki = keyInfluencers(ctx.model, { ...fo, measure, explainBy, filters, max: fo.max ?? 8 });
      if (cache.size > 50) cache.clear();
      cache.set(key, ki);
    }
    const res = ki;
    const wrap = el('div', { class: 'pbi-ai-ki', style: 'container-type:inline-size' });
    const left = el('div', { role: 'list' }, el('h4', {}, `What influences ${res.metric}`));
    const right = el('div', {});
    wrap.append(left, right);
    // the chosen influencer (by label) picks the column shown on the right
    const state = ctx.host.state as { kiPick?: string };
    const pick = res.influencers.find((i) => i.label === state.kiPick) ?? res.influencers[0];
    const column = pick?.column ?? res.columns[0]?.column;
    const ref = (r: string) => {
      const m = /^'?(.*?)'?\[([^\]]+)\]$/.exec(r);
      return m ? { table: m[1], column: m[2] } : null;
    };
    const drawColumn = () => {
      const col = res.columns.find((c) => c.column === column);
      right.replaceChildren();
      if (!col) return;
      right.append(el('h4', {}, `${res.metric} by ${col.name}`));
      const segs = [...col.segments].sort((a, b) => b.segment - a.segment);
      const max = Math.max(...segs.map((x) => Math.abs(x.segment)), Math.abs(res.overall ?? 0), 1e-12);
      const chosen = res.influencers.filter((i) => i.column === col.column).map((i) => i.label);
      for (const sg of segs) {
        const on = chosen.includes(`${col.name} is ${sg.label}`);
        const bar = el('i', { class: sg.segment < (res.overall ?? 0) ? 'neg' : '', style: `width:${Math.max(2, (Math.abs(sg.segment) / max) * 100).toFixed(1)}%` });
        const row = el('div', { class: `pbi-ai-bar${on ? ' is-on' : ''}`, role: 'button', tabindex: '0', title: `${sg.label}: ${res.format(sg.segment)}${Number.isFinite(sg.share) ? ` · ${(sg.share * 100).toFixed(1)}% of rows` : ''}` }, el('b', {}, sg.label), el('div', {}, bar), el('em', {}, res.format(sg.segment)));
        const c = ref(col.column);
        const select = (e: Event) => {
          e.stopPropagation();
          if (c) ctx.host.select({ columns: [c], values: [sg.value] }, { multi: (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey });
        };
        row.addEventListener('click', select);
        row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), select(e)));
        right.append(row);
      }
      if (res.overall !== null) right.append(el('div', { class: 'pbi-ai-note' }, `Average: ${res.format(res.overall)}`));
    };
    if (!res.influencers.length) left.append(el('div', { class: 'pbi-empty' }, 'No column value moves this measure much in the current selection.'));
    for (const inf of res.influencers) {
      const item = el('button', { type: 'button', class: 'pbi-ai-item', role: 'listitem', 'aria-pressed': String(inf === pick) }, el('div', { class: 'pbi-ai-icon', 'aria-hidden': 'true' }, inf.direction === 'up' ? '▲' : '▼'), el('b', {}, `When ${inf.label}`), el('span', {}, `${res.metric} is ${inf.effect} (${res.format(inf.segment)} vs ${res.format(inf.overall)})`));
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.host.setState({ kiPick: inf.label });
      });
      left.append(item);
    }
    drawColumn();
    ctx.root.replaceChildren(wrap);
  },
});

export function registerAI(): void {
  registerVisual(keyInfluencersVisual, ['influencers']);
  registerVisual(qnaVisual);
  registerVisual(insightsVisual);
  registerVisual(narrativeVisual);
  enableExplain();
}
