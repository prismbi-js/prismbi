import type { Studio } from '@prismbi/prismbi/studio';
import { createAgentTools, type AgentTool } from './agent';
import type { AskOptions } from './ask';
import { ruleBasedLLM, runAgent, type AgentLLM, type AgentMessage, type AgentRun, type AgentStep, type AgentToolCall } from './run';

const CSS = `
.pbi-agent{position:absolute;top:44px;right:0;bottom:0;z-index:40;width:min(360px,100%);display:flex;flex-direction:column;gap:8px;padding:10px 12px;box-sizing:border-box;background:var(--pbi-surface);color:var(--pbi-fg);border-left:1px solid var(--pbi-border);box-shadow:-8px 0 24px rgb(0 0 0/.12);font:12.5px/1.45 var(--pbi-font)}
.pbi-agent[hidden]{display:none}
.pbi-agent header{display:flex;align-items:center;gap:8px}
.pbi-agent header b{flex:1;font-size:13px}
.pbi-agent-log{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.pbi-agent-log li{padding:7px 9px;border:1px solid var(--pbi-border);border-radius:8px}
.pbi-agent-log li.is-user{background:color-mix(in srgb,var(--pbi-accent) 10%,transparent);border-color:transparent}
.pbi-agent-log li.is-text{border-style:dashed}
.pbi-agent-log li.is-error{border-color:var(--pbi-bad)}
.pbi-agent-log li.is-undone{opacity:.5;text-decoration:line-through}
.pbi-agent-step{display:flex;gap:6px;align-items:baseline}
.pbi-agent-step span{flex:1;min-width:0;overflow-wrap:anywhere}
.pbi-agent-step code{font:11px ui-monospace,Consolas,monospace;color:var(--pbi-accent)}
.pbi-agent details{margin-top:4px;color:var(--pbi-fg-2)}
.pbi-agent pre{margin:4px 0 0;max-height:160px;overflow:auto;font:11px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap}
.pbi-agent-btn{font:inherit;font-size:11.5px;padding:3px 9px;border:1px solid var(--pbi-border);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.pbi-agent-btn.is-primary{background:var(--pbi-accent);border-color:var(--pbi-accent);color:#fff}
.pbi-agent-btn:disabled{opacity:.45;cursor:default}
.pbi-agent-chips{display:flex;flex-wrap:wrap;gap:6px}
.pbi-agent form{display:flex;flex-direction:column;gap:6px}
.pbi-agent textarea{font:inherit;min-height:58px;resize:vertical;padding:7px 9px;border:1px solid var(--pbi-border);border-radius:8px;background:var(--pbi-bg);color:var(--pbi-fg)}
.pbi-agent-actions{display:flex;gap:6px;justify-content:flex-end;align-items:center}
.pbi-agent-actions small{flex:1;color:var(--pbi-fg-3)}
`;

let styled = false;
function injectStyles(doc: Document): void {
  if (styled) return;
  styled = true;
  const s = doc.createElement('style');
  s.setAttribute('data-prismbi-agent', '');
  s.textContent = CSS;
  doc.head.append(s);
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

export interface AgentPanelOptions {
  /** The language model; default {@link ruleBasedLLM} (offline, rule-based). */
  llm?: AgentLLM;
  /** Tools to offer; default `createAgentTools({ model, report })` for the Studio's model and report. */
  tools?: AgentTool[];
  system?: string;
  /** Show each change and wait for Apply or Skip before running it (default false: apply, with undo per step). */
  confirmWrites?: boolean;
  maxSteps?: number;
  ask?: AskOptions;
  /** Example prompts shown as chips. */
  suggestions?: string[];
  /** Start open (default false). */
  open?: boolean;
}

export interface AgentPanel {
  readonly element: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Run a prompt as if typed into the panel. */
  run(prompt: string): Promise<AgentRun>;
  /** Restore the document from before a step (and drop that step and later ones). */
  undoStep(index: number): void;
  readonly steps: readonly AgentStep[];
  destroy(): void;
}

/** One-line summary of a tool call for the log. */
export function describeCall(c: AgentToolCall): string {
  const i = c.input;
  switch (c.name) {
    case 'add_page':
      return `Add page “${String(i.name)}”`;
    case 'add_visual': {
      const s = (i.spec ?? {}) as { type?: string; title?: string };
      return `Add ${s.type ?? 'visual'}${s.title ? ` “${s.title}”` : ''}`;
    }
    case 'ask':
      return `Ask “${String(i.question)}”`;
    case 'create_measure':
      return `Create measure [${String(i.name)}]`;
    case 'remove_visual':
      return `Remove visual ${String(i.id)}`;
    case 'set_filters':
      return `Set ${String(i.scope ?? 'report')} filters (${Array.isArray(i.filters) ? i.filters.length : 0})`;
    case 'go_to_page':
      return `Go to page “${String(i.page)}”`;
    default:
      return c.name.replace(/_/g, ' ');
  }
}

/**
 * An agent panel for the Studio: type a request ("build a page explaining Q3: sales by month, top products, sales by
 * country"), and the agent plans and runs tool calls on the report. Every change is logged with a preview of its input
 * and result, and each one can be undone. Bring your own LLM endpoint with `anthropicLLM` / `openAILLM`, or use the
 * built-in rule-based planner.
 */
export function agentPanel(studio: Studio, opts: AgentPanelOptions = {}): AgentPanel {
  injectStyles(studio.root.ownerDocument);
  const llm = opts.llm ?? ruleBasedLLM();
  const tools = opts.tools ?? createAgentTools({ model: studio.model, report: studio.report, ask: opts.ask });
  const log = el('ul', { class: 'pbi-agent-log', 'aria-live': 'polite', 'aria-label': 'Agent steps' });
  const input = el('textarea', { 'aria-label': 'Ask the agent', placeholder: 'Build a page about bikes: sales by month, top 5 products, sales by country' }) as HTMLTextAreaElement;
  const runBtn = el('button', { type: 'submit', class: 'pbi-agent-btn is-primary' }, 'Run') as HTMLButtonElement;
  const stopBtn = el('button', { type: 'button', class: 'pbi-agent-btn' }, 'Stop') as HTMLButtonElement;
  stopBtn.disabled = true;
  const status = el('small', { role: 'status' });
  const form = el('form', {}, input, el('div', { class: 'pbi-agent-actions' }, status, stopBtn, runBtn));
  const closeBtn = el('button', { type: 'button', class: 'pbi-agent-btn', 'aria-label': 'Close agent panel' }, '×');
  const chips = el('div', { class: 'pbi-agent-chips' });
  for (const s of opts.suggestions ?? []) {
    const b = el('button', { type: 'button', class: 'pbi-agent-btn' }, s);
    b.addEventListener('click', () => void panel.run(s));
    chips.append(b);
  }
  const root = el('aside', { class: 'pbi-agent', 'aria-label': 'AI agent' }, el('header', {}, el('b', {}, '✦ Agent'), closeBtn), log, chips, form);
  root.hidden = !opts.open;
  studio.root.append(root);
  const toggleBtn = studio.addToolbarButton('✦ Agent', () => panel.toggle(), { title: 'Build and change the report by asking', 'aria-expanded': String(!!opts.open) });

  const steps: AgentStep[] = [];
  const snapshots: string[] = [];
  const rows: HTMLElement[] = [];
  let messages: AgentMessage[] = [];
  let busy: AbortController | null = null;

  const pre = (v: unknown) => el('pre', {}, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  const item = (cls: string, ...kids: (Node | string)[]) => {
    const li = el('li', { class: cls }, ...kids);
    log.append(li);
    li.scrollIntoView?.({ block: 'nearest' });
    return li;
  };

  const confirm = (call: AgentToolCall) =>
    new Promise<boolean>((resolve) => {
      const apply = el('button', { type: 'button', class: 'pbi-agent-btn is-primary' }, 'Apply');
      const skip = el('button', { type: 'button', class: 'pbi-agent-btn' }, 'Skip');
      const li = item('is-pending', el('div', { class: 'pbi-agent-step' }, el('span', {}, `Preview: ${describeCall(call)}`), skip, apply), el('details', { open: '' }, el('summary', {}, 'Input'), pre(call.input)));
      const done = (ok: boolean) => (li.remove(), resolve(ok));
      apply.addEventListener('click', () => done(true));
      skip.addEventListener('click', () => done(false));
      busy?.signal.addEventListener('abort', () => done(false));
    });

  const undoStep = (index: number) => {
    const snap = snapshots[index];
    if (snap === undefined || busy) return;
    studio.restore(snap);
    for (let k = index; k < steps.length; k++) {
      rows[k]?.classList.add('is-undone');
      rows[k]?.querySelector('button')?.setAttribute('disabled', '');
      snapshots[k] = undefined as unknown as string;
    }
    // tell the model on the next turn that these changes were reverted
    messages.push({ role: 'user', content: `(I undid: ${steps.slice(index).filter((s) => s.write).map((s) => describeCall(s.call)).join('; ')})` }, { role: 'assistant', content: 'Understood.' });
    studio.toast('Agent step undone');
  };

  const panel: AgentPanel = {
    element: root,
    get isOpen() {
      return !root.hidden;
    },
    get steps() {
      return steps;
    },
    open() {
      root.hidden = false;
      toggleBtn.setAttribute('aria-expanded', 'true');
      input.focus();
    },
    close() {
      root.hidden = true;
      toggleBtn.setAttribute('aria-expanded', 'false');
    },
    toggle() {
      if (root.hidden) panel.open();
      else panel.close();
    },
    undoStep,
    async run(prompt) {
      if (busy) throw new Error('The agent is already running');
      busy = new AbortController();
      runBtn.disabled = true;
      stopBtn.disabled = false;
      status.textContent = 'Working…';
      item('is-user', prompt);
      let before = JSON.stringify(studio.document);
      try {
        const result = await runAgent({
          llm,
          tools,
          prompt,
          system: opts.system,
          messages,
          maxSteps: opts.maxSteps,
          signal: busy.signal,
          beforeTool: async (call, write) => {
            studio.commit();
            before = JSON.stringify(studio.document);
            return write && opts.confirmWrites ? confirm(call) : true;
          },
          onStep: (step) => {
            studio.commit();
            const index = steps.length;
            steps.push(step);
            const undo = el('button', { type: 'button', class: 'pbi-agent-btn', 'aria-label': `Undo ${describeCall(step.call)}` }, 'Undo') as HTMLButtonElement;
            undo.addEventListener('click', () => undoStep(index));
            const changed = step.write && !step.error && !step.skipped;
            snapshots[index] = changed ? before : (undefined as unknown as string);
            const li = item(
              step.error ? 'is-error' : '',
              el('div', { class: 'pbi-agent-step' }, el('code', {}, step.skipped ? 'skipped' : step.write ? 'change' : 'read'), el('span', {}, describeCall(step.call)), ...(changed ? [undo] : [])),
              el('details', {}, el('summary', {}, step.error ? `Error: ${step.error}` : 'Details'), pre({ input: step.call.input, result: step.result })),
            );
            rows[index] = li;
          },
        });
        messages = result.messages;
        if (result.text) item('is-text', result.text);
        status.textContent = '';
        return result;
      } catch (e) {
        item('is-error', `Agent failed: ${(e as Error).message}`);
        status.textContent = '';
        throw e;
      } finally {
        busy = null;
        runBtn.disabled = false;
        stopBtn.disabled = true;
      }
    },
    destroy() {
      busy?.abort();
      root.remove();
      toggleBtn.remove();
    },
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = input.value.trim();
    if (!p || busy) return;
    input.value = '';
    panel.run(p).catch(() => {});
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit?.();
  });
  stopBtn.addEventListener('click', () => busy?.abort());
  closeBtn.addEventListener('click', () => panel.close());
  return panel;
}
