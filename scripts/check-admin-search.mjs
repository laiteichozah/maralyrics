#!/usr/bin/env node
// The admin dashboard's search: any case, any accents, any word order, a typo or two.   npm run test:adminsearch
//
//   • the matcher (public/search-match.js) on its own
//   • the Worker's Songs and Articles lists (GET /api/v1/admin/songs?q=… and /articles?q=…), which are paged on the server, against a
//     real in-memory SQLite database: a search that LIKE could not do (accented capitals, typos), paging, wild characters
//   • the dashboard wiring: every search box goes through the matcher, and the page and its offline worker load it
// The click-through in a real browser (typing in the Songs tab) is in scripts/e2e-guitar-node.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { fold, score, rank, filter } = await load('public/search-match.js');
const { default: app } = await load('worker/worker.js');
const { signJWT } = await load('worker/lib/auth.js');

let passes = 0;
let failures = 0;
const check = (cond, msg) => { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } };

// ─── The matcher ─────────────────────────────────────────────────────────────
console.log('The matcher');
const hit = (q, text) => score(q, text) > 0;
check(hit('RAMA', 'Ramâ') && hit('rama', 'RAMÂ') && hit('ramâ', 'RAMA') && hit('RAMÂ', 'Ramâ'), 'case and accents do not matter, in either direction');
check(hit('ÂNG', 'Ṭhâng') && hit('ṭhang', 'ṬHÂNG') && hit('ZOÉ', 'zoe') && hit('Ünal', 'unal') && hit('naïve', 'NAIVE'), 'capitals with accents (which SQLite\'s LIKE cannot fold) match their plain letters');
check(hit('Strasse', 'STRAßE') && hit('Ørsted', 'orsted') && hit('Æther', 'aether'), 'ß, ø and æ match ss, o and ae');
check(hit('dont', "Don't stop") && hit("don't", 'DONT STOP') && hit('Dont', 'Don’t stop'), 'an apostrophe (straight or curly) is ignored');
check(hit('waltz sad', 'Sad Waltz') && hit('sad waltz', 'Sad Waltz') && hit('mystery sad', 'Sad Mystery Key'), 'words in any order');
check(hit('ramâ pop', 'Mara Pop (Ramâ)') && !hit('rama jazz', 'Mara Pop (Ramâ)'), 'every word has to match: "pop" alone is not enough for "rama jazz"');
check(hit('fal', 'Falling') && hit('lling', 'Falling') && hit('sad wal', 'Sad Waltz'), 'the start of a word, or the inside of one, as before');
check(hit('fallng', 'Falling') && hit('fallign', 'Falling') && hit('fallling', 'Falling') && hit('falling', 'Fallin'), 'a missing, swapped, extra or wrong letter in a word of 4 or more letters');
check(hit('sad waltx', 'Sad Waltz') && hit('amazng gras', 'Amazing grace') && hit('gosple', 'Gospel') && hit('grce', 'Grace'), 'typos in several words, and in a word still being typed');
check(hit('hymnall', 'Hymnal Book') && hit('beutiful', 'Beautiful Savior') && hit('bautiful sevior', 'Beautiful Savior'), 'two typos in a long word');
check(!hit('xyz', 'Falling') && !hit('zzzz', 'Sad Waltz') && !hit('falling', 'Sad Waltz') && !hit('qwerty', 'Mara Pop'), 'unrelated words do not match');
check(!hit('ab', 'Ac') && !hit('mat', 'Map') && !hit('cat', 'Cut'), 'words of 3 letters or fewer must be right: no typo matching');
check(!hit('mara', 'Maro') || score('mara', 'Maro') < 0.7, 'a 4-letter word with a typo is a weaker match than the real word');
check(!hit('lamp', 'Camp') && !hit('rama', 'Dama'), 'a short word must keep its first letter (a typo in the first letter is not guessed)');
check(score('', 'anything') === 1 && score('   ', 'anything') === 1, 'an empty query matches everything');
check(hit('?', 'What?') && !hit('?', 'What') && hit('(', 'Mara (live)') && hit('john@example.com', 'John@Example.COM') && hit('my-song-1', 'my-song-1'), 'queries made of punctuation, e-mail addresses and slugs work');
check(hit('မြန်', 'မြန်မာနိုင်ငံ') && hit('မြန်မာ', 'မြန်မာနိုင်ငံ') && !hit('ကျော်', 'မြန်မာနိုင်ငံ'), 'Burmese: the marks that carry meaning are kept, so different words do not collapse into one');
check(fold('Ramâ') === 'rama' && fold('ṬHÂNG') === 'thang' && fold(null) === '' && fold(undefined) === '' && fold(12) === '12', 'fold(): lower case, no Latin accents, null-safe');
check(score('rama', 'rama') === 1 && score('rama', 'ramâ nu') > score('rama', 'drama') && score('rama', 'drama') > score('ramaa', 'rama'), 'exact beats start of word beats inside a word beats a typo');
check(score('sad waltz', 'Sad Waltz') > score('waltz sad', 'Sad Waltz'), 'the words in a row rank above the same words out of order');

const songs = ['Falling', 'Sad Waltz', 'Mara Pop', 'Mari', 'Mark', 'Mare Day', 'Ramâ Nu', 'Amazing Grace'].map((title, id) => ({ id, title, artist: id === 6 ? 'Zoé Ṭhâng' : 'Nobody', category: 'Gospel' }));
const names = (q, fields = ['title', 'artist', 'category']) => filter(songs, q, fields).map((s) => s.title);
check(filter(songs, '', ['title']) === songs && filter(songs, '  ', ['title']) === songs, 'filtering by an empty query returns the same list');
check(names('mara').join() === 'Mara Pop', 'when something matches as typed, near-misses are not added ("mara" is not drowned in Mari, Mark, Mare)');
check(names('maro').join() === 'Mara Pop,Mari,Mark,Mare Day', 'when nothing does, near-misses are offered (best first, then in the list\'s own order)');
check(names('falling').join() === 'Falling' && names('FALLNG').join() === 'Falling', 'a typo finds it');
check(names('zoe thang').join() === 'Ramâ Nu' && names('RAMÂ ZOÉ').join() === 'Ramâ Nu', 'the words may be spread over fields (title + artist)');
check(names('gospel').length === songs.length && names('nu').join() === 'Ramâ Nu', 'any field is searched');
const ranked = rank([{ n: 'Alpha beta' }, { n: 'beta' }, { n: 'Zeta' }, { n: 'Betamax' }], 'beta', ['n']);
check(ranked.map((r) => r.item.n).join() === 'Alpha beta,beta,Betamax' && ranked[0].score === 1 && ranked[2].score < 1, 'rank(): best first (ties keep the list\'s order), with the score');
check(filter([{ a: 'x', b: 'Hello' }], 'hello', [(o) => o.b, 'a']).length === 1, 'a field may be a function');
check(filter(Array.from({ length: 2000 }, (_, i) => ({ t: `Song number ${i} in the long list` })), 'sogn numbr 1999', ['t']).length >= 1, 'a long list is searched without trouble');
const long = `${Array.from({ length: 5000 }, (_, i) => `word${i}`).join(' ')} zebra`;
check(score('word1', long) > 0 && score('zebra', long) === 0, 'a very long text is only searched in its first words (so a huge report cannot make a search slow)');

// ─── The Worker's lists ──────────────────────────────────────────────────────
console.log('The Songs and Articles lists on the server');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec(read('schema.sql'));
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
const ENV = { DB, JWT_SECRET: 'test-secret' };
run(`INSERT INTO admin_users (id, username, password_hash, role) VALUES (1, 'boss', 'x', 'super_admin')`);
const token = await signJWT({ sub: 1, username: 'boss' }, ENV.JWT_SECRET);
const get = async (p, auth = true) => {
  const res = await app.fetch(new Request(`https://api.test/api/v1/admin${p}`, { headers: auth ? { Authorization: `Bearer ${token}` } : {} }), ENV);
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

let minutes = 0;
const addSong = (title, slug, category = 'Gospel') => {
  minutes++;
  return Number(run(`INSERT INTO songs (title, slug, lyrics, category, status, created_at) VALUES (?, ?, 'words', ?, 'published', datetime('now', ?))`, title, slug, category, `-${minutes} minutes`).lastInsertRowid);
};
const addPerson = (table, junction, fk, songId, name, slug, position = 0) => {
  const id = Number(run(`INSERT INTO ${table} (name, slug) VALUES (?, ?)`, name, slug).lastInsertRowid);
  run(`INSERT INTO ${junction} (song_id, ${fk}, position) VALUES (?, ?, ?)`, songId, id, position);
};
const s1 = addSong('Ramâ Nu', 'rama-nu', 'Traditional');
addPerson('artists', 'song_artists', 'artist_id', s1, 'Zoé Ṭhâng', 'zoe-thang');
addPerson('composers', 'song_composers', 'composer_id', s1, 'Ṅâng Léi', 'nang-lei');
addSong('Falling', 'falling', 'Love');
addSong('Sad Waltz', 'sad-waltz', 'Love');
addSong('Mara Pop', 'mara-pop', 'Patriotic');
addSong('Mari', 'mari');
addSong('မြန်မာ သီချင်း', 'myanmar-song');
const titles = (r) => r.json.songs.map((s) => s.title);

check((await get('/songs?q=ram', false)).status === 401, 'the list still needs a signed-in admin');
let r = await get('/songs');
check(r.json.total === 6 && titles(r)[0] === 'Ramâ Nu' && titles(r)[5] === 'မြန်မာ သီချင်း', 'without a search the list is unchanged (newest first)');
check(r.json.songs[0].artist_name === 'Zoé Ṭhâng' && r.json.songs[0].composer_name === 'Ṅâng Léi', '…with its artist and composer names');
for (const q of ['RAMÂ', 'rama', 'RAMA', 'ramâ', 'Rama Nu']) check(titles(await get(`/songs?q=${encodeURIComponent(q)}`)).join() === 'Ramâ Nu', `q=${q}: found, whatever the case and accents`);
for (const q of ['ṬHÂNG', 'ṭhâng', 'THANG', 'zoe thang', 'ZOÉ', 'NANG', 'ṅâng léi', 'LEI']) check(titles(await get(`/songs?q=${encodeURIComponent(q)}`)).join() === 'Ramâ Nu', `q=${q}: found by its artist or composer (accented capitals included)`);
check(titles(await get('/songs?q=rama-nu')).join() === 'Ramâ Nu' && titles(await get('/songs?q=TRADITIONAL')).join() === 'Ramâ Nu', 'found by slug and by category');
check(titles(await get('/songs?q=fallng')).join() === 'Falling' && titles(await get('/songs?q=FALLIGN')).join() === 'Falling', 'a typo finds the song');
check(titles(await get('/songs?q=waltz%20sad')).join() === 'Sad Waltz' && titles(await get('/songs?q=sad%20waltx')).join() === 'Sad Waltz', 'any word order, and a typo in one of the words');
check(titles(await get('/songs?q=mara')).join() === 'Mara Pop' && titles(await get('/songs?q=maro')).join().startsWith('Mara Pop'), 'exact matches alone when there are some; near-misses when there are none');
check(titles(await get('/songs?q=' + encodeURIComponent('မြန်'))).join() === 'မြန်မာ သီချင်း', 'a Burmese title is found');
r = await get('/songs?q=zzzzqq');
check(r.status === 200 && r.json.total === 0 && r.json.songs.length === 0 && r.json.totalPages === 1, 'no match: an empty list, total 0');
for (const q of ['100%', '_', '%', "'; DROP TABLE songs; --", '\\', '"', '(', 'a'.repeat(500)]) {
  r = await get(`/songs?q=${encodeURIComponent(q)}`);
  check(r.status === 200 && Array.isArray(r.json.songs), `q=${q.slice(0, 20)}: wild characters are only text (no error)`);
}
check(sqlite.prepare('SELECT COUNT(*) AS n FROM songs').get().n === 6, '…and the table is intact');

// paging
for (let i = 1; i <= 120; i++) addSong(`Alpha Song ${i}`, `alpha-song-${i}`);
r = await get('/songs?q=alpha&limit=50&page=1');
const page1 = titles(r);
check(r.json.total === 120 && page1.length === 50 && r.json.totalPages === 3 && r.json.page === 1, 'a search is paged on the server: 120 matches, 50 on page 1, 3 pages');
const page2 = titles(await get('/songs?q=alpha&limit=50&page=2'));
const page3 = titles(await get('/songs?q=alpha&limit=50&page=3'));
check(page2.length === 50 && page3.length === 20 && new Set([...page1, ...page2, ...page3]).size === 120, 'pages 2 and 3 continue where page 1 stopped, with no repeats');
check(page1[0] === 'Alpha Song 1' && page3[19] === 'Alpha Song 120', 'matches that tie keep the list\'s own order (newest first)');
check(titles(await get('/songs?q=alpha&limit=50&page=4')).length === 0, 'a page past the end is empty');
check(titles(await get('/songs?q=alpha%20song%20120')).join() === 'Alpha Song 120' && titles(await get('/songs?q=alpha&limit=100&page=2')).length === 20, 'more words narrow the list; the largest page size (100) works');

// articles
const addArticle = (title, slug, author, status = 'published', summary = '') => run(`INSERT INTO articles (title, slug, author_name, summary, content, status, created_at) VALUES (?, ?, ?, ?, 'text', ?, datetime('now', ?))`, title, slug, author, summary, status, `-${++minutes} minutes`);
addArticle('Mara Music Festival', 'mara-music-festival', 'Dr. Éla Zhang');
addArticle('Choir Practice Notes', 'choir-practice-notes', 'Ṭhomas Lal', 'draft', 'Rehearsal schedule');
addArticle('A Guide to Hymnals', 'guide-to-hymnals', 'Ela Zhang');
const articleTitles = (r2) => r2.json.articles.map((a) => a.title);
check((await get('/articles')).json.total === 3, 'the article list is unchanged without a search');
check(articleTitles(await get('/articles?q=ELA')).sort().join() === 'A Guide to Hymnals,Mara Music Festival', 'found by author, whatever the case and accents');
check(articleTitles(await get('/articles?q=ṬHOMAS')).join() === 'Choir Practice Notes' && articleTitles(await get('/articles?q=thomas')).join() === 'Choir Practice Notes', 'an accented capital in an author\'s name');
check(articleTitles(await get('/articles?q=festivl')).join() === 'Mara Music Festival' && articleTitles(await get('/articles?q=hymnal%20guid')).join() === 'A Guide to Hymnals', 'a typo, and any word order');
check(articleTitles(await get('/articles?q=rehearsal')).join() === 'Choir Practice Notes' && articleTitles(await get('/articles?q=guide-to-hymnals')).join() === 'A Guide to Hymnals', 'found by summary and by slug');
check(articleTitles(await get('/articles?q=ela&status=draft')).length === 0 && articleTitles(await get('/articles?q=choir&status=draft')).join() === 'Choir Practice Notes', 'the status filter still applies to a search');
r = await get('/articles?q=zzzzqq');
check(r.json.total === 0 && r.json.articles.length === 0 && (await get("/articles?q=100%25_'")).status === 200, 'no match is an empty list; wild characters are harmless');

// ─── The dashboard ───────────────────────────────────────────────────────────
console.log('The dashboard');
const indexJs = read('public/admin/index.js');
const adminHtml = read('public/admin/index.html');
const adminRoutes = read('worker/routes/admin.js');
check(!/\bLIKE\s+\?/.test(adminRoutes), 'the Worker\'s admin routes no longer search with LIKE');
check(/import \{ rank \} from '\.\.\/\.\.\/public\/search-match\.js'/.test(adminRoutes), 'they use the shared matcher');
check(/<script type="module" src="\/search-match\.js"><\/script>\s*<script src="index\.js\?v=\d+"><\/script>/.test(adminHtml), 'the admin page loads the matcher before its own script, and index.js carries a ?v=');
check(/'\/search-match\.js'/.test(read('public/admin/sw.js')) && Number(/ml-admin-v(\d+)/.exec(read('public/admin/sw.js'))[1]) >= 21, 'the admin worker keeps the matcher for offline use (and its version was bumped)');
check(/function filterBySearch[\s\S]*?MaraMatch\.filter\(items, q, fields\)/.test(indexJs), 'filterBySearch (Artists, Composers, Copyright owners, Reports, Revisions, Contacts, Audit log, offline lists) uses the matcher');
check(/filterBySearch\(allIdols\.filter/.test(indexJs) && /filterBySearch\(allAdminUsers, query/.test(indexJs) && /filterBySearch\(rows, q, \[\(row\) => row\.dataset\.name\]\)/.test(indexJs), 'so do the Idols tab, the Admin accounts tab and the artist / composer pickers in the song form');
check(!/\.toLowerCase\(\)\.includes\(/.test(indexJs) && !/normalizeForSearch\([^)]*\)\.includes\(q\)/.test(indexJs.replace(/function filterBySearch[\s\S]*?\n}\n/, '')), 'no search box still does its own "contains" test');
const withoutMatcher = new Function('globalThis', `${indexJs.slice(indexJs.indexOf('function normalizeForSearch'), indexJs.indexOf('function generateSlug'))}; return { filterBySearch };`)({});
check(withoutMatcher.filterBySearch([{ n: 'Ramâ' }, { n: 'Other' }], 'RAMA', ['n']).length === 1, 'if the matcher failed to load, the old accent- and case-insensitive "contains" still works');

console.log(failures ? `\n✗ ${failures} failed, ${passes} passed` : `\n✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
