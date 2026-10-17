#!/usr/bin/env node
// PrismBI command line: report files for version control.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { diffReports, formatDiff, joinReport, splitReport, stableStringify } from '../dist/files.js';

const USAGE = `Usage:
  prismbi split <report.json> <dir>      write one file per page, visual and bookmark
  prismbi join  <dir> [report.json]      rebuild a single report JSON (stdout when no file)
  prismbi diff  <before> <after>         plain-language changes (each a report.json or a split folder)`;

function readDir(dir) {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.json')) files[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return files;
}

const load = (p) => (statSync(p).isDirectory() ? joinReport(readDir(p)) : readFileSync(p, 'utf8'));

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'split' && a && b) {
    const files = splitReport(readFileSync(a, 'utf8'));
    for (const [path, text] of Object.entries(files)) {
      const out = join(b, ...path.split('/'));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, text);
    }
    console.log(`Wrote ${Object.keys(files).length} files to ${b}`);
  } else if (cmd === 'join' && a) {
    const json = stableStringify(joinReport(readDir(a)));
    if (b) {
      writeFileSync(b, json);
      console.log(`Wrote ${b}`);
    } else process.stdout.write(json);
  } else if (cmd === 'diff' && a && b) {
    if (!existsSync(a) || !existsSync(b)) throw new Error('both paths must exist');
    const changes = diffReports(load(a), load(b));
    console.log(formatDiff(changes));
    process.exitCode = changes.length ? 1 : 0;
  } else {
    console.log(USAGE);
    process.exitCode = cmd ? 2 : 0;
  }
} catch (e) {
  console.error(`prismbi: ${e.message}`);
  process.exitCode = 2;
}
