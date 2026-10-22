import { describe, expect, it } from 'vitest';
import { ask, askSync, contextToPrompt, createAgentTools, explain, findInsights, getAIContext, runTool, suggestQuestions, toAnthropicTools, toMcpTools, toOpenAITools } from '@prismbi/prismbi/ai';
import { Report, createVisual } from '../src/index';
import { buildModel } from '../examples/model';

const model = buildModel();

describe('ask', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['total sales by category', { type: 'clusteredColumn', fields: { category: 'Product[Category]', values: ['Total Sales'] } }],
    ['sales trend by month in 2025', { type: 'line', fields: { category: 'Date[Month]', values: ['Total Sales'] }, filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }] }],
    ['sales by month', { type: 'line', fields: { category: 'Date[MonthYear]', values: ['Total Sales'] } }],
    ['top 5 products by profit', { type: 'clusteredBar', top: 5, fields: { category: 'Product[Name]', values: ['Total Profit'] }, sort: { field: 'Total Profit', direction: 'desc' } }],
    ['margin % by region as a table', { type: 'table', fields: { columns: ['Region[Region]', 'Margin %'] } }],
    ['orders in Canada last year', { type: 'card', fields: { value: 'Orders' }, filters: [{ target: 'Date[Year]', op: 'eq', value: 2024 }, { target: 'Region[Region]', op: 'eq', value: 'Canada' }] }],
    ['average quantity by channel', { fields: { category: 'Sales[Channel]', values: [{ field: 'Sales[Quantity]', aggregation: 'avg' }] } }],
    ['share of sales by region group', { type: 'donut', fields: { legend: 'Region[Group]', values: 'Total Sales' } }],
    ['sales and profit by category and year', { fields: { values: ['Total Sales', 'Total Profit'] } }],
    ['sunburst of sales by category and subcategory', { type: 'sunburst', fields: { category: ['Product[Category]', 'Product[Subcategory]'], values: 'Total Sales' } }],
  ];
  it.each(cases)('%s', (q, expected) => {
    const r = askSync(model, q);
    expect(r.spec).toMatchObject(expected);
    expect(r.unmatched).toEqual([]);
    expect(r.confidence).toBeGreaterThan(0.6);
  });

  it('understands relative dates against the latest data, and says what it did not understand', () => {
    const r = askSync(model, 'bikes sales last 6 months');
    const range = r.spec!.filters!.find((f) => 'op' in f && f.op === 'between') as { min: Date; max: Date };
    expect(range.max.getFullYear()).toBe(2025);
    expect(range.max.getMonth()).toBe(11);
    expect(r.spec!.filters).toContainEqual({ target: 'Product[Category]', op: 'eq', value: 'Bikes' });
    const none = askSync(model, 'what is the weather');
    expect(none.spec).toBeNull();
    expect(none.unmatched).toContain('weather');
    expect(askSync(model, 'revenue by category', { synonyms: { 'Total Sales': ['revenue'] } }).spec?.fields).toMatchObject({ values: ['Total Sales'] });
    expect(suggestQuestions(model).length).toBeGreaterThan(2);
    for (const q of suggestQuestions(model)) expect(askSync(model, q).spec, q).not.toBeNull();
  });

  it('uses a language model when given, validating its plan and falling back to the rules', async () => {
    let prompt = '';
    const good = await ask(model, 'anything', {
      llm: async (p) => {
        prompt = p;
        return 'Sure! {"measures":["Total Profit"],"groupBy":["Region[Country]"],"filters":[{"target":"Date[Year]","op":"eq","value":2025}],"visual":"donut"}';
      },
    });
    expect(prompt).toContain('[Total Sales]');
    expect(prompt).toContain('Question: anything');
    expect(good.source).toBe('llm');
    expect(good.spec).toMatchObject({ type: 'donut', fields: { legend: 'Region[Country]', values: 'Total Profit' } });
    const bad = await ask(model, 'sales by category', { llm: async () => '{"measures":["Nope"]}' });
    expect(bad.source).toBe('rules');
    expect(bad.spec?.fields).toMatchObject({ category: 'Product[Category]' });
  });
});

describe('explain and insights', () => {
  it('explains a change against the previous period', () => {
    const x = explain(model, { measure: 'Total Sales', filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }] });
    expect(x.mode).toBe('change');
    expect(x.baseline).toBe(model.evaluate('[Total Sales]', [{ target: 'Date[Year]', op: 'eq', value: 2024 }]));
    expect(x.drivers.length).toBeGreaterThan(0);
    expect(x.drivers.every((d) => Math.sign(d.delta) === Math.sign(x.change!))).toBe(true);
    expect(x.summary).toMatch(/Total Sales (rose|fell) [\d.]+% to \$/);
    // only real dimensions: never calculation groups or parameter tables
    expect(x.drivers.some((d) => /Calculation|Metric/.test(d.column))).toBe(false);
  });

  it('explains composition without a period', () => {
    const x = explain(model, { measure: 'Total Sales', filters: [{ target: 'Product[Category]', op: 'eq', value: 'Bikes' }] });
    expect(x.mode).toBe('composition');
    expect(x.drivers[0].share).toBeGreaterThan(0.3);
    expect(x.spec?.type).toBe('donut');
  });

  it('finds anomalies, trends, movers, concentration and outliers', () => {
    const list = findInsights(model, { measure: 'Total Sales' });
    expect(list.length).toBeGreaterThan(2);
    expect(new Set(list.map((i) => i.kind)).size).toBeGreaterThan(1);
    expect(list.find((i) => i.kind === 'concentration')?.title).toMatch(/Bikes makes up \d+% of Total Sales/);
    for (const i of list) expect(i.spec?.type).toBeTruthy();
    expect([...list].sort((a, b) => b.score - a.score)).toEqual(list);
  });
});

describe('agent context and tools', () => {
  const mountReport = () => {
    const el = document.createElement('div');
    el.style.height = '700px';
    document.body.append(el);
    const report = new Report(el, {
      model: buildModel(),
      pages: [{ id: 'p1', name: 'Overview', visuals: [{ id: 'year', type: 'slicer', layout: { x: 0, y: 0, w: 4, h: 2 }, fields: { field: 'Date[Year]' } }] }, { id: 'p2', name: 'Detail', visuals: [] }],
    });
    report.flush();
    return { el, report };
  };

  it('describes the model and live report state', () => {
    const { el, report } = mountReport();
    report.setSlicerSelection('year', [{ target: 'Date[Year]', op: 'eq', value: 2025 }]);
    const ctx = getAIContext(report.model, { report });
    const sales = ctx.model.tables.find((t) => t.name === 'Sales')!;
    expect(sales.rows).toBeGreaterThan(1000);
    expect(sales.columns.find((c) => c.name === 'Channel')?.examples).toContain('Online');
    expect(ctx.model.measures.find((m) => m.name === 'Margin %')?.expression).toContain('DIVIDE');
    expect(ctx.model.relationships.some((r) => r.from === 'Sales[ProductKey]')).toBe(true);
    expect(ctx.report?.currentPage.name).toBe('Overview');
    expect(ctx.report?.slicers.year).toEqual([{ target: 'Date[Year]', op: 'eq', value: 2025 }]);
    const text = contextToPrompt(ctx);
    expect(text).toContain('## Sales');
    expect(text).toContain('[Total Sales] = SUM(Sales[SalesAmount])');
    expect(text).toContain('Active filters');
    expect(JSON.parse(JSON.stringify(ctx))).toBeTruthy(); // serialisable
    report.destroy();
    el.remove();
  });

  it('lets an agent explore, query and build a report', async () => {
    const { el, report } = mountReport();
    const tools = createAgentTools({ model: report.model, report });
    expect(toAnthropicTools(tools)[0]).toHaveProperty('input_schema');
    expect(toOpenAITools(tools)[0]).toMatchObject({ type: 'function', function: { name: 'describe_model' } });
    expect(toMcpTools(tools).map((t) => t.name)).toEqual(expect.arrayContaining(['run_query', 'evaluate_dax', 'ask', 'add_visual', 'set_filters', 'create_measure']));
    // a scripted "agent" run
    const values = (await runTool(tools, 'list_values', { column: 'Region[Country]', search: 'can' })) as { values: string[] };
    expect(values.values).toEqual(['Canada']);
    const q = (await runTool(tools, 'run_query', { groupBy: ['Product[Category]'], values: ['Total Sales'], filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }], orderBy: 'Total Sales', top: 2 })) as { rows: unknown[][]; totals: { text: string }[] };
    expect(q.rows).toHaveLength(2);
    expect(q.rows[0][0]).toBe('Bikes');
    expect(q.totals[0].text).toMatch(/^\$/);
    expect(await runTool(tools, 'evaluate_dax', { expression: '[Total Sales] - [Total Profit]', filters: [{ target: 'Date[Date]', op: 'between', min: '2025-01-01', max: '2025-12-31' }] })).toHaveProperty('value');
    const t = (await runTool(tools, 'evaluate_dax', { expression: 'EVALUATE VALUES(Product[Category])' })) as { rows: unknown[][] };
    expect(t.rows).toHaveLength(4);
    const created = (await runTool(tools, 'create_measure', { name: 'Cost', expression: '[Total Sales] - [Total Profit]', format: '$#,0' })) as { created: string };
    expect(created.created).toBe('Cost');
    expect(await runTool(tools, 'create_measure', { name: 'Broken', expression: 'SUM(Nope[x])' })).toHaveProperty('error');
    const answer = (await runTool(tools, 'ask', { question: 'cost by region group' })) as { spec: object };
    const added = (await runTool(tools, 'add_visual', { spec: answer.spec })) as { id: string; layout: { x: number; y: number } };
    expect(report.visualIds()).toContain(added.id);
    expect(added.layout.x >= 4 || added.layout.y >= 2).toBe(true); // never on top of the slicer
    await runTool(tools, 'set_filters', { filters: [{ target: 'Product[Category]', op: 'eq', value: 'Bikes' }] });
    expect(report.reportFilterList).toHaveLength(1);
    expect(await runTool(tools, 'go_to_page', { page: 'Detail' })).toMatchObject({ name: 'Detail' });
    expect(await runTool(tools, 'nope', {})).toEqual({ error: 'Unknown tool "nope"' });
    expect(((await runTool(tools, 'find_insights', { measure: 'Total Sales', max: 3 })) as unknown[]).length).toBeLessThanOrEqual(3);
    // read-only tool set
    expect(createAgentTools({ model }).map((x) => x.name)).not.toContain('create_measure');
    report.destroy();
    el.remove();
  });
});

describe('AI visuals and Explain this', () => {
  it('Q&A visual answers a question with a nested visual under the page filters', () => {
    const el = document.createElement('div');
    el.style.height = '500px';
    document.body.append(el);
    const r = createVisual(el, { model, type: 'qna', fields: {}, format: { qna: { question: 'total sales by category' } } as never, filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }] });
    r.flush();
    const inner = el.querySelector('.pbi-ai-result .pbi-report');
    expect(inner).not.toBeNull();
    expect(el.querySelectorAll('.pbi-ai-chip[data-kind=measure]')).toHaveLength(1);
    // submitting a new question swaps the answer
    const input = el.querySelector('input')!;
    input.value = 'share of sales by region group';
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(el.querySelector('.pbi-ai-result [data-visual-id]')).not.toBeNull();
    input.value = '';
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(el.querySelectorAll('button.pbi-ai-chip').length).toBeGreaterThan(1);
    r.destroy();
    el.remove();
  });

  it('Insights visual lists insights and expands one into a chart', () => {
    const el = document.createElement('div');
    el.style.height = '500px';
    document.body.append(el);
    const r = createVisual(el, { model, type: 'insights', fields: { values: 'Total Sales' } });
    r.flush();
    const items = el.querySelectorAll<HTMLButtonElement>('.pbi-ai-item');
    expect(items.length).toBeGreaterThan(1);
    items[0].click();
    expect(items[0].getAttribute('aria-expanded')).toBe('true');
    expect(items[0].querySelector('.pbi-ai-mini .pbi-report')).not.toBeNull();
    r.destroy();
    el.remove();
  });

  it('adds "Explain this" to data-point menus', () => {
    const el = document.createElement('div');
    el.style.height = '600px';
    document.body.append(el);
    const r = createVisual(el, { model, type: 'clusteredColumn', fields: { category: 'Product[Category]', values: 'Total Sales' }, filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }] });
    r.flush();
    el.querySelector('path.pbi-mark')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
    const item = [...document.querySelectorAll<HTMLElement>('.pbi-menu [role=menuitem], .pbi-menu button')].find((b) => b.textContent?.includes('Explain this'));
    expect(item).toBeTruthy();
    item!.click();
    const panel = document.querySelector('.pbi-ai-panel');
    expect(panel?.textContent).toMatch(/Why Total Sales changed/);
    expect(panel?.querySelectorAll('.pbi-ai-bar').length).toBeGreaterThan(0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    r.destroy();
    el.remove();
  });
});

describe('key influencers', () => {
  it('compares sums per row, averages and rates as they are, and lists each segment once', async () => {
    const { keyInfluencers } = await import('@prismbi/prismbi/ai');
    const model = buildModel();
    const sales = keyInfluencers(model, { measure: 'Total Sales', explainBy: ['Product[Category]', 'Product[Subcategory]', 'Product[Name]'] });
    expect(sales.basis).toBe('perRow');
    const rows = model.query({ values: ['Total Sales', { name: 'n', expression: 'COUNTROWS(Sales)' }] }).rows[0].values as number[];
    expect(sales.overall).toBeCloseTo(rows[0] / rows[1], 6);
    const top = sales.influencers[0];
    const seg = model.query({ groupBy: [top.column], values: ['Total Sales', { name: 'n', expression: 'COUNTROWS(Sales)' }] }).rows.find((r) => r.keys[0] === top.value)!.values as number[];
    expect(top.segment).toBeCloseTo(seg[0] / seg[1], 6);
    expect(top.ratio).toBeCloseTo(top.segment / top.overall, 9);
    expect(top.direction).toBe(top.ratio > 1 ? 'up' : 'down');
    // a segment reached through two columns (a subcategory with one product) appears once
    const keys = sales.influencers.map((i) => `${i.share.toFixed(9)}|${i.segment.toFixed(6)}`);
    expect(new Set(keys).size).toBe(keys.length);
    const margin = keyInfluencers(model, { measure: 'Margin %', explainBy: ['Product[Category]'] });
    expect(margin.basis).toBe('value');
    expect(margin.overall).toBeCloseTo(model.evaluate('[Margin %]') as number, 9);
    // small segments are ignored
    expect(keyInfluencers(model, { measure: 'Margin %', explainBy: ['Product[Name]'], minShare: 0.99 }).influencers).toEqual([]);
  });

  it('renders the influencers and the chosen column, and cross-filters from a bar', async () => {
    const { registerAI } = await import('@prismbi/prismbi/ai');
    registerAI();
    const model = buildModel();
    const el = document.createElement('div');
    document.body.append(el);
    const r = createVisual(el, { model, type: 'keyInfluencers', fields: { values: 'Margin %', explainBy: ['Product[Category]', 'Region[Group]'] } });
    r.flush();
    const items = [...el.querySelectorAll('.pbi-ai-item')];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].textContent).toMatch(/^.When /);
    expect(el.querySelector('.pbi-ai-ki h4')!.textContent).toBe('What influences Margin %');
    const bars = [...el.querySelectorAll('.pbi-ai-bar')];
    expect(bars.length).toBeGreaterThan(1);
    const picked: unknown[] = [];
    r.on('selectionChanged', (e) => picked.push(e));
    (bars[0] as HTMLElement).click();
    expect(picked.length).toBe(1);
    r.destroy();
    el.remove();
  });
});
