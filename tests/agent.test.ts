import { describe, expect, it, vi } from 'vitest';
import { agentPanel, anthropicLLM, createAgentTools, openAILLM, planPrompt, ruleBasedLLM, runAgent } from '@prismbi/prismbi/ai';
import type { AgentLLM } from '@prismbi/prismbi/ai';
import { Studio } from '@prismbi/prismbi/studio';
import { buildModel } from '../examples/model';

const mountStudio = () => {
  const el = document.createElement('div');
  el.style.height = '700px';
  document.body.append(el);
  const studio = new Studio(el, { model: buildModel(), starter: 'blank' });
  return { el, studio };
};

describe('planPrompt', () => {
  it('splits a page request into a name and questions', () => {
    expect(planPrompt('Build a page explaining Q3: sales by month, top 5 products by sales and show sales by country')).toEqual({
      page: 'Q3',
      questions: ['sales by month', 'top 5 products by sales', 'sales by country'],
    });
    expect(planPrompt('create a dashboard about sales by region')).toEqual({ page: 'Sales by region', questions: ['sales by region'] });
    expect(planPrompt('show sales by category')).toEqual({ questions: ['sales by category'] });
  });
});

describe('runAgent', () => {
  it('loops through tool calls and stops when the model answers', async () => {
    const tools = createAgentTools({ model: buildModel() });
    let turn = 0;
    const llm: AgentLLM = async ({ messages }) => {
      turn++;
      if (turn === 1) return { toolCalls: [{ id: 't1', name: 'evaluate_dax', input: { expression: '[Total Sales]' } }] };
      const last = messages[messages.length - 1] as { role: string; content: { value: number } };
      expect(last.role).toBe('tool');
      return { text: `Total is ${last.content.value > 0 ? 'positive' : 'zero'}` };
    };
    const steps: string[] = [];
    const r = await runAgent({ llm, tools, prompt: 'what is total sales?', onStep: (s) => steps.push(s.call.name) });
    expect(r.text).toBe('Total is positive');
    expect(steps).toEqual(['evaluate_dax']);
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('reports declined steps back to the model', async () => {
    const tools = createAgentTools({ model: buildModel() });
    const llm: AgentLLM = async ({ messages }) => (messages.length === 1 ? { toolCalls: [{ id: 'x', name: 'create_measure', input: { name: 'M', expression: '1' } }] } : { text: 'ok' });
    const r = await runAgent({ llm, tools, prompt: 'p', beforeTool: (_c, write) => !write });
    expect(r.steps[0]).toMatchObject({ skipped: true, write: true, error: 'The user declined this step.' });
  });
});

describe('LLM adapters', () => {
  const tools = createAgentTools({ model: buildModel() }).slice(0, 2);
  const history = [
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c1', name: 'describe_model', input: {} }, { id: 'c2', name: 'list_values', input: { column: 'Product[Category]' } }] },
    { role: 'tool' as const, toolCallId: 'c1', name: 'describe_model', content: { tables: [] } },
    { role: 'tool' as const, toolCallId: 'c2', name: 'list_values', content: { error: 'x' }, isError: true },
  ];

  it('anthropicLLM maps messages and tool_use blocks', async () => {
    const fetch = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      const body = JSON.parse(init.body);
      expect(body.messages).toHaveLength(3);
      expect(body.messages[2].content.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(['c1', 'c2']);
      expect(body.messages[2].content[1].is_error).toBe(true);
      expect(body.tools[0].input_schema).toBeTruthy();
      expect(init.headers['anthropic-version']).toBe('2023-06-01');
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'u1', name: 'ask', input: { question: 'q' } }] }));
    });
    const r = await anthropicLLM({ url: '/llm', fetch: fetch as never })({ system: 's', messages: history, tools });
    expect(r).toEqual({ text: 'Hi', toolCalls: [{ id: 'u1', name: 'ask', input: { question: 'q' } }] });
  });

  it('openAILLM maps tool_calls and reports HTTP errors', async () => {
    const ok = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool']);
      expect(body.messages[2].tool_calls[1].function.arguments).toBe('{"column":"Product[Category]"}');
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'k', function: { name: 'ask', arguments: '{"question":"q"}' } }] } }] }));
    });
    expect(await openAILLM({ fetch: ok as never })({ system: 's', messages: history, tools })).toEqual({ text: '', toolCalls: [{ id: 'k', name: 'ask', input: { question: 'q' } }] });
    const bad = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
    await expect(openAILLM({ fetch: bad as never })({ system: 's', messages: history, tools })).rejects.toThrow(/401.*bad key/);
  });
});

describe('Studio agent panel', () => {
  it('builds a three-visual page from one prompt, with undo per step', async () => {
    const { el, studio } = mountStudio();
    const panel = agentPanel(studio, { llm: ruleBasedLLM() });
    expect(el.querySelector('button[title^="Build and change"]')).toBeTruthy();
    const pagesBefore = studio.report.pageList.length;
    const r = await panel.run('Build a page explaining Q3: sales by month, top 5 products by sales, sales by country');
    expect(r.text).toMatch(/Added 3 visuals to “Q3”/);
    expect(studio.report.pageList.length).toBe(pagesBefore + 1);
    expect(studio.report.currentPage.name).toBe('Q3');
    const page = () => studio.document.report.pages.find((p) => p.name === 'Q3');
    expect(page()!.visuals).toHaveLength(3);
    expect(panel.steps.map((s) => s.call.name)).toEqual(['add_page', 'ask', 'add_visual', 'ask', 'add_visual', 'ask', 'add_visual']);
    // undo the last visual only
    panel.undoStep(6);
    expect(page()!.visuals).toHaveLength(2);
    expect(panel.element.querySelectorAll('li.is-undone')).toHaveLength(1);
    // the Studio's own undo history still works on top
    studio.undo();
    expect(page()!.visuals).toHaveLength(3);
    // undoing the page step reverts everything after it
    panel.undoStep(0);
    expect(page()).toBeUndefined();
    panel.destroy();
    studio.destroy();
    el.remove();
  });

  it('previews changes and waits for Apply or Skip when confirmWrites is on', async () => {
    const { el, studio } = mountStudio();
    const panel = agentPanel(studio, { confirmWrites: true });
    const click = async (label: string) => {
      for (let i = 0; i < 50 && !panel.element.querySelector('li.is-pending'); i++) await new Promise((r) => setTimeout(r, 0));
      [...panel.element.querySelectorAll<HTMLButtonElement>('li.is-pending button')].find((x) => x.textContent === label)!.click();
    };
    const first = panel.run('show sales by category');
    await click('Skip');
    const run1 = await first;
    expect(run1.steps[run1.steps.length - 1]).toMatchObject({ skipped: true });
    expect(studio.report.toJSON().pages[0].visuals).toHaveLength(0);
    const second = panel.run('show sales by category');
    await click('Apply');
    await second;
    expect(studio.report.toJSON().pages[0].visuals).toHaveLength(1);
    panel.destroy();
    studio.destroy();
    el.remove();
  });
});
