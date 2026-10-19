#!/usr/bin/env node
// Integration checks for "claim your profile" (artist / composer accounts).   npm run test:claims
//
// Runs the real Hono worker against an in-memory SQLite database built from schema.sql: account
// registration/login (+ lockout), the claim → review → own-profile flow, who may do what, the
// separation between artist sessions and admin sessions, and the audit trail. Exit code 1 on failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { default: app } = await load('worker/worker.js');
const { signJWT } = await load('worker/lib/auth.js');
const { validateOwnerEdit, validateSocialLinks, validateContact } = await load('worker/lib/profile.js');

let passes = 0;
let failures = 0;
const check = (cond, msg) => { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } };

const makeDb = (schemaTransform = (s) => s) => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(schemaTransform(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8')));
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
  return { sqlite, DB };
};

const { sqlite, DB } = makeDb();
const run = (sql, ...a) => sqlite.prepare(sql).run(...a);
const get = (sql, ...a) => sqlite.prepare(sql).get(...a);

const ROLES = ['viewer', 'translator', 'reviewer', 'editor', 'manager', 'super_admin'];
ROLES.forEach((role, i) => run(`INSERT INTO admin_users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`, i + 1, role, role));
const SECRET = 'test-secret';
const adminToken = {};
for (const [i, role] of ROLES.entries()) adminToken[role] = await signJWT({ sub: i + 1, username: role }, SECRET);

run(`INSERT INTO artists (id, name, slug, bio) VALUES (1, 'Ann Artist', 'ann-artist', 'Original bio'), (2, 'Ben Singer', 'ben-singer', NULL)`);
run(`INSERT INTO composers (id, name, slug) VALUES (1, 'Cy Composer', 'cy-composer')`);

const ENV = { DB, JWT_SECRET: SECRET };
const call = async (method, url, { token, body, env = ENV } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await app.fetch(new Request(`https://api.test${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const acct = (method, url, token, body, env) => call(method, `/api/v1/account${url}`, { token, body, env });
const adm = (method, url, role, body) => call(method, `/api/v1/admin${url}`, { token: adminToken[role], body });

const register = async (username, extra = {}) => {
  const r = await acct('POST', '/register', undefined, { username, password: 'correct horse', contact_email: `${username}@example.com`, contact_phone: '+91 98765 43210', ...extra });
  return { ...r, token: r.json && r.json.token };
};

// ─── Validation (pure) ───────────────────────────────────────────────────────
console.log('Validation');
check(validateOwnerEdit({ bio: ' Hello ', social_links: ['https://a.example', 'mailto:me@x.com'] }).values.bio === '<p>Hello</p>', 'bio trimmed and stored as paragraphs');
check(!validateOwnerEdit({ bio: 'x'.repeat(5001) }).ok, 'bio too long rejected');
check(!validateOwnerEdit({ image_url: 'javascript:alert(1)' }).ok && !validateOwnerEdit({ image_url: 'data:text/html;base64,AAAA' }).ok, 'unsafe photo rejected');
check(validateOwnerEdit({ image_url: 'data:image/jpeg;base64,AAAA' }).ok && validateOwnerEdit({ image_url: 'https://img.example.com/a.jpg' }).ok, 'data:image and https photo accepted');
check(!validateOwnerEdit({ image_url: `data:image/jpeg;base64,${'A'.repeat(400000)}` }).ok, 'oversized photo rejected');
check(!validateOwnerEdit({ social_links: ['javascript:alert(1)'] }).ok && !validateOwnerEdit({ social_links: 'not json' }).ok, 'unsafe / malformed social links rejected');
check(!validateOwnerEdit({ social_links: Array.from({ length: 11 }, (_, i) => `https://e.com/${i}`) }).ok, 'max 10 social links');
check(validateSocialLinks('["https://a.example"]').value === '["https://a.example"]' && validateSocialLinks(['  ', 'https://b.example']).value === '["https://b.example"]', 'social links: JSON string or array, blanks dropped');
check(validateOwnerEdit({}).values.bio === null && validateOwnerEdit({}).values.social_links === null, 'empty edit clears fields (PUT replaces)');

console.log('Contact details');
check(validateContact({ contact_email: ' a@b.co ', contact_phone: '+91 98765-43210' }).phone === '+919876543210' && validateContact({ contact_email: 'a@b.co', contact_phone: '0091 (98765) 43210' }).phone === '+919876543210', 'phone is stored as + and digits (spaces, dashes, brackets removed, 00 → +)');
for (const [label, c] of [['no email', { contact_phone: '+919876543210' }], ['bad email', { contact_email: 'nope', contact_phone: '+919876543210' }], ['no phone', { contact_email: 'a@b.co' }], ['short phone', { contact_email: 'a@b.co', contact_phone: '12345' }], ['letters in phone', { contact_email: 'a@b.co', contact_phone: '+91 98x65 43210' }], ['too long phone', { contact_email: 'a@b.co', contact_phone: '+1234567890123456' }]]) check(!validateContact(c).ok, `contact: ${label} rejected`);

// ─── Accounts ────────────────────────────────────────────────────────────────
console.log('Accounts');
for (const [label, body] of [
  ['username too short', { username: 'ab', password: 'correct horse' }], ['username with spaces', { username: 'has space', password: 'correct horse' }],
  ['username starts with dot', { username: '.abc', password: 'correct horse' }], ['password too short', { username: 'okname', password: 'short' }],
  ['bad email', { username: 'okname', password: 'correct horse', contact_email: 'nope', contact_phone: '+919876543210' }],
  ['no email', { username: 'okname', password: 'correct horse', contact_phone: '+919876543210' }], ['no phone', { username: 'okname', password: 'correct horse', contact_email: 'a@b.co' }],
  ['bad phone', { username: 'okname', password: 'correct horse', contact_email: 'a@b.co', contact_phone: '12' }],
]) check((await acct('POST', '/register', undefined, body)).status === 400, `register: ${label} → 400`);

const ann = await register('Ann_Singer', { contact_email: 'ann@example.com', contact_phone: '+91 98765 43210' });
check(ann.status === 201 && ann.token && ann.json.account.username === 'ann_singer' && !('password_hash' in ann.json.account), 'register creates the account (username lower-cased, no hash returned)');
check((await register('ann_SINGER')).status === 409, 'username is unique, case-insensitively → 409');
const bob = await register('bob.writer');
const eve = await register('eve');

const goodLogin = await acct('POST', '/login', undefined, { username: 'ANN_singer', password: 'correct horse' });
check(goodLogin.status === 200 && goodLogin.json.token, 'login works (username case-insensitive)');
check((await acct('POST', '/login', undefined, { username: 'ann_singer', password: 'wrong' })).status === 401 && (await acct('POST', '/login', undefined, { username: 'nobody', password: 'x' })).status === 401, 'wrong password / unknown user → the same 401');
for (let i = 0; i < 5; i++) await acct('POST', '/login', undefined, { username: 'eve', password: 'bad' });
check((await acct('POST', '/login', undefined, { username: 'eve', password: 'correct horse' })).status === 429, 'five failed logins lock the account (even a correct password) → 429');
check(get(`SELECT COUNT(*) AS n FROM login_attempts WHERE username = 'eve'`).n === 0 && get(`SELECT COUNT(*) AS n FROM login_attempts WHERE username = 'person:eve'`).n === 5, 'lockout uses its own key (person:…), not the admin one');
run(`DELETE FROM login_attempts`);

console.log('Sessions are separate');
check((await acct('GET', '/me')).status === 401 && (await acct('GET', '/me', 'garbage')).status === 401, 'no / bad token → 401');
check((await acct('GET', '/me', adminToken.super_admin)).status === 401, 'an ADMIN token does not work on the artist API');
check((await call('GET', '/api/v1/admin/claims', { token: ann.token })).status === 401 && (await call('GET', '/api/v1/admin/artists', { token: ann.token })).status === 401, 'an ARTIST token does not work on the admin API (even though the account id matches an admin id)');
check(get('SELECT id FROM person_accounts WHERE username = ?', 'ann_singer').id === 1, '(setup: artist account #1 shares its id with admin user #1)');
const me = await acct('GET', '/me', ann.token);
check(me.status === 200 && me.json.account.username === 'ann_singer' && me.json.claims.length === 0, 'GET /me');
check((await acct('POST', '/change-password', ann.token, { current_password: 'nope', new_password: 'new password 1' })).status === 401 && (await acct('POST', '/change-password', ann.token, { current_password: 'correct horse', new_password: 'short' })).status === 400, 'change password: wrong current / too short rejected');
const pw = await acct('POST', '/change-password', ann.token, { current_password: 'correct horse', new_password: 'new password 1' });
check(pw.status === 200 && (await acct('POST', '/login', undefined, { username: 'ann_singer', password: 'new password 1' })).status === 200, 'change password works');
check((await acct('GET', '/me', ann.token)).status === 401 && pw.json.token && (await acct('GET', '/me', pw.json.token)).status === 200, 'changing the password ends the old session; the response carries a fresh one');
ann.token = pw.json.token;

// ─── Claiming ────────────────────────────────────────────────────────────────
console.log('Claiming');
const claim = (token, body) => acct('POST', '/claims', token, body);
check((await claim(undefined, { type: 'artist', slug: 'ann-artist', evidence: 'my official page https://x' })).status === 401, 'claiming needs a login');
check((await claim(ann.token, { type: 'label', slug: 'ann-artist', evidence: 'long enough evidence' })).status === 400, 'bad type → 400');
check((await claim(ann.token, { type: 'artist', slug: 'ann-artist', evidence: 'short' })).status === 400, 'evidence required (min length)');
check((await claim(ann.token, { type: 'artist', slug: 'ann-artist', evidence: 'x'.repeat(1001) })).status === 400, 'evidence max length');
check((await claim(ann.token, { type: 'artist', slug: 'nobody', evidence: 'long enough evidence' })).status === 404, 'unknown profile → 404');
check((await claim(ann.token, { type: 'composer', slug: 'ann-artist', evidence: 'long enough evidence' })).status === 404, 'type and slug must match (artist slug is not a composer)');
const c1 = await claim(ann.token, { type: 'artist', slug: 'ann-artist', evidence: 'This is my channel https://youtube.com/@ann', contact_email: 'ann@new.example' });
check(c1.status === 201 && c1.json.status === 'pending' && c1.json.name === 'Ann Artist', 'create a pending claim');
check(get('SELECT contact_email, contact_phone FROM person_accounts WHERE id = 1').contact_email === 'ann@example.com' && get('SELECT contact_phone FROM person_accounts WHERE id = 1').contact_phone === '+919876543210', "the claim form cannot swap the account's email (that is done in the Account tab and confirmed again); the phone is kept");
check(ann.json.account.contact_phone === '+919876543210' && ann.json.account.contact_complete === true && (await acct('GET', '/me', ann.token)).json.account.contact_complete === true, 'registration stores the phone; /me says the contact details are complete');
{
  // An account from before phone numbers existed has no phone: it cannot claim until it adds one.
  run(`INSERT INTO person_accounts (id, username, password_hash, contact_email) VALUES (60, 'oldtimer', 'x', 'old@example.com')`);
  const { signJWT: s } = await load('worker/lib/auth.js');
  const oldTok = await s({ sub: 60, username: 'oldtimer', typ: 'person' }, `${SECRET}:person-account`);
  check((await acct('GET', '/me', oldTok)).json.account.contact_complete === false, 'an account without a phone is incomplete');
  const noPhone = await claim(oldTok, { type: 'artist', slug: 'ben-singer', evidence: 'long enough evidence here' });
  check(noPhone.status === 400 && /phone/i.test(noPhone.json.error), 'claiming needs a phone number on file (or in the form) → 400');
  check((await acct('PUT', '/contact', oldTok, { contact_email: 'old@example.com', contact_phone: 'abc' })).status === 400 && (await acct('PUT', '/contact', undefined, { contact_email: 'a@b.co', contact_phone: '+919876543210' })).status === 401, 'updating contact details validates and needs a login');
  const upd = await acct('PUT', '/contact', oldTok, { contact_email: 'old@example.com', contact_phone: '+44 7700 900123' });
  check(upd.status === 200 && upd.json.account.contact_phone === '+447700900123' && upd.json.account.contact_complete === true, 'contact details can be updated');
  const viaForm = await claim(oldTok, { type: 'artist', slug: 'ben-singer', evidence: 'long enough evidence here' });
  check(viaForm.status === 201, 'after adding the phone the claim goes through');
  await acct('DELETE', `/claims/${viaForm.json.id}`, oldTok);
  const withForm = await claim(ann.token, { type: 'artist', slug: 'ben-singer', evidence: 'long enough evidence here', contact_phone: '+1 202 555 0143', contact_email: 'ann@new.example' });
  check(withForm.status === 201 && get('SELECT contact_phone FROM person_accounts WHERE id = 1').contact_phone === '+12025550143', 'phone and email given with the claim are saved on the account');
  check((await claim(ann.token, { type: 'artist', slug: 'a1', evidence: 'long enough evidence here', contact_phone: '12' })).status === 400, 'a bad phone in the claim form → 400');
  await acct('DELETE', `/claims/${withForm.json.id}`, ann.token);
  run(`UPDATE person_accounts SET contact_phone = '+919876543210' WHERE id = 1`);
}
check((await claim(ann.token, { type: 'artist', slug: 'ann-artist', evidence: 'long enough evidence' })).status === 409, 'the same account cannot claim the same profile twice');
const c2 = await claim(bob.token, { type: 'artist', slug: 'ann-artist', evidence: 'I am also Ann, honest' });
check(c2.status === 201, 'a second account can also have a pending claim (admins decide)');
const cc = await claim(ann.token, { type: 'composer', slug: 'cy-composer', evidence: 'I compose under that name' });
check(cc.status === 201, 'composer claims work');
check((await acct('GET', '/me', ann.token)).json.claims.map((c) => `${c.type}:${c.slug}:${c.status}`).join() === 'composer:cy-composer:pending,artist:ann-artist:pending', 'GET /me lists my claims (newest first), nothing about other accounts');
check((await acct('GET', `/claims/${c1.json.id}/profile`, ann.token)).status === 404 && (await acct('PUT', `/claims/${c1.json.id}/profile`, ann.token, { bio: 'hijack' })).status === 404, 'a PENDING claim cannot read or edit the profile');
check(get('SELECT bio FROM artists WHERE id = 1').bio === 'Original bio', '…and the profile is untouched');

console.log('Withdraw');
check((await acct('DELETE', `/claims/${c2.json.id}`, ann.token)).status === 404, "cannot withdraw someone else's claim");
check((await acct('DELETE', `/claims/${c2.json.id}`, bob.token)).status === 200 && (await acct('DELETE', `/claims/${c2.json.id}`, bob.token)).status === 404, 'withdraw own pending claim (twice → 404)');
const c2b = await claim(bob.token, { type: 'artist', slug: 'ann-artist', evidence: 'I am also Ann, honest' });
check(c2b.status === 201, 're-claiming after withdrawing is fine');

// ─── Admin review ────────────────────────────────────────────────────────────
console.log('Review (admin)');
for (const role of ['viewer', 'translator', 'reviewer', 'editor']) {
  check((await adm('GET', '/claims', role)).status === 403 && (await adm('PUT', `/claims/${c1.json.id}/approve`, role)).status === 403, `${role} cannot see or review claims`);
}
check((await call('GET', '/api/v1/admin/claims')).status === 401, 'anonymous → 401');
const list = await adm('GET', '/claims', 'manager');
check(list.status === 200 && list.json.total === 3 && list.json.claims[0].status === 'pending' && list.json.claims[0].claimant && list.json.claims.some((c) => c.claimant_email === 'ann@example.com' && c.claimant_phone === '+919876543210'), 'manager sees claims with claimant, evidence, contact email and phone');
check((await adm('GET', '/claims?status=approved', 'manager')).json.total === 0, 'status filter');
check((await adm('PUT', `/claims/${c1.json.id}/reject`, 'manager', {})).status === 400, 'reject needs a note');
check((await adm('PUT', '/claims/999/approve', 'manager')).status === 404, 'unknown claim → 404');
const rej = await adm('PUT', `/claims/${cc.json.id}/reject`, 'manager', { note: 'Please send a link to your official page.' });
check(rej.status === 200 && rej.json.status === 'rejected', 'manager rejects with a note');
check((await acct('GET', '/me', ann.token)).json.claims.find((c) => c.slug === 'cy-composer').review_note === 'Please send a link to your official page.', 'the claimant sees the note');
check((await adm('PUT', `/claims/${cc.json.id}/approve`, 'manager')).status === 409, 'a rejected claim cannot be approved afterwards (they must claim again)');
const ok = await adm('PUT', `/claims/${c1.json.id}/approve`, 'super_admin');
check(ok.status === 200 && ok.json.status === 'approved', 'super admin approves');
check(get('SELECT status FROM person_claims WHERE id = ?', c2b.json.id).status === 'rejected', 'approving closes the other pending claims on the same profile');
check((await adm('PUT', `/claims/${c1.json.id}/approve`, 'manager')).status === 409, 'approving twice → 409');
check((await claim(bob.token, { type: 'artist', slug: 'ann-artist', evidence: 'I really am Ann this time' })).status === 409, 'an owned profile cannot be claimed again → 409');
check(get(`SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('claim.approve','claim.reject')`).n === 2, 'reviews are in the audit log');
try { run(`INSERT INTO person_claims (account_id, artist_id, status, evidence) VALUES (3, 1, 'approved', 'dup')`); check(false, 'DB must refuse a second owner'); } catch { check(true, 'DB itself refuses a second owner of a profile'); }

// ─── Editing your profile ────────────────────────────────────────────────────
console.log('Owner edits');
const prof = await acct('GET', `/claims/${c1.json.id}/profile`, ann.token);
check(prof.status === 200 && prof.json.name === 'Ann Artist' && prof.json.bio === 'Original bio' && prof.json.bio_html === '<p>Original bio</p>' && Array.isArray(prof.json.social_links), 'owner reads the editable profile');
check((await acct('GET', `/claims/${c1.json.id}/profile`, bob.token)).status === 404 && (await acct('PUT', `/claims/${c1.json.id}/profile`, bob.token, { bio: 'hijack' })).status === 404, "someone else's account cannot read or edit it");
check((await acct('PUT', `/claims/${c1.json.id}/profile`, undefined, { bio: 'x' })).status === 401, 'editing needs a login');
const before = get('SELECT name, slug, updated_at FROM artists WHERE id = 1');
const edit = await acct('PUT', `/claims/${c1.json.id}/profile`, ann.token, {
  bio: '  New bio from Ann  ', image_url: 'data:image/jpeg;base64,/9j/AAAA', social_links: ['https://youtube.com/@ann', 'mailto:ann@example.com'],
  name: 'Hacked Name', slug: 'hacked-slug' });
check(edit.status === 200 && edit.json.bio === '<p>New bio from Ann</p>' && edit.json.social_links.length === 2, 'owner edits bio, photo and social links');
const after = get('SELECT name, slug, bio, image_url, social_links, updated_at FROM artists WHERE id = 1');
check(after.name === 'Ann Artist' && after.slug === 'ann-artist', 'name and slug can NOT be changed by an owner (extra fields ignored)');
check(after.bio === '<p>New bio from Ann</p>' && after.image_url === 'data:image/jpeg;base64,/9j/AAAA' && JSON.parse(after.social_links)[1] === 'mailto:ann@example.com', 'changes are stored');
check((await call('GET', '/api/v1/artists/ann-artist')).json.bio === 'New bio from Ann', 'the public profile shows the new bio immediately');
for (const [label, body] of [['javascript: link', { social_links: ['javascript:alert(1)'] }], ['unsafe photo', { image_url: 'javascript:alert(1)' }], ['long bio', { bio: 'x'.repeat(5001) }]]) {
  check((await acct('PUT', `/claims/${c1.json.id}/profile`, ann.token, body)).status === 400, `owner edit: ${label} → 400`);
}
check(get('SELECT bio FROM artists WHERE id = 1').bio === '<p>New bio from Ann</p>', '…and rejected edits change nothing');
const log = get(`SELECT admin_id, admin_username, action, target_type, target_id, detail FROM audit_log WHERE action = 'profile.owner_edit'`);
check(log && log.admin_id === null && log.admin_username === 'artist:ann_singer' && log.target_type === 'artist' && log.target_id === 1 && /bio/.test(log.detail) && /photo/.test(log.detail) && /social links/.test(log.detail), 'the edit is in the audit log as artist:<username> with what changed');
check(!/data:image/.test(log.detail), 'the audit log names the photo, it does not copy it');
check((await adm('GET', '/audit-log', 'manager')).json.audit_log.some((e) => e.action === 'profile.owner_edit'), 'admins see it in the Audit Log');
check((await acct('PUT', `/claims/${c1.json.id}/profile`, ann.token, { bio: 'New bio from Ann', image_url: 'data:image/jpeg;base64,/9j/AAAA', social_links: ['https://youtube.com/@ann', 'mailto:ann@example.com'] })).status === 200 && get(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile.owner_edit'`).n === 1, 'saving without changes writes no audit entry');

console.log('Public API');
const pub = await call('GET', '/api/v1/artists/ann-artist');
check(pub.json.claimed === true && !JSON.stringify(pub.json).includes('ann_singer') && !JSON.stringify(pub.json).includes('ann@new.example'), 'public profile says claimed, never who or contact details');
check((await call('GET', '/api/v1/artists/ben-singer')).json.claimed === false && (await call('GET', '/api/v1/composers/cy-composer')).json.claimed === false, 'unclaimed profiles say claimed: false');

console.log('Revoke');
check((await adm('PUT', `/claims/${c1.json.id}/revoke`, 'manager', {})).status === 400, 'revoke needs a note');
check((await adm('PUT', `/claims/${c1.json.id}/revoke`, 'manager', { note: 'Disputed by the artist.' })).status === 200, 'manager revokes ownership');
check((await acct('PUT', `/claims/${c1.json.id}/profile`, ann.token, { bio: 'still me' })).status === 404 && get('SELECT bio FROM artists WHERE id = 1').bio === '<p>New bio from Ann</p>', 'after revoking, the old owner can no longer edit (checked on every request)');
check((await call('GET', '/api/v1/artists/ann-artist')).json.claimed === false, 'the profile is claimable again');
check((await claim(bob.token, { type: 'artist', slug: 'ann-artist', evidence: 'Verified by phone call' })).status === 201, 'someone else can now claim it');
check((await adm('PUT', `/claims/${c1.json.id}/revoke`, 'manager', { note: 'again' })).status === 409, 'a revoked claim cannot be revoked again');

console.log('Limits');
const dan = await register('dan_the_man');
run(`INSERT INTO artists (id, name, slug) VALUES (10,'A1','a1'),(11,'A2','a2'),(12,'A3','a3'),(13,'A4','a4'),(14,'A5','a5'),(15,'A6','a6')`);
let last;
for (const s of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']) last = await claim(dan.token, { type: 'artist', slug: s, evidence: 'long enough evidence here' });
check(last.status === 429, 'at most 5 open claims per account → 429');
const strict = await acct('POST', '/register', undefined, { username: 'turnstile_user', password: 'correct horse', contact_email: 'ts@example.com', contact_phone: '+919876543210' }, { ...ENV, TURNSTILE_SECRET_KEY: 'x' });
check(strict.status === 400 && /Security check/.test(strict.json.error), 'with Turnstile configured, registering without a token is refused');

// ─── The refactored admin profile validators still behave ─────────────────────
console.log('Admin profile editing (unchanged)');
const put = (body) => adm('PUT', '/artists/2', 'manager', { name: 'Ben Singer', ...body });
check((await put({ bio: 'Admin bio', social_links: JSON.stringify(['https://b.example']) })).status === 200, 'admin can still edit a profile (social_links as a JSON string)');
check((await put({ social_links: JSON.stringify(['javascript:alert(1)']) })).status === 400 && (await put({ image_url: 'javascript:x' })).status === 400, 'admin: unsafe link / image still rejected');
check((await adm('PUT', '/artists/2', 'editor', { name: 'x' })).status === 403, 'admin: editors still cannot edit profiles');

// ─── Deploy order: new code before migration 0015 ─────────────────────────────
console.log('Before migration 0015');
{
  const old = makeDb((s) => s.replace(/-- ─── Claim your profile[\s\S]*?(?=-- ── Performance indexes)/, ''));
  old.sqlite.exec(`INSERT INTO artists (id, name, slug) VALUES (1, 'Old Artist', 'old-artist')`);
  const pre = await call('GET', '/api/v1/artists/old-artist', { env: { DB: old.DB, JWT_SECRET: SECRET } });
  check(old.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'person_claims'").get() === undefined, '(setup: this database has no person_claims table)');
  check(pre.status === 200 && pre.json.claimed === false, 'public profiles still load (claimed: false) until the migration is run');
}

console.log(`\n${failures ? '✗' : '✓'} ${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
