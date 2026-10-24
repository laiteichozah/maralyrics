#!/usr/bin/env node
// Writes CHANGELOG.md (every version with its full commit log) and, with --tag, creates the annotated git tags.
//
//   npm run changelog                  regenerate CHANGELOG.md from scripts/releases.json + git history
//   npm run changelog -- --tag         also create any missing annotated tag (vX.Y.Z) at each release's ref
//   npm run changelog -- --check       exit 1 if CHANGELOG.md or public/releases.json is out of date (used by npm test)
//   npm run changelog -- --notes 1.4.0 print the release notes of one version (for a GitHub release body)
//
// To cut a new release: add an entry at the END of scripts/releases.json (version, ref = the commit to tag — use "HEAD"
// for the newest —, title, summary, highlights), run `npm run changelog -- --tag`, commit CHANGELOG.md, push the tags.
// Each version's log is every commit since the previous version's ref; merge commits are counted but not listed.
// It also writes public/releases.json, which the Project page (/project) renders as the public "Version history".
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const REPO = 'laiteichozah/maralyrics';
const GITHUB = `https://github.com/${REPO}`;

const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/releases.json'), 'utf8'));
const releases = file.releases;
const unreleased = file.unreleased || [];
const args = process.argv.slice(2);
let resolved;
try {
  resolved = releases.map((r) => ({ ...r, sha: git('rev-parse', '--verify', `${r.ref}^{commit}`) }));
} catch (err) {
  // A shallow clone (or no git) can't rebuild the log, so a check has nothing to compare against.
  if (args.includes('--check')) { console.log('changelog check skipped: git history is not available here'); process.exit(0); }
  throw err;
}

function describe(r, i) {
  const prev = i > 0 ? resolved[i - 1].sha : null;
  const range = prev ? `${prev}..${r.sha}` : r.sha;
  const log = git('log', '--reverse', '--no-merges', '--date=short', '--format=%h%x09%ad%x09%an%x09%s', range)
    .split('\n').filter(Boolean).map((l) => { const [hash, date, author, ...subject] = l.split('\t'); return { hash, date, author, subject: subject.join('\t') }; });
  const merges = Number(git('rev-list', '--count', '--merges', range));
  const shortstat = git('diff', '--shortstat', prev || EMPTY_TREE, r.sha) || 'no file changes';
  const migrations = git('diff', '--name-only', '--diff-filter=A', prev || EMPTY_TREE, r.sha, '--', 'migrations').split('\n').filter(Boolean).map((f) => path.basename(f));
  const date = git('log', '-1', '--date=short', '--format=%ad', r.sha);
  const authors = [...new Set(log.map((c) => c.author))];
  return { ...r, log, merges, shortstat, migrations, date, authors };
}
const described = resolved.map(describe);

function notes(v, { markdown }) {
  const lines = [];
  lines.push(v.summary, '');
  lines.push(markdown ? '**Highlights**' : 'Highlights:');
  for (const h of v.highlights) lines.push(`- ${h}`);
  if (v.deploy) lines.push('', markdown ? `**Deploy notes:** ${v.deploy}` : `Deploy notes: ${v.deploy}`);
  if (v.migrations.length) lines.push('', markdown ? `**Database migrations:** ${v.migrations.map((m) => `\`${m}\``).join(', ')}` : `Database migrations: ${v.migrations.join(', ')}`);
  lines.push('', `${v.log.length} commits (${v.merges} merge commits not listed) · ${v.authors.length} author${v.authors.length === 1 ? '' : 's'} · ${v.shortstat}`);
  return lines;
}
const commitLine = (c) => `${c.hash} ${c.date} ${c.subject} — ${c.author}`;

function changelog() {
  const out = [
    '# Changelog', '',
    'Every released version of MaraLyrics, newest first, with its full commit log. Versions follow [semantic versioning](https://semver.org) and each one is a git tag (`vX.Y.Z`) on the commit it names.',
    'This file is generated: edit `scripts/releases.json` and run `npm run changelog`. A version\'s log lists every commit since the previous version; merge commits are counted, not listed.',
    '',
  ];
  if (unreleased.length) out.push('## Unreleased', '', 'Merged after the latest version; it ships with the next one.', '', ...unreleased.map((h) => `- ${h}`), '');
  for (const v of [...described].reverse()) {
    out.push(`## v${v.version} — ${v.title} (${v.date})`, '', ...notes(v, { markdown: true }), '');
    out.push(`<details><summary>Full log — ${v.log.length} commits</summary>`, '');
    for (const c of v.log) out.push(`- \`${c.hash}\` ${c.date} ${c.subject} — ${c.author}`);
    out.push('', '</details>', '');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

const noteIdx = args.indexOf('--notes');
if (noteIdx !== -1) {
  const v = described.find((d) => d.version === String(args[noteIdx + 1]).replace(/^v/, ''));
  if (!v) { console.error(`No such version: ${args[noteIdx + 1]}`); process.exit(1); }
  console.log([...notes(v, { markdown: true }), '', '### Full log', ...v.log.map((c) => `- \`${c.hash}\` ${c.date} ${c.subject} — ${c.author}`)].join('\n'));
  process.exit(0);
}

/** The public, website-facing version of the history (newest first): no deploy notes or migrations, with GitHub links. */
function publicReleases() {
  const out = described.map((v, i) => {
    const prev = i > 0 ? resolved[i - 1].sha : null;
    const commits = [...v.log].reverse().map((c) => ({
      sha: git('rev-parse', c.hash), short: c.hash, date: c.date, subject: c.subject, author: c.author,
    }));
    return {
      version: v.version, tag: `v${v.version}`, title: v.title, date: v.date, summary: v.summary, highlights: v.highlights,
      commit_count: v.log.length,
      compare_url: prev ? `${GITHUB}/compare/${prev}...${v.sha}` : `${GITHUB}/commits/${v.sha}`,
      tag_url: `${GITHUB}/releases/tag/v${v.version}`,
      commits,
    };
  });
  return `${JSON.stringify({ repo: REPO, github_url: GITHUB, changelog_url: `${GITHUB}/blob/main/CHANGELOG.md`, tags_url: `${GITHUB}/tags`, releases: out.reverse() }, null, 1)}\n`;
}

const files = { 'CHANGELOG.md': changelog(), 'public/releases.json': publicReleases() };
if (args.includes('--check')) {
  const stale = Object.entries(files).filter(([name, text]) => !fs.existsSync(path.join(ROOT, name)) || fs.readFileSync(path.join(ROOT, name), 'utf8') !== text).map(([name]) => name);
  if (stale.length) { console.error(`✗ out of date: ${stale.join(', ')} — run: npm run changelog`); process.exit(1); }
  console.log(`✓ CHANGELOG.md and public/releases.json are up to date (${described.length} versions)`);
  process.exit(0);
}
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(ROOT, name), text);
console.log(`CHANGELOG.md and public/releases.json written: ${described.length} versions, ${described.reduce((n, v) => n + v.log.length, 0)} commits`);

if (args.includes('--tag')) {
  const existing = new Set(git('tag', '-l').split('\n').filter(Boolean));
  for (const v of described) {
    const tag = `v${v.version}`;
    if (existing.has(tag)) { console.log(`  = ${tag} already exists (${git('rev-parse', '--short', `${tag}^{commit}`)})`); continue; }
    const message = [`MaraLyrics ${tag} — ${v.title}`, `Released ${v.date}`, '', ...notes(v, { markdown: false }), '', `Full log (${v.log.length} commits):`, ...v.log.map(commitLine)].join('\n');
    execFileSync('git', ['tag', '-a', tag, '-F', '-', v.sha], { cwd: ROOT, input: message });
    console.log(`  + ${tag} → ${v.sha.slice(0, 7)} ${v.title} (${v.log.length} commits)`);
  }
}
