import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { createVisual, listVisuals } from '@prismbi/prismbi/core';
import { waterfall } from '@prismbi/prismbi/visuals/waterfall';
import '@prismbi/prismbi/visuals/bar';
import { makeModel } from './fixtures';

declare module 'node:fs' {
  export function readdirSync(path: string): string[];
}

describe('per-visual entry points', () => {
  it('register their visuals (and aliases) when imported', () => {
    expect(waterfall.type).toBe('waterfall');
    for (const t of ['waterfall', 'clusteredColumn', 'column', 'percentStackedBar']) expect(listVisuals()).toContain(t);
    const el = document.createElement('div');
    document.body.append(el);
    const v = createVisual(el, { type: 'column', model: makeModel(), fields: { category: 'Products[Category]', values: 'Total Sales' } } as never);
    v.flush();
    expect(el.querySelector('svg')).toBeTruthy();
    v.destroy();
    el.remove();
  });

  it('cover every built-in visual', async () => {
    const all = Object.values(await import('../src/visuals')).map((d) => (d as { type: string }).type);
    const files = readdirSync('src/visuals/entries').filter((f: string) => f.endsWith('.ts'));
    const covered = new Set<string>();
    for (const f of files) for (const d of Object.values(await import(`../src/visuals/entries/${f}`))) covered.add((d as { type: string }).type);
    expect(all.filter((t) => !covered.has(t))).toEqual([]);
    expect(all.length).toBeGreaterThan(30);
  });
});
