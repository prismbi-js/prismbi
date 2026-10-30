import { s, measureText } from '../render/svg';
import type { CellValue } from '../data/types';
import { defineVisual } from './registry';
import { emptyState, identityOf, interactive, markOpacity } from './common';

export interface ChordFormat {
  padAngle?: number;
  innerRadiusRatio?: number;
}

interface FlowLink {
  source: string;
  target: string;
  sourceValue: CellValue;
  targetValue: CellValue;
  weight: number;
}

interface ChordNode {
  id: string;
  value: CellValue;
  label: string;
  total: number;
  startAngle: number;
  endAngle: number;
  colorIndex: number;
}

/** Chord diagram: circular visualization of directional flows, transfers, and relationships. */
export const chord = /* @__PURE__ */ defineVisual({
  type: 'chord',
  displayName: 'Chord diagram',
  category: 'chart',
  roles: [
    { name: 'source', displayName: 'Source', kind: 'grouping', required: true },
    { name: 'target', displayName: 'Destination', kind: 'grouping', required: true },
    { name: 'values', displayName: 'Weight', kind: 'measure', required: true },
  ],
  render(ctx) {
    const si = ctx.role('source').indices[0];
    const ti = ctx.role('target').indices[0];
    const vi = ctx.role('values').indices[0];

    if (si === undefined || ti === undefined || vi === undefined || !ctx.data.rows.length) {
      return emptyState(ctx);
    }

    const sField = ctx.data.groups[si];
    const tField = ctx.data.groups[ti];
    const vField = ctx.data.values[vi];

    const links: FlowLink[] = [];
    for (const row of ctx.data.rows) {
      const w = Number(row.values[vi]);
      if (Number.isNaN(w) || w <= 0) continue;
      const src = ctx.fmt(sField, row.keys[si]) || '(Blank)';
      const tgt = ctx.fmt(tField, row.keys[ti]) || '(Blank)';
      links.push({
        source: src,
        target: tgt,
        sourceValue: row.keys[si],
        targetValue: row.keys[ti],
        weight: w,
      });
    }

    if (!links.length) return emptyState(ctx);

    const t = ctx.theme;
    const W = ctx.width;
    const H = ctx.height;
    const cx = W / 2;
    const cy = H / 2;
    const margin = 28;
    const maxR = Math.max(20, Math.min(W, H) / 2 - margin);
    const rOut = maxR;
    const rIn = Math.max(10, rOut - 14);

    // Collect distinct nodes and compute flow totals
    const nodeMap = new Map<string, { value: CellValue; total: number; colorIndex: number }>();
    for (const l of links) {
      if (!nodeMap.has(l.source)) nodeMap.set(l.source, { value: l.sourceValue, total: 0, colorIndex: nodeMap.size });
      if (!nodeMap.has(l.target)) nodeMap.set(l.target, { value: l.targetValue, total: 0, colorIndex: nodeMap.size });
      nodeMap.get(l.source)!.total += l.weight;
      nodeMap.get(l.target)!.total += l.weight;
    }

    const nodes: ChordNode[] = [];
    const padAngle = 0.04;
    const numNodes = nodeMap.size;
    const totalWeight = [...nodeMap.values()].reduce((acc, n) => acc + n.total, 0);

    const availAngle = Math.max(0, 2 * Math.PI - numNodes * padAngle);
    let currentAngle = -Math.PI / 2; // start at 12 o'clock

    for (const [id, info] of nodeMap) {
      const sweep = totalWeight > 0 ? (info.total / totalWeight) * availAngle : 0;
      const startAngle = currentAngle;
      const endAngle = currentAngle + sweep;
      nodes.push({
        id,
        value: info.value,
        label: id,
        total: info.total,
        startAngle,
        endAngle,
        colorIndex: info.colorIndex,
      });
      currentAngle = endAngle + padAngle;
    }

    const svg = s('svg', {
      width: W,
      height: H,
      class: 'pbi-svg',
      role: 'img',
      'aria-label': ctx.spec.title ?? 'Chord diagram',
    });

    const nodeOffsets = new Map<string, number>();
    for (const n of nodes) nodeOffsets.set(n.id, n.startAngle);

    // Draw chord ribbons between connected nodes
    const ribbonsGroup = s('g', { class: 'pbi-chord-ribbons' });
    for (const l of links) {
      const srcNode = nodes.find((n) => n.id === l.source);
      const tgtNode = nodes.find((n) => n.id === l.target);
      if (!srcNode || !tgtNode) continue;

      const srcSpan = srcNode.endAngle - srcNode.startAngle;
      const tgtSpan = tgtNode.endAngle - tgtNode.startAngle;

      const dSrc = srcNode.total > 0 ? (l.weight / srcNode.total) * srcSpan : 0;
      const dTgt = tgtNode.total > 0 ? (l.weight / tgtNode.total) * tgtSpan : 0;

      const a1 = nodeOffsets.get(l.source)!;
      const a2 = a1 + dSrc;
      nodeOffsets.set(l.source, a2);

      const b1 = nodeOffsets.get(l.target)!;
      const b2 = b1 + dTgt;
      nodeOffsets.set(l.target, b2);

      const xA1 = cx + rIn * Math.cos(a1);
      const yA1 = cy + rIn * Math.sin(a1);
      const xA2 = cx + rIn * Math.cos(a2);
      const yA2 = cy + rIn * Math.sin(a2);

      const xB1 = cx + rIn * Math.cos(b1);
      const yB1 = cy + rIn * Math.sin(b1);
      const xB2 = cx + rIn * Math.cos(b2);
      const yB2 = cy + rIn * Math.sin(b2);

      const largeA = a2 - a1 > Math.PI ? 1 : 0;
      const largeB = b2 - b1 > Math.PI ? 1 : 0;

      // Ribbon path using inner circle arcs and quadratic curves toward center
      const d = [
        `M ${xA1} ${yA1}`,
        `A ${rIn} ${rIn} 0 ${largeA} 1 ${xA2} ${yA2}`,
        `Q ${cx} ${cy} ${xB1} ${yB1}`,
        `A ${rIn} ${rIn} 0 ${largeB} 1 ${xB2} ${yB2}`,
        `Q ${cx} ${cy} ${xA1} ${yA1}`,
        'Z',
      ].join(' ');

      const color = ctx.colorFor(sField, l.sourceValue, srcNode.colorIndex);
      const ribbonPath = s('path', {
        d,
        fill: color,
        'fill-opacity': 0.55,
        stroke: 'none',
        class: 'pbi-chord-ribbon',
      });
      ribbonPath.append(s('title', {}, `${l.source} → ${l.target}: ${ctx.fmt(vField, l.weight)}`));
      ribbonsGroup.append(ribbonPath);
    }
    svg.append(ribbonsGroup);

    // Draw outer node arcs and labels
    const nodesGroup = s('g', { class: 'pbi-chord-nodes' });
    const fs = Math.max(9, t.labelFontSize - 1);

    for (const n of nodes) {
      const { startAngle: a1, endAngle: a2 } = n;
      const large = a2 - a1 > Math.PI ? 1 : 0;

      const p1x = cx + rIn * Math.cos(a1);
      const p1y = cy + rIn * Math.sin(a1);
      const p2x = cx + rOut * Math.cos(a1);
      const p2y = cy + rOut * Math.sin(a1);
      const p3x = cx + rOut * Math.cos(a2);
      const p3y = cy + rOut * Math.sin(a2);
      const p4x = cx + rIn * Math.cos(a2);
      const p4y = cy + rIn * Math.sin(a2);

      const d = [
        `M ${p1x} ${p1y}`,
        `L ${p2x} ${p2y}`,
        `A ${rOut} ${rOut} 0 ${large} 1 ${p3x} ${p3y}`,
        `L ${p4x} ${p4y}`,
        `A ${rIn} ${rIn} 0 ${large} 0 ${p1x} ${p1y}`,
        'Z',
      ].join(' ');

      const color = ctx.colorFor(sField, n.value, n.colorIndex);
      const ident = identityOf(ctx.data.groups, [n.value]);
      const op = markOpacity(ctx, ident);

      const nodeG = s('g', { class: 'pbi-mark', opacity: op });
      const arc = s('path', { d, fill: color });
      nodeG.append(arc);

      interactive(
        ctx,
        nodeG,
        ident,
        () => ({
          title: n.label,
          items: [{ label: 'Total Flow', value: ctx.fmt(vField, n.total), color }],
        }),
        [n.value],
      );

      // Node label on perimeter
      const midAngle = (a1 + a2) / 2;
      const labelR = rOut + 10;
      const lx = cx + labelR * Math.cos(midAngle);
      const ly = cy + labelR * Math.sin(midAngle);
      const isRight = Math.cos(midAngle) >= 0;

      nodeG.append(
        s(
          'text',
          {
            x: lx,
            y: ly + 3,
            'text-anchor': isRight ? 'start' : 'end',
            fill: t.axis,
            'font-size': fs,
            'font-family': t.fontFamily,
          },
          measureText(n.label, fs, t.fontFamily) > 60 ? n.label.slice(0, 8) + '…' : n.label,
        ),
      );

      nodesGroup.append(nodeG);
    }

    svg.append(nodesGroup);
    ctx.root.replaceChildren(svg);
  },
});

