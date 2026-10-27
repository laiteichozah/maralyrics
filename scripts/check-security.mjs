#!/usr/bin/env node
// Security checks: response headers, private data never cached, errors that do not leak, form limits, sign-in throttling.   npm run test:security
//
// Runs the real Hono worker against an in-memory SQLite database, and loads public/sw.js into a sandbox to see what it
// would cache. Cloudflare Turnstile is not configured here (no secret), so the public forms skip the challenge.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { default: app } = await load('worker/worker.js');
const { IP_FAILURE_LIMIT, RETENTION_HOURS } = await load('worker/lib/throttle.js');
const { hashPassword, signJWT } = await load('worker/lib/auth.js');

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
const get = (sql, ...a) => sqlite.prepare(sql).get(...a);
const run = (sql, ...a) => sqlite.prepare(sql).run(...a);
const ENV = { DB, JWT_SECRET: 'test-secret' };
const call = async (method, p, body, { headers = {}, env = ENV } = {}) => {
  const res = await app.fetch(new Request(`https://api.test${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
};

// ─── Static headers (public/_headers) ────────────────────────────────────────
console.log('Static headers');
const headersFile = fs.readFileSync(path.join(ROOT, 'public/_headers'), 'utf8');
const blocks = {};
let current = null;
for (const line of headersFile.split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  if (/^\S/.test(line)) { current = line.trim(); blocks[current] = blocks[current] || {}; } else if (current) { const i = line.indexOf(':'); blocks[current][line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
}
const everything = blocks['/*'] || {};
check(/max-age=\d{7,}/.test(everything['strict-transport-security'] || ''), 'HTTPS is enforced for at least a year (HSTS)');
check(/frame-ancestors 'self'/.test(everything['content-security-policy'] || ''), 'other sites cannot frame the pages (CSP frame-ancestors)');
check(/object-src 'none'/.test(everything['content-security-policy'] || '') && /base-uri 'self'/.test(everything['content-security-policy'] || ''), 'no plug-ins, and <base> stays on the site');
check(everything['x-content-type-options'] === 'nosniff', 'no MIME sniffing');
check(/camera=\(\)/.test(everything['permissions-policy'] || '') && /microphone=\(\)/.test(everything['permissions-policy'] || ''), 'camera / microphone are off');
// Cloudflare joins the values of every matching rule: a second X-Frame-Options would become "A, B", which browsers ignore.
check(!('x-frame-options' in everything) && blocks['/admin/*']?.['x-frame-options'] === 'DENY', 'X-Frame-Options is set once (the admin only), so the values never conflict');
check(blocks['/.well-known/assetlinks.json']?.['content-type'] === 'application/json', 'assetlinks.json is served as JSON');

// ─── API response headers ────────────────────────────────────────────────────
console.log('API headers');
let r = await call('GET', '/api/v1/stats');
check(r.status === 200 && r.headers.get('x-content-type-options') === 'nosniff', 'API answers carry nosniff');
check(!/no-store/.test(r.headers.get('cache-control') || ''), '(public data may still be cached)');
r = await call('GET', '/api/v1/account/config');
check(r.headers.get('cache-control') === 'no-store', 'account answers are never stored by a browser or proxy');
r = await call('POST', '/api/v1/admin/auth/login', { username: 'x', password: 'y' });
check(r.headers.get('cache-control') === 'no-store', 'admin answers are never stored either');
r = await call('GET', '/api/v1/account/me');
check(r.status === 401 && r.headers.get('cache-control') === 'no-store', 'including the refusals');

// ─── Errors that do not leak ─────────────────────────────────────────────────
console.log('Unexpected errors');
const boom = { ...ENV, DB: { prepare() { throw new Error('SQLITE_ERROR: no such table: secret_table (binding user_pw_hash)'); } } };
const origError = console.error; console.error = () => {};
r = await call('GET', '/api/v1/stats', undefined, { env: boom });
console.error = origError;
check(r.status === 500 && r.json.success === false, 'an unexpected failure is a plain 500');
check(!/secret_table|SQLITE|binding|user_pw_hash/.test(r.text), 'and the database message is not sent to the caller');

// ─── Public forms ────────────────────────────────────────────────────────────
console.log('Public forms');
run(`INSERT INTO songs (title, slug, lyrics, status) VALUES ('Song', 'song', 'words', 'published')`);
const report = (over = {}) => call('POST', '/api/v1/reports', { song_slug: 'song', song_title: 'Song', reporter_name: 'Ann', reporter_email: 'ann@example.com', body: 'A typo in line 2', ...over });
r = await report();
check(r.status === 201 && get('SELECT COUNT(*) AS n FROM reports').n === 1, 'a normal report is saved');
r = await report({ body: { $gt: '' } });
check(r.status === 400 && get('SELECT COUNT(*) AS n FROM reports').n === 1, 'a body that is not text is refused (not a server error)');
r = await report({ body: 'x'.repeat(5001) });
check(r.status === 400 && /too long/i.test(r.json.error), 'a report over 5000 characters is refused, with a reason');
r = await report({ reporter_email: 'not an email' });
check(r.status === 400, 'a bad email address is refused');
r = await report({ song_slug: { a: 1 } });
check(r.status === 400, 'a slug that is not text is refused');
r = await report({ reporter_name: 'N'.repeat(500), song_title: 'T'.repeat(900) });
const saved = get('SELECT reporter_name, song_title FROM reports ORDER BY id DESC LIMIT 1');
check(r.status === 201 && saved.reporter_name.length === 100 && saved.song_title.length === 300, 'long names and titles are cut to a sane length');

const contact = (over = {}) => call('POST', '/api/v1/contacts', { name: 'Ann', email: 'ann@example.com', subject: 'Hello', message: 'Nice site', ...over });
r = await contact();
check(r.status === 201 && get('SELECT COUNT(*) AS n FROM contacts').n === 1, 'a normal message is saved');
r = await contact({ message: ['array'] });
check(r.status === 400, 'a message that is not text is refused');
r = await contact({ message: 'm'.repeat(5001) });
check(r.status === 400 && /too long/i.test(r.json.error), 'a message over 5000 characters is refused');
r = await contact({ email: 'nope' });
check(r.status === 400, 'a bad email address is refused');
r = await contact({ subject: 'S'.repeat(1000) });
check(r.status === 201 && get('SELECT subject FROM contacts ORDER BY id DESC LIMIT 1').subject.length === 200, 'a long subject is cut');

// ─── Sign-in: malformed input and the per-address limit ──────────────────────
console.log('Sign-in guards');
r = await call('POST', '/api/v1/admin/auth/login', { username: { $ne: '' }, password: 'x' });
check(r.status === 400, 'admin sign-in with a non-text name is refused (not a server error)');
r = await call('POST', '/api/v1/admin/auth/login', { username: 'boss', password: ['x'] });
check(r.status === 400, 'admin sign-in with a non-text password is refused');
r = await call('POST', '/api/v1/admin/auth/login', { username: 'boss', password: 'p'.repeat(5000) });
check(r.status === 401, 'an absurdly long password is refused without hashing it');
r = await call('POST', '/api/v1/account/login', { identifier: 'a'.repeat(400), password: 'x' });
check(r.status === 401, 'account sign-in with an absurdly long name is refused');

const fromIp = (ip) => ({ headers: { 'CF-Connecting-IP': ip } });
run('DELETE FROM login_attempts');
r = await call('POST', '/api/v1/admin/auth/login', { username: 'ghost-1', password: 'wrong-password' }, fromIp('203.0.113.7'));
check(r.status === 401 && get(`SELECT COUNT(*) AS n FROM login_attempts WHERE username = 'ip:admin:203.0.113.7'`).n === 1, 'a failed admin sign-in is counted against the address too');
for (let i = 0; i < IP_FAILURE_LIMIT; i++) run(`INSERT INTO login_attempts (username) VALUES ('ip:admin:198.51.100.9')`);
r = await call('POST', '/api/v1/admin/auth/login', { username: 'a-name-never-tried', password: 'wrong-password' }, fromIp('198.51.100.9'));
check(r.status === 429, `one address that failed ${IP_FAILURE_LIMIT} times is stopped, even with a name it never tried before`);
r = await call('POST', '/api/v1/admin/auth/login', { username: 'a-name-never-tried', password: 'wrong-password' }, fromIp('198.51.100.10'));
check(r.status === 401, 'another address is not affected');
for (let i = 0; i < IP_FAILURE_LIMIT; i++) run(`INSERT INTO login_attempts (username) VALUES ('ip:person:198.51.100.9')`);
r = await call('POST', '/api/v1/account/login', { identifier: 'new@example.com', password: 'wrong-password' }, fromIp('198.51.100.9'));
check(r.status === 429, 'the same limit protects the account sign-in');
r = await call('POST', '/api/v1/account/login', { identifier: 'new@example.com', password: 'wrong-password' }, fromIp('198.51.100.11'));
check(r.status === 401 && get(`SELECT COUNT(*) AS n FROM login_attempts WHERE username = 'ip:person:198.51.100.11'`).n === 1, '…and another address still gets the normal answer (and is counted)');
run(`UPDATE login_attempts SET created_at = datetime('now', '-20 minutes') WHERE username = 'ip:admin:198.51.100.9'`);
r = await call('POST', '/api/v1/admin/auth/login', { username: 'a-name-never-tried', password: 'wrong-password' }, fromIp('198.51.100.9'));
check(r.status === 401, 'the limit lifts by itself after the window');
r = await call('POST', '/api/v1/admin/auth/login', { username: 'ghost-2', password: 'wrong-password' });
check(r.status === 401, 'with no address (local development) the limit simply does nothing');
// The Privacy Policy says sign-in attempt records (names and addresses) are deleted within a day.
run(`INSERT INTO login_attempts (username, created_at) VALUES ('person:old@example.com', datetime('now', '-30 hours')), ('ip:admin:192.0.2.1', datetime('now', '-30 hours')), ('person:recent@example.com', datetime('now', '-2 hours'))`);
await call('POST', '/api/v1/account/login', { identifier: 'someone@example.com', password: 'wrong-password' }, fromIp('192.0.2.55'));
check(get(`SELECT COUNT(*) AS n FROM login_attempts WHERE created_at < datetime('now', '-24 hours')`).n === 0 && get(`SELECT COUNT(*) AS n FROM login_attempts WHERE username = 'person:recent@example.com'`).n === 1, 'sign-in attempt records older than a day are deleted, recent ones kept');

// ─── Admin sessions end when the password changes ────────────────────────────
console.log('Admin sessions');
run(`INSERT INTO admin_users (id, username, password_hash, role) VALUES (1, 'boss', ?, 'super_admin'), (2, 'ed', ?, 'editor')`, await hashPassword('first-password'), await hashPassword('editor-password'));
const asAdmin = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
r = await call('POST', '/api/v1/admin/auth/login', { username: 'boss', password: 'first-password' });
const bossOld = r.json.token;
check(r.status === 200 && bossOld, 'an admin can sign in');
r = await call('GET', '/api/v1/admin/auth/me', undefined, asAdmin(bossOld));
check(r.status === 200 && r.json.username === 'boss', 'the session works');
r = await call('POST', '/api/v1/admin/auth/login', { username: 'ed', password: 'editor-password' });
const edOld = r.json.token;
r = await call('POST', '/api/v1/admin/auth/change-password', { current_password: 'first-password', new_password: 'second-password' }, asAdmin(bossOld));
const bossNew = r.json.token;
check(r.status === 200 && r.json.success && bossNew && bossNew !== bossOld, 'changing the password hands back a fresh session');
r = await call('GET', '/api/v1/admin/auth/me', undefined, asAdmin(bossOld));
check(r.status === 401, 'the session from before the change no longer works (a stolen token dies with the old password)');
r = await call('GET', '/api/v1/admin/auth/me', undefined, asAdmin(bossNew));
check(r.status === 200, 'the fresh session does');
r = await call('POST', '/api/v1/admin/auth/change-password', { current_password: { x: 1 }, new_password: 'third-password' }, asAdmin(bossNew));
check(r.status === 400, 'a password that is not text is refused');
r = await call('PUT', '/api/v1/admin/admin-users/2', { username: 'ed', role: 'editor', password: 'reset-by-boss' }, asAdmin(bossNew));
check(r.status === 200, 'a manager / admin can reset another account\'s password');
r = await call('GET', '/api/v1/admin/auth/me', undefined, asAdmin(edOld));
check(r.status === 401, 'and that account\'s old sessions end');
r = await call('POST', '/api/v1/admin/auth/login', { username: 'ed', password: 'reset-by-boss' });
check(r.status === 200 && (await call('GET', '/api/v1/admin/auth/me', undefined, asAdmin(r.json.token))).status === 200, 'the new password signs in');
const legacy = await signJWT({ sub: 1, username: 'boss', role: 'super_admin' }, ENV.JWT_SECRET);
r = await call('GET', '/api/v1/admin/auth/me', undefined, asAdmin(legacy));
check(r.status === 200, 'a session signed before this check existed still works until it expires (12 hours)');
r = await call('POST', '/api/v1/admin/admin-users', { username: { a: 1 }, password: 'long-enough-1', role: 'viewer' }, asAdmin(bossNew));
check(r.status === 400, 'creating an admin with a name that is not text is refused (not a server error)');
r = await call('POST', '/api/v1/admin/admin-users', { username: 'n'.repeat(80), password: 'long-enough-1', role: 'viewer' }, asAdmin(bossNew));
check(r.status === 400 && /too long/i.test(r.json.error), '…and so is a name that is too long');

// ─── Privacy Policy and Terms say what the code does ─────────────────────────
console.log('Legal pages');
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/en.json'), 'utf8'));
const privacy = Object.values(en.privacy).join(' ');
const terms = Object.values(en.terms).join(' ');
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
for (const [name, text] of [['Privacy Policy', plain(privacy)], ['Terms', plain(terms)]]) {
  const sections = Object.keys(en[name === 'Terms' ? 'terms' : 'privacy']).filter((k) => /^s\d+_content$/.test(k)).length;
  const html = fs.readFileSync(path.join(ROOT, `public/${name === 'Terms' ? 'terms' : 'privacy'}.html`), 'utf8');
  check((html.match(/class="static-page__section"/g) || []).length === sections, `${name}: the page and en.json have the same number of sections (${sections})`);
  check(en[name === 'Terms' ? 'terms' : 'privacy'].date === (html.match(/data-i18n="[a-z]+\.date">([^<]+)</) || [])[1], `${name}: the date in the page matches en.json`);
}
check(/Last updated: \w+ \d+, 20\d\d/.test(en.privacy.date) && en.privacy.date === en.terms.date, 'both documents carry the same "Last updated" date');
for (const word of ['Google', 'Cloudflare Turnstile', 'Resend', 'AdSense', 'YouTube', 'calendar-api.marareih.org', 'Green mark', 'favorites', 'Android', 'delete your account']) check(plain(privacy).includes(word), `the Privacy Policy covers: ${word}`);
check(plain(privacy).includes(`within ${RETENTION_HOURS} hours`), `the retention period for sign-in records (${RETENTION_HOURS} hours) matches the code`);
for (const word of ['Accounts', 'Green Mark', 'Android App', 'Artist & Composer Profiles', 'Limitation of Liability']) check(Object.values(en.terms).some((v) => String(v).replace(/&amp;/g, '&').includes(word)), `the Terms cover: ${word}`);
check(fs.readFileSync(path.join(ROOT, 'public/account.html'), 'utf8').includes('href="/terms"') && en.account.legal_notice.includes('/privacy'), 'sign-in / sign-up shows the agreement notice with links to both documents');

// ─── Service worker: private answers are never cached ────────────────────────
console.log('Service worker');
const listeners = {};
const cached = [];
const sandbox = {
  self: { addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim() {} } },
  caches: { open: async () => ({ put: async (req) => { cached.push(typeof req === 'string' ? req : req.url); }, match: async () => undefined, addAll: async () => {} }), match: async () => undefined, keys: async () => [], delete: async () => true },
  fetch: async () => new Response('{"ok":true}', { status: 200 }),
  Response, URL, console,
};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8'), sandbox);
const intercepts = async (url, headers = {}) => {
  let answered = null;
  const request = { method: 'GET', url, headers: { has: (n) => n.toLowerCase() in Object.fromEntries(Object.keys(headers).map((k) => [k.toLowerCase(), 1])), get: (n) => headers[n] || null }, mode: 'cors' };
  listeners.fetch({ request, respondWith: (p) => { answered = p; } });
  if (answered) await answered;
  await new Promise((resolve) => setTimeout(resolve, 5));
  return !!answered;
};
const BASE = 'https://api.maralyrics.com/api/v1';
check(await intercepts(`${BASE}/songs?page=1`) === true, 'public lists are cached for offline use (as before)');
check(await intercepts(`${BASE}/categories`) === true, '…so are categories');
const before = cached.length;
for (const [url, headers] of [
  [`${BASE}/account/me`, { Authorization: 'Bearer t' }], [`${BASE}/account/export`, { Authorization: 'Bearer t' }], [`${BASE}/account/green`, {}],
  [`${BASE}/account`, {}], [`${BASE}/admin/songs`, {}], [`${BASE}/admin/auth/me`, { Authorization: 'Bearer t' }],
  [`${BASE}/songs?page=1`, { Authorization: 'Bearer t' }],
]) check(await intercepts(url, headers) === false, `not touched by the cache: ${url.replace(BASE, '')}${headers.Authorization ? ' (with a token)' : ''}`);
check(cached.length === before, 'nothing private was stored');
check(await intercepts(`${BASE}/songs/falling`) === false, 'a single song stays out of the cache (downloads only), as before');
check(/ml-v(\d+)/.test(fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8')) && Number(/ml-v(\d+)/.exec(fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8'))[1]) >= 44, 'the cache version was bumped, so copies stored by the old worker are deleted');

console.log(failures ? `\n✗ ${failures} failed, ${passes} passed` : `\n✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
