import type { AgentTool } from './agent';
import { runTool } from './agent';

// ---------------------------------------------------------------- types

export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Provider-neutral conversation; the adapters translate it to each API's format. */
export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AgentToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: unknown; isError?: boolean };

export interface AgentReply {
  text?: string;
  toolCalls?: AgentToolCall[];
}

/** One model turn: see the conversation and the tools, answer with text and/or tool calls. */
export type AgentLLM = (req: { system: string; messages: AgentMessage[]; tools: AgentTool[]; signal?: AbortSignal }) => Promise<AgentReply>;

export interface AgentStep {
  call: AgentToolCall;
  result: unknown;
  error?: string;
  /** The tool changes the model or report. */
  write: boolean;
  /** Declined by `beforeTool`. */
  skipped?: boolean;
}

export interface RunAgentOptions {
  llm: AgentLLM;
  tools: AgentTool[];
  prompt: string;
  system?: string;
  /** Earlier conversation, to continue it. */
  messages?: AgentMessage[];
  /** Model turns before giving up (default 16). */
  maxSteps?: number;
  signal?: AbortSignal;
  /** Called before each tool call (e.g. to preview and confirm writes); return false to skip it. */
  beforeTool?: (call: AgentToolCall, write: boolean) => boolean | Promise<boolean>;
  onStep?: (step: AgentStep) => void;
  onText?: (text: string) => void;
}

export interface AgentRun {
  text: string;
  steps: AgentStep[];
  messages: AgentMessage[];
}

/** Tools from `createAgentTools` that change the model or the report. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['add_page', 'add_visual', 'remove_visual', 'set_filters', 'create_measure', 'go_to_page']);

export const AGENT_SYSTEM = [
  'You are a report-building assistant inside PrismBI, a business-intelligence library.',
  'Call describe_model first to learn the tables, columns and measures. Use list_values to find exact filter values.',
  'To show something, use ask to turn a question into a visual spec, then add_visual. Use add_page when asked for a new page.',
  'Keep visuals few and focused, give them clear titles, and finish with one or two sentences on what you built or found.',
].join('\n');

// ---------------------------------------------------------------- loop

/** Run a tool-using agent until it answers without tool calls (or `maxSteps` turns). */
export async function runAgent(o: RunAgentOptions): Promise<AgentRun> {
  const messages: AgentMessage[] = [...(o.messages ?? []), { role: 'user', content: o.prompt }];
  const steps: AgentStep[] = [];
  const max = o.maxSteps ?? 16;
  const system = o.system ?? AGENT_SYSTEM;
  for (let turn = 0; turn < max; turn++) {
    if (o.signal?.aborted) return { text: 'Stopped.', steps, messages };
    const reply = await o.llm({ system, messages, tools: o.tools, signal: o.signal });
    const calls = reply.toolCalls ?? [];
    messages.push({ role: 'assistant', content: reply.text ?? '', ...(calls.length ? { toolCalls: calls } : {}) });
    if (reply.text) o.onText?.(reply.text);
    if (!calls.length) return { text: reply.text ?? '', steps, messages };
    for (const call of calls) {
      if (o.signal?.aborted) return { text: 'Stopped.', steps, messages };
      const write = WRITE_TOOLS.has(call.name);
      const ok = o.beforeTool ? await o.beforeTool(call, write) : true;
      const result = ok ? await runTool(o.tools, call.name, call.input) : { error: 'The user declined this step.' };
      const error = result && typeof result === 'object' && 'error' in result ? String((result as { error: unknown }).error) : undefined;
      const step: AgentStep = { call, result, write, ...(error ? { error } : {}), ...(ok ? {} : { skipped: true }) };
      steps.push(step);
      o.onStep?.(step);
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result, ...(error ? { isError: true } : {}) });
    }
  }
  return { text: `Stopped after ${max} steps.`, steps, messages };
}

// ---------------------------------------------------------------- adapters

export interface HttpLLMOptions {
  /** Endpoint; point it at your own proxy so keys stay on the server. */
  url?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

const toJson = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

async function post(o: HttpLLMOptions, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await (o.fetch ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers, ...o.headers }, body: JSON.stringify(body), signal });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`LLM request failed (${res.status}): ${toJson((data.error as { message?: string })?.message ?? data.error ?? res.statusText)}`);
  return data;
}

/** Anthropic Messages API (or a proxy with the same shape). */
export function anthropicLLM(o: HttpLLMOptions = {}): AgentLLM {
  return async ({ system, messages, tools, signal }) => {
    const out: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
    for (const m of messages) {
      if (m.role === 'user') out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
      else if (m.role === 'assistant') out.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls ?? []).map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input }))] });
      else {
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: toJson(m.content), ...(m.isError ? { is_error: true } : {}) };
        const last = out[out.length - 1];
        if (last?.role === 'user' && (last.content[0] as { type?: string })?.type === 'tool_result') last.content.push(block);
        else out.push({ role: 'user', content: [block] });
      }
    }
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
    if (o.apiKey) Object.assign(headers, { 'x-api-key': o.apiKey, 'anthropic-dangerous-direct-browser-access': 'true' });
    const data = await post(o, o.url ?? 'https://api.anthropic.com/v1/messages', headers, {
      model: o.model ?? 'claude-sonnet-5-5',
      max_tokens: o.maxTokens ?? 2048,
      system,
      messages: out,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    }, signal);
    const blocks = (data.content as { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]) ?? [];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id!, name: b.name!, input: b.input ?? {} })),
    };
  };
}

/** OpenAI-compatible Chat Completions API (OpenAI, Azure OpenAI, Ollama, vLLM, LM Studio…). */
export function openAILLM(o: HttpLLMOptions = {}): AgentLLM {
  return async ({ system, messages, tools, signal }) => {
    const out: Record<string, unknown>[] = [{ role: 'system', content: system }];
    for (const m of messages) {
      if (m.role === 'user') out.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant')
        out.push({ role: 'assistant', content: m.content || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) });
      else out.push({ role: 'tool', tool_call_id: m.toolCallId, content: toJson(m.content) });
    }
    const data = await post(o, o.url ?? 'https://api.openai.com/v1/chat/completions', o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}, {
      model: o.model ?? 'gpt-4o',
      messages: out,
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
    }, signal);
    const msg = ((data.choices as { message?: Record<string, unknown> }[])?.[0]?.message ?? {}) as { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
    return {
      text: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((c) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          /* malformed arguments: the tool reports what is missing */
        }
        return { id: c.id, name: c.function.name, input };
      }),
    };
  };
}

// ---------------------------------------------------------------- built-in planner

const VERB = '(?:show|add|plot|chart|list|compare|include|display|give)';

/** Split "Build a page about bikes: sales by month, top 5 products and show sales by country" into a page name and questions. */
export function planPrompt(prompt: string): { page?: string; questions: string[] } {
  const text = prompt.trim();
  const wantsPage = /\b(?:build|create|make|add|new|design|generate)\b/i.test(text) && /\b(?:page|dashboard)\b/i.test(text);
  let header = '';
  let body = text;
  const colon = text.indexOf(':');
  if (colon >= 0) {
    header = text.slice(0, colon);
    body = text.slice(colon + 1);
  } else if (wantsPage) {
    const m = new RegExp(`^(.*?\\b(?:page|dashboard)\\b)\\s*(?:(?:about|for|on|explaining|covering|showing|with|that shows)\\s+)?(.*)$`, 'is').exec(text);
    if (m) {
      header = m[1];
      body = m[2];
    }
  }
  const questions = body
    .split(new RegExp(`\\s*(?:[;\\n]|,(?:\\s*and\\b)?|\\s+then\\s+|\\s+and\\s+(?=${VERB}\\b|a\\b|an\\b|the\\b|top\\b))\\s*`, 'i'))
    .map((q) => q.replace(new RegExp(`^(?:and\\s+)?(?:${VERB}\\s+(?:me\\s+)?)?`, 'i'), '').replace(/[.!?]+$/, '').trim())
    .filter((q) => q.length > 1)
    .slice(0, 8);
  if (!wantsPage) return { questions };
  const topic = header
    .replace(/^.*?\b(?:page|dashboard)\b/i, '')
    .replace(/^\s*(?:about|for|on|explaining|covering|showing|called|named)\s+/i, '')
    .trim();
  const name = topic || questions[0] || 'New page';
  return { page: name.charAt(0).toUpperCase() + name.slice(1), questions };
}

/**
 * A rule-based stand-in for a language model: splits the prompt into a page and questions, then calls `add_page`,
 * `ask` and `add_visual`. Works offline with no API key; swap in {@link anthropicLLM} or {@link openAILLM} for open-ended requests.
 */
export function ruleBasedLLM(): AgentLLM {
  return async ({ messages }) => {
    const firstUser = [...messages].reverse().find((m) => m.role === 'user') as { content: string } | undefined;
    const start = messages.lastIndexOf(firstUser as AgentMessage);
    const plan = planPrompt(firstUser?.content ?? '');
    const since = messages.slice(start + 1);
    const results = new Map(since.filter((m) => m.role === 'tool').map((m) => [(m as { toolCallId: string }).toolCallId, (m as { content: unknown }).content]));
    let pageDone = !plan.page;
    let next = 0;
    let pending: Record<string, unknown> | null = null;
    const added: string[] = [];
    const missed: string[] = [];
    for (const m of since) {
      if (m.role !== 'assistant') continue;
      for (const c of m.toolCalls ?? []) {
        const r = results.get(c.id) as Record<string, unknown> | undefined;
        if (c.name === 'add_page') pageDone = true;
        else if (c.name === 'ask') {
          const spec = r?.spec as Record<string, unknown> | null | undefined;
          if (spec && Number(r?.confidence ?? 1) >= 0.3) pending = spec;
          else (missed.push(String(c.input.question)), next++);
        } else if (c.name === 'add_visual') {
          if (!r || !('error' in r)) added.push(String((c.input.spec as { title?: string })?.title ?? 'visual'));
          pending = null;
          next++;
        }
      }
    }
    let n = 0;
    const call = (name: string, input: Record<string, unknown>): AgentReply => ({ toolCalls: [{ id: `rule-${since.length}-${n++}`, name, input }] });
    if (!pageDone) return call('add_page', { name: plan.page });
    if (pending) {
      const small = pending.type === 'card' || pending.type === 'multiRowCard';
      return call('add_visual', { spec: pending, ...(small ? { width: 3, height: 4 } : {}) });
    }
    if (next < plan.questions.length) return call('ask', { question: plan.questions[next] });
    const where = plan.page ? ` to “${plan.page}”` : '';
    const parts = [added.length ? `Added ${added.length} visual${added.length === 1 ? '' : 's'}${where}: ${added.join(', ')}.` : `I couldn't build anything from that${plan.questions.length ? '' : ' (no questions found)'}.`];
    if (missed.length) parts.push(`Not understood: ${missed.map((q) => `“${q}”`).join(', ')}. Try naming a measure and a field, e.g. “sales by month”.`);
    return { text: parts.join(' ') };
  };
}
