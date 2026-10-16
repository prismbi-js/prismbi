import { DaxLanguageService, formatValue } from 'prismbi';
import type { DataModel, DaxCompletion } from 'prismbi';

/** A small DAX console: completion (Ctrl+Space / typing), live diagnostics, formatting and results. */
export function mountDaxConsole(model: DataModel, button: HTMLButtonElement): void {
  const ls = new DaxLanguageService(model);
  const panel = document.createElement('aside');
  panel.className = 'dax-console';
  panel.hidden = true;
  panel.innerHTML = `
    <header><b>DAX console</b><span>Ctrl+Enter runs · Tab accepts a suggestion</span><button type="button" data-close aria-label="Close">✕</button></header>
    <textarea spellcheck="false" aria-label="DAX expression">SUMMARIZECOLUMNS(
    Product[Category],
    "Sales", [Total Sales],
    "Margin", [Margin %]
)</textarea>
    <ul class="dax-suggest" role="listbox" hidden></ul>
    <div class="dax-diag" role="status"></div>
    <div class="dax-actions"><button type="button" data-run>Run</button><button type="button" data-format>Format</button><span class="dax-sig"></span></div>
    <div class="dax-result"></div>`;
  document.body.append(panel);
  const ta = panel.querySelector('textarea')!;
  const list = panel.querySelector<HTMLUListElement>('.dax-suggest')!;
  const diag = panel.querySelector<HTMLDivElement>('.dax-diag')!;
  const sig = panel.querySelector<HTMLSpanElement>('.dax-sig')!;
  const result = panel.querySelector<HTMLDivElement>('.dax-result')!;
  let items: DaxCompletion[] = [];
  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    document.body.classList.toggle('console-open', open);
    button.setAttribute('aria-pressed', String(open));
    if (open) {
      ta.focus();
      refresh();
    }
  };
  let active = 0;

  const fmt = (v: unknown, format?: string) => (v === null ? '(Blank)' : formatValue(v as never, format ?? (typeof v === 'number' && !Number.isInteger(v) ? '#,0.####' : undefined)));
  const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

  const refresh = () => {
    const d = ls.diagnose(ta.value);
    diag.innerHTML = d.length ? d.map((x) => `<div class="${x.severity}">${escape(x.message)}</div>`).join('') : '<div class="ok">No problems</div>';
    const help = ls.signatureHelp(ta.value, ta.selectionStart);
    sig.textContent = help ? help.signature : '';
  };
  const suggest = (force = false) => {
    const before = ta.value.slice(0, ta.selectionStart);
    if (!force && !/[A-Za-z_\['][\w. ]*$/.test(before.slice(-30))) return hide();
    items = ls.complete(ta.value, ta.selectionStart).slice(0, 8);
    if (!items.length) return hide();
    active = 0;
    list.innerHTML = items.map((it, i) => `<li role="option" aria-selected="${i === active}" data-i="${i}"><b>${escape(it.label)}</b><small>${escape(it.detail ?? it.kind)}</small></li>`).join('');
    list.hidden = false;
  };
  const hide = () => {
    list.hidden = true;
    items = [];
  };
  const accept = (i: number) => {
    const it = items[i];
    if (!it) return;
    ta.setRangeText(it.insertText, it.from, it.to, 'end');
    hide();
    ta.focus();
    refresh();
  };
  const run = () => {
    hide();
    const text = ta.value;
    try {
      let t: { columns: string[]; rows: unknown[][]; formats?: (string | undefined)[] };
      try {
        t = model.evaluateTable(text);
      } catch (tableErr) {
        if (!/table expression was expected/i.test((tableErr as Error).message)) throw tableErr;
        t = { columns: ['Value'], rows: [[model.evaluate(text)]], formats: [/^\s*\[([^\]]+)\]\s*$/.test(text) && model.hasMeasure(text.trim().slice(1, -1)) ? model.measure(text.trim().slice(1, -1)).format : undefined] };
      }
      result.innerHTML = `<p>${t.rows.length} row(s)</p><table><thead><tr>${t.columns.map((c) => `<th>${escape(c)}</th>`).join('')}</tr></thead><tbody>${t.rows
        .slice(0, 200)
        .map((r) => `<tr>${r.map((v, i) => `<td class="${typeof v === 'number' ? 'num' : ''}">${escape(fmt(v, t.formats?.[i]))}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`;
    } catch (e) {
      result.innerHTML = `<p class="error">${escape((e as Error).message)}</p>`;
    }
  };

  ta.addEventListener('input', () => {
    refresh();
    suggest();
  });
  ta.addEventListener('click', refresh);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    } else if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      suggest(true);
    } else if (!list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      list.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    } else if (!list.hidden && (e.key === 'Tab' || e.key === 'Enter')) {
      e.preventDefault();
      accept(active);
    } else if (e.key === 'Escape') hide();
  });
  list.addEventListener('mousedown', (e) => {
    const li = (e.target as HTMLElement).closest('li');
    if (li) {
      e.preventDefault();
      accept(Number(li.dataset.i));
    }
  });
  panel.querySelector('[data-run]')!.addEventListener('click', run);
  panel.querySelector('[data-format]')!.addEventListener('click', () => {
    ta.value = ls.format(ta.value);
    refresh();
  });
  panel.querySelector('[data-close]')!.addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', (e) => e.key === 'Escape' && list.hidden && setOpen(false));
  button.addEventListener('click', () => setOpen(panel.hidden));
}
