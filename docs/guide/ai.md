# AI: questions, explanations, insights and agents

`prismbi/ai` adds four things. Everything runs offline on the model by default, with no API keys or network calls:

- **Ask:** a plain-language question becomes a visual.
- **Explain:** why a value is what it is.
- **Insights:** what's unusual in the data.
- **Agents:** context and tools for AI agent frameworks.

Language models are optional, plugged in through a function you provide.

```ts
import 'prismbi/ai'; // registers the `qna` and `insights` visuals and "Explain this" on right-click
import { ask, explain, findInsights, getAIContext, createAgentTools } from 'prismbi/ai';
```

## Ask

```ts
const { spec, interpretation, unmatched, confidence } = askSync(model, 'top 5 products by profit in 2025');
// spec → { type: 'clusteredBar', fields: { category: 'Product[Name]', values: ['Total Profit'] }, top: 5, sort: …, filters: [Year = 2025] }
report.addVisual({ ...spec, layout: { x: 0, y: 0, w: 6, h: 7 } });
```

The parser builds its vocabulary from the model: measure names (with "Total Sales" also answering to "sales"), table and column names, and the values of short text columns. It understands:

| You say | It does |
|---|---|
| `by category`, `per region`, `for each channel` | groups by the column (a table name picks its label column) |
| `in Canada`, `bikes and clothing` | filters on the column holding those values |
| `2025`, `last year`, `this year`, `last quarter`, `last 6 months`, `ytd` | date filters relative to the latest date with data |
| `top 5`, `bottom 3`, `highest`, `lowest` | Top N and sort direction |
| `average price`, `max quantity`, `how many orders`, `distinct customers` | implicit aggregations |
| `trend`, `share`, `as a table`, `matrix`, `scatter`, `as bars` | the visual type |

Without a hint it picks a sensible chart:

| Question shape | Chart |
|---|---|
| No grouping | A card |
| Grouped by time | A line, by year-month unless a single year is selected |
| Few categories | Columns |
| Many categories or a Top N | Bars |
| Two groupings | A clustered or matrix layout |

`unmatched` lists words it didn't understand. `confidence` is the share of the question it did.

- **Synonyms:** `askSync(model, q, { synonyms: { 'Total Sales': ['revenue', 'turnover'] } })`.
- **Language model:** `await ask(model, q, { llm })` calls `llm(prompt)` with the schema and the question. It expects a JSON plan back. Plans that reference unknown fields fall back to the rules (`source` says which was used). `llmPrompt(model, q)` shows the exact prompt.

```ts
const llm = async (prompt: string) => (await fetch('/api/llm', { method: 'POST', body: prompt })).text();
const answer = await ask(model, 'how did margins move in Europe vs last year?', { llm });
```

### The Q&A visual

```ts
{ type: 'qna', title: 'Ask a question', layout: { x: 0, y: 0, w: 7, h: 9 }, fields: {},
  format: { qna: { synonyms: { 'Total Sales': ['revenue'] }, suggestions: ['sales by month'] } } }
```

- **Answers:** a nested visual, filtered by the page's slicers and filters.
- **Chips:** show how the question was understood.
- **Empty box:** suggested questions generated from the model.

## Explain

```ts
const x = explain(model, { measure: 'Total Sales', filters: [{ target: 'Date[Year]', op: 'eq', value: 2025 }] });
x.summary; // "Total Sales rose 3.1% to $9.34M from $9.07M in 2024. Biggest contributors: Category Bikes (+$138K, …)"
x.drivers; // [{ column: 'Product[Category]', value: 'Bikes', current, baseline, delta, share }, …]
```

- **Change mode:** when the filters contain a period (a year, a date range, a day), the value is compared with the period before. Members of each dimension are ranked by their contribution to the change.
- **Composition mode:** otherwise, it says which members make up the value.
- **Dimensions:** text columns of tables wired into the model. Calculation groups and parameter tables are skipped. Pass `dimensions` to choose them.

Right-clicking any data point offers **Explain this** once `prismbi/ai` is imported (`enableExplain(false)` turns it off). Its panel shows the summary, the top drivers and a chart.

## Insights

```ts
findInsights(model, { measure: 'Total Sales', filters, max: 6 });
// [{ kind: 'outlier', title: 'Road Bikes stands out among Subcategory values', detail: '$2.7M against a typical $124K.', score, spec }, …]
```

| Kind | Finds |
|---|---|
| `anomaly` | periods far from a rolling median (robust z-score ≥ 3.5) |
| `trend` | the latest periods against the ones before (±5% or more) |
| `mover` | the member that drove most of the change in the latest period |
| `concentration` | one member holding 40% or more of the total |
| `outlier` | members far from the rest of their dimension |

The `insights` visual (`fields: { values: 'Total Sales' }`, optional `dimensions`) lists them for the current filters. Clicking one shows its chart.

## Agents

Agent frameworks need two things: context about the data, and tools to act on it.

### Context

```ts
const ctx = getAIContext(model, { report });   // serialisable JSON
const system = contextToPrompt(ctx);           // compact text for a system prompt
```

The context contains:
- **Tables:** row counts and columns, each with type, distinct count, examples or min/max, format and calculated-column DAX.
- **Model:** relationships, and measures with their DAX, format and description.
- **Report state** (with a `report`): current page, pages, the visuals on the page with their fields, report and page filters, slicer selections and the cross-filter selection.

### Tools

`createAgentTools({ model, report })` returns provider-agnostic tools, each with a JSON-schema input and a `run` function:

| Tool | Does |
|---|---|
| `describe_model` | schema, relationships, measures |
| `list_values` | distinct values of a column (with search), to find exact filter values |
| `run_query` | group, aggregate, sort, Top N; formatted and raw values plus totals |
| `evaluate_dax` | a scalar expression, or `EVALUATE <table expression>` |
| `ask` | a question → a visual spec |
| `explain_value`, `find_insights` | as above |
| `get_report_state`, `go_to_page` | with a report |
| `add_visual`, `remove_visual`, `set_filters` | with a report and writes allowed |
| `create_measure` | validated by evaluating it first; writes allowed |

- **Writes:** allowed by default when a report is attached. Set `allowWrites: false` for read-only agents.
- **Dates:** may arrive as ISO strings and are revived automatically.
- **Errors:** `runTool` returns them as `{ error }` so the agent can correct itself.
- **Formats:** convert the tools with `toAnthropicTools`, `toOpenAITools` or `toMcpTools`.

### A Claude agent loop

Run this on your server with the Anthropic SDK:

```ts
import Anthropic from '@anthropic-ai/sdk';
import { createAgentTools, getAIContext, contextToPrompt, runTool, toAnthropicTools } from 'prismbi/ai';

const client = new Anthropic();
const tools = createAgentTools({ model, report });
const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'Build a page explaining why 2025 sales grew, by region and product.' }];

for (;;) {
  const res = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 4096,
    system: `You are a BI analyst working in a PrismBI report.\n\n${contextToPrompt(getAIContext(model, { report }))}`,
    tools: toAnthropicTools(tools),
    messages,
  });
  messages.push({ role: 'assistant', content: res.content });
  if (res.stop_reason !== 'tool_use') break;
  const results = await Promise.all(
    res.content.filter((b) => b.type === 'tool_use').map(async (b) => ({
      type: 'tool_result' as const,
      tool_use_id: b.id,
      content: JSON.stringify(await runTool(tools, b.name, b.input)),
    })),
  );
  messages.push({ role: 'user', content: results });
}
```

The same tools work with any orchestrator that accepts JSON-schema tools: OpenAI function calling, LangGraph, the Vercel AI SDK, and your own planner.

### An MCP server

Expose a model to MCP clients with the official SDK:

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgentTools, runTool, toMcpTools } from 'prismbi/ai';

const tools = createAgentTools({ model, allowWrites: false });
const server = new Server({ name: 'prismbi', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toMcpTools(tools) }));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: JSON.stringify(await runTool(tools, req.params.name, req.params.arguments)) }],
}));
await server.connect(new StdioServerTransport());
```

The model engine has no DOM dependency, so this runs on Node. Load data with `prismbi/connectors`.
