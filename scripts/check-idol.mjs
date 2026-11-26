#!/usr/bin/env node
// Integration checks for Mara Idol (seasons + contestants).   npm run test:idol
//
// Runs the real Hono worker against an in-memory SQLite database built from schema.sql, with real
// signed JWTs for every admin role: permissions, validation, constraints, draft/published
// visibility on the PUBLIC API, ordering, artist links and cascades. Exit code 1 on failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { default: app } = await load('worker/worker.js');
const { signJWT } = await load('worker/lib/auth.js');
const { validateSeason, validateContestant, normalizeVideos, parseVideos } = await load('worker/lib/idol.js');

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
};
const run = (sql, ...a) => sqlite.prepare(sql).run(...a);
const count = (sql, ...a) => Number(sqlite.prepare(sql).get(...a).n);

const ROLES = ['viewer', 'translator', 'reviewer', 'editor', 'manager', 'super_admin'];
ROLES.forEach((role, i) => run(`INSERT INTO admin_users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`, i + 1, role, role));
const SECRET = 'test-secret';
const token = {};
for (const [i, role] of ROLES.entries()) token[role] = await signJWT({ sub: i + 1, username: role }, SECRET);

run(`INSERT INTO artists (id, name, slug) VALUES (1, 'Ann Artist', 'ann-artist')`);
run(`INSERT INTO person_badges (artist_id, period, period_value) VALUES (1, 'lifetime', '')`);

const call = async (method, url, { as, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (as) headers.Authorization = `Bearer ${token[as]}`;
  const res = await app.fetch(new Request(`https://api.test${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { DB, JWT_SECRET: SECRET });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const adm = (method, url, body, as = 'editor') => call(method, `/api/v1/admin${url}`, { as, body });
const pub = (url) => call('GET', `/api/v1/mara-idol${url}`);

// ─── Validation (pure) ───────────────────────────────────────────────────────
console.log('Validation');
const okSeason = { title: 'Mara Idol 2025', year: 2025 };
check(validateSeason(okSeason).ok && validateSeason(okSeason).values.slug === 'mara-idol-2025', 'season: slug generated from title');
for (const [label, patch] of [
  ['missing title', { title: '' }], ['year too small', { year: 1899 }], ['year too big', { year: 2101 }], ['year not a number', { year: 'abc' }],
  ['bad start date', { start_date: '2025-02-30' }], ['non-date start', { start_date: 'tomorrow' }], ['end before start', { start_date: '2025-05-02', end_date: '2025-05-01' }],
  ['end without start', { end_date: '2025-05-01' }], ['bad status', { status: 'archived' }], ['javascript: cover', { cover_url: 'javascript:alert(1)' }], ['javascript: photo', { photo_url: 'javascript:alert(1)' }],
  ['long title', { title: 'x'.repeat(151) }], ['long description', { description: 'x'.repeat(5001) }],
]) check(!validateSeason({ ...okSeason, ...patch }).ok, `season: ${label} must be rejected`);
check(validateSeason({ ...okSeason, cover_url: 'data:image/png;base64,AAAA' }).ok, 'season: data:image cover accepted');
check(validateSeason({ ...okSeason, photo_url: 'data:image/jpeg;base64,AAAA' }).values.photo_url === 'data:image/jpeg;base64,AAAA' && validateSeason(okSeason).values.photo_url === null, 'season: photo accepted (data:image) and optional');
check(validateSeason({ ...okSeason, start_date: '2024-02-29' }).ok, 'season: leap day accepted');
check(validateSeason(okSeason).values.status === 'draft', 'season: defaults to draft');

const okIdol = { season_id: 1, name: 'Dee Idol' };
check(validateContestant(okIdol).ok && validateContestant(okIdol).values.result === 'contestant', 'idol: result defaults to contestant');
for (const [label, patch] of [
  ['missing name', { name: ' ' }], ['no season', { season_id: undefined }], ['bad result', { result: 'champion' }], ['placement 0', { placement: 0 }],
  ['placement 1000', { placement: 1000 }], ['placement 1.5', { placement: 1.5 }], ['javascript: photo', { photo_url: 'javascript:x' }],
  ['bad artist id', { artist_id: 'abc' }], ['bad sort', { sort_order: 'x' }], ['long bio', { bio: 'x'.repeat(5001) }],
  ['non-latin name, no slug', { name: 'မြန်မာ' }],
]) check(!validateContestant({ ...okIdol, ...patch }).ok, `idol: ${label} must be rejected`);
check(validateContestant({ ...okIdol, name: 'မြန်မာ', slug: 'myanmar-idol' }).ok, 'idol: explicit slug rescues a non-latin name');

check(normalizeVideos([{ url: '  https://youtu.be/abc ' }, { title: '', url: '' }, { title: 'Final', url: 'https://example.com/v' }]).value === '[{"url":"https://youtu.be/abc"},{"title":"Final","url":"https://example.com/v"}]', 'videos: trimmed, blank rows dropped');
check(!normalizeVideos([{ url: 'ftp://x' }]).ok && !normalizeVideos([{ url: 'javascript:alert(1)' }]).ok, 'videos: only http(s)');
check(!normalizeVideos(Array.from({ length: 11 }, (_, i) => ({ url: `https://e.com/${i}` }))).ok, 'videos: max 10');
check(!normalizeVideos('not json').ok && !normalizeVideos({}).ok, 'videos: must be a list');
{
  const t = normalizeVideos([{ url: 'https://youtu.be/abc', thumb: ' data:image/jpeg;base64,AAAA ' }, { title: 'B', url: 'https://example.com/v', thumb: 'https://img.example.com/t.jpg' }, { url: 'https://youtu.be/c' }]);
  check(t.ok && t.value === '[{"url":"https://youtu.be/abc","thumb":"data:image/jpeg;base64,AAAA"},{"title":"B","url":"https://example.com/v","thumb":"https://img.example.com/t.jpg"},{"url":"https://youtu.be/c"}]', 'videos: optional uploaded thumbnail kept, none invented');
  check(!normalizeVideos([{ url: 'https://youtu.be/abc', thumb: 'javascript:alert(1)' }]).ok && !normalizeVideos([{ url: 'https://youtu.be/abc', thumb: 'data:text/html;base64,AAAA' }]).ok, 'videos: unsafe thumbnail rejected');
  check(!normalizeVideos([{ url: 'https://youtu.be/abc', thumb: `data:image/jpeg;base64,${'A'.repeat(120001)}` }]).ok, 'videos: oversized thumbnail rejected');
  check(JSON.stringify(parseVideos('[{"url":"https://youtu.be/a","thumb":"javascript:alert(1)"}]')) === '[{"url":"https://youtu.be/a"}]', 'videos: a stored unsafe thumbnail is dropped on read');
}

// ─── Permissions ─────────────────────────────────────────────────────────────
console.log('Permissions');
check((await call('GET', '/api/v1/admin/idol-seasons')).status === 401, 'anonymous admin read → 401');
check((await call('POST', '/api/v1/admin/idol-seasons', { body: okSeason })).status === 401, 'anonymous create → 401');
for (const role of ['viewer', 'translator', 'reviewer']) {
  check((await adm('POST', '/idol-seasons', okSeason, role)).status === 403, `${role} must not create a season`);
  check((await adm('GET', '/idol-seasons', undefined, role)).status === 200, `${role} can read seasons`);
}
check(count('SELECT COUNT(*) AS n FROM idol_seasons') === 0, 'nothing written by forbidden requests');
const s1 = await adm('POST', '/idol-seasons', { title: 'Mara Idol Season 1', year: 2024, status: 'published', venue: 'Town Hall', start_date: '2024-12-01', end_date: '2024-12-03',
  description: 'The first edition.', videos: [{ title: 'Final night', url: 'https://youtu.be/final' }] }, 'editor');
check(s1.status === 201 && s1.json.slug === 'mara-idol-season-1' && s1.json.videos.length === 1, 'editor can create a season (slug + videos returned as array)');
const s2 = await adm('POST', '/idol-seasons', { title: 'Mara Idol Season 2', year: 2025, status: 'published', cover_url: 'https://img.example.com/c2.jpg', photo_url: 'https://img.example.com/p2.jpg' }, 'manager');
const withThumbs = await adm('PUT', `/idol-seasons/${s2.json.id}`, { title: 'Mara Idol Season 2', year: 2025, status: 'published', cover_url: 'https://img.example.com/c2.jpg', photo_url: 'https://img.example.com/p2.jpg',
  videos: [{ title: 'Final', url: 'https://youtu.be/aaaaaaaaaaa', thumb: 'data:image/jpeg;base64,AAAA' }, { url: 'https://youtu.be/bbbbbbbbbbb' }] }, 'manager');
check(withThumbs.status === 200 && withThumbs.json.videos[0].thumb === 'data:image/jpeg;base64,AAAA' && !('thumb' in withThumbs.json.videos[1]), 'season: uploaded video thumbnail saved; videos without one have none (→ platform thumbnail)');
check((await pub('/mara-idol-season-2')).json.videos[0].thumb === 'data:image/jpeg;base64,AAAA', 'public season: video thumbnail returned');
check((await adm('PUT', `/idol-seasons/${s2.json.id}`, { title: 'Mara Idol Season 2', year: 2025, status: 'published', videos: [{ url: 'https://youtu.be/aaaaaaaaaaa', thumb: 'javascript:alert(1)' }] }, 'manager')).status === 400, 'season: unsafe video thumbnail → 400');
// Back to the plain season for the checks below (PUT replaces everything).
await adm('PUT', `/idol-seasons/${s2.json.id}`, { title: 'Mara Idol Season 2', year: 2025, status: 'published', cover_url: 'https://img.example.com/c2.jpg', photo_url: 'https://img.example.com/p2.jpg' }, 'manager');
const s3 = await adm('POST', '/idol-seasons', { title: 'Mara Idol Season 3', year: 2026 }, 'super_admin'); // draft
check([s2, s3].every((r) => r.status === 201), 'manager and super_admin can create seasons');
check((await adm('PUT', `/idol-seasons/${s3.json.id}`, { ...okSeason, title: 'Season 3 renamed', year: 2026 }, 'viewer')).status === 403, 'viewer must not edit');
check((await adm('DELETE', `/idol-seasons/${s3.json.id}`, undefined, 'editor')).status === 403, 'editor must not delete a season');
check((await adm('DELETE', `/idol-contestants/1`, undefined, 'editor')).status === 403, 'editor must not delete a contestant');

console.log('Seasons API');
check((await adm('POST', '/idol-seasons', { title: 'Another', slug: 'mara-idol-season-1', year: 2024 })).status === 409, 'duplicate season slug → 409');
check((await adm('POST', '/idol-seasons', { title: 'Bad', year: 1800 })).status === 400, 'bad year → 400');
check((await adm('POST', '/idol-seasons', {})).status === 400, 'empty body → 400');
// PUT is a full replace (the dashboard form always sends every field), so omitted fields are cleared.
const ed = await adm('PUT', `/idol-seasons/${s1.json.id}`, { title: 'Mara Idol Season 1', year: 2024, status: 'published', description: 'Edited.', start_date: '2024-12-01', end_date: '2024-12-03', videos: [{ title: 'Final night', url: 'https://youtu.be/final' }] });
check(ed.status === 200 && ed.json.description === 'Edited.' && ed.json.venue === null && ed.json.videos.length === 1, 'editor can edit a season');
check((await adm('PUT', '/idol-seasons/999', okSeason)).status === 404 && (await adm('GET', '/idol-seasons/abc')).status === 404, 'unknown/non-numeric season → 404');
check((await adm('GET', '/idol-seasons')).json.seasons.map((s) => s.year).join() === '2026,2025,2024', 'admin list: newest year first, includes drafts');

// ─── Contestants ─────────────────────────────────────────────────────────────
console.log('Contestants API');
const idolBody = (extra) => ({ season_id: s1.json.id, ...extra });
check((await adm('POST', '/idol-contestants', idolBody({ name: 'X' }), 'viewer')).status === 403, 'viewer must not add a contestant');
check((await adm('POST', '/idol-contestants', { name: 'X', season_id: 999 })).status === 400, 'unknown season → 400');
check((await adm('POST', '/idol-contestants', idolBody({ name: 'X', artist_id: 999 }))).status === 400, 'unknown artist → 400');
check((await adm('POST', '/idol-contestants', idolBody({ name: 'X', result: 'king' }))).status === 400, 'bad result → 400');
const mk = async (extra, season = s1.json.id) => (await adm('POST', '/idol-contestants', { season_id: season, ...extra })).json;
const winner = await mk({ name: 'Win Ner', result: 'winner', placement: 1, bio: 'Won it all.', photo_url: 'https://img.test/w.jpg', artist_id: 1, videos: [{ title: 'Audition', url: 'https://youtu.be/aud' }, { url: '' }] });
const runner = await mk({ name: 'Runner Up', result: 'runner_up', placement: 2 });
const fin2 = await mk({ name: 'Zed Final', result: 'finalist', sort_order: 2 });
const fin1 = await mk({ name: 'Amy Final', result: 'finalist', sort_order: 1 });
const plain = await mk({ name: 'Plain Entry' });
check(winner.slug === 'win-ner' && winner.videos.length === 1 && winner.artist_id === 1, 'contestant created with generated slug, videos and artist link');
check((await adm('POST', '/idol-contestants', idolBody({ name: 'Win Ner' }))).status === 409, 'same slug twice in one season → 409');
const otherSeasonSame = await adm('POST', '/idol-contestants', { season_id: s2.json.id, name: 'Win Ner', result: 'winner' });
check(otherSeasonSame.status === 201, 'the same slug in a different season is fine');
const s3idol = await adm('POST', '/idol-contestants', { season_id: s3.json.id, name: 'Draft Idol' });
check(s3idol.status === 201, 'contestants can be added to a draft season');
check((await adm('PUT', `/idol-contestants/${plain.id}`, { season_id: s1.json.id, name: 'Plain Entry', bio: 'Updated bio.' })).json.bio === 'Updated bio.', 'edit a contestant');
check((await adm('GET', `/idol-contestants?season_id=${s1.json.id}`)).json.contestants.length === 5, 'admin list filters by season');

// ─── Public API: published only ──────────────────────────────────────────────
console.log('Public API');
const idx = await pub('');
check(idx.status === 200 && idx.json.seasons.map((s) => s.slug).join() === 'mara-idol-season-2,mara-idol-season-1', 'index lists published seasons, newest first, no drafts');
const season1 = idx.json.seasons.find((s) => s.slug === 'mara-idol-season-1');
const season2 = idx.json.seasons.find((s) => s.slug === 'mara-idol-season-2');
check(season2.cover_url === 'https://img.example.com/c2.jpg' && season2.photo_url === 'https://img.example.com/p2.jpg' && season1.photo_url === null, 'index: seasons carry cover and season photo');
check((await pub('/mara-idol-season-2')).json.photo_url === 'https://img.example.com/p2.jpg', 'season detail: season photo returned');
check((await adm('PUT', `/idol-seasons/${s2.json.id}`, { title: 'Mara Idol Season 2', year: 2025, status: 'published', photo_url: 'javascript:alert(1)' }, 'manager')).status === 400, 'season photo: unsafe URL rejected on update');
check(season1.contestant_count === 5 && season1.winners.length === 1 && season1.winners[0].slug === 'win-ner', 'season shows contestant count and its winner');
check(idx.json.idols.every((i) => i.season_slug !== 'mara-idol-season-3'), 'idols of a draft season are not listed');
check(idx.json.idols.filter((i) => i.season_slug === 'mara-idol-season-1').map((i) => i.name).join() === 'Win Ner,Runner Up,Amy Final,Zed Final,Plain Entry', 'idols ordered: winner → runner-up → finalists (manual order) → others');
check(!JSON.stringify(idx.json).match(/"(id|status|artist_id|created_at|updated_at)"/), 'index leaks no internal fields');
const draft = await pub('/mara-idol-season-3');
check(draft.status === 404 && (await pub('/mara-idol-season-3/draft-idol')).status === 404, 'a draft season is 404 — even by direct slug');
const detail = await pub('/mara-idol-season-1');
check(detail.status === 200 && detail.json.contestants.length === 5 && detail.json.videos[0].title === 'Final night' && detail.json.start_date === '2024-12-01', 'season detail: info, videos, contestants');
check(detail.json.contestants[0].artist_slug === 'ann-artist' && !('bio' in detail.json.contestants[0]) && detail.json.contestants[0].summary === 'Won it all.', 'season detail: contestants carry a summary and artist slug');
const idolPage = await pub('/mara-idol-season-1/win-ner');
check(idolPage.status === 200 && idolPage.json.name === 'Win Ner' && idolPage.json.season.slug === 'mara-idol-season-1' && idolPage.json.videos.length === 1, 'idol detail: info, season, videos');
check(idolPage.json.artist.slug === 'ann-artist' && idolPage.json.artist.badges[0].period === 'lifetime' && !('id' in idolPage.json.artist), 'idol detail: linked artist (with badges), no ids');
check(!JSON.stringify(idolPage.json).match(/"(id|artist_id|status)"/), 'idol detail leaks no internal fields');
check((await pub('/mara-idol-season-1/nobody')).status === 404 && (await pub('/nope')).status === 404, 'unknown idol/season → 404');
check((await pub('/mara-idol-season-2/win-ner')).json.season.slug === 'mara-idol-season-2', 'same slug resolves per season');

console.log('Publishing');
await adm('PUT', `/idol-seasons/${s3.json.id}`, { title: 'Mara Idol Season 3', year: 2026, status: 'published' });
check((await pub('/mara-idol-season-3/draft-idol')).status === 200 && (await pub('')).json.seasons.length === 3, 'publishing makes the season and its idols public');
await adm('PUT', `/idol-seasons/${s3.json.id}`, { title: 'Mara Idol Season 3', year: 2026, status: 'draft' });
check((await pub('/mara-idol-season-3')).status === 404, 'unpublishing hides it again');

console.log('Integrity');
const audit = sqlite.prepare("SELECT action FROM audit_log WHERE action LIKE 'idol%'").all().map((a) => a.action);
check(['idol_season.create', 'idol_season.edit', 'idol.create', 'idol.edit'].every((a) => audit.includes(a)), 'create/edit are audit-logged');
check(await (async () => { try { run(`INSERT INTO idol_contestants (season_id, name, slug, result) VALUES (${s1.json.id}, 'x', 'x2', 'king')`); return false; } catch { return true; } })(), 'DB rejects an invalid result');
check(await (async () => { try { run(`INSERT INTO idol_seasons (title, slug, year, start_date) VALUES ('t', 'tt', 2020, '2020-1-1')`); return false; } catch { return true; } })(), 'DB rejects a malformed date');
check(await (async () => { try { run(`INSERT INTO idol_seasons (title, slug, year, videos) VALUES ('t', 'tt2', 2020, 'not json')`); return false; } catch { return true; } })(), 'DB rejects invalid videos JSON');

run('DELETE FROM artists WHERE id = 1');
check((await pub('/mara-idol-season-1/win-ner')).json.artist === null, 'deleting the artist just unlinks the idol (artist → null)');
check(count('SELECT COUNT(*) AS n FROM idol_contestants WHERE id = ?', winner.id) === 1, '…and keeps the idol');
const del = await adm('DELETE', `/idol-contestants/${plain.id}`, undefined, 'manager');
check(del.status === 200 && (await adm('DELETE', `/idol-contestants/${plain.id}`, undefined, 'manager')).status === 404, 'manager can delete a contestant (twice → 404)');
const before = count('SELECT COUNT(*) AS n FROM idol_contestants WHERE season_id = ?', s1.json.id);
check((await adm('DELETE', `/idol-seasons/${s1.json.id}`, undefined, 'manager')).status === 200 && before === 4 && count('SELECT COUNT(*) AS n FROM idol_contestants WHERE season_id = ?', s1.json.id) === 0, 'deleting a season deletes its contestants (cascade)');
check((await pub('/mara-idol-season-1')).status === 404, '…and the season page is gone');

// ─── Deploy order: new code against a database that has not run migration 0014 yet ───────────
console.log('\nBefore migration 0014 (no idol_seasons.photo_url)');
{
  const old = new DatabaseSync(':memory:');
  old.exec('PRAGMA foreign_keys = ON');
  old.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  old.exec('ALTER TABLE idol_seasons DROP COLUMN photo_url');
  old.exec(`INSERT INTO idol_seasons (id, title, slug, year, status) VALUES (1, 'Old Season', 'old-season', 2024, 'published')`);
  const OLD_DB = { prepare(sql) { const st = old.prepare(sql); const bound = (a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { const r = st.run(...a); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; } }); return { ...bound([]), bind: (...a) => bound(a) }; } };
  const oldPub = async (url) => { const res = await app.fetch(new Request(`https://api.test/api/v1/mara-idol${url}`), { DB: OLD_DB, JWT_SECRET: SECRET }); return { status: res.status, json: await res.json().catch(() => null) }; };
  const oi = await oldPub('');
  check(oi.status === 200 && oi.json.seasons.length === 1 && oi.json.seasons[0].photo_url === null, 'public index still works (photo_url → null)');
  const od = await oldPub('/old-season');
  check(od.status === 200 && od.json.title === 'Old Season' && od.json.photo_url === null, 'public season page still works (photo_url → null)');
}

// ─── A slug pasted as a whole address ─────────────────────────────────────────────────────────────
// Three contestants once got "httpsmaralyricscomartisthc-teresa-ngiano" as their slug (and URL) because an address was pasted into the slug
// box and slugify() glued it together. Only the last part of an address is a slug now, and migration 0022 repairs the old rows.
{
  const { slugFromInput } = await load('worker/lib/helpers.js');
  check(slugFromInput('https://maralyrics.com/artist/hc-teresa-ngiano') === 'hc-teresa-ngiano', 'slugFromInput: the last part of a pasted address');
  check(slugFromInput('https://maralyrics.com/artist/Fc%20Siteite/') === 'fc-siteite' && slugFromInput('http://x.test/a/b?x=1#y') === 'b', 'slugFromInput: trailing slash, an escaped space, a query and a fragment');
  check(slugFromInput('My New Slug') === 'my-new-slug' && slugFromInput('  Rônah Chai  ') === 'ronah-chai' && slugFromInput('') === '', 'slugFromInput: anything else is slugified as before');
  check(slugFromInput('https://') === 'https' && slugFromInput('https://maralyrics.com') === 'httpsmaralyricscom', 'slugFromInput: an address with no path is not turned into nothing');
  const c = validateContestant({ name: 'HC Teresa Ngiano', slug: 'https://maralyrics.com/artist/hc-teresa-ngiano', season_id: 1 });
  check(c.ok && c.values.slug === 'hc-teresa-ngiano', `a contestant saved with a pasted address gets the clean slug (${c.values && c.values.slug})`);
  const s = validateSeason({ title: 'Season 9', slug: 'https://maralyrics.com/mara-idol/season-9', year: 2026 });
  check(s.ok && s.values.slug === 'season-9', 'a season saved with a pasted address gets the clean slug');
  check(validateContestant({ name: 'Plain Name', season_id: 1 }).values.slug === 'plain-name', 'no slug typed: made from the name, as before');

  // the migration, on the real schema
  const m = new DatabaseSync(':memory:');
  m.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  m.exec(`INSERT INTO idol_seasons (id, title, slug, year, status) VALUES (1, 'S7', 's7', 2024, 'published'), (2, 'S8', 's8', 2025, 'published')`);
  m.exec(`INSERT INTO idol_contestants (id, season_id, name, slug) VALUES
    (1, 1, 'HC Teresa Ngiano', 'httpsmaralyricscomartisthc-teresa-ngiano'),
    (2, 1, 'FC Siteite', 'httpsmaralyricscomartistfc-siteite'),
    (3, 1, 'Cy', 'httpsmaralyricscomcomposercy-composer'),
    (4, 2, 'Taken', 'httpsmaralyricscomartisttaken'),
    (5, 2, 'Already There', 'taken'),
    (6, 1, 'Normal One', 'normal-one'),
    (7, 1, 'Nothing After', 'httpsmaralyricscomartist')`);
  m.exec(fs.readFileSync(path.join(ROOT, 'migrations/0022_fix_idol_slugs.sql'), 'utf8'));
  const slugs = Object.fromEntries(m.prepare('SELECT id, slug FROM idol_contestants').all().map((r) => [r.id, r.slug]));
  check(slugs[1] === 'hc-teresa-ngiano' && slugs[2] === 'fc-siteite' && slugs[3] === 'cy-composer', 'migration 0022: the artist and composer addresses are cut back to the slug');
  check(slugs[4] === 'httpsmaralyricscomartisttaken' && slugs[5] === 'taken', 'migration 0022: a row whose clean slug is taken in its season is left alone (no clash)');
  check(slugs[6] === 'normal-one' && slugs[7] === 'httpsmaralyricscomartist', 'migration 0022: normal slugs, and a bare address with nothing after it, are untouched');
  m.exec(fs.readFileSync(path.join(ROOT, 'migrations/0022_fix_idol_slugs.sql'), 'utf8'));
  check(JSON.stringify(m.prepare('SELECT slug FROM idol_contestants ORDER BY id').all().map((r) => r.slug)) === JSON.stringify(Object.values(slugs)), 'migration 0022: running it twice changes nothing');
}

console.log(`\n${failures ? '✗' : '✓'} ${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
