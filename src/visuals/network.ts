import { s } from '../render/svg';
import type { CellValue } from '../data/types';
import { defineVisual } from './registry';
import { emptyState, identityOf, interactive, markOpacity } from './common';

export interface NetworkFormat {
  /** Base node radius in pixels (default 8). */
  nodeSize?: number;
  /** Link stroke width in pixels (default 1.5). */
  linkWidth?: number;
  /** Repulsion charge between nodes (default 120). */
  repulsion?: number;
  /** Whether to render node text labels (default true). */
  labels?: boolean;
  /** Whether to render directional arrowheads on links (default false). */
  arrows?: boolean;
  /** Centering gravitational pull (default 0.05). */
  gravity?: number;
  /** Number of physics simulation relaxation iterations (default 80). */
  iterations?: number;
}

interface NetworkNode {
  id: string;
  label: string;
  value: CellValue;
  group: string;
  sizeVal: number;
  degree: number;
  inWeight: number;
  outWeight: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
}

interface NetworkLink {
  source: string;
  target: string;
  sourceVal: CellValue;
  targetVal: CellValue;
  weight: number;
  srcNode?: NetworkNode;
  tgtNode?: NetworkNode;
  line?: SVGLineElement;
}

/**
 * Force-directed Network Graph visual: interactive nodes and interconnecting edges
 * with physics-based relaxation, cluster coloring, node dragging, and cross-filtering.
 */
export const network = /* @__PURE__ */ defineVisual({
  type: 'network',
  displayName: 'Network graph',
  category: 'chart',
  roles: [
    { name: 'source', displayName: 'Source', kind: 'grouping', required: true },
    { name: 'target', displayName: 'Destination', kind: 'grouping', required: true },
    { name: 'values', displayName: 'Weight', kind: 'measure' },
    { name: 'group', displayName: 'Group', kind: 'grouping' },
    { name: 'size', displayName: 'Node size', kind: 'measure' },
  ],
  render(ctx) {
    const si = ctx.role('source').indices[0];
    const ti = ctx.role('target').indices[0];
    const vi = ctx.role('values').indices[0];
    const gi = ctx.role('group').indices[0];
    const zi = ctx.role('size').indices[0];

    if (si === undefined || ti === undefined || !ctx.data.rows.length) {
      return emptyState(ctx);
    }

    const sField = ctx.data.groups[si];
    const tField = ctx.data.groups[ti];
    const vField = vi !== undefined ? ctx.data.values[vi] : undefined;
    const gField = gi !== undefined ? ctx.data.groups[gi] : undefined;
    const zField = zi !== undefined ? ctx.data.values[zi] : undefined;

    const links: NetworkLink[] = [];
    const nodeMap = new Map<string, { val: CellValue; group: string; size: number; inWeight: number; outWeight: number; degree: number }>();

    const ensureNode = (id: string, val: CellValue, grp: string, sz: number) => {
      let n = nodeMap.get(id);
      if (!n) {
        nodeMap.set(id, (n = { val, group: grp, size: sz, inWeight: 0, outWeight: 0, degree: 0 }));
      }
      return n;
    };

    for (const row of ctx.data.rows) {
      const srcRaw = row.keys[si];
      const tgtRaw = row.keys[ti];
      if (srcRaw === null || tgtRaw === null) continue;

      const srcId = ctx.fmt(sField, srcRaw) || '(Blank)';
      const tgtId = ctx.fmt(tField, tgtRaw) || '(Blank)';
      const weight = vi !== undefined && typeof row.values[vi] === 'number' ? Math.max(0.1, Number(row.values[vi])) : 1;
      const grp = gi !== undefined ? ctx.fmt(gField, row.keys[gi]) || 'Default' : 'Default';
      const sz = zi !== undefined && typeof row.values[zi] === 'number' ? Number(row.values[zi]) : 1;

      const sNode = ensureNode(srcId, srcRaw, grp, sz);
      const tNode = ensureNode(tgtId, tgtRaw, grp, sz);

      sNode.outWeight += weight;
      sNode.degree++;
      tNode.inWeight += weight;
      tNode.degree++;

      links.push({
        source: srcId,
        target: tgtId,
        sourceVal: srcRaw,
        targetVal: tgtRaw,
        weight,
      });
    }

    if (!nodeMap.size || !links.length) return emptyState(ctx);

    const t = ctx.theme;
    const W = ctx.width;
    const H = ctx.height;
    const cx = W / 2;
    const cy = H / 2;
    const fmt = (ctx.format as { network?: NetworkFormat }).network ?? {};

    const baseRadius = fmt.nodeSize ?? 8;
    const linkBaseWidth = fmt.linkWidth ?? 1.5;
    const repulsion = fmt.repulsion ?? 120;
    const gravity = fmt.gravity ?? 0.05;
    const iterations = fmt.iterations ?? 80;
    const showLabels = fmt.labels !== false;
    const showArrows = !!fmt.arrows;
    const fs = Math.max(9, t.labelFontSize - 1);
    const margin = baseRadius * 2 + 16;

    // Collect distinct groups for cluster coloring
    const groupColors = new Map<string, string>();
    let colIdx = 0;
    for (const n of nodeMap.values()) {
      if (!groupColors.has(n.group)) {
        groupColors.set(n.group, ctx.seriesColor(n.group, colIdx++));
      }
    }

    // Size normalization
    const allSizes = [...nodeMap.values()].map((n) => n.size);
    const minSize = Math.min(...allSizes);
    const maxSize = Math.max(...allSizes);

    // Build node layout array
    const nodes: NetworkNode[] = [];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    let i = 0;

    for (const [id, meta] of nodeMap) {
      // Phyllotaxis distribution as stable seed layout
      const rDist = Math.min(W, H) * 0.35 * Math.sqrt((i + 1) / nodeMap.size);
      const theta = i * goldenAngle;
      let r = baseRadius;
      if (maxSize > minSize) {
        const factor = (meta.size - minSize) / (maxSize - minSize);
        r = baseRadius * 0.75 + factor * baseRadius * 1.5;
      } else {
        r = baseRadius + Math.min(8, Math.sqrt(meta.degree) * 1.5);
      }

      nodes.push({
        id,
        label: id,
        value: meta.val,
        group: meta.group,
        sizeVal: meta.size,
        degree: meta.degree,
        inWeight: meta.inWeight,
        outWeight: meta.outWeight,
        x: cx + rDist * Math.cos(theta),
        y: cy + rDist * Math.sin(theta),
        vx: 0,
        vy: 0,
        r,
        color: groupColors.get(meta.group) ?? t.accent,
      });
      i++;
    }

    const nodeLookup = new Map<string, NetworkNode>(nodes.map((n) => [n.id, n]));
    for (const lk of links) {
      lk.srcNode = nodeLookup.get(lk.source);
      lk.tgtNode = nodeLookup.get(lk.target);
    }

    // Physics simulation: Coulomb repulsion + Hooke spring attraction + Centering gravity
    let alpha = 1.0;
    const targetSpringLen = Math.max(35, Math.min(120, Math.sqrt((W * H) / nodes.length) * 0.7));

    for (let iter = 0; iter < iterations; iter++) {
      alpha *= 0.96;

      // 1. Coulomb repulsion between all node pairs
      for (let a = 0; a < nodes.length; a++) {
        const u = nodes[a];
        for (let b = a + 1; b < nodes.length; b++) {
          const v = nodes[b];
          let dx = v.x - u.x;
          let dy = v.y - u.y;
          let distSq = dx * dx + dy * dy;
          if (distSq < 1) {
            dx = 1;
            dy = 1;
            distSq = 2;
          }
          const dist = Math.sqrt(distSq);
          const force = (repulsion * repulsion) / distSq;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          u.vx -= fx;
          u.vy -= fy;
          v.vx += fx;
          v.vy += fy;
        }
      }

      // 2. Hooke spring attraction along edges
      for (const lk of links) {
        const u = lk.srcNode;
        const v = lk.tgtNode;
        if (!u || !v) continue;
        let dx = v.x - u.x;
        let dy = v.y - u.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) dist = 1;
        const delta = (dist - targetSpringLen) * 0.05 * Math.min(2.5, Math.max(0.4, Math.log10(lk.weight + 1)));
        const fx = (dx / dist) * delta;
        const fy = (dy / dist) * delta;
        u.vx += fx;
        u.vy += fy;
        v.vx -= fx;
        v.vy -= fy;
      }

      // 3. Gravity pulling toward center and position integration
      for (const n of nodes) {
        n.vx += (cx - n.x) * gravity;
        n.vy += (cy - n.y) * gravity;

        n.x += n.vx * alpha;
        n.y += n.vy * alpha;

        // Bounded boundaries
        n.x = Math.max(margin, Math.min(W - margin, n.x));
        n.y = Math.max(margin, Math.min(H - margin, n.y));

        n.vx = 0;
        n.vy = 0;
      }
    }

    const svg = s('svg', {
      width: W,
      height: H,
      class: 'pbi-svg pbi-network',
      role: 'img',
      'aria-label': ctx.spec.title ?? 'Network graph',
    });

    // Arrow markers if requested
    if (showArrows) {
      const defs = s('defs');
      const marker = s('marker', {
        id: 'pbi-net-arrow',
        viewBox: '0 0 10 10',
        refX: '18',
        refY: '5',
        markerWidth: '6',
        markerHeight: '6',
        orient: 'auto-start-reverse',
      });
      marker.append(s('path', { d: 'M 0 1.5 L 8 5 L 0 8.5 z', fill: t.foregroundSecondary }));
      defs.append(marker);
      svg.append(defs);
    }

    const gLinks = s('g', { class: 'pbi-network-links' });
    const gNodes = s('g', { class: 'pbi-network-nodes' });
    svg.append(gLinks, gNodes);
    ctx.root.replaceChildren(svg);

    // Max weight for scaling link widths
    const maxWeight = Math.max(...links.map((l) => l.weight));

    // Render links
    for (const lk of links) {
      const u = lk.srcNode;
      const v = lk.tgtNode;
      if (!u || !v) continue;

      const sw = Math.min(6, Math.max(linkBaseWidth, linkBaseWidth + (lk.weight / maxWeight) * 4));
      const line = s('line', {
        x1: u.x,
        y1: u.y,
        x2: v.x,
        y2: v.y,
        stroke: t.axis,
        'stroke-width': sw,
        'stroke-opacity': 0.45,
        class: 'pbi-network-edge',
        ...(showArrows ? { 'marker-end': 'url(#pbi-net-arrow)' } : {}),
      }) as SVGLineElement;

      lk.line = line;
      gLinks.append(line);
    }

    // Render nodes
    for (const n of nodes) {
      const identity = identityOf([sField], [n.value]);
      const nodeG = s('g', {
        class: 'pbi-network-node',
        'data-node-id': n.id,
      });

      const circle = s('circle', {
        cx: n.x,
        cy: n.y,
        r: n.r,
        fill: n.color,
        stroke: t.surface,
        'stroke-width': 2,
        opacity: markOpacity(ctx, identity),
        class: 'pbi-network-circle',
      });
      nodeG.append(circle);

      let labelEl: SVGTextElement | null = null;
      if (showLabels) {
        labelEl = s(
          'text',
          {
            x: n.x,
            y: n.y + n.r + fs,
            'text-anchor': 'middle',
            class: 'pbi-label pbi-network-label',
            fill: t.foregroundSecondary,
            'font-size': `${fs}px`,
            'pointer-events': 'none',
          },
          n.label,
        ) as SVGTextElement;
        nodeG.append(labelEl);
      }

      // Adjacency for hover highlighting
      const connectedLinks = links.filter((l) => l.srcNode === n || l.tgtNode === n);
      const neighborIds = new Set(connectedLinks.flatMap((l) => [l.source, l.target]));

      // Wire interactive selection and tooltips
      interactive(
        ctx,
        circle,
        identity,
        () => {
          const items = [
            { label: 'Connections', value: String(n.degree), color: n.color },
            { label: 'Inbound weight', value: ctx.fmt(vField, n.inWeight), color: t.foregroundSecondary },
            { label: 'Outbound weight', value: ctx.fmt(vField, n.outWeight), color: t.foregroundSecondary },
          ];
          if (zi !== undefined) items.push({ label: 'Size', value: ctx.fmt(zField, n.sizeVal), color: t.foregroundSecondary });
          if (gi !== undefined) items.push({ label: 'Group', value: n.group, color: n.color });
          return { title: n.label, items };
        },
        [n.value],
      );

      // Node dragging
      nodeG.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        let startX = e.clientX;
        let startY = e.clientY;

        const onMouseMove = (ev: MouseEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          startX = ev.clientX;
          startY = ev.clientY;

          n.x = Math.max(margin, Math.min(W - margin, n.x + dx));
          n.y = Math.max(margin, Math.min(H - margin, n.y + dy));

          circle.setAttribute('cx', String(n.x));
          circle.setAttribute('cy', String(n.y));
          if (labelEl) {
            labelEl.setAttribute('x', String(n.x));
            labelEl.setAttribute('y', String(n.y + n.r + fs));
          }

          for (const lk of connectedLinks) {
            if (lk.line) {
              if (lk.srcNode === n) {
                lk.line.setAttribute('x1', String(n.x));
                lk.line.setAttribute('y1', String(n.y));
              } else {
                lk.line.setAttribute('x2', String(n.x));
                lk.line.setAttribute('y2', String(n.y));
              }
            }
          }
        };

        const onMouseUp = () => {
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });

      // Hover dimming of non-adjacent entities
      nodeG.addEventListener('mouseenter', () => {
        for (const other of nodes) {
          const isNeighbor = neighborIds.has(other.id);
          const el = gNodes.querySelector(`[data-node-id="${other.id}"] .pbi-network-circle`);
          if (el) (el as HTMLElement).style.opacity = isNeighbor ? '1' : '0.15';
        }
        for (const lk of links) {
          if (lk.line) {
            const isConn = lk.srcNode === n || lk.tgtNode === n;
            lk.line.style.strokeOpacity = isConn ? '0.9' : '0.08';
            lk.line.style.stroke = isConn ? n.color : t.axis;
          }
        }
      });

      nodeG.addEventListener('mouseleave', () => {
        for (const other of nodes) {
          const el = gNodes.querySelector(`[data-node-id="${other.id}"] .pbi-network-circle`);
          if (el) (el as HTMLElement).style.opacity = '';
        }
        for (const lk of links) {
          if (lk.line) {
            lk.line.style.strokeOpacity = '';
            lk.line.style.stroke = '';
          }
        }
      });

      gNodes.append(nodeG);
    }
  },
});

