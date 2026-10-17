import * as prism from '@prismbi/prismbi';
import * as ai from '@prismbi/prismbi/ai';
import * as files from '@prismbi/prismbi/files';
import * as sql from '@prismbi/prismbi/sql';
import { buildModel } from './model';
import { extractExamples, runExample, type PlaygroundExample } from './playground-run';

const modules: Record<string, Record<string, unknown>> = { '@prismbi/prismbi': prism, '@prismbi/prismbi/core': prism, '@prismbi/prismbi/ai': ai, '@prismbi/prismbi/files': files, '@prismbi/prismbi/sql': sql };
const sources = import.meta.glob('../docs/guide/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const examples: PlaygroundExample[] = Object.entries(sources)
  .flatMap(([path, md]) => extractExamples(path.split('/').pop()!.replace(/\.md$/, ''), md));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const code = $<HTMLTextAreaElement>('code');
const list = $('list');
const result = $('result');
const where = $('where');
let current: PlaygroundExample | undefined;
let cleanup: (() => void) | undefined;

const guides = [...new Set(examples.map((e) => e.guide))];
for (const g of guides) {
  list.append(Object.assign(document.createElement('h3'), { textContent: g.replace(/-/g, ' ') }));
  for (const e of examples.filter((x) => x.guide === g)) {
    const a = Object.assign(document.createElement('a'), { href: `#${g}/${e.index}`, textContent: e.title });
    a.dataset.key = `${g}/${e.index}`;
    list.append(a);
  }
}

async function run(): Promise<void> {
  cleanup?.();
  cleanup = undefined;
  const el = $('el');
  el.replaceChildren();
  result.textContent = '';
  result.classList.remove('error');
  const model = buildModel();
  try {
    const out = await runExample(code.value, { el, model, modules });
    if (typeof out === 'function') cleanup = out as () => void;
    else if (out && typeof out === 'object' && 'destroy' in out && typeof (out as { destroy: unknown }).destroy === 'function') cleanup = () => (out as { destroy: () => void }).destroy();
    else if (out !== undefined) result.textContent = typeof out === 'string' ? out : JSON.stringify(out, (_k, v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v), 2);
  } catch (e) {
    result.classList.add('error');
    result.textContent = String((e as Error).stack ?? e);
  }
}

function select(): void {
  const key = decodeURIComponent(location.hash.slice(1));
  current = examples.find((e) => `${e.guide}/${e.index}` === key) ?? examples[0];
  if (!current) return;
  code.value = current.code;
  where.textContent = `${current.guide} › ${current.title}`;
  for (const a of list.querySelectorAll('a')) a.toggleAttribute('aria-current', a.dataset.key === `${current.guide}/${current.index}`);
  void run();
}

$('run').addEventListener('click', () => void run());
$('reset').addEventListener('click', () => current && ((code.value = current.code), void run()));
code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void run();
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end');
  }
});
addEventListener('hashchange', select);
select();
