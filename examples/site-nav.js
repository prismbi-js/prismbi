// The site menu: a fixed bar at the top of every page (demo, docs, playground, studio, gallery, perf, elements).
// Plain JS so the generated docs pages can load the same file (scripts/build-docs.mjs copies it to examples/docs/).
// Pages offset their content with `html { padding-top }`; full-height pages size from html/body height: 100%.
const LINKS = [
  ['Demo', 'index.html'],
  ['Docs', 'docs/index.html'],
  ['Playground', 'playground.html'],
  ['Studio', 'studio.html'],
  ['Gallery', 'gallery.html'],
  ['Web components', 'elements.html'],
  ['Performance', 'perf.html'],
];
const EXTERNAL = [
  ['GitHub', 'https://github.com/prismbi-js/prismbi'],
  ['npm', 'https://www.npmjs.com/package/@prismbi/prismbi'],
];
const HEIGHT = 40;

const CSS = `
html{box-sizing:border-box;padding-top:${HEIGHT}px}
.site-nav{position:fixed;inset:0 0 auto 0;height:${HEIGHT}px;z-index:2147483000;display:flex;align-items:center;gap:2px;padding:0 12px;
  background:#101114;border-bottom:1px solid #26282e;font:500 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
  overflow-x:auto;scrollbar-width:none;box-sizing:border-box}
.site-nav::-webkit-scrollbar{display:none}
.site-nav a{color:#c9ccd3;text-decoration:none;padding:7px 10px;border-radius:6px;white-space:nowrap}
.site-nav a:hover{color:#fff;background:#1f2229}
.site-nav a[aria-current="page"]{color:#fff;background:#2a2e37}
.site-nav .brand{color:#fff;font-weight:700;font-size:14px;margin-right:8px;padding-left:0}
.site-nav .brand:hover{background:none}
.site-nav .spacer{flex:1;min-width:12px}
.site-nav a.ext::after{content:" ↗";opacity:.6}
@media print{.site-nav{display:none}html{padding-top:0}}`;

if (!document.querySelector('.site-nav')) {
  const inDocs = /\/docs\/[^/]*$/.test(location.pathname);
  const root = inDocs ? '../' : './';
  const file = location.pathname.split('/').pop() || 'index.html';
  const current = inDocs ? 'docs/index.html' : file;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.setAttribute('aria-label', 'Site');
  const link = (label, href, cls) => {
    const a = document.createElement('a');
    a.textContent = label;
    a.href = href;
    if (cls) a.className = cls;
    return a;
  };
  nav.append(link('PrismBI', `${root}index.html`, 'brand'));
  for (const [label, path] of LINKS) {
    const a = link(label, root + path);
    if (path === current) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  nav.append(spacer);
  for (const [label, href] of EXTERNAL) nav.append(link(label, href, 'ext'));
  document.body.prepend(nav);
}
