// Runs the guides' ```js playground examples (shared by /playground.html and tests/playground.test.ts).
import type { DataModel } from '@prismbi/prismbi';

export interface PlaygroundExample {
  guide: string;
  index: number;
  /** The nearest heading above the example. */
  title: string;
  code: string;
}

/** The ```js playground blocks of a guide, in order (the docs site numbers them the same way). */
export function extractExamples(guide: string, md: string): PlaygroundExample[] {
  const out: PlaygroundExample[] = [];
  let title = guide;
  let doc = guide;
  let lead = '';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,4})\s+(.*)$/.exec(lines[i]);
    if (h) {
      title = h[2].replace(/`/g, '');
      if (h[1].length === 1) doc = title;
      lead = '';
      continue;
    }
    const fence = /^(\s*)```(\S*)\s*(.*)$/.exec(lines[i]);
    if (!fence) {
      // the sentence introducing an example names it best
      if (lines[i].trim()) lead = lines[i].trim().replace(/[:.]$/, '').replace(/[`*]/g, '');
      continue;
    }
    const body: string[] = [];
    i++;
    while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++].slice(fence[1].length));
    if (/\bplayground\b/.test(fence[3])) out.push({ guide, index: out.length, title: lead.length > 3 && lead.length < 90 ? lead : title === 'Try it' ? doc : title, code: body.join('\n') });
    lead = '';
  }
  return out;
}

/**
 * Run example code as an async function. `import … from '@prismbi/prismbi…'` lines are resolved from `modules`;
 * `model` (the demo model) and `el` (an output element) are in scope. Resolves with what the code returns.
 */
export async function runExample(code: string, scope: { el: HTMLElement; model: DataModel; modules: Record<string, Record<string, unknown>> }): Promise<unknown> {
  const body = code.replace(/^\s*import\s+(?:(\{[^}]*\})|\*\s+as\s+(\w+))?\s*(?:from\s*)?['"]([^'"]+)['"];?\s*$/gm, (_m, named: string | undefined, ns: string | undefined, spec: string) => {
    if (!scope.modules[spec]) throw new Error(`The playground can't import "${spec}"`);
    const ref = `__modules[${JSON.stringify(spec)}]`;
    if (named) return `const ${named.replace(/\s+as\s+/g, ': ')} = ${ref};`;
    if (ns) return `const ${ns} = ${ref};`;
    return '';
  });
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;
  return new AsyncFunction('__modules', 'model', 'el', body)(scope.modules, scope.model, scope.el);
}
