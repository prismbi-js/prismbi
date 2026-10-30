import { s } from '../render/svg';
import { linearScale, bandScale } from '../render/scales';
import type { CellValue } from '../data/types';
import { defineVisual } from './registry';
import { emptyState, identityOf, interactive, markOpacity } from './common';

export interface CandlestickFormat {
  upColor?: string;
  downColor?: string;
  showVolume?: boolean;
}

function num(v: CellValue): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}

/** Candlestick chart: financial trading visual displaying OHLC (Open, High, Low, Close) and volume. */
export const candlestick = /* @__PURE__ */ defineVisual({
  type: 'candlestick',
  displayName: 'Candlestick',
  category: 'chart',
  roles: [
    { name: 'category', displayName: 'Date / Time', kind: 'grouping', required: true },
    { name: 'open', displayName: 'Open', kind: 'measure', required: true },
    { name: 'high', displayName: 'High', kind: 'measure', required: true },
    { name: 'low', displayName: 'Low', kind: 'measure', required: true },
    { name: 'close', displayName: 'Close', kind: 'measure', required: true },
    { name: 'volume', displayName: 'Volume', kind: 'measure' },
  ],
  defaultSort: 'key',
  render(ctx) {
    const ci = ctx.role('category').indices[0];
    const oi = ctx.role('open').indices[0];
    const hi = ctx.role('high').indices[0];
    const li = ctx.role('low').indices[0];
    const cli = ctx.role('close').indices[0];
    const vi = ctx.role('volume').indices[0];

    if (ci === undefined || oi === undefined || hi === undefined || li === undefined || cli === undefined || !ctx.data.rows.length) {
      return emptyState(ctx);
    }

    const t = ctx.theme;
    const cf = (ctx.format.candlestick ?? {}) as CandlestickFormat;
    const upColor = cf.upColor ?? (t.good || t.accent || '#16a34a');
    const downColor = cf.downColor ?? (t.bad || '#dc2626');

    const W = ctx.width;
    const H = ctx.height;
    const fs = t.labelFontSize;

    const catField = ctx.data.groups[ci];

    interface CandleItem {
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume?: number;
      identity: ReturnType<typeof identityOf>;
      opacity: number;
    }

    const items: CandleItem[] = ctx.data.rows.map((row) => {
      const date = ctx.fmt(catField, row.keys[ci]) || '';
      const o = num(row.values[oi]);
      const h = num(row.values[hi]);
      const l = num(row.values[li]);
      const c = num(row.values[cli]);
      const vol = vi !== undefined ? num(row.values[vi]) : undefined;
      const ident = identityOf(ctx.data.groups, row.keys);
      const op = markOpacity(ctx, ident);
      return { date, open: o, high: h, low: l, close: c, volume: vol, identity: ident, opacity: op };
    });

    const hasVol = vi !== undefined && items.some((it) => (it.volume ?? 0) > 0);
    const minVal = Math.min(...items.map((it) => it.low));
    const maxVal = Math.max(...items.map((it) => it.high));
    const pad = (maxVal - minVal) * 0.05 || 1;

    const left = 16;
    const right = 50;
    const top = 20;
    const bottom = 26;

    const chartW = Math.max(40, W - left - right);
    const totalH = Math.max(40, H - top - bottom);
    const priceH = hasVol ? Math.round(totalH * 0.72) : totalH;
    const volH = hasVol ? totalH - priceH - 8 : 0;
    const volTop = top + priceH + 8;

    const yScale = linearScale(minVal - pad, maxVal + pad, [top + priceH, top], { includeZero: false });
    const maxVol = hasVol ? Math.max(...items.map((it) => it.volume ?? 0)) : 0;
    const yVolScale = linearScale(0, maxVol * 1.15 || 1, [volTop + volH, volTop], { includeZero: true });

    const xBand = bandScale(items.length, [left, left + chartW], 0.25, 0.05);

    const svg = s('svg', { width: W, height: H, class: 'pbi-svg', role: 'img', 'aria-label': ctx.spec.title ?? 'Candlestick' });

    // Price horizontal gridlines
    for (const val of yScale.ticks) {
      const y = yScale(val);
      svg.append(
        s('line', { x1: left, y1: y, x2: left + chartW, y2: y, stroke: t.gridline, 'stroke-width': 1, 'stroke-dasharray': '2,2' }),
        s('text', { x: left + chartW + 6, y: y + 4, fill: t.axis, 'font-size': fs - 1, 'font-family': t.fontFamily }, val.toLocaleString(undefined, { maximumFractionDigits: 2 })),
      );
    }

    // Render candles
    items.forEach((item, i) => {
      const x = xBand(i);
      const bw = Math.max(3, xBand.bandwidth);
      const cx = x + bw / 2;

      const isUp = item.close >= item.open;
      const color = isUp ? upColor : downColor;

      const yHigh = yScale(item.high);
      const yLow = yScale(item.low);
      const yOpen = yScale(item.open);
      const yClose = yScale(item.close);

      const yBodyTop = Math.min(yOpen, yClose);
      const yBodyH = Math.max(2, Math.abs(yClose - yOpen));

      const g = s('g', { class: 'pbi-mark', opacity: item.opacity });

      // Wick line
      g.append(s('line', { x1: cx, y1: yHigh, x2: cx, y2: yLow, stroke: color, 'stroke-width': 1.5 }));

      // Body rect
      g.append(s('rect', { x, y: yBodyTop, width: bw, height: yBodyH, fill: color, rx: 1 }));

      // Volume bar if present
      if (hasVol && item.volume !== undefined) {
        const vY = yVolScale(item.volume);
        const vH = Math.max(1, volTop + volH - vY);
        g.append(s('rect', { x, y: vY, width: bw, height: vH, fill: color, opacity: 0.4 }));
      }

      interactive(
        ctx,
        g,
        item.identity,
        () => {
          const changePct = item.open ? (((item.close - item.open) / item.open) * 100).toFixed(2) : '0.00';
          return {
            title: item.date,
            items: [
              { label: 'Open', value: item.open.toLocaleString() },
              { label: 'High', value: item.high.toLocaleString() },
              { label: 'Low', value: item.low.toLocaleString() },
              { label: 'Close', value: item.close.toLocaleString() },
              { label: 'Change', value: `${changePct}%` },
              ...(item.volume !== undefined ? [{ label: 'Volume', value: item.volume.toLocaleString() }] : []),
            ],
          };
        },
        [item.date],
      );

      svg.append(g);
    });

    // Date category labels at bottom (thinned if many)
    const step = Math.max(1, Math.ceil(items.length / (chartW / 70)));
    for (let i = 0; i < items.length; i += step) {
      const cx = xBand(i) + xBand.bandwidth / 2;
      svg.append(
        s('text', { x: cx, y: H - 8, 'text-anchor': 'middle', fill: t.axis, 'font-size': fs - 1, 'font-family': t.fontFamily }, items[i].date),
      );
    }

    ctx.root.replaceChildren(svg);
  },
});
