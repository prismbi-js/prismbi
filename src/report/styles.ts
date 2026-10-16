import type { Theme } from '../theme/theme';

/** Theme → CSS custom properties (set on the report root; override any of them in your own CSS). */
export function themeVars(t: Theme): Record<string, string> {
  return {
    '--pbi-bg': t.background,
    '--pbi-surface': t.surface,
    '--pbi-fg': t.foreground,
    '--pbi-fg-2': t.foregroundSecondary,
    '--pbi-fg-3': t.foregroundMuted,
    '--pbi-grid': t.gridline,
    '--pbi-axis': t.axis,
    '--pbi-border': t.border,
    '--pbi-accent': t.accent,
    '--pbi-good': t.good,
    '--pbi-bad': t.bad,
    '--pbi-warning': t.warning,
    '--pbi-font': t.fontFamily,
    '--pbi-font-size': `${t.fontSize}px`,
    '--pbi-title-size': `${t.titleFontSize}px`,
    '--pbi-label-size': `${t.labelFontSize}px`,
    '--pbi-radius': `${t.radius}px`,
  };
}

export const CSS = /* css */ `
.pbi-report{--pbi-gap:12px;position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--pbi-bg);color:var(--pbi-fg);font:var(--pbi-font-size)/1.4 var(--pbi-font);color-scheme:light;-webkit-font-smoothing:antialiased;box-sizing:border-box}
.pbi-report[data-mode=dark]{color-scheme:dark}
.pbi-report *,.pbi-report *::before,.pbi-report *::after{box-sizing:border-box}
.pbi-report [hidden],.pbi-report[hidden],.pbi-tooltip[hidden],.pbi-menu[hidden]{display:none!important}
.pbi-report button{font:inherit;color:inherit}
.pbi-report :focus-visible{outline:2px solid var(--pbi-accent);outline-offset:1px}
.pbi-toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--pbi-border);background:var(--pbi-surface);flex-wrap:wrap}
.pbi-toolbar-title{font-weight:600;font-size:var(--pbi-title-size);margin-right:auto}
.pbi-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--pbi-border);border-radius:6px;background:transparent;cursor:pointer;font-size:12px;color:var(--pbi-fg-2)}
.pbi-btn:hover{background:color-mix(in srgb,var(--pbi-fg) 6%,transparent)}
.pbi-btn[aria-pressed=true]{border-color:var(--pbi-accent);color:var(--pbi-accent)}
.pbi-main{display:flex;flex:1;min-height:0}
.pbi-page-scroll{flex:1;min-width:0;overflow:auto;position:relative}
.pbi-page{container-type:inline-size;position:relative;display:grid;grid-template-columns:repeat(var(--pbi-cols,12),minmax(0,1fr));grid-auto-rows:var(--pbi-row,44px);gap:var(--pbi-gap);padding:var(--pbi-gap);min-height:100%}
.pbi-visual{grid-column:calc(var(--x) + 1)/span var(--w);grid-row:calc(var(--y) + 1)/span var(--h);z-index:var(--z,auto);position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--pbi-v-bg,var(--pbi-surface));border:var(--pbi-v-bw,1px) solid var(--pbi-v-bc,var(--pbi-border));border-radius:var(--pbi-v-radius,var(--pbi-radius));padding:var(--pbi-v-pad,12px);transition:box-shadow .15s}
.pbi-visual.has-shadow{box-shadow:0 1px 2px rgb(0 0 0/.06),0 4px 14px rgb(0 0 0/.06)}
.pbi-visual.is-active{box-shadow:0 0 0 2px color-mix(in srgb,var(--pbi-accent) 35%,transparent)}
@container (max-width:640px){.pbi-visual{grid-column:1/-1;grid-row:auto/span var(--h)}}
.pbi-vh{display:flex;align-items:flex-start;gap:8px;min-height:0;margin-bottom:6px}
.pbi-vh-text{flex:1;min-width:0}
.pbi-title{font-size:var(--pbi-title-size);font-weight:600;line-height:1.25;color:var(--pbi-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pbi-subtitle{font-size:12px;color:var(--pbi-fg-3);margin-top:2px}
.pbi-icons{display:flex;gap:2px;opacity:0;transition:opacity .15s;flex-shrink:0}
.pbi-visual:hover .pbi-icons,.pbi-visual:focus-within .pbi-icons,.pbi-visual.is-focus .pbi-icons{opacity:1}
.pbi-icon{width:24px;height:24px;display:grid;place-items:center;border:0;background:transparent;border-radius:5px;cursor:pointer;color:var(--pbi-fg-3);font-size:13px;line-height:1}
.pbi-icon:hover{background:color-mix(in srgb,var(--pbi-fg) 8%,transparent);color:var(--pbi-fg)}
.pbi-icon[aria-pressed=true]{color:var(--pbi-accent)}
.pbi-vbody{position:relative;flex:1;min-height:0;min-width:0}
.pbi-vbody>*{position:absolute;inset:0}
.pbi-visual.is-focus{position:absolute;inset:var(--pbi-gap);z-index:50;grid-area:auto;box-shadow:0 12px 40px rgb(0 0 0/.25)}
.pbi-page-scroll.is-focusing{overflow:hidden}
.pbi-focus-back{position:absolute;top:8px;left:8px;z-index:51}
.pbi-chart{display:flex;width:100%;height:100%;gap:6px}
.pbi-chart-legend-top{flex-direction:column}.pbi-chart-legend-bottom{flex-direction:column}
.pbi-chart-legend-left,.pbi-chart-legend-right{flex-direction:row}
.pbi-plot{flex:1;min-width:0;min-height:0;position:relative}
.pbi-svg{display:block;overflow:visible;user-select:none}
.pbi-map{overflow:hidden;cursor:grab}
.pbi-svg text{font-family:var(--pbi-font);font-size:var(--pbi-label-size)}
.pbi-tick{font-variant-numeric:tabular-nums}
.pbi-label{font-variant-numeric:tabular-nums;pointer-events:none}
.pbi-axis-title{font-size:var(--pbi-label-size)}
.pbi-mark{cursor:pointer;transition:opacity .15s;outline:none}
.pbi-mark:focus-visible{stroke:var(--pbi-fg);stroke-width:2px}
.pbi-hit{cursor:crosshair}
.pbi-grow{animation:pbi-grow ease-out both}
@keyframes pbi-grow{from{transform:scale(1,0)}to{transform:none}}
.pbi-grow-x{animation:pbi-grow-x ease-out both}
@keyframes pbi-grow-x{from{transform:scale(0,1)}to{transform:none}}
.pbi-pop{animation:pbi-pop ease-out both}
@keyframes pbi-pop{from{transform:scale(.85);opacity:0}to{transform:none}}
.pbi-draw{animation:pbi-draw ease-out forwards}
@keyframes pbi-draw{to{stroke-dashoffset:0}}
.pbi-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--pbi-fg-2);align-content:flex-start}
.pbi-legend-left,.pbi-legend-right{flex-direction:column;flex-wrap:nowrap;max-width:40%;overflow:auto}
.pbi-legend-item{display:inline-flex;align-items:center;gap:6px;border:0;background:none;padding:2px 0;cursor:pointer;color:var(--pbi-fg-2);font-size:inherit;max-width:100%;text-align:left}
.pbi-legend-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pbi-legend-item:disabled{cursor:default}
.pbi-legend-item.is-dim{opacity:.4}
.pbi-swatch{display:inline-block;flex-shrink:0;width:10px;height:10px;border-radius:3px}
.pbi-swatch-line{height:3px;width:14px;border-radius:2px}
.pbi-swatch-dot{border-radius:50%}
.pbi-empty,.pbi-error{display:grid;place-items:center;text-align:center;color:var(--pbi-fg-3);font-size:12px;padding:8px}
.pbi-error{color:var(--pbi-bad);white-space:pre-wrap;overflow:auto;place-items:start;text-align:left;font:12px/1.5 ui-monospace,Consolas,monospace}
.pbi-loading{background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--pbi-fg) 5%,transparent),transparent);background-size:200% 100%;animation:pbi-shimmer 1.2s infinite}
@keyframes pbi-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
.pbi-tooltip{position:fixed;z-index:1000;pointer-events:none;max-width:280px;background:var(--pbi-surface);color:var(--pbi-fg);border:1px solid var(--pbi-border);border-radius:8px;padding:8px 10px;box-shadow:0 8px 24px rgb(0 0 0/.16);font:12px/1.45 var(--pbi-font)}
.pbi-tooltip-title{font-weight:600;margin-bottom:4px}
.pbi-tooltip-row{display:flex;align-items:center;gap:8px;justify-content:space-between}
.pbi-tooltip-row span:first-child{display:flex;align-items:center;gap:6px;color:var(--pbi-fg-2)}
.pbi-tooltip-row b{font-weight:600;font-variant-numeric:tabular-nums}
.pbi-card{display:flex;flex-direction:column;justify-content:center;height:100%;gap:2px;min-width:0}
.pbi-card-center{align-items:center;text-align:center}
.pbi-card-value{font-weight:600;letter-spacing:-.01em;line-height:1.1;color:var(--pbi-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pbi-card-label{font-size:12px;color:var(--pbi-fg-2)}
.pbi-card-delta{font-size:12px;color:var(--pbi-fg-2)}
.pbi-card-delta b,.is-good,.is-bad,.is-flat{font-weight:600}
.is-good{color:var(--pbi-good)}.is-bad{color:var(--pbi-bad)}.is-flat{color:var(--pbi-fg-3)}
.pbi-report[data-mode=light] .is-good{color:color-mix(in srgb,var(--pbi-good) 70%,#000)}
.pbi-kpi{display:flex;flex-direction:column;gap:2px;position:relative!important;inset:auto!important}
.pbi-spark{position:absolute;left:0;bottom:0}
.pbi-mrc{overflow:auto;height:100%;display:flex;flex-direction:column;gap:8px}
.pbi-mrc-row{border-left:3px solid var(--pbi-accent);padding:4px 10px}
.pbi-mrc-title{font-weight:600;margin-bottom:4px}
.pbi-mrc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px}
.pbi-mrc-value{font-weight:600;font-size:16px}
.pbi-table-scroll{overflow:auto;height:100%}
.pbi-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;font-variant-numeric:tabular-nums}
.pbi-table th,.pbi-table td{padding:6px 8px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--pbi-grid)}
.pbi-wrap th,.pbi-wrap td{white-space:normal}
.pbi-density-compact th,.pbi-density-compact td{padding:3px 6px}
.pbi-density-comfortable th,.pbi-density-comfortable td{padding:9px 10px}
.pbi-table thead th{position:sticky;top:0;z-index:1;background:var(--pbi-surface);font-weight:600;color:var(--pbi-fg-2);border-bottom:1px solid var(--pbi-axis);cursor:pointer;user-select:none}
.pbi-table tfoot td,.pbi-table tfoot th{position:sticky;bottom:0;background:var(--pbi-surface);font-weight:600;border-top:1px solid var(--pbi-axis);border-bottom:0}
.pbi-table .is-num{text-align:right}
.pbi-banded tbody tr:nth-child(even) td,.pbi-banded tbody tr:nth-child(even) th{background:color-mix(in srgb,var(--pbi-fg) 2.5%,transparent)}
.pbi-table tbody tr:hover td,.pbi-table tbody tr:hover th{background:color-mix(in srgb,var(--pbi-accent) 7%,transparent)}
.pbi-row-select{cursor:pointer}
.pbi-table tr.is-dim td,.pbi-table tr.is-dim th{opacity:.4}
.pbi-table tr.is-selected td{background:color-mix(in srgb,var(--pbi-accent) 12%,transparent)}
.pbi-databar-cell{position:relative}
.pbi-databar{position:absolute;right:8px;top:5px;bottom:5px;opacity:.22;border-radius:3px 0 0 3px;max-width:calc(100% - 16px)}
.pbi-cell-text{position:relative}
.pbi-cf-icon{font-style:normal;font-size:10px}
.pbi-matrix tbody th{font-weight:500;background:var(--pbi-surface)}
.pbi-matrix .pbi-col-group{text-align:center}
.pbi-matrix tr.has-children>th{font-weight:600}
.pbi-expander{width:18px;height:18px;margin-right:6px;border:1px solid var(--pbi-axis);border-radius:4px;background:transparent;cursor:pointer;font-size:12px;line-height:1;padding:0;vertical-align:-3px}
.pbi-slicer{display:flex;flex-direction:column;gap:6px;height:100%;min-height:0}
.pbi-slicer-search,.pbi-range-input,.pbi-select{width:100%;padding:6px 8px;border:1px solid var(--pbi-axis);border-radius:6px;background:var(--pbi-surface);color:var(--pbi-fg);font:inherit;font-size:12px}
.pbi-slicer-list{overflow:auto;display:flex;flex-direction:column;min-height:0;flex:1}
.pbi-slicer-item{display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:12.5px;cursor:pointer;border-radius:4px}
.pbi-slicer-item:hover{background:color-mix(in srgb,var(--pbi-fg) 5%,transparent)}
.pbi-slicer-item input{accent-color:var(--pbi-accent);margin:0}
.pbi-select-all{font-weight:600}
.pbi-tree-item{gap:4px}
.pbi-tree-item label{display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;min-width:0}
.pbi-tree-item label input{accent-color:var(--pbi-accent);margin:0}
.pbi-tree-toggle{width:18px;height:18px;border:0;background:none;cursor:pointer;color:var(--pbi-fg-3);padding:0;font-size:11px;flex-shrink:0}
.pbi-tree-spacer{display:inline-block;width:18px;flex-shrink:0}
.pbi-slicer-tiles{display:flex;flex-wrap:wrap;gap:6px}
.pbi-slicer-tiles.is-vertical{flex-direction:column}
.pbi-tile{padding:5px 12px;border-radius:6px;border:1px solid var(--pbi-axis);background:transparent;cursor:pointer;font-size:12.5px}
.pbi-tile[aria-pressed=true]{background:var(--pbi-accent);border-color:var(--pbi-accent);color:#fff}
.pbi-dropdown{position:relative}
.pbi-dropdown-btn{width:100%;display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border:1px solid var(--pbi-axis);border-radius:6px;background:var(--pbi-surface);cursor:pointer;font-size:12.5px}
.pbi-dropdown-panel{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:60;max-height:260px;display:flex;flex-direction:column;gap:6px;padding:8px;background:var(--pbi-surface);border:1px solid var(--pbi-border);border-radius:8px;box-shadow:0 8px 24px rgb(0 0 0/.16)}
.pbi-between{display:flex;flex-direction:column;gap:10px}
.pbi-between-inputs{display:flex;align-items:center;gap:6px}
.pbi-between-sep{color:var(--pbi-fg-3)}
.pbi-dual-range{position:relative;height:20px;margin:0 8px}
.pbi-range-track{position:absolute;left:0;right:0;top:8px;height:4px;border-radius:2px;background:var(--pbi-grid)}
.pbi-range-fill{position:absolute;top:0;bottom:0;border-radius:2px;background:var(--pbi-accent)}
.pbi-range{position:absolute;left:-8px;right:-8px;top:0;width:calc(100% + 16px);height:20px;margin:0;background:transparent;pointer-events:none;-webkit-appearance:none;appearance:none;outline:none}
.pbi-range::-webkit-slider-runnable-track{height:20px;background:transparent;border:0}
.pbi-range::-moz-range-track{height:20px;background:transparent;border:0}
.pbi-range::-webkit-slider-thumb{pointer-events:all;-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:2px;border-radius:50%;background:var(--pbi-accent);border:2px solid var(--pbi-surface);box-shadow:0 0 0 1px var(--pbi-accent);cursor:grab}
.pbi-range::-moz-range-thumb{pointer-events:all;width:12px;height:12px;border-radius:50%;background:var(--pbi-accent);border:2px solid var(--pbi-surface);box-shadow:0 0 0 1px var(--pbi-accent);cursor:grab}
.pbi-range:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 3px color-mix(in srgb,var(--pbi-accent) 45%,transparent)}
.pbi-relative{display:flex;flex-direction:column;gap:6px}
.pbi-slider-wrap{display:flex;flex-direction:column;gap:6px;padding:0 4px}
.pbi-slider-head{display:flex;justify-content:space-between;align-items:baseline}
.pbi-slider-value{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
.pbi-slider{width:100%;accent-color:var(--pbi-accent)}
.pbi-slider-ends{display:flex;justify-content:space-between;font-size:11px;color:var(--pbi-fg-3)}
.pbi-relative-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pbi-relative-row>*{width:auto;flex:1}
.pbi-rel-n{max-width:70px}
.pbi-relative-desc{font-size:12px;color:var(--pbi-fg-3)}
.pbi-link{border:0;background:none;color:var(--pbi-accent);cursor:pointer;font-size:12px;padding:2px 4px;flex:0!important}
.pbi-text{overflow:auto;height:100%;font-size:13px;line-height:1.55;color:var(--pbi-fg-2)}
.pbi-text h3,.pbi-text h4,.pbi-text h5{margin:0 0 6px;color:var(--pbi-fg)}
.pbi-text p{margin:0 0 6px}
.pbi-tabs{display:flex;gap:2px;padding:0 12px;border-top:1px solid var(--pbi-border);background:var(--pbi-surface);overflow-x:auto;flex-shrink:0}
.pbi-tab{padding:9px 14px;border:0;border-top:2px solid transparent;background:none;cursor:pointer;font-size:12.5px;color:var(--pbi-fg-2);white-space:nowrap}
.pbi-tab[aria-selected=true]{color:var(--pbi-fg);font-weight:600;border-top-color:var(--pbi-accent)}
.pbi-fpane{width:280px;flex-shrink:0;border-left:1px solid var(--pbi-border);background:var(--pbi-surface);overflow:auto;display:flex;flex-direction:column}
.pbi-fpane[hidden]{display:none}
.pbi-fpane-h{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;font-weight:600;border-bottom:1px solid var(--pbi-border)}
.pbi-fpane-sec{padding:10px 12px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--pbi-border)}
.pbi-fpane-sec h4{margin:0;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--pbi-fg-3)}
.pbi-fcard{border:1px solid var(--pbi-border);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;background:var(--pbi-bg)}
.pbi-fcard.is-active{border-color:color-mix(in srgb,var(--pbi-accent) 60%,transparent)}
.pbi-fcard-h{display:flex;align-items:center;gap:6px;font-size:12.5px}
.pbi-fcard-h b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.pbi-fcard-sum{font-size:11.5px;color:var(--pbi-fg-3)}
.pbi-fcard-body{display:flex;flex-direction:column;gap:6px;max-height:240px}
.pbi-fcard .pbi-slicer-list{max-height:180px}
.pbi-seg{display:flex;border:1px solid var(--pbi-axis);border-radius:6px;overflow:hidden}
.pbi-seg button{flex:1;border:0;background:none;padding:4px 6px;font-size:11.5px;cursor:pointer;color:var(--pbi-fg-2)}
.pbi-seg button[aria-pressed=true]{background:var(--pbi-accent);color:#fff}
.pbi-drill-crumb{font-size:11.5px;color:var(--pbi-fg-3);margin-top:2px}
.pbi-standalone{background:transparent}.pbi-standalone .pbi-page{grid-auto-rows:1fr;height:100%;min-height:0;padding:0}.pbi-standalone .pbi-page-scroll{overflow:visible}.pbi-standalone .pbi-visual{grid-row:1/-1}
.pbi-menu{position:fixed;z-index:1001;min-width:180px;padding:4px;background:var(--pbi-surface);color:var(--pbi-fg);border:1px solid var(--pbi-border);border-radius:8px;box-shadow:0 10px 30px rgb(0 0 0/.18);font:12.5px/1.3 var(--pbi-font)}
.pbi-menu[hidden]{display:none}
.pbi-menu-item{display:flex;width:100%;justify-content:space-between;gap:16px;align-items:center;padding:7px 10px;border:0;border-radius:5px;background:none;text-align:left;cursor:pointer;color:inherit;font:inherit}
.pbi-menu-item:hover,.pbi-menu-item:focus-visible{background:color-mix(in srgb,var(--pbi-accent) 12%,transparent);outline:none}
.pbi-menu-item:disabled{opacity:.45;cursor:default}
.pbi-menu-item small{color:var(--pbi-fg-3);font-size:11px}
.pbi-menu-sep{height:1px;margin:4px 6px;background:var(--pbi-border)}
.pbi-refline-label{font-size:10.5px}
.pbi-back{font-weight:600;color:var(--pbi-accent);border-color:color-mix(in srgb,var(--pbi-accent) 40%,transparent)}
.pbi-sm{display:flex;flex-direction:column;gap:6px;width:100%;height:100%;overflow:auto}
.pbi-sm-grid{display:grid}
.pbi-sm-cell{display:flex;flex-direction:column;min-width:0;border-top:1px solid var(--pbi-grid);padding-top:4px}
.pbi-sm-title{font-size:var(--pbi-label-size);font-weight:600;color:var(--pbi-fg-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:calc(var(--pbi-label-size) + 4px)}
.pbi-sm-body{position:relative;flex:1;min-height:0}
.pbi-decomp-scroll{overflow:auto;height:100%}
.pbi-decomp{display:flex;gap:14px;min-height:100%;align-items:flex-start}
.pbi-decomp-col{flex:0 0 var(--pbi-decomp-col,190px);display:flex;flex-direction:column;gap:6px;min-width:0}
.pbi-decomp-col+.pbi-decomp-col{border-left:1px solid var(--pbi-grid);padding-left:14px}
.pbi-decomp-head{display:flex;flex-direction:column;gap:2px;font-size:12px;font-weight:600;color:var(--pbi-fg-2);min-height:30px;justify-content:center}
.pbi-decomp-auto{font-size:10.5px;font-weight:500;color:var(--pbi-accent)}
.pbi-decomp-node{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:none;cursor:pointer;text-align:left;width:100%}
.pbi-decomp-node:hover{background:color-mix(in srgb,var(--pbi-fg) 5%,transparent)}
.pbi-decomp-node.is-selected{border-color:var(--pbi-accent);background:color-mix(in srgb,var(--pbi-accent) 8%,transparent)}
.pbi-decomp-node.is-dim{opacity:.55}
.pbi-decomp-row{display:flex;justify-content:space-between;gap:8px;font-size:12px}
.pbi-decomp-row b{font-weight:600;font-variant-numeric:tabular-nums}
.pbi-decomp-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pbi-fg)}
.pbi-decomp-track{height:6px;border-radius:3px;background:var(--pbi-grid);overflow:hidden}
.pbi-decomp-track i{display:block;height:100%;border-radius:3px}
.pbi-decomp-more,.pbi-decomp-hint{font-size:11.5px;color:var(--pbi-fg-3);padding:2px 8px}
.pbi-tooltip.is-page{padding:0;max-width:none;overflow:hidden}
.pbi-tooltip-page{min-height:0;padding:8px;--pbi-gap:6px;background:var(--pbi-surface)}
.pbi-tooltip-page .pbi-visual{border:0;padding:4px}
.pbi-tooltip-page .pbi-icons{display:none}
.pbi-ei{position:absolute;top:6px;right:6px;z-index:5;display:flex;border:1px solid var(--pbi-accent);border-radius:6px;overflow:hidden;background:var(--pbi-surface);box-shadow:0 2px 8px rgb(0 0 0/.12)}
.pbi-ei button{border:0;background:none;padding:4px 8px;font-size:11px;cursor:pointer;color:var(--pbi-fg-2)}
.pbi-ei button[aria-pressed=true]{background:var(--pbi-accent);color:#fff}
.pbi-datatable-wrap{overflow:auto;height:100%}
@media (prefers-reduced-motion:reduce){.pbi-report *{animation:none!important;transition:none!important}}
`;

let injected = false;

export function injectStyles(doc: Document = document): void {
  if (injected || typeof doc === 'undefined') return;
  if (doc.querySelector('style[data-prismbi]')) {
    injected = true;
    return;
  }
  const el = doc.createElement('style');
  el.setAttribute('data-prismbi', '');
  el.textContent = CSS;
  doc.head.append(el);
  injected = true;
}
