#!/usr/bin/env node
// Integration checks for Guitar Node on the server: keys and chords saved with songs (admin create / edit / revisions),
// what visitors get, and backward compatibility for songs without chords.   npm run test:guitar
// Runs the real Hono worker against an in-memory SQLite database built from schema.sql.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { default: app } = await load('worker/worker.js');
const { signJWT } = await load('worker/lib/auth.js');
const { resolveChordColumns, readChordFields } = await load('worker/lib/guitarNode.js');

let passes = 0;
let failures = 0;
const check = (cond, msg) => { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } };

const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
const DB = {
  prepare(sql) {
    const st = sqlite.prepare(sql);
    const bound = (args) => ({
      first: async () => st.get(...args) ?? null,
      all: async () => ({ results: st.all(...args) }),
      run: async () => { const r = st.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
    });
    return { ...bound([]), bind: (...args) => bound(args) };
  },
  async batch(statements) { const out = []; for (const s of statements) out.push(await s.run()); return out; },
};
const run = (sql, ...a) => sqlite.prepare(sql).run(...a);
const get = (sql, ...a) => sqlite.prepare(sql).get(...a);
const SECRET = 'test-secret';
const ROLES = ['viewer', 'translator', 'reviewer', 'editor', 'manager', 'super_admin'];
ROLES.forEach((role, i) => run(`INSERT INTO admin_users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`, i + 1, role, role));
const tokens = {};
for (const [i, role] of ROLES.entries()) tokens[role] = await signJWT({ sub: i + 1, username: role }, SECRET);
const ENV = { DB, JWT_SECRET: SECRET };
const call = async (method, url, { token, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await app.fetch(new Request(`https://api.test${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), ENV);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const adm = (method, url, role, body) => call(method, `/api/v1/admin${url}`, { token: tokens[role], body });
const pub = (url) => call('GET', `/api/v1${url}`);

const LYRICS = 'Wise men say only fools rush in\nBut I can\'t help falling in love with you\n\nShall I stay? Would it be a sin?';
const CHORDS = { v: 1, lines: { 0: [[0, 'C'], [9, 'Em'], [18, 'Am']], 1: [[0, 'F'], [14, 'C'], [28, 'G7']], 3: [[0, 'C']] } };
const song = (extra = {}) => ({ title: 'Falling', lyrics: LYRICS, category: 'Love', artist_ids: [], composer_ids: [], ...extra });

console.log('Saving a song with a key and chords');
let r = await adm('POST', '/songs', 'editor', song({ original_key: 'C major', chords: CHORDS }));
check(r.status === 201 && r.json.original_key === 'C', 'a song can be created with its key (typed "C major", stored "C") …');
check(r.json.chords && r.json.chords.v === 1 && r.json.chords.lines['0'].length === 3, '… and chords, which the API returns as an object');
check(r.json.chords.lines['0'][1][0] === 4 || r.json.chords.lines['0'][1][0] === 9, '(positions are kept)');
const id = r.json.id;
const stored = get('SELECT original_key, chords, lyrics FROM songs WHERE id = ?', id);
check(stored.original_key === 'C' && typeof stored.chords === 'string' && JSON.parse(stored.chords).v === 1, 'the database holds the key and the chords as JSON text');
check(stored.lyrics === LYRICS, 'the lyrics are stored exactly as sent, without the chords');
check(JSON.stringify(JSON.parse(stored.chords).lines['0']) === JSON.stringify([[0, 'C'], [9, 'Em'], [18, 'Am']]), 'chords are stored sorted by position');

console.log('Visitors');
run(`UPDATE songs SET status = 'published' WHERE id = ?`, id);
const slug = get('SELECT slug FROM songs WHERE id = ?', id).slug;
r = await pub(`/songs/${slug}`);
check(r.status === 200 && r.json.original_key === 'C' && r.json.chords.v === 1 && r.json.lyrics === LYRICS, 'the song page API returns the key, the chords and the unchanged lyrics');
r = await pub('/songs?limit=10');
check(r.status === 200 && r.json.songs.length === 1 && !('chords' in r.json.songs[0]) && !('original_key' in r.json.songs[0]), 'song lists stay small: no chords in them');
r = await pub('/songs/popular');
check(r.status === 200 && JSON.stringify(r.json).indexOf('"chords"') === -1, '… nor in the popular list');
r = await pub(`/search?q=${encodeURIComponent('fools rush')}`);
check(r.status === 200 && JSON.stringify(r.json).includes('Falling'), 'search still finds the song by its lyrics');

console.log('Songs without chords');
r = await adm('POST', '/songs', 'editor', song({ title: 'Plain song', lyrics: 'one\ntwo' }));
check(r.status === 201 && r.json.original_key === null && r.json.chords === null, 'a song without a key or chords is saved as before');
const plainId = r.json.id;
run(`UPDATE songs SET status = 'published' WHERE id = ?`, plainId);
r = await pub(`/songs/${get('SELECT slug FROM songs WHERE id = ?', plainId).slug}`);
check(r.status === 200 && r.json.original_key === null && r.json.chords === null && r.json.lyrics === 'one\ntwo', 'its page API says: no key, no chords, same lyrics');
r = await adm('POST', '/songs', 'editor', song({ title: 'Key only', lyrics: 'a', original_key: 'F#m' }));
check(r.status === 201 && r.json.original_key === 'F#m' && r.json.chords === null, 'a key without chords is fine');
r = await adm('POST', '/songs', 'editor', song({ title: 'Unknown key', lyrics: 'a\nb', chords: { v: 1, lines: { 0: [[0, 'Am']] } }, original_key: '' }));
check(r.status === 201 && r.json.original_key === null && r.json.chords.lines['0'][0][1] === 'Am', 'chords with an UNKNOWN key are allowed — the key is never guessed');
r = await adm('POST', '/songs', 'editor', song({ title: 'Null key', lyrics: 'a\nb', original_key: null, chords: null }));
check(r.status === 201 && r.json.original_key === null && r.json.chords === null, 'null key and null chords');

console.log('Refusing bad data');
for (const [extra, why] of [
  [{ original_key: 'H' }, 'a key that is not a key'],
  [{ original_key: 'C dorian' }, 'a mode we do not support'],
  [{ original_key: 7 }, 'a key that is not text'],
  [{ chords: { v: 1, lines: { 0: [[0, 'Bridge']] } } }, 'a chord that is not a chord'],
  [{ chords: { v: 1, lines: { 9: [[0, 'C']] } } }, 'a line that does not exist'],
  [{ chords: { v: 1, lines: { 0: [[999, 'C']] } } }, 'a position past the end of the line'],
  [{ chords: { v: 2, lines: {} } }, 'an unknown format'],
  [{ chords: 'not json' }, 'broken JSON'],
  [{ chords: { v: 1, lines: { 0: [[0, '<script>']] } } }, 'markup as a chord'],
]) {
  r = await adm('POST', '/songs', 'editor', song({ title: `Bad ${Math.random()}`, ...extra }));
  check(r.status === 400 && typeof r.json.error === 'string', `refuses ${why}`);
}
r = await adm('POST', '/songs', 'editor', song({ title: 'x', chords: { v: 1, lines: { 0: [[0, 'Am7x']] } } }));
check(/Am7x/.test(r.json.error) && /line 1/.test(r.json.error), 'the message names the chord and the line');
check(get(`SELECT COUNT(*) AS n FROM songs WHERE title LIKE 'Bad %'`).n === 0, 'nothing was saved by the refused requests');

console.log('Who can do what');
check((await adm('POST', '/songs', 'viewer', song({ title: 'v', original_key: 'C' }))).status === 403, 'a viewer cannot add a song with chords');
check((await adm('PUT', `/songs/${id}`, 'translator', song({ original_key: 'D' }))).status === 403, 'a translator cannot edit directly (they submit a revision)');
check((await call('POST', '/api/v1/admin/songs', { body: song({ title: 'anon' }) })).status === 401, 'anonymous: 401');
check((await adm('GET', `/songs/${id}`, 'viewer')).json.original_key === 'C', 'everyone who can open the song sees its key');

console.log('Editing');
r = await adm('PUT', `/songs/${id}`, 'editor', song({ original_key: 'G', chords: { v: 1, lines: { 0: [[0, 'G']] } } }));
check(r.status === 200 && r.json.original_key === 'G' && r.json.chords.lines['0'].length === 1 && !r.json.chords_cleared, 'an editor can change the key and the chords');
r = await adm('PUT', `/songs/${id}`, 'editor', song({ original_key: 'G', chords: CHORDS }));
check(r.status === 200 && r.json.chords.lines['0'].length === 3, '… and put them back');
r = await adm('PUT', `/songs/${id}`, 'editor', song({ original_key: 'C', chords: null }));
check(r.status === 200 && r.json.chords === null && r.json.original_key === 'C' && r.json.lyrics === LYRICS, 'chords can be removed without touching the lyrics (the key stays)');
check(get('SELECT chords FROM songs WHERE id = ?', id).chords === null, '(NULL in the database)');
r = await adm('PUT', `/songs/${id}`, 'editor', song({ original_key: '', chords: CHORDS }));
check(r.json.original_key === null && r.json.chords.v === 1, 'the key can be set back to unknown');
await adm('PUT', `/songs/${id}`, 'editor', song({ original_key: 'C', chords: CHORDS }));

// An older admin page (or an offline edit queued before the update) does not send the new fields.
r = await adm('PUT', `/songs/${id}`, 'editor', song({ title: 'Falling (retitled)' }));
check(r.status === 200 && r.json.original_key === 'C' && r.json.chords && r.json.chords.lines['0'].length === 3 && !r.json.chords_cleared, 'a request without the new fields keeps the stored key and chords');
r = await adm('PUT', `/songs/${id}`, 'editor', song({ title: 'Falling (retitled)', lyrics: LYRICS + '\nAnd one more line' }));
check(r.status === 200 && r.json.chords_cleared === true && r.json.chords === null && r.json.original_key === 'C', 'a request that changes the lyrics without sending chords drops the chords (their positions may no longer fit) and says so; the key stays');
await adm('PUT', `/songs/${id}`, 'editor', song({ title: 'Falling', original_key: 'C', chords: CHORDS }));
r = await adm('PUT', `/songs/${id}`, 'editor', song({ lyrics: LYRICS.replace('Wise men', 'Wiser men'), original_key: 'C', chords: CHORDS }));
check(r.status === 200 && r.json.chords.lines['0'].length === 3, 'when the lyrics change AND the chords are sent, both are saved');
await adm('PUT', `/songs/${id}`, 'editor', song({ original_key: 'C', chords: CHORDS }));
r = await adm('PUT', `/songs/${id}`, 'editor', song({ lyrics: 'short', original_key: 'C', chords: CHORDS }));
check(r.status === 400 && /outside the line|does not exist/.test(r.json.error), 'chords that no longer fit the lyrics are refused (the editor must reposition them)');
check(get('SELECT lyrics FROM songs WHERE id = ?', id).lyrics === LYRICS, '(the lyrics were not saved either)');

console.log('Admin lists');
r = await adm('GET', '/songs', 'viewer');
const row = r.json.songs.find((s) => s.id === id);
check(r.status === 200 && row && row.has_chords === true && row.original_key === 'C' && !('chords' in row), 'the admin list says which songs have chords, without sending them all');
check(r.json.songs.find((s) => s.id === plainId).has_chords === false, '(and which do not)');
r = await adm('GET', `/songs/${id}`, 'viewer');
check(r.json.chords.lines['1'][2][1] === 'G7', 'a single song comes with its chords as an object');

console.log('Revisions (translators propose, reviewers approve)');
const rev = await adm('POST', `/songs/${id}/revisions`, 'translator', song({ original_key: 'D', chords: { v: 1, lines: { 0: [[0, 'D'], [9, 'F#m']] } } }));
check(rev.status === 201 && rev.json.original_key === 'D' && rev.json.has_chord_data === 1 && JSON.parse(rev.json.chords).lines['0'].length === 2, 'a revision carries a proposed key and chords');
r = await adm('GET', `/songs/${id}`, 'viewer');
check(r.json.original_key === 'C' && r.json.chords.lines['0'].length === 3, 'the live song is unchanged until the revision is approved');
r = await adm('PUT', `/revisions/${rev.json.id}/approve`, 'reviewer', {});
check(r.status === 200 && r.json.original_key === 'D' && r.json.chords.lines['0'][1][1] === 'F#m', 'approving applies the proposed key and chords');
const bad = await adm('POST', `/songs/${id}/revisions`, 'translator', song({ chords: { v: 1, lines: { 0: [[0, 'Nope']] } } }));
check(bad.status === 400, 'a revision with a bad chord is refused when it is submitted');
// A revision written before Guitar Node (no chord data at all) must not wipe the song's chords.
await adm('PUT', `/songs/${id}`, 'editor', song({ original_key: 'C', chords: CHORDS }));
const old = await adm('POST', `/songs/${id}/revisions`, 'translator', song({ title: 'Falling (older revision)' }));
check(old.json.has_chord_data === 0, 'a revision that does not mention chords is marked as having none');
await adm('PUT', `/revisions/${old.json.id}/approve`, 'reviewer', {});
r = await adm('GET', `/songs/${id}`, 'viewer');
check(r.json.title === 'Falling (older revision)' && r.json.original_key === 'C' && r.json.chords.lines['0'].length === 3, 'approving it keeps the song\'s key and chords');
const old2 = await adm('POST', `/songs/${id}/revisions`, 'translator', song({ title: 'Falling', lyrics: LYRICS + '\nnew last line' }));
await adm('PUT', `/revisions/${old2.json.id}/approve`, 'reviewer', {});
r = await adm('GET', `/songs/${id}`, 'viewer');
check(r.json.chords === null && r.json.original_key === 'C' && r.json.lyrics.endsWith('new last line'), 'approving an older revision that changes the lyrics drops the chords (they may no longer fit), not the key');

console.log('The rules in isolation');
{
  const existing = { lyrics: LYRICS, original_key: 'C', chords: '{"v":1,"lines":{"0":[[0,"C"]]}}' };
  const none = readChordFields({}, LYRICS);
  check(none.ok && !none.has, 'no fields: nothing sent');
  check(resolveChordColumns(existing, none, LYRICS).chords === existing.chords, 'unchanged lyrics, no fields: the chords are kept');
  check(resolveChordColumns(existing, none, 'other').chords === null && resolveChordColumns(existing, none, 'other').cleared, 'changed lyrics, no fields: the chords are dropped');
  const crlf = LYRICS.replace(/\n/g, '\r\n');
  check(resolveChordColumns(existing, none, crlf).chords === existing.chords, 'the same lyrics with Windows line endings count as unchanged');
  check(resolveChordColumns(null, none, LYRICS).chords === null && resolveChordColumns(null, none, LYRICS).original_key === null, 'a new song with nothing sent has neither');
  check(!readChordFields({ original_key: 'Cx' }, LYRICS).ok, 'a bad key is refused');
}

console.log(failures ? `\n✗ ${failures} failed, ${passes} passed` : `\n✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
