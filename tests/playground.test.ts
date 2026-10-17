import { describe, expect, it } from 'vitest';
import * as prism from '@prismbi/prismbi';
import * as ai from '@prismbi/prismbi/ai';
import * as files from '@prismbi/prismbi/files';
import * as sql from '@prismbi/prismbi/sql';
import { extractExamples, runExample } from '../examples/playground-run';
import { buildModel } from '../examples/model';

// every ```js playground block in the guides runs (the playground loads the same blocks)
const sources = import.meta.glob('../docs/guide/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const examples = Object.entries(sources).flatMap(([path, md]) => extractExamples(path.split('/').pop()!.replace(/\.md$/, ''), md));
const modules = { '@prismbi/prismbi': prism, '@prismbi/prismbi/core': prism, '@prismbi/prismbi/ai': ai, '@prismbi/prismbi/files': files, '@prismbi/prismbi/sql': sql } as Record<string, Record<string, unknown>>;

describe('guide examples (playground)', () => {
  it('finds examples in the guides', () => {
    expect(examples.length).toBeGreaterThanOrEqual(10);
  });

  for (const ex of examples) {
    it(`${ex.guide}: ${ex.title} #${ex.index}`, async () => {
      const el = document.createElement('div');
      el.style.cssText = 'width:800px;height:500px';
      document.body.append(el);
      const log = console.log;
      console.log = () => {};
      try {
        const out = (await runExample(ex.code, { el, model: buildModel(), modules })) as { flush?: () => void; destroy?: () => void } | undefined;
        out?.flush?.();
        expect(el.querySelector('.pbi-error')).toBeNull();
        if (el.childElementCount) expect(el.querySelector('svg, table, .pbi-card, .pbi-slicer')).toBeTruthy();
        else expect(out).toBeDefined();
        out?.destroy?.();
      } finally {
        console.log = log;
        el.remove();
      }
    });
  }

  it('rewrites imports and reports unknown modules', async () => {
    const el = document.createElement('div');
    expect(await runExample("import { DataModel as M } from '@prismbi/prismbi';\nreturn typeof M;", { el, model: buildModel(), modules })).toBe('function');
    await expect(runExample("import x from 'lodash';", { el, model: buildModel(), modules })).rejects.toThrow();
    await expect(runExample("import { a } from 'lodash';", { el, model: buildModel(), modules })).rejects.toThrow(/can't import "lodash"/);
  });
});
