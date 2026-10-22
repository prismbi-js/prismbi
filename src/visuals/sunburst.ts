import { s, arcPath, measureText, fitText } from '../render/svg';
import { mix, textOn } from '../render/color';
import type { CellValue } from '../data/types';
import { valueKey } from '../data/types';
import { defineVisual } from './registry';
import { emptyState, identityOf, interactive, markOpacity } from './common';

interface Node {
  path: CellValue[];
  value: number;
  children: Node[];
  a0: number;
  a1: number;
  color: string;
}

/** Arcs narrower than this (radians) are not drawn. */
const MIN_SWEEP = 0.002;

/**
 * Sunburst: a hierarchy as rings, the first level innermost. Each level's values are real measure evaluations (as
 * a matrix's subtotals), and children share their parent's angle in proportion to their own values.
 */
export const sunburst = /* @__PURE__ */ defineVisual({
  type: 'sunburst',
  displayName: 'Sunburst',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'Levels', kind: 'grouping', multiple: true, required: true },
    { name: 'values', displayName: 'Value', kind: 'measure', required: true },
  ],
  render(ctx) {
    const gi = ctx.role('category').indices;
    const vi = ctx.role('values').indices[0];
    if (!gi.length || vi === undefined || !ctx.data.rows.length) return emptyState(ctx);
    const { data, theme: t, model } = ctx;
    const fields = gi.map((i) => data.groups[i]);
    const vField = data.values[vi];
    const valueSpec = ctx.fields('values')[0];
    const filters = data.baseFilters as never[];
    const key = (path: CellValue[]) => JSON.stringify(path.map(valueKey));

    // one query per level above the leaves (the leaves are the visual's own rows)
    const levels: { path: CellValue[]; value: number }[][] = fields.map((_, lvl) => {
      const rows = lvl === fields.length - 1 ? data.rows.map((r) => ({ keys: gi.map((i) => r.keys[i]), v: r.values[vi] })) : model.query({ groupBy: fields.slice(0, lvl + 1).map((f) => f.ref), values: [valueSpec], filters }).rows.map((r) => ({ keys: r.keys, v: r.values[0] }));
      return rows.filter((r): r is { keys: CellValue[]; v: number } => typeof r.v === 'number' && r.v > 0).map((r) => ({ path: r.keys, value: r.v }));
    });
    const total = model.query({ values: [valueSpec], filters }).rows[0]?.values[0];

    // the tree, children by value (largest first)
    const root: Node = { path: [], value: 0, children: [], a0: 0, a1: Math.PI * 2, color: t.foregroundMuted };
    const byPath = new Map<string, Node>([[key([]), root]]);
    for (const level of levels)
      for (const { path, value } of level) {
        const parent = byPath.get(key(path.slice(0, -1)));
        if (!parent) continue;
        const node: Node = { path, value, children: [], a0: 0, a1: 0, color: '' };
        parent.children.push(node);
        byPath.set(key(path), node);
      }
    if (!root.children.length) return emptyState(ctx);
    const pal = ctx.format.colors.palette ?? t.dataColors;
    const layout = (n: Node, depth: number) => {
      n.children.sort((a, b) => b.value - a.value);
      const sum = n.children.reduce((acc, c) => acc + c.value, 0);
      let a = n.a0;
      n.children.forEach((c, i) => {
        c.a0 = a;
        c.a1 = a += ((n.a1 - n.a0) * c.value) / sum;
        // the first ring takes the palette; deeper rings lighten their parent's colour
        c.color = depth === 0 ? pal[i % pal.length] : mix(n.color, t.surface, 0.2);
        layout(c, depth + 1);
      });
    };
    layout(root, 0);

    const W = ctx.width;
    const H = ctx.height;
    const cx = W / 2;
    const cy = H / 2;
    const outer = Math.max(10, Math.min(W, H) / 2 - 4);
    const hole = outer * 0.28;
    const ring = (outer - hole) / fields.length;
    const fs = t.labelFontSize;
    const svg = s('svg', { width: W, height: H, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Sunburst' });
    // labels follow the arc (upright on the lower half too) when they fit there, else run along the radius
    const uid = `pbi-sb-${Math.random().toString(36).slice(2, 8)}`;
    const defs = s('defs');
    let seq = 0;
    const arcLabel = (label: string, a0: number, a1: number, r0: number, r1: number, fill: string): SVGElement | null => {
      const mid = (a0 + a1) / 2;
      const rm = (r0 + r1) / 2;
      const sweep = a1 - a0;
      const width = measureText(label, fs, t.fontFamily);
      const along = Math.min(sweep, Math.PI * 1.9) * rm - 10;
      const radial = sweep * r0 >= fs + 2 ? r1 - r0 - 8 : 0;
      const curved = width <= along || along >= radial;
      const room = curved ? along : radial;
      if (room < 20 || r1 - r0 < fs + 4) return null;
      const text = fitText(label, room, fs, t.fontFamily);
      if (!text || measureText(text, fs, t.fontFamily) > room) return null;
      const attrs = { 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'pbi-label', fill, 'pointer-events': 'none' };
      if (curved) {
        const p = (ang: number) => `${(cx + rm * Math.sin(ang)).toFixed(2)},${(cy - rm * Math.cos(ang)).toFixed(2)}`;
        const lo = mid - Math.min(sweep, Math.PI * 1.9) / 2;
        const hi = mid + Math.min(sweep, Math.PI * 1.9) / 2;
        const large = hi - lo > Math.PI ? 1 : 0;
        // the lower half runs right to left, so its text reads upright
        const flip = mid > Math.PI / 2 && mid < (3 * Math.PI) / 2;
        const id = `${uid}-${seq++}`;
        defs.append(s('path', { id, d: flip ? `M${p(hi)}A${rm},${rm} 0 ${large} 0 ${p(lo)}` : `M${p(lo)}A${rm},${rm} 0 ${large} 1 ${p(hi)}` }));
        const el = s('text', attrs);
        el.append(s('textPath', { href: `#${id}`, startOffset: '50%' }, text));
        return el;
      }
      const x = cx + rm * Math.sin(mid);
      const y = cy - rm * Math.cos(mid);
      const deg = (mid * 180) / Math.PI - 90 - (mid > Math.PI ? 180 : 0);
      return s('text', { x, y, transform: `rotate(${deg.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})`, ...attrs }, text);
    };
    const labels: SVGElement[] = [];
    const draw = (n: Node, depth: number) => {
      for (const c of n.children) {
        if (c.a1 - c.a0 < MIN_SWEEP) continue;
        const r0 = hole + depth * ring;
        const r1 = r0 + ring - 1;
        const identity = identityOf(fields.slice(0, depth + 1), c.path);
        const label = ctx.fmt(fields[depth], c.path[depth]) || '(Blank)';
        const path = s('path', { d: arcPath(cx, cy, r0, r1, c.a0, c.a1), fill: c.color, stroke: t.surface, 'stroke-width': 1, opacity: markOpacity(ctx, identity) });
        interactive(
          ctx,
          path,
          identity,
          () => ({
            title: c.path.map((v, i) => ctx.fmt(fields[i], v) || '(Blank)').join(' › '),
            items: [
              { label: vField.name, value: ctx.fmt(vField, c.value), color: c.color },
              { label: 'Share of parent', value: `${((c.value / n.children.reduce((a, x) => a + x.value, 0)) * 100).toFixed(1)}%` },
            ],
          }),
          c.path,
        );
        svg.append(path);
        const fill = textOn(c.color, t.foreground);
        const lbl = arcLabel(label, c.a0, c.a1, r0, r1, fill);
        if (lbl) labels.push(lbl);
        if (depth + 1 < fields.length) draw(c, depth + 1);
      }
    };
    draw(root, 0);
    svg.append(defs, ...labels);
    // the total in the middle
    if (typeof total === 'number' && hole > fs * 1.5) {
      svg.append(s('text', { x: cx, y: cy + fs / 3, 'text-anchor': 'middle', class: 'pbi-label', fill: t.foreground, 'font-weight': 600 }, fitText(ctx.fmt(vField, total, { displayUnits: 'auto' }), hole * 1.8, fs, t.fontFamily)));
    }
    ctx.root.replaceChildren(svg);
  },
});
