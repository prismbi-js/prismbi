import type { DataModel } from '../data/model';
import { DaxLanguageService } from '../dax/language';
import type { DaxCompletion } from '../dax/language';
import { h } from '../render/svg';

/** Textarea-based DAX editor: completion (typing / Ctrl+Space), live diagnostics and signature help. */
export class ExpressionEditor {
  readonly el: HTMLElement;
  readonly textarea: HTMLTextAreaElement;
  private list: HTMLUListElement;
  private diag: HTMLElement;
  private sig: HTMLElement;
  private items: DaxCompletion[] = [];
  private active = 0;
  private ls: DaxLanguageService;
  onChange?: (value: string) => void;

  constructor(model: DataModel, value = '', opts: { placeholder?: string; ariaLabel?: string } = {}) {
    this.ls = new DaxLanguageService(model);
    this.textarea = h('textarea', { spellcheck: 'false', placeholder: opts.placeholder ?? 'SUM(Sales[Amount])', 'aria-label': opts.ariaLabel ?? 'DAX expression' }) as HTMLTextAreaElement;
    this.textarea.value = value;
    this.list = h('ul', { class: 'pbs-suggest', role: 'listbox' }) as HTMLUListElement;
    this.list.hidden = true;
    this.sig = h('div', { class: 'pbs-sig' });
    this.diag = h('div', { class: 'pbs-diag', role: 'status' });
    this.el = h('div', { class: 'pbs-editor' }, this.textarea, this.list, this.sig, this.diag);
    this.textarea.addEventListener('input', () => {
      this.refresh();
      this.suggest(false);
      this.onChange?.(this.value);
    });
    this.textarea.addEventListener('click', () => this.refresh());
    this.textarea.addEventListener('keydown', (e) => this.key(e));
    this.textarea.addEventListener('blur', () => setTimeout(() => this.hide(), 150));
    this.list.addEventListener('mousedown', (e) => {
      const li = (e.target as HTMLElement).closest('li');
      if (li) {
        e.preventDefault();
        this.accept(Number(li.dataset.i));
      }
    });
    this.refresh();
  }

  get value(): string {
    return this.textarea.value;
  }

  set value(v: string) {
    this.textarea.value = v;
    this.refresh();
  }

  /** Current problems (empty when the expression is valid). */
  problems(): string[] {
    return this.value.trim() ? this.ls.diagnose(this.value).map((d) => d.message) : ['Enter an expression'];
  }

  format(): void {
    this.value = this.ls.format(this.value);
    this.onChange?.(this.value);
  }

  private refresh(): void {
    const problems = this.value.trim() ? this.ls.diagnose(this.value) : [];
    this.diag.replaceChildren(...(problems.length ? problems.map((p) => h('div', { class: p.severity }, p.message)) : [h('div', { class: 'ok' }, this.value.trim() ? 'No problems' : '')]));
    const help = this.ls.signatureHelp(this.value, this.textarea.selectionStart ?? this.value.length);
    this.sig.textContent = help ? help.signature : '';
  }

  private suggest(force: boolean): void {
    const pos = this.textarea.selectionStart ?? 0;
    const before = this.value.slice(0, pos);
    if (!force && !/[A-Za-z_[']$|[A-Za-z_][\w.]*$|\[[^\]]*$/.test(before)) return this.hide();
    this.items = this.ls.complete(this.value, pos).slice(0, 8);
    if (!this.items.length) return this.hide();
    this.active = 0;
    this.list.replaceChildren(...this.items.map((it, i) => h('li', { role: 'option', 'aria-selected': String(i === 0), 'data-i': i }, h('b', {}, it.label), h('small', {}, it.detail ?? it.kind))));
    this.list.hidden = false;
  }

  private hide(): void {
    this.list.hidden = true;
    this.items = [];
  }

  private accept(i: number): void {
    const it = this.items[i];
    if (!it) return;
    this.textarea.setRangeText(it.insertText, it.from, it.to, 'end');
    this.hide();
    this.textarea.focus();
    this.refresh();
    this.onChange?.(this.value);
  }

  private key(e: KeyboardEvent): void {
    if (e.key === ' ' && e.ctrlKey) {
      e.preventDefault();
      this.suggest(true);
    } else if (!this.list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.items.length) % this.items.length;
      this.list.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === this.active)));
    } else if (!this.list.hidden && (e.key === 'Tab' || e.key === 'Enter') && !e.ctrlKey) {
      e.preventDefault();
      this.accept(this.active);
    } else if (e.key === 'Escape' && !this.list.hidden) {
      e.stopPropagation();
      this.hide();
    }
  }
}
