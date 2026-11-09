import { h, measureText } from '../render/svg';
import { linearScale, type LinearScale } from '../render/scales';
import { valueKey, type CellValue } from '../data/types';
import type { QueryRow } from '../data/query';
import { deepMerge } from '../utils';
import type { VisualFormat } from './format';
import type { RenderContext } from './types';
import { pivot, renderLegend } from './common';

export interface SmallMultiplesFormat {
  /** Fixed number of grid columns (default: auto from aspect ratio). */
  columns?: number;
  /** Fixed number of grid rows (optional, default: auto). */
  rows?: number;
  /** Share one value axis range across panels (default true). */
  sharedAxis?: boolean;
  /** Share category domain across panels (default true, keeps uniform x-axis alignment). */
  sharedCategoryAxis?: boolean;
  /** Trellis grid style: 'grid' (default flow), or 'matrix' (2D row/col breakdown if multiple fields). */
  layout?: 'grid' | 'matrix';
  /** Panel header position: 'top' | 'bottom'. Default: 'top'. */
  headerPosition?: 'top' | 'bottom';
  /** Panel header text alignment: 'left' | 'center' | 'right'. Default: 'left'. */
  headerAlignment?: 'left' | 'center' | 'right';
  /** Panel header font size in px. */
  headerFontSize?: number;
  /** Panel header font color. */
  headerColor?: string;
  /** Whether to draw a border around each small multiple cell/panel. Default: false. */
  border?: boolean;
  /** Custom border color for panels. */
  borderColor?: string;
  /** Background color for each panel. */
  panelBackground?: string;
  /** Padding inside each panel cell in px. */
  padding?: number;
  /** Outer axes only: deduplicate axis ticks/labels to only border edges. Default: false. */
  outerAxesOnly?: boolean;
  /** Minimum panel size in px. */
  minWidth?: number;
  minHeight?: number;
  /** Gap between panels in px. */
  gap?: number;
}

/**
 * If the visual has a `smallMultiples` field, render one panel per member with a shared value
 * axis and a single legend, calling `render` for each panel. Returns false when not applicable.
 */
export function renderSmallMultiples(ctx: RenderContext, render: (panel: RenderContext) => void, stacked = false): boolean {
  const sm = ctx.role('smallMultiples');
  if (!sm.indices.length) return false;
  const smf = (ctx.format.smallMultiples ?? {}) as SmallMultiplesFormat;
  const is2D = sm.indices.length >= 2;
  const useMatrix = is2D && smf.layout === 'matrix';

  // shared value range across panels (stack totals for stacked charts)
  const vals = ctx.role('values').indices.length
    ? ctx.role('values').indices
    : [...ctx.role('value').indices, ...ctx.role('y').indices, ...ctx.role('x').indices];
  const lineVals = ctx.role('lineValues').indices;
  const cat = ctx.role('category').indices.length
    ? ctx.role('category').indices
    : ctx.role('details').indices;
  const hasCat = ctx.role('category').indices.length > 0;

  let lo = 0;
  let hi = 0;
  if (stacked) {
    const sums = new Map<string, [number, number]>();
    for (const r of ctx.data.rows) {
      const k = JSON.stringify([...sm.indices.map((i) => valueKey(r.keys[i])), ...cat.map((i) => valueKey(r.keys[i]))]);
      const cur = sums.get(k) ?? [0, 0];
      for (const vi of vals) {
        const v = r.values[vi];
        if (typeof v === 'number') v >= 0 ? (cur[1] += v) : (cur[0] += v);
      }
      sums.set(k, cur);
    }
    for (const [n, p] of sums.values()) (lo = Math.min(lo, n)), (hi = Math.max(hi, p));
  } else {
    for (const r of ctx.data.rows) {
      for (const vi of vals) {
        const v = r.values[vi];
        if (typeof v === 'number') (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
      }
    }
  }
  const nice = linearScale(lo, hi, [0, 1]);

  let nice2: LinearScale | undefined;
  if (lineVals.length) {
    let lo2 = 0;
    let hi2 = 0;
    for (const r of ctx.data.rows) {
      for (const vi of lineVals) {
        const v = r.values[vi];
        if (typeof v === 'number') (lo2 = Math.min(lo2, v)), (hi2 = Math.max(hi2, v));
      }
    }
    nice2 = linearScale(lo2, hi2, [0, 1]);
  }

  // Category unification across panels
  const catKeyFn = (keys: CellValue[]) => JSON.stringify(keys.map(valueKey));
  const catMap = new Map<string, CellValue[]>();
  if (hasCat && smf.sharedCategoryAxis !== false) {
    for (const r of ctx.data.rows) {
      const cks = cat.map((i) => r.keys[i]);
      const k = catKeyFn(cks);
      if (!catMap.has(k)) catMap.set(k, cks);
    }
  }
  const allCategories = [...catMap.entries()];

  const alignRows = (panelRows: QueryRow[], rawKeys?: CellValue[], singleKey?: CellValue): QueryRow[] => {
    if (!hasCat || smf.sharedCategoryAxis === false || !allCategories.length) return panelRows;
    const rowsByCat = new Map<string, QueryRow[]>();
    for (const r of panelRows) {
      const k = catKeyFn(cat.map((i) => r.keys[i]));
      let arr = rowsByCat.get(k);
      if (!arr) rowsByCat.set(k, (arr = []));
      arr.push(r);
    }
    const aligned: QueryRow[] = [];
    for (const [, cks] of allCategories) {
      const existing = rowsByCat.get(catKeyFn(cks));
      if (existing && existing.length) {
        aligned.push(...existing);
      } else {
        const synthKeys: CellValue[] = new Array(ctx.data.groups.length).fill(null);
        if (rawKeys) {
          rawKeys.forEach((v, i) => { synthKeys[i] = v; });
        } else if (singleKey !== undefined) {
          synthKeys[sm.indices[0]] = singleKey;
        }
        cat.forEach((ci, idx) => {
          synthKeys[ci] = cks[idx];
        });
        aligned.push({
          keys: synthKeys,
          values: new Array(ctx.data.values.length).fill(null),
        });
      }
    }
    return aligned;
  };

  // one legend for the whole visual (supporting combo charts with secondary lines)
  const full = pivot(ctx);
  let legend: HTMLElement | null = null;
  if (lineVals.length) {
    const lp = pivot(ctx, 'category', '__none__', 'lineValues');
    const items = [
      ...full.series.map((se) => ({ name: se.name, color: se.color, identity: se.identity, shape: 'square' as const })),
      ...lp.series.map((se, i) => ({ name: se.name, color: ctx.seriesColor(se.name, full.series.length + i), identity: se.identity, shape: 'line' as const })),
    ];
    legend = renderLegend(ctx, items);
  } else {
    legend = renderLegend(ctx, full.series.map((se) => ({ name: se.name, color: se.color, identity: se.identity })));
  }

  const fmt: VisualFormat = deepMerge(ctx.format, {
    legend: { show: false },
    valueAxis: smf.sharedAxis === false ? {} : { min: ctx.format.valueAxis.min ?? nice.domain[0], max: ctx.format.valueAxis.max ?? nice.domain[1] },
    ...(nice2 && smf.sharedAxis !== false
      ? {
          secondaryValueAxis: {
            ...ctx.format.secondaryValueAxis,
            min: ctx.format.secondaryValueAxis?.min ?? nice2.domain[0],
            max: ctx.format.secondaryValueAxis?.max ?? nice2.domain[1],
          },
        }
      : {}),
  } as Partial<VisualFormat>);

  const gap = smf.gap ?? 8;
  const W = ctx.width;
  const H = ctx.height - (legend ? Math.max(legend.offsetHeight || 0, 24) + 6 : 0);

  // ----------------- 2D Matrix Layout (facet_grid) -----------------
  if (useMatrix) {
    const rowField = ctx.data.groups[sm.indices[0]];
    const colField = ctx.data.groups[sm.indices[1]];
    const rowOrder = new Map<unknown, number>();
    if (rowField.column) ctx.model.table(rowField.column.table).distinct(rowField.column.column).forEach((v, i) => rowOrder.set(valueKey(v), i));
    const colOrder = new Map<unknown, number>();
    if (colField.column) ctx.model.table(colField.column.table).distinct(colField.column.column).forEach((v, i) => colOrder.set(valueKey(v), i));

    const rowSet = new Map<unknown, CellValue>();
    const colSet = new Map<unknown, CellValue>();
    const cellRowsMap = new Map<string, QueryRow[]>();

    for (const r of ctx.data.rows) {
      const rv = r.keys[sm.indices[0]];
      const cv = r.keys[sm.indices[1]];
      const rk = valueKey(rv);
      const ck = valueKey(cv);
      rowSet.set(rk, rv);
      colSet.set(ck, cv);
      const cellKey = `${rk}___${ck}`;
      let arr = cellRowsMap.get(cellKey);
      if (!arr) cellRowsMap.set(cellKey, (arr = []));
      arr.push(r);
    }

    const rowVals = [...rowSet.values()].sort((a, b) => (rowOrder.get(valueKey(a)) ?? 0) - (rowOrder.get(valueKey(b)) ?? 0));
    const colVals = [...colSet.values()].sort((a, b) => (colOrder.get(valueKey(a)) ?? 0) - (colOrder.get(valueKey(b)) ?? 0));
    const R = Math.max(1, rowVals.length);
    const C = Math.max(1, colVals.length);

    ctx.root.replaceChildren();
    const wrap = h('div', { class: 'pbi-sm' });
    if (legend) wrap.append(legend);
    const matrix = h('div', { class: 'pbi-sm-matrix' });
    wrap.append(matrix);
    ctx.root.append(wrap);

    const fs = ctx.theme.labelFontSize;
    const colHeaderH = fs + 8;
    const rowHeaderW = Math.min(120, Math.max(48, ...rowVals.map((v) => measureText(ctx.fmt(rowField, v), fs, ctx.theme.fontFamily) + 12)));

    matrix.style.gridTemplateColumns = `${rowHeaderW}px repeat(${C}, minmax(0, 1fr))`;
    matrix.style.gridTemplateRows = `${colHeaderH}px repeat(${R}, minmax(0, 1fr))`;
    matrix.style.gap = `${gap}px`;

    const cellW = Math.max(smf.minWidth ?? 100, (W - rowHeaderW - gap * C) / C);
    const cellH = Math.max(smf.minHeight ?? 90, (H - colHeaderH - gap * R) / R);

    // Corner cell
    matrix.append(h('div', { class: 'pbi-sm-matrix-corner' }));
    // Column headers
    for (const cv of colVals) {
      matrix.append(h('div', { class: 'pbi-sm-col-header' }, ctx.fmt(colField, cv) || '(Blank)'));
    }

    for (let r = 0; r < R; r++) {
      const rv = rowVals[r];
      matrix.append(h('div', { class: 'pbi-sm-row-header' }, ctx.fmt(rowField, rv) || '(Blank)'));
      for (let c = 0; c < C; c++) {
        const cv = colVals[c];
        const cellKey = `${valueKey(rv)}___${valueKey(cv)}`;
        const pRows = cellRowsMap.get(cellKey) ?? [];
        const cell = h('div', { class: 'pbi-sm-cell', style: `height:${cellH}px` });
        if (smf.border) cell.classList.add('has-border');
        if (smf.borderColor) cell.style.borderColor = smf.borderColor;
        if (smf.panelBackground) cell.style.backgroundColor = smf.panelBackground;
        if (smf.padding) cell.style.padding = `${smf.padding}px`;

        if (smf.outerAxesOnly) {
          if (c > 0) cell.classList.add('pbi-sm-inner-col');
          if (r < R - 1) cell.classList.add('pbi-sm-inner-row');
        }

        const body = h('div', { class: 'pbi-sm-body' });
        cell.append(body);
        matrix.append(cell);

        const alignedRows = alignRows(pRows, undefined, rv);
        render({
          ...ctx,
          root: body,
          width: cellW,
          height: cellH,
          format: fmt,
          data: { ...ctx.data, rows: alignedRows, totals: undefined },
          role: (name) => (name === 'smallMultiples' ? { kind: 'group', indices: [], fields: [] } : ctx.role(name)),
        });
      }
    }
    return true;
  }

  // ----------------- Standard Flow Grid Layout -----------------
  const si = sm.indices[0];
  const field = ctx.data.groups[si];
  const order = new Map<unknown, number>();
  if (field.column) ctx.model.table(field.column.table).distinct(field.column.column).forEach((v, i) => order.set(valueKey(v), i));

  const panels = new Map<string, { key: CellValue; label: string; rawKeys: CellValue[]; rows: QueryRow[] }>();
  for (const r of ctx.data.rows) {
    let k: string;
    let label: string;
    if (is2D) {
      k = JSON.stringify(sm.indices.map((i) => valueKey(r.keys[i])));
      label = sm.indices.map((i) => ctx.fmt(ctx.data.groups[i], r.keys[i]) || '(Blank)').join(' · ');
    } else {
      k = String(valueKey(r.keys[si]));
      label = ctx.fmt(field, r.keys[si]) || '(Blank)';
    }
    let p = panels.get(k);
    if (!p) panels.set(k, (p = { key: r.keys[si], label, rawKeys: r.keys, rows: [] }));
    p.rows.push(r);
  }

  const list = [...panels.values()].sort((a, b) => (order.get(valueKey(a.key)) ?? 0) - (order.get(valueKey(b.key)) ?? 0));
  ctx.root.replaceChildren();
  const wrap = h('div', { class: 'pbi-sm' });
  if (legend) wrap.append(legend);
  const grid = h('div', { class: 'pbi-sm-grid' });
  wrap.append(grid);
  ctx.root.append(wrap);

  const n = list.length;
  const minW = smf.minWidth ?? 160;
  let cols: number;
  let rowsN: number;
  if (smf.columns && smf.rows) {
    cols = Math.max(1, smf.columns);
    rowsN = Math.max(1, smf.rows);
  } else if (smf.columns) {
    cols = Math.max(1, Math.min(n, smf.columns));
    rowsN = Math.ceil(n / cols);
  } else if (smf.rows) {
    rowsN = Math.max(1, Math.min(n, smf.rows));
    cols = Math.ceil(n / rowsN);
  } else {
    cols = Math.max(1, Math.min(n, Math.max(1, Math.min(Math.floor(W / minW), Math.round(Math.sqrt((n * W) / Math.max(1, H)))))));
    rowsN = Math.ceil(n / cols);
  }

  const cellW = (W - gap * (cols - 1)) / cols;
  const cellH = Math.max(smf.minHeight ?? 110, (H - gap * (rowsN - 1)) / rowsN);
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gap = `${gap}px`;
  const titleH = (smf.headerFontSize ?? ctx.theme.labelFontSize) + 8;

  list.forEach((p, index) => {
    const colIdx = index % cols;
    const rowIdx = Math.floor(index / cols);
    const cell = h('div', { class: 'pbi-sm-cell', style: `height:${cellH}px` });
    if (smf.border) cell.classList.add('has-border');
    if (smf.borderColor) cell.style.borderColor = smf.borderColor;
    if (smf.panelBackground) cell.style.backgroundColor = smf.panelBackground;
    if (smf.padding) cell.style.padding = `${smf.padding}px`;

    if (smf.outerAxesOnly) {
      if (colIdx > 0) cell.classList.add('pbi-sm-inner-col');
      if (rowIdx < rowsN - 1 && index + cols < n) cell.classList.add('pbi-sm-inner-row');
    }

    const title = h('div', { class: 'pbi-sm-title' }, p.label);
    if (smf.headerAlignment) title.style.textAlign = smf.headerAlignment;
    if (smf.headerFontSize) title.style.fontSize = `${smf.headerFontSize}px`;
    if (smf.headerColor) title.style.color = smf.headerColor;

    const body = h('div', { class: 'pbi-sm-body' });
    if (smf.headerPosition === 'bottom') {
      cell.append(body, title);
    } else {
      cell.append(title, body);
    }
    grid.append(cell);

    const alignedRows = alignRows(p.rows, p.rawKeys, p.key);
    render({
      ...ctx,
      root: body,
      width: cellW,
      height: cellH - titleH,
      format: fmt,
      data: { ...ctx.data, rows: alignedRows, totals: undefined },
      role: (name) => (name === 'smallMultiples' ? { kind: 'group', indices: [], fields: [] } : ctx.role(name)),
    });
  });

  return true;
}
