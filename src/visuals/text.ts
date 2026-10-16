import { h } from '../render/svg';
import { escapeHtml } from '../utils';
import { defineVisual } from './registry';

/** Minimal, safe markdown: # headings, **bold**, *italic*, `code`, [links](https://...), lists, {{Measure}} placeholders. */
export function miniMarkdown(src: string, resolve?: (name: string) => string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\{\{([^}]+)\}\}/g, (_m, name: string) => escapeHtml(resolve ? resolve(name.trim()) : name))
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out: string[] = [];
  let list = false;
  for (const line of src.split(/\r?\n/)) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (list) {
      out.push('</ul>');
      list = false;
    }
    if (m) out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

/** Rich text box. `{{Measure name}}` placeholders are evaluated live under the page filters. */
export const textBox = defineVisual({
  type: 'text',
  displayName: 'Text box',
  category: 'other',
  roles: [{ name: 'values', displayName: 'Dynamic values', kind: 'measure', multiple: true }],
  defaultFormat: { header: { show: false }, title: { show: false }, border: { show: false } },
  render(ctx) {
    const content = String((ctx.format.text as { content?: string } | undefined)?.content ?? '');
    const byName = new Map(ctx.data.values.map((v, i) => [v.name, i]));
    const html = miniMarkdown(content, (name) => {
      const i = byName.get(name);
      if (i === undefined) return `{{${name}}}`;
      return ctx.fmt(ctx.data.values[i], ctx.data.rows[0]?.values[i] ?? null);
    });
    const el = h('div', { class: 'pbi-text' });
    el.innerHTML = html;
    ctx.root.replaceChildren(el);
  },
});
