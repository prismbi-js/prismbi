export const STUDIO_CSS = /* css */ `
.pbs{--pbs-pane:var(--pbi-surface);--pbs-line:var(--pbi-border);position:relative;display:grid;grid-template-columns:44px var(--pbs-left,248px) minmax(0,1fr) var(--pbs-right,300px);grid-template-rows:44px minmax(0,1fr);height:100%;min-height:480px;background:var(--pbi-bg);color:var(--pbi-fg);font:13px/1.4 var(--pbi-font);box-sizing:border-box;color-scheme:light}
.pbs[data-mode=dark]{color-scheme:dark}
.pbs *,.pbs *::before,.pbs *::after{box-sizing:border-box}
.pbs [hidden]{display:none!important}
.pbs button,.pbs input,.pbs select,.pbs textarea{font:inherit;color:inherit}
.pbs :focus-visible{outline:2px solid var(--pbi-accent);outline-offset:1px}
.pbs.is-preview{grid-template-columns:0 0 minmax(0,1fr) 0}
.pbs.is-preview .pbs-rail,.pbs.is-preview .pbs-left,.pbs.is-preview .pbs-right{display:none}
.pbs.no-left{--pbs-left:0px}.pbs.no-left .pbs-left{display:none}
.pbs.no-right{--pbs-right:0px}.pbs.no-right .pbs-right{display:none}

.pbs-top{grid-column:1/-1;display:flex;align-items:center;gap:6px;padding:0 10px;border-bottom:1px solid var(--pbs-line);background:var(--pbs-pane);min-width:0;overflow-x:auto}
.pbs-brand{font-weight:700;margin-right:6px;white-space:nowrap}
.pbs-name{border:1px solid transparent;background:transparent;border-radius:6px;padding:4px 6px;font-weight:600;min-width:80px;max-width:220px}
.pbs-name:hover,.pbs-name:focus{border-color:var(--pbs-line)}
.pbs-sep{width:1px;height:22px;background:var(--pbs-line);margin:0 4px;flex-shrink:0}
.pbs-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--pbs-line);border-radius:6px;background:transparent;cursor:pointer;white-space:nowrap;font-size:12.5px}
.pbs-btn:hover:not(:disabled){background:color-mix(in srgb,var(--pbi-fg) 7%,transparent)}
.pbs-btn:disabled{opacity:.4;cursor:default}
.pbs-btn[aria-pressed=true]{border-color:var(--pbi-accent);color:var(--pbi-accent)}
.pbs-btn.is-primary{background:var(--pbi-accent);border-color:var(--pbi-accent);color:#fff}
.pbs-icon{width:30px;height:30px;padding:0;justify-content:center}
.pbs-spacer{flex:1}
.pbs-status{font-size:12px;color:var(--pbi-fg-3);white-space:nowrap}

.pbs-rail{display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 0;border-right:1px solid var(--pbs-line);background:var(--pbs-pane)}
.pbs-rail button{width:34px;height:34px;border:0;border-radius:8px;background:transparent;cursor:pointer;display:grid;place-items:center;color:var(--pbi-fg-2)}
.pbs-rail button:hover{background:color-mix(in srgb,var(--pbi-fg) 7%,transparent)}
.pbs-rail button[aria-pressed=true]{background:color-mix(in srgb,var(--pbi-accent) 16%,transparent);color:var(--pbi-accent)}
.pbs-rail svg{width:18px;height:18px}

.pbs-left,.pbs-right{display:flex;flex-direction:column;min-height:0;background:var(--pbs-pane);overflow:hidden}
.pbs-left{border-right:1px solid var(--pbs-line)}
.pbs-right{border-left:1px solid var(--pbs-line)}
.pbs-pane-h{display:flex;align-items:center;gap:6px;padding:10px 12px 6px;font-weight:600}
.pbs-pane-h span{flex:1}
.pbs-search{margin:0 10px 8px;padding:6px 8px;border:1px solid var(--pbs-line);border-radius:6px;background:var(--pbi-bg)}
.pbs-scroll{overflow:auto;flex:1;min-height:0;padding-bottom:12px}

.pbs-tabs{display:flex;border-bottom:1px solid var(--pbs-line)}
.pbs-tabs button{flex:1;border:0;background:none;padding:10px 6px;cursor:pointer;font-weight:600;font-size:12.5px;color:var(--pbi-fg-3);border-bottom:2px solid transparent}
.pbs-tabs button[aria-selected=true]{color:var(--pbi-fg);border-bottom-color:var(--pbi-accent)}

.pbs-table{margin:2px 6px}
.pbs-table>summary{list-style:none;display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px;cursor:pointer;font-weight:600}
.pbs-table>summary::-webkit-details-marker{display:none}
.pbs-table>summary::before{content:'▸';font-size:10px;color:var(--pbi-fg-3);width:10px}
.pbs-table[open]>summary::before{content:'▾'}
.pbs-table>summary:hover{background:color-mix(in srgb,var(--pbi-fg) 5%,transparent)}
.pbs-table small{color:var(--pbi-fg-3);font-weight:400;margin-left:auto}
.pbs-field{display:flex;align-items:center;gap:8px;padding:4px 6px 4px 22px;border-radius:6px;cursor:grab;user-select:none}
.pbs-field:hover{background:color-mix(in srgb,var(--pbi-accent) 9%,transparent)}
.pbs-field.is-used{font-weight:600}
.pbs-field span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pbs-badge{flex-shrink:0;min-width:22px;height:18px;padding:0 4px;border-radius:4px;display:grid;place-items:center;font:600 10px ui-monospace,Consolas,monospace;background:color-mix(in srgb,var(--pbi-fg) 8%,transparent);color:var(--pbi-fg-2)}
.pbs-badge.is-measure{background:color-mix(in srgb,var(--pbi-accent) 18%,transparent);color:var(--pbi-accent)}
.pbs-more{border:0;background:none;cursor:pointer;color:var(--pbi-fg-3);padding:0 4px;visibility:hidden;font-size:14px}
.pbs-field:hover .pbs-more{visibility:visible}
.pbs-folder{padding:4px 6px 2px 22px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--pbi-fg-3)}

.pbs-vgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(38px,1fr));gap:4px;padding:6px 10px 10px}
.pbs-vbtn{aspect-ratio:1;border:1px solid transparent;border-radius:6px;background:transparent;cursor:pointer;display:grid;place-items:center;color:var(--pbi-fg-2)}
.pbs-vbtn:hover{background:color-mix(in srgb,var(--pbi-fg) 7%,transparent)}
.pbs-vbtn[aria-pressed=true]{border-color:var(--pbi-accent);background:color-mix(in srgb,var(--pbi-accent) 14%,transparent);color:var(--pbi-accent)}
.pbs-vbtn svg{width:20px;height:20px}
.pbs-hint{padding:10px 12px;color:var(--pbi-fg-3);font-size:12px}

.pbs-well{margin:6px 10px;display:flex;flex-direction:column;gap:4px}
.pbs-well-h{font-size:11.5px;font-weight:600;color:var(--pbi-fg-2);display:flex;justify-content:space-between}
.pbs-well-h small{font-weight:400;color:var(--pbi-fg-3)}
.pbs-drop{min-height:34px;padding:4px;border:1px dashed var(--pbs-line);border-radius:7px;display:flex;flex-direction:column;gap:3px}
.pbs-drop.is-over{border-color:var(--pbi-accent);background:color-mix(in srgb,var(--pbi-accent) 8%,transparent)}
.pbs-drop:empty::after{content:'Drag fields here';font-size:11.5px;color:var(--pbi-fg-3);padding:4px 6px}
.pbs-chip{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:5px;background:var(--pbi-bg);border:1px solid var(--pbs-line);cursor:grab;font-size:12px}
.pbs-chip span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pbs-chip select{border:0;background:transparent;font-size:11px;color:var(--pbi-fg-3);max-width:96px}
.pbs-chip button{border:0;background:none;cursor:pointer;color:var(--pbi-fg-3);padding:0 2px}

.pbs-sec{border-bottom:1px solid var(--pbs-line)}
.pbs-sec>summary{list-style:none;display:flex;align-items:center;gap:6px;padding:9px 12px;cursor:pointer;font-weight:600}
.pbs-sec>summary::-webkit-details-marker{display:none}
.pbs-sec>summary::after{content:'▸';margin-left:auto;color:var(--pbi-fg-3);font-size:10px}
.pbs-sec[open]>summary::after{content:'▾'}
.pbs-sec .pbs-reset{border:0;background:none;color:var(--pbi-accent);cursor:pointer;font-size:11.5px;font-weight:400}
.pbs-ctl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);align-items:center;gap:8px;padding:4px 12px}
.pbs-ctl label{font-size:12px;color:var(--pbi-fg-2)}
.pbs-ctl.is-wide{grid-template-columns:1fr}
.pbs-ctl input[type=text],.pbs-ctl input[type=number],.pbs-ctl select,.pbs-ctl textarea{width:100%;padding:5px 7px;border:1px solid var(--pbs-line);border-radius:6px;background:var(--pbi-bg)}
.pbs-ctl textarea{min-height:64px;font:12px ui-monospace,Consolas,monospace;resize:vertical}
.pbs-ctl input[type=color]{width:100%;height:28px;padding:2px;border:1px solid var(--pbs-line);border-radius:6px;background:var(--pbi-bg)}
.pbs-ctl input[type=checkbox]{justify-self:start;accent-color:var(--pbi-accent);width:16px;height:16px}
.pbs-ctl input[type=range]{width:100%;accent-color:var(--pbi-accent)}
.pbs-ctl .pbs-err{grid-column:1/-1;color:var(--pbi-bad);font-size:11.5px}
.pbs-colors{display:grid;grid-template-columns:repeat(8,1fr);gap:4px}
.pbs-colors input{width:100%;height:24px;padding:1px;border:1px solid var(--pbs-line);border-radius:4px;background:none}

.pbs-center{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0}
.pbs-canvas{flex:1;min-height:0;position:relative}
.pbs-canvas>.pbi-report{height:100%}
.pbs-arrange{max-width:120px}
.pbs-sched h4{margin:12px 0 6px;font-size:12px;color:var(--pbi-fg-2)}
.pbs-sched-list{margin:0 0 8px;padding:0;list-style:none;display:grid;gap:4px}
.pbs-sched-list li{display:flex;gap:6px;align-items:center}
.pbs-sched-list li>span{flex:1}
.pbs-sched-list .pbs-empty{color:var(--pbi-fg-3)}
.pbs-note{font-size:11px;color:var(--pbi-fg-3);margin:10px 0 0}
.pbs-layers{position:absolute;top:52px;right:330px;z-index:50;width:240px;max-height:60vh;overflow:auto;margin:0;padding:6px;list-style:none;display:grid;gap:2px;background:var(--pbs-pane);border:1px solid var(--pbs-line);border-radius:10px;box-shadow:0 12px 32px rgb(0 0 0/.18)}
.pbs-layers li{display:flex;gap:4px;align-items:center}
.pbs-layer-name{flex:1;min-width:0;text-align:left;font:inherit;font-size:12px;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pbs-layer-name[aria-pressed=true]{background:color-mix(in srgb,var(--pbi-accent) 14%,transparent);color:var(--pbi-accent)}
.is-phone .pbs-canvas{display:flex;justify-content:center;background:color-mix(in srgb,var(--pbi-fg) 4%,transparent)}
.is-phone .pbs-canvas>.pbi-report{width:390px;max-width:100%;border-inline:1px solid var(--pbs-line);box-shadow:0 0 0 6px color-mix(in srgb,var(--pbi-fg) 6%,transparent)}
.pbs-canvas.is-drop{outline:2px dashed var(--pbi-accent);outline-offset:-6px}
.pbs-pages{display:flex;align-items:stretch;gap:2px;padding:0 8px;border-top:1px solid var(--pbs-line);background:var(--pbs-pane);overflow-x:auto;flex-shrink:0;height:36px}
.pbs-page{display:flex;align-items:center;gap:6px;padding:0 12px;border:0;border-top:2px solid transparent;background:none;cursor:pointer;white-space:nowrap;color:var(--pbi-fg-2)}
.pbs-page[aria-selected=true]{border-top-color:var(--pbi-accent);color:var(--pbi-fg);font-weight:600}
.pbs-page small{font-size:10px;color:var(--pbi-fg-3);border:1px solid var(--pbs-line);border-radius:4px;padding:0 4px}
.pbs-page input{width:120px;padding:2px 4px;border:1px solid var(--pbi-accent);border-radius:4px;background:var(--pbi-bg)}
.pbs-addpage{border:0;background:none;cursor:pointer;font-size:18px;color:var(--pbi-fg-3);padding:0 10px}

.pbs-data{display:grid;grid-template-columns:200px minmax(0,1fr);height:100%;min-height:0}
.pbs-data-list{border-right:1px solid var(--pbs-line);overflow:auto;padding:8px}
.pbs-data-list button{display:flex;width:100%;justify-content:space-between;border:0;background:none;padding:6px 8px;border-radius:6px;cursor:pointer;text-align:left}
.pbs-data-list button[aria-pressed=true]{background:color-mix(in srgb,var(--pbi-accent) 14%,transparent);font-weight:600}
.pbs-data-list small{color:var(--pbi-fg-3)}
.pbs-data-main{display:flex;flex-direction:column;min-width:0;min-height:0}
.pbs-data-bar{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--pbs-line)}
.pbs-grid{overflow:auto;flex:1}
.pbs-grid table{border-collapse:separate;border-spacing:0;font-size:12px;font-variant-numeric:tabular-nums}
.pbs-grid th,.pbs-grid td{padding:5px 10px;border-bottom:1px solid var(--pbs-line);border-right:1px solid var(--pbs-line);white-space:nowrap;text-align:left}
.pbs-grid th{position:sticky;top:0;background:var(--pbs-pane);font-weight:600}
.pbs-grid th small{display:block;font-weight:400;color:var(--pbi-fg-3)}
.pbs-grid td.num{text-align:right}

.pbs-model{position:relative;height:100%;overflow:auto;background-image:radial-gradient(color-mix(in srgb,var(--pbi-fg) 12%,transparent) 1px,transparent 1px);background-size:20px 20px}
.pbs-model svg{position:absolute;inset:0;overflow:visible;pointer-events:none}
.pbs-model svg path.pbs-rel{pointer-events:stroke;cursor:pointer;fill:none;stroke-width:2}
.pbs-model svg path.pbs-rel-hit{pointer-events:stroke;cursor:pointer;fill:none;stroke:transparent;stroke-width:12}
.pbs-card{position:absolute;width:200px;background:var(--pbs-pane);border:1px solid var(--pbs-line);border-radius:8px;box-shadow:0 2px 10px rgb(0 0 0/.08);user-select:none}
.pbs-card header{padding:7px 10px;font-weight:700;border-bottom:1px solid var(--pbs-line);cursor:move;display:flex;justify-content:space-between}
.pbs-card header small{font-weight:400;color:var(--pbi-fg-3)}
.pbs-card ul{list-style:none;margin:0;padding:4px 0;max-height:260px;overflow:auto}
.pbs-card li{display:flex;gap:6px;align-items:center;padding:2px 10px;font-size:12px;height:22px;cursor:crosshair}
.pbs-card li:hover,.pbs-card li.is-target{background:color-mix(in srgb,var(--pbi-accent) 12%,transparent)}
.pbs-card li.is-hidden{color:var(--pbi-fg-3)}
.pbs-pop{position:absolute;z-index:20;width:240px;padding:12px;background:var(--pbs-pane);border:1px solid var(--pbs-line);border-radius:10px;box-shadow:0 10px 30px rgb(0 0 0/.18);display:flex;flex-direction:column;gap:8px;font-size:12.5px}
.pbs-pop label{display:flex;justify-content:space-between;gap:8px;align-items:center}

.pbs-modal{position:fixed;inset:0;z-index:3000;display:grid;place-items:center;background:rgb(0 0 0/.35);padding:16px}
.pbs-dialog{width:min(640px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--pbs-pane);color:var(--pbi-fg);border:1px solid var(--pbs-line);border-radius:12px;box-shadow:0 20px 60px rgb(0 0 0/.3);display:flex;flex-direction:column}
.pbs-dialog:has(.pbs-transform){width:min(880px,100%)}
.pbs-transform h4{margin:12px 0 6px;font-size:12px;color:var(--pbi-fg-2)}
.pbs-steps{margin:0;padding-left:20px;display:grid;gap:4px}
.pbs-steps li{display:flex;gap:4px;align-items:center}
.pbs-steps li>span{flex:1}
.pbs-steps .pbs-empty{list-style:none;margin-left:-20px;color:var(--pbi-fg-3)}
.pbs-icon-btn{border:1px solid var(--pbs-line);background:transparent;color:inherit;border-radius:6px;width:24px;height:24px;cursor:pointer}
.pbs-step-pick{display:flex;gap:8px;margin-bottom:8px}
.pbs-step-fields{display:flex;flex-wrap:wrap;gap:8px 12px}
.pbs-step-fields label{display:grid;gap:2px;font-size:11px;color:var(--pbi-fg-2)}
.pbs-step-fields input,.pbs-step-fields select,.pbs-step-pick select{font:inherit;font-size:12px;padding:4px 6px;border:1px solid var(--pbs-line);border-radius:6px;background:var(--pbi-bg);color:var(--pbi-fg)}
.pbs-step-preview{max-height:220px;margin-top:6px}
.pbs-dialog header{padding:14px 16px;font-weight:700;font-size:15px;border-bottom:1px solid var(--pbs-line)}
.pbs-dialog .pbs-body{padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.pbs-dialog footer{padding:12px 16px;display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--pbs-line)}
.pbs-row{display:flex;flex-direction:column;gap:4px}
.pbs-row>label{font-size:12px;font-weight:600;color:var(--pbi-fg-2)}
.pbs-row input,.pbs-row select{padding:6px 8px;border:1px solid var(--pbs-line);border-radius:6px;background:var(--pbi-bg)}
.pbs-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}

.pbs-editor{position:relative;display:flex;flex-direction:column;gap:6px}
.pbs-editor textarea{min-height:120px;resize:vertical;padding:10px;border:1px solid var(--pbs-line);border-radius:8px;background:var(--pbi-bg);font:13px/1.5 ui-monospace,Consolas,monospace;tab-size:4}
.pbs-suggest{list-style:none;margin:0;padding:4px;border:1px solid var(--pbs-line);border-radius:8px;max-height:200px;overflow:auto;background:var(--pbs-pane)}
.pbs-suggest li{display:flex;justify-content:space-between;gap:12px;padding:4px 8px;border-radius:5px;cursor:pointer;font:12px ui-monospace,Consolas,monospace}
.pbs-suggest li small{color:var(--pbi-fg-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pbs-suggest li[aria-selected=true]{background:color-mix(in srgb,var(--pbi-accent) 18%,transparent)}
.pbs-diag{font-size:12px}.pbs-diag .error{color:var(--pbi-bad)}.pbs-diag .ok{color:var(--pbi-fg-3)}
.pbs-sig{font:11.5px ui-monospace,Consolas,monospace;color:var(--pbi-fg-3);min-height:16px}
.pbs-copilot{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px dashed var(--pbi-accent);border-radius:8px}
.pbs-copilot-row{display:flex;gap:6px}
.pbs-copilot-row input{flex:1;min-width:0}
.pbs-copilot-note{font-size:12px;color:var(--pbi-fg-2);white-space:pre-line}
.pbs-copilot-note:empty{display:none}
.pbs-preview{font-size:12.5px;padding:8px 10px;border-radius:8px;background:var(--pbi-bg);border:1px solid var(--pbs-line)}
.pbs-preview b{font-size:16px}
.pbs .pbi-fpane{width:auto;border-left:0;background:transparent}
.pbs .pbi-fpane-h{display:none}
.pbs-toast{position:absolute;left:50%;bottom:52px;transform:translateX(-50%);z-index:50;padding:8px 14px;border-radius:8px;background:var(--pbi-fg);color:var(--pbi-bg);font-size:12.5px;box-shadow:0 8px 24px rgb(0 0 0/.25)}
@media (max-width:900px){.pbs{--pbs-left:0px;--pbs-right:260px}.pbs-left{display:none}}
@media (prefers-reduced-motion:reduce){.pbs *{transition:none!important}}
`;

let injected = false;
export function injectStudioStyles(doc: Document = document): void {
  if (injected || doc.querySelector('style[data-prismbi-studio]')) {
    injected = true;
    return;
  }
  const el = doc.createElement('style');
  el.setAttribute('data-prismbi-studio', '');
  el.textContent = STUDIO_CSS;
  doc.head.append(el);
  injected = true;
}
