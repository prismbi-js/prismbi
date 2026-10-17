#!/usr/bin/env node
// Builds the docs site from docs/guide/*.md into examples/docs/ (served by `npm run dev` at /docs/).
// Code blocks fenced as ```js playground get a "Run" link that opens them in /playground.html.
// Zero dependencies: a small Markdown renderer covering what the guides use.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const guideDir = join(root, 'docs', 'guide');
const out = join(root, 'examples', 'docs');

// reading order (the README's), then any other guide alphabetically
const ORDER = ['getting-started', 'data-model', 'expressions', 'advanced-modeling', 'tooling', 'visuals', 'interactions', 'theming', 'studio', 'react', 'frameworks', 'custom-visuals', 'ai', 'transforms', 'connectors', 'sql', 'performance', 'files', 'server', 'collab', 'plugins', 'powerbi'];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    // images: guides reference ../images/…, the site serves them from images/
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${src.replace(/^\.\.\/images\//, 'images/')}" alt="${alt}" loading="lazy">`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(?<!<img[^>]*)\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${esc(href.replace(/^(?!https?:)([\w./-]+)\.md(#.*)?$/, (_m, p, h) => `${p.split('/').pop()}.html${h ?? ''}`))}">${label}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

/** Markdown → { html, title, headings, examples }. */
export function render(md, page = '') {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const headings = [];
  const examples = [];
  let title = '';
  let i = 0;
  const listStack = []; // { type, indent }
  const closeLists = (indent = -1) => {
    while (listStack.length && listStack[listStack.length - 1].indent > indent) html.push(`</li></${listStack.pop().type}>`);
  };
  let para = [];
  const flush = () => {
    if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^(\s*)```(\S*)\s*(.*)$/.exec(line);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++].slice(fence[1].length));
      i++;
      const code = body.join('\n');
      const lang = fence[2] || 'text';
      let run = '';
      if (/\bplayground\b/.test(fence[3])) {
        examples.push(code);
        run = `<a class="run" href="../playground.html#${encodeURIComponent(`${page}/${examples.length - 1}`)}">▶ Run in playground</a>`;
      }
      html.push(`<div class="code">${run}<pre><code class="lang-${esc(lang)}">${esc(code)}</code></pre></div>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      closeLists();
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 1 && !title) title = text.replace(/`/g, '');
      const id = slug(text);
      if (level > 1) headings.push({ level, text: text.replace(/`/g, ''), id });
      html.push(`<h${level} id="${id}">${inline(text)}${level > 1 ? ` <a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : ''}</h${level}>`);
      i++;
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      flush();
      closeLists();
      const cells = (l) => l.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      html.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const indent = li[1].length;
      const type = /\d/.test(li[2]) ? 'ol' : 'ul';
      const top = listStack[listStack.length - 1];
      if (!top || indent > top.indent) {
        html.push(`<${type}><li>`);
        listStack.push({ type, indent });
      } else {
        closeLists(indent);
        html.push('</li><li>');
      }
      let text = li[3];
      // continuation lines of the same item
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i + 1]) && !/^\s*```/.test(lines[i + 1])) text += ` ${lines[++i].trim()}`;
      html.push(inline(text));
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      closeLists();
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${inline(body.join(' '))}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      // a blank line ends a list unless the next line continues it
      if (listStack.length && !/^\s*([-*]|\d+\.)\s+/.test(lines[i + 1] ?? '') && !/^\s+```/.test(lines[i + 1] ?? '')) closeLists();
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      flush();
      closeLists();
      html.push('<hr>');
      i++;
      continue;
    }
    closeLists();
    para.push(line.trim());
    i++;
  }
  flush();
  closeLists();
  return { html: html.join('\n'), title, headings, examples };
}

const CSS = `
:root{--bg:#fff;--fg:#1d2330;--fg2:#5b6475;--line:#e3e6ec;--side:#f6f7f9;--accent:#2f6fde;--code:#f3f4f7;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e4e7ec;--fg2:#9aa3b2;--line:#2a2f38;--side:#191d23;--accent:#6aa0ff;--code:#1e232b;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}
nav{background:var(--side);border-right:1px solid var(--line);padding:16px;position:sticky;top:0;height:100vh;overflow:auto}
nav .brand{font-weight:700;font-size:16px;display:block;margin-bottom:12px;color:var(--fg);text-decoration:none}
nav input{width:100%;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;margin-bottom:10px}
nav ul{list-style:none;margin:0;padding:0}
nav li a{display:block;padding:4px 8px;border-radius:6px;color:var(--fg2);text-decoration:none;font-size:14px}
nav li a:hover,nav li a[aria-current]{background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--fg)}
nav .results a small{display:block;color:var(--fg2);font-size:12px}
main{padding:32px 48px 80px;max-width:920px}
h1{font-size:30px;margin:0 0 16px}h2{margin-top:36px;padding-top:8px;border-top:1px solid var(--line)}h3{margin-top:26px}
.anchor{opacity:0;text-decoration:none;color:var(--fg2);font-weight:400}h2:hover .anchor,h3:hover .anchor{opacity:1}
a{color:var(--accent)}
code{font:13px ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code);padding:1px 5px;border-radius:4px}
.code{position:relative;margin:14px 0}
pre{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow:auto;margin:0}
pre code{background:none;padding:0;font-size:13px;line-height:1.55}
.run{position:absolute;top:8px;right:10px;font-size:12px;padding:3px 10px;border-radius:999px;background:var(--accent);color:#fff;text-decoration:none}
.table{overflow:auto}table{border-collapse:collapse;margin:14px 0;font-size:14px}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--side)}
main img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:10px}td img{border:0;border-radius:6px}thead:not(:has(th:not(:empty))){display:none}p:has(>img:only-child){margin:18px 0}
blockquote{margin:14px 0;padding:8px 14px;border-left:3px solid var(--accent);color:var(--fg2)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;padding:0;list-style:none}
.cards a{display:block;padding:14px;border:1px solid var(--line);border-radius:10px;text-decoration:none;color:var(--fg)}.cards a:hover{border-color:var(--accent)}
.cards small{display:block;color:var(--fg2);margin-top:4px}
@media (max-width:760px){body{grid-template-columns:1fr}nav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:20px 16px 60px}}
`;

const SEARCH = `
const box=document.getElementById('q'),list=document.getElementById('nav-list'),res=document.getElementById('results');
let index=null;
box.addEventListener('input',async()=>{const q=box.value.trim().toLowerCase();if(!q){res.hidden=true;list.hidden=false;return}
index??=await (await fetch('search.json')).json();
const hits=index.filter(e=>e.t.toLowerCase().includes(q)||e.x.includes(q)).slice(0,20);
res.innerHTML=hits.map(e=>'<li><a href="'+e.u+'">'+e.t.replace(/</g,'&lt;')+'<small>'+e.p.replace(/</g,'&lt;')+'</small></a></li>').join('')||'<li><a>No results</a></li>';
res.hidden=false;list.hidden=true});
`;

function page(title, body, nav, current) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · PrismBI docs</title><link rel="stylesheet" href="docs.css"></head>
<body><nav aria-label="Guides"><a class="brand" href="index.html">PrismBI docs</a>
<input id="q" type="search" placeholder="Search the guides" aria-label="Search the guides">
<ul id="results" class="results" hidden></ul>
<ul id="nav-list">${nav.map((g) => `<li><a href="${g.file}.html"${g.file === current ? ' aria-current="page"' : ''}>${esc(g.title)}</a></li>`).join('')}<li><a href="../playground.html">▶ Playground</a></li></ul></nav>
<main>${body}</main><script>${SEARCH}</script></body></html>`;
}

export function buildDocs() {
  const files = readdirSync(guideDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  files.sort((a, b) => (ORDER.indexOf(a) + 1 || 999) - (ORDER.indexOf(b) + 1 || 999) || a.localeCompare(b));
  const guides = files.map((file) => ({ file, ...render(readFileSync(join(guideDir, `${file}.md`), 'utf8'), file) }));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'docs.css'), CSS);
  const images = join(root, 'docs', 'images');
  if (existsSync(images)) cpSync(images, join(out, 'images'), { recursive: true });
  const search = [];
  for (const g of guides) {
    writeFileSync(join(out, `${g.file}.html`), page(g.title, g.html, guides, g.file));
    search.push({ t: g.title, p: 'Guide', u: `${g.file}.html`, x: g.title.toLowerCase() });
    for (const h of g.headings) search.push({ t: h.text, p: g.title, u: `${g.file}.html#${h.id}`, x: h.text.toLowerCase() });
  }
  writeFileSync(join(out, 'search.json'), JSON.stringify(search));
  const intro = `<h1>PrismBI documentation</h1><p>Guides for the model, DAX, visuals, the report runtime, the Studio and every entry point. Examples marked <strong>▶ Run in playground</strong> run live against the demo model.</p>
<ul class="cards">${guides.map((g) => `<li><a href="${g.file}.html"><strong>${esc(g.title)}</strong><small>${g.headings.filter((h) => h.level === 2).slice(0, 4).map((h) => esc(h.text)).join(' · ')}</small></a></li>`).join('')}</ul>`;
  writeFileSync(join(out, 'index.html'), page('Guides', intro, guides, ''));
  return { pages: guides.length, examples: guides.reduce((n, g) => n + g.examples.length, 0) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = buildDocs();
  console.log(`Docs: ${r.pages} guides, ${r.examples} playground examples → examples/docs/ (open /docs/ with npm run dev)`);
}
