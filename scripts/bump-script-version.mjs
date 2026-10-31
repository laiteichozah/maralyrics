#!/usr/bin/env node
// Gives a script a new ?v= in every page that loads it, so browsers fetch the changed file instead of a cached one.
//   npm run bump-script -- app-mode.js            (one or more files, by name or by path under public/)
// A tag with ?v=N becomes ?v=N+1; a tag with no ?v= gets ?v=1. See scripts/check-script-versions.mjs for why (and what npm test checks).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const wanted = process.argv.slice(2).map((a) => a.replace(/^\/?(public\/)?/, ''));
if (!wanted.length) { console.error('usage: npm run bump-script -- <script.js> [more.js]'); process.exit(1); }

const pages = [];
const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, f.name); if (f.isDirectory()) walk(full); else if (f.name.endsWith('.html')) pages.push(full); } };
walk(PUBLIC);

for (const script of wanted) {
  if (!fs.existsSync(path.join(PUBLIC, script))) { console.error(`public/${script} does not exist`); process.exit(1); }
  let touched = 0;
  for (const file of pages) {
    const dir = path.posix.dirname(path.relative(PUBLIC, file).split(path.sep).join('/'));
    const html = fs.readFileSync(file, 'utf8');
    const next = html.replace(/(<script\b[^>]*\bsrc=")([^"]+)(")/g, (all, open, src, close) => {
      if (/^([a-z]+:)?\/\//i.test(src)) return all;
      const [target, query = ''] = src.split('?');
      const resolved = target.startsWith('/') ? target.slice(1) : path.posix.join(dir === '.' ? '' : dir, target);
      if (resolved !== script) return all;
      const params = new URLSearchParams(query);
      const v = params.get('v');
      if (v !== null && !/^\d+$/.test(v)) { console.error(`${path.relative(PUBLIC, file)}: ?v=${v} is not a number; change it by hand`); process.exit(1); }
      params.set('v', String(v === null ? 1 : Number(v) + 1));
      return `${open}${target}?${params}${close}`;
    });
    if (next !== html) { fs.writeFileSync(file, next); touched++; }
  }
  console.log(`${script}: ${touched} page${touched === 1 ? '' : 's'} updated`);
}
