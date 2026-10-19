#!/usr/bin/env node
// Builds the demo, studio, playground and docs site for GitHub Pages and pushes it to the orphan `gh-pages` branch.
// No CI: run it by hand. `node scripts/deploy-pages.mjs --dry` builds into .pages/site and stops before committing.
// Served from https://prismbi.github.io/ (docs at /docs/); the repo is prismbi/prismbi.github.io, so the site is at the root.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = join(root, 'node_modules', '.pages');
const site = join(work, 'site');
const tree = join(work, 'tree');
const dry = process.argv.includes('--dry');
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
console.log(`\nSite built in ${site}`);
if (dry) process.exit(0);

// 4. commit to gh-pages through a worktree (created as an orphan branch the first time) and push
const source = git(['rev-parse', '--short', 'HEAD']);
const remoteHas = git(['ls-remote', '--heads', 'origin', 'gh-pages']) !== '';
if (remoteHas) git(['fetch', 'origin', 'gh-pages:gh-pages']);
git(['worktree', 'prune']);
if (remoteHas || git(['branch', '--list', 'gh-pages']) !== '') git(['worktree', 'add', tree, 'gh-pages']);
else git(['worktree', 'add', '--orphan', '-b', 'gh-pages', tree]);
try {
  for (const f of readdirSync(tree)) if (f !== '.git') rmSync(join(tree, f), { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  cpSync(site, tree, { recursive: true });
  git(['add', '-A'], tree);
  if (git(['status', '--porcelain'], tree) === '') console.log('No changes to deploy.');
  else {
    git(['commit', '-m', `deploy: site from ${source}`], tree);
    git(['push', 'origin', 'gh-pages'], tree);
    console.log('Pushed gh-pages. https://prismbi.github.io/');
  }
} finally {
  git(['worktree', 'remove', '--force', tree]);
}
