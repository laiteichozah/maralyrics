#!/usr/bin/env node
// Publishes a GitHub Release for each version in scripts/releases.json, using the `gh` CLI (GH_TOKEN must be set).
// The title and body come from scripts/changelog.mjs (--title / --notes), so a release matches CHANGELOG.md and the Project page.
//
//   node scripts/publish-releases.mjs                 create every release that does not exist yet (oldest first)
//   node scripts/publish-releases.mjs --update        also rewrite the title and notes of releases that already exist
//   node scripts/publish-releases.mjs --tag v1.9.0    only this version (a tag with no entry in releases.json gets GitHub's own notes)
//   node scripts/publish-releases.mjs --dry-run       print what would happen and change nothing
//
// A release needs its tag on GitHub first (npm run changelog -- --tag, then git push origin --tags): releases are created
// with --verify-tag, so a missing tag is reported and skipped instead of being invented at the default branch.
// The newest version is marked "Latest"; all the others are not.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const update = args.includes('--update');
const only = args.includes('--tag') ? String(args[args.indexOf('--tag') + 1]).replace(/^v?/, 'v') : null;

const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const gh = (...argv) => run('gh', argv);

const versions = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/releases.json'), 'utf8')).releases.map((r) => r.version);
const newest = versions[versions.length - 1];
let tags;
try { tags = new Set(run('git', ['tag', '-l', 'v*']).split('\n').filter(Boolean)); } catch { tags = new Set(); }
const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || 'laiteichozah/maralyrics';
let existing = new Set();
try {
  existing = new Set(gh('api', '--paginate', `repos/${repo}/releases?per_page=100`, '--jq', '.[].tag_name').split('\n').filter(Boolean));
} catch (err) {
  if (!dry) throw err;
  console.log('(dry run: could not list the existing releases, assuming none)');
}

const plan = only ? [only.slice(1)] : versions;
const known = new Set(versions);
let created = 0, updated = 0, skipped = 0, failed = 0;

for (const version of plan) {
  const tag = `v${version}`;
  const latest = `--latest=${version === newest}`;
  if (!tags.has(tag) && !dry) {
    console.log(`! ${tag}: no such tag here — push the tags first (git push origin --tags)`);
    failed++; continue;
  }
  if (existing.has(tag) && !update) { console.log(`= ${tag}: release exists`); skipped++; continue; }
  const notesFile = path.join(os.tmpdir(), `release-notes-${process.pid}-${version}.md`);
  let titleArgs, notesArgs;
  if (known.has(version)) {
    const title = run('node', ['scripts/changelog.mjs', '--title', version]);
    fs.writeFileSync(notesFile, `${run('node', ['scripts/changelog.mjs', '--notes', version])}\n`);
    titleArgs = ['--title', title]; notesArgs = ['--notes-file', notesFile];
  } else {
    // A tag pushed before its entry reached releases.json: still publish it, with GitHub's own notes.
    titleArgs = ['--title', tag]; notesArgs = ['--generate-notes'];
  }
  const verb = existing.has(tag) ? 'edit' : 'create';
  const cmd = verb === 'edit'
    ? ['release', 'edit', tag, ...titleArgs, ...(notesArgs[0] === '--notes-file' ? notesArgs : []), latest]
    : ['release', 'create', tag, '--verify-tag', ...titleArgs, ...notesArgs, latest];
  if (dry) { console.log(`~ ${tag}: would ${verb} (${titleArgs[1]}, ${latest})`); fs.rmSync(notesFile, { force: true }); continue; }
  try {
    gh(...cmd);
    console.log(`${verb === 'edit' ? '*' : '+'} ${tag}: release ${verb === 'edit' ? 'updated' : 'created'}`);
    verb === 'edit' ? updated++ : created++;
  } catch (err) {
    console.log(`! ${tag}: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
    failed++;
  } finally { fs.rmSync(notesFile, { force: true }); }
}
console.log(`\nreleases: ${created} created, ${updated} updated, ${skipped} already there, ${failed} failed`);
process.exit(failed ? 1 : 0);
