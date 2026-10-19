#!/usr/bin/env node
// Builds the demo, studio, playground and docs site for GitHub Pages and pushes it to the site repo (SITE_REPO, branch main).
// No CI: run it by hand. `node scripts/deploy-pages.mjs --dry` builds into node_modules/.pages/site and stops before committing.
// Served from https://prismbi-js.github.io/ (docs at /docs/). The source lives in prismbi-js/prismbi; the built site in
// prismbi-js/prismbi-js.github.io, which GitHub serves at the domain root.
import { cpSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, 'node_modules', '.pages');
const site = join(work, 'site');
const tree = join(work, 'tree');
const dry = process.argv.includes('--dry');
const SITE_REPO = 'https://github.com/prismbi-js/prismbi-js.github.io.git';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// 1. docs/guide/*.md → examples/docs/
run('node', ['scripts/build-docs.mjs']);

// 2. the Vite pages
rmSync(work, { recursive: true, force: true });
run('npx', ['vite', 'build', '--config', 'examples/vite.config.ts', '--outDir', site, '--emptyOutDir']);

// 3. the static docs (relative links, so they work under any base) and no Jekyll processing
cpSync(join(root, 'examples', 'docs'), join(site, 'docs'), { recursive: true });
writeFileSync(join(site, '.nojekyll'), '');
// 404 page: old addresses (the first Pages site was …/PrismBI/…) redirect to the same page at the root, in any letter
// case (Pages paths are case-sensitive, Windows folders are not, so folders can't cover both); anything else gets a
// not-found page with the site menu
writeFileSync(join(site, '404.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Page not found · PrismBI</title>
<script>const m = /^\\/prismbi(\\/.*)?$/i.exec(location.pathname); if (m) location.replace((m[1] || '/') + location.search + location.hash);</script>
<style>body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#14171c;color:#e4e7ec}main{max-width:560px;margin:15vh auto;padding:0 16px}a{color:#6aa0ff}</style>
<script type="module" src="/docs/site-nav.js"></script></head>
<body><main><h1>Page not found</h1><p>Try the <a href="/">demo</a>, the <a href="/docs/">docs</a> or the <a href="/playground.html">playground</a>.</p></main></body></html>`);
console.log(`\nSite built in ${site}`);
if (dry) process.exit(0);

// 4. commit to the site repo's main branch (a fresh clone each time; it holds only the built site) and push
const source = git(['rev-parse', '--short', 'HEAD']);
git(['clone', '--depth', '1', SITE_REPO, tree]);
for (const f of readdirSync(tree)) if (f !== '.git') rmSync(join(tree, f), { recursive: true, force: true });
cpSync(site, tree, { recursive: true });
git(['add', '-A'], tree);
if (git(['status', '--porcelain'], tree) === '') console.log('No changes to deploy.');
else {
  git(['commit', '-m', `deploy: site from prismbi-js/prismbi@${source}`], tree);
  git(['push', 'origin', 'HEAD:main'], tree);
  console.log('Pushed the site. https://prismbi-js.github.io/');
}
rmSync(tree, { recursive: true, force: true });
