#!/usr/bin/env node
// A script that changed must have a new ?v= in the pages that load it.   npm run test:scriptv
//
// Pages Functions and Cloudflare Pages serve every script with `Cache-Control: public, max-age=14400`, and the service worker keeps
// scripts cache-first, so a browser that has an older copy of /app-mode.js runs the NEW page against the OLD script (this is what
// broke /app-auth once: the old parse() wanted app=android). The only reliable fix is a new address: <script src="/app-mode.js?v=2">.
// So whenever a script under public/ changes, every page that loads it must carry a different ?v= than before.
//
// "Before" is each of these (a script is checked against every one that applies):
//   • the last release in scripts/releases.json (what visitors have had a long time), and
//   • the point where this branch left origin/main (what the previous deploy served), when origin/main is known.
// A script that did not exist then, or a page that did not load it then, has no old copy to go stale and is skipped.
// Also: every local script tag in /app-auth and /account must carry a ?v= at all.
// To bump a script on every page that loads it:   npm run bump-script -- app.js
// Needs the git history (CI checks out all of it); in a shallow clone the git part is skipped with a message.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The local scripts a page loads: Map of public-relative path → its ?v= (or null). `dir` is the page's folder inside public/. */
export function scriptTags(html, dir = '') {
  const tags = new Map();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
    const src = m[1];
    if (/^([a-z]+:)?\/\//i.test(src)) continue; // another site's script
    const [file, query = ''] = src.split('?');
    const resolved = file.startsWith('/') ? file.slice(1) : path.posix.join(dir, file);
    tags.set(resolved, new URLSearchParams(query).get('v'));
  }
  return tags;
}

/**
 * What is wrong, given the scripts that changed (public-relative), every page now ({ 'index.html': html }) and then
 * (the same at the older point; undefined when the page did not exist). → a list of messages.
 */
export function stale({ changed, now, then, label }) {
  const problems = [];
  for (const script of changed) {
    for (const [page, html] of Object.entries(now)) {
      const dir = path.posix.dirname(page) === '.' ? '' : path.posix.dirname(page);
      const current = scriptTags(html, dir);
      if (!current.has(script)) continue;
      const oldHtml = then[page];
      if (oldHtml === undefined) continue;                         // a new page: nobody has an old copy
      const before = scriptTags(oldHtml, dir);
      if (!before.has(script)) continue;                           // a new reference to this script
      const v = current.get(script);
      if (v === null) problems.push(`${page}: ${script} changed since ${label} but its tag has no ?v= (add one: npm run bump-script -- ${path.posix.basename(script)})`);
      else if (v === before.get(script)) problems.push(`${page}: ${script} changed since ${label} but its ?v= is still ${v} (bump it: npm run bump-script -- ${path.posix.basename(script)})`);
    }
  }
  return problems;
}

let passes = 0;
let failures = 0;
const check = (cond, msg) => { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // ─── The rule itself, on made-up pages ─────────────────────────────────────
  console.log('The rule');
  const page = (v) => `<script src="/app-mode.js${v === undefined ? '' : `?v=${v}`}"></script><script src="https://example.com/x.js"></script>`;
  const run = (before, after, changed = ['app-mode.js'], pages = { 'a.html': after }, oldPages = { 'a.html': before }) => stale({ changed, now: pages, then: oldPages, label: 'then' });
  check(run(page(), page()).length === 1, 'a changed script with no ?v= (before and now) is reported');
  check(run(page(1), page(1)).length === 1 && /still 1/.test(run(page(1), page(1))[0]), 'a changed script whose ?v= did not change is reported, with the number');
  check(run(page(1), page(2)).length === 0, 'a changed script whose ?v= changed passes');
  check(run(page(), page(1)).length === 0, 'adding a ?v= to a script that had none passes');
  check(run(page(1), page()).length === 1, 'taking the ?v= away is reported');
  check(run(page(1), page(1), []).length === 0, 'a script that did not change needs nothing');
  check(run(undefined, page(1), ['app-mode.js'], { 'a.html': page(1) }, { 'a.html': '<script src="/other.js"></script>' }).length === 0, 'a script a page did not load before is a new reference: skipped');
  check(run(undefined, page(1), ['app-mode.js'], { 'a.html': page(1) }, { 'a.html': undefined }).length === 0, 'a page that did not exist before is skipped');
  check(run(page(1), page(1), ['app-mode.js'], { 'a.html': page(2), 'b.html': page(1) }, { 'a.html': page(1), 'b.html': page(1) }).join().startsWith('b.html'), 'every page that loads the script is checked, and the page that was missed is named');
  const admin = (v) => `<script src="index.js${v ? `?v=${v}` : ''}"></script>`;
  check(stale({ changed: ['admin/index.js'], now: { 'admin/index.html': admin(1) }, then: { 'admin/index.html': admin(1) }, label: 'then' }).length === 1, 'a page in a folder finds its relative scripts (admin/index.js)');
  check(stale({ changed: ['admin/index.js'], now: { 'admin/index.html': admin(2) }, then: { 'admin/index.html': admin(1) }, label: 'then' }).length === 0, '…and passes when bumped');
  check([...scriptTags('<script src="https://x.test/a.js?v=1"></script><script src="//x.test/b.js"></script><script src="/c.js?v=7&x=1" async></script>').entries()].join('|') === 'c.js,7', 'another site\'s scripts are ignored; the ?v= is read among other parameters');

  // ─── Every script tag on the app's pages carries a version ─────────────────
  console.log('Versions on the pages the app uses');
  for (const file of ['app-auth.html', 'account.html']) {
    const tags = scriptTags(fs.readFileSync(path.join(PUBLIC, file), 'utf8'));
    const bare = [...tags].filter(([, v]) => !v).map(([s]) => s);
    check(tags.size >= 4 && bare.length === 0, `${file}: every local script tag has a ?v=${bare.length ? ` (missing on ${bare.join(', ')})` : ''}`);
  }

  // ─── The real pages against the last release and the previous deploy ───────
  console.log('Changed scripts against the last release and origin/main');
  const pagesNow = {};
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, f.name); if (f.isDirectory()) walk(full); else if (f.name.endsWith('.html')) pagesNow[path.relative(PUBLIC, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8'); } };
  walk(PUBLIC);

  const baselines = [];
  try {
    const releases = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/releases.json'), 'utf8')).releases;
    const last = releases[releases.length - 1];
    baselines.push({ label: `v${last.version}`, ref: git('rev-parse', '--verify', `${last.ref}^{commit}`) });
  } catch { console.log('  (the git history is not available here, so the last release is not compared: skipped)'); }
  try {
    const base = git('merge-base', 'HEAD', 'origin/main');
    if (!baselines.some((b) => b.ref === base)) baselines.push({ label: 'origin/main', ref: base });
  } catch { /* no origin/main here (or an unrelated history): only the release is compared */ }

  for (const { label, ref } of baselines) {
    // Scripts that changed (not new, not deleted): the working tree against that point.
    const changed = git('diff', '--name-only', '--diff-filter=M', ref, '--', 'public').split('\n').filter((f) => f.endsWith('.js')).map((f) => f.replace(/^public\//, ''));
    const then = {};
    for (const p of Object.keys(pagesNow)) { try { then[p] = git('show', `${ref}:public/${p}`); } catch { then[p] = undefined; } }
    const problems = stale({ changed, now: pagesNow, then, label });
    check(problems.length === 0, problems.length ? `${problems.length} page tag(s) need a new ?v= (against ${label}):\n    ${problems.join('\n    ')}` : '');
    const loaded = changed.filter((script) => Object.entries(pagesNow).some(([p, html]) => scriptTags(html, path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p)).has(script)));
    if (!problems.length) console.log(`  ✓ against ${label}: ${loaded.length ? `${loaded.join(', ')} changed and every page that loads ${loaded.length > 1 ? 'them' : 'it'} has a new ?v=` : 'no script that a page loads changed'}`);
  }

  console.log(failures ? `\n✗ ${failures} failed, ${passes} passed` : `\n✓ ${passes} checks passed, 0 failed`);
  process.exit(failures ? 1 : 0);
}
