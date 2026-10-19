#!/usr/bin/env node
// Checks for artist-account sign-in: email + password, Google, email confirmation and password reset (Resend).   npm run test:auth
//
// Runs the real Hono worker against an in-memory SQLite database. Resend and Google are stubbed at fetch(): the
// "Google" side is a real RSA key pair, so the signature / audience / expiry checks run for real.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { default: app } = await load('worker/worker.js');
const { signJWT } = await load('worker/lib/auth.js');
const { resetGoogleKeyCache } = await load('worker/lib/google.js');
const { verifyEmailMessage, resetPasswordMessage } = await load('worker/lib/mailTemplates.js');
const { sendMail } = await load('worker/lib/mail.js');

let passes = 0;
let failures = 0;
const check = (cond, msg) => { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } };

// ─── Stubs: Resend + Google ──────────────────────────────────────────────────
const KEY_ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
const googleKeys = await crypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify']);
const otherKeys = await crypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify']);
const jwkOf = async (pair, kid) => ({ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256', use: 'sig' });
let servedKeys = [await jwkOf(googleKeys, 'key-1')];
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
async function idToken(claims = {}, { pair = googleKeys, kid = 'key-1', alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(Buffer.from(JSON.stringify({ alg, typ: 'JWT', kid })));
  const body = b64u(Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'g-1', email: 'gina@gmail.com', email_verified: true, name: 'Gina', iat: now, exp: now + 3600, ...claims })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(`${header}.${body}`));
  return `${header}.${body}.${b64u(sig)}`;
}

const sent = [];           // every email "sent" through Resend
let resendStatus = 200;    // set to 500 to make Resend fail
let jwksFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://api.resend.com/emails') {
    if (resendStatus !== 200) return new Response(JSON.stringify({ message: 'nope' }), { status: resendStatus });
    sent.push({ auth: init.headers.Authorization, ...JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
  }
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') { jwksFetches++; return new Response(JSON.stringify({ keys: servedKeys }), { status: 200 }); }
  return realFetch(input, init);
};
const lastLink = (re) => { const m = re.exec(sent[sent.length - 1].html); return m && decodeURIComponent(m[1]); };
const tokenFromMail = (param) => { const m = new RegExp(`my-profile\\?${param}=([^"&\\s<]+)`).exec(sent[sent.length - 1].text); return m && decodeURIComponent(m[1]); };

// ─── Harness ─────────────────────────────────────────────────────────────────
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
const get = (sql, ...a) => sqlite.prepare(sql).get(...a);
const SECRET = 'test-secret';
const FULL = { DB, JWT_SECRET: SECRET, RESEND_API_KEY: 're_test_key', MAIL_FROM: 'MaraLyrics <noreply@maralyrics.com>', GOOGLE_CLIENT_ID: CLIENT_ID };
const NO_MAIL = { DB, JWT_SECRET: SECRET, GOOGLE_CLIENT_ID: CLIENT_ID };
const NOTHING = { DB, JWT_SECRET: SECRET };
run(`INSERT INTO admin_users (id, username, password_hash, role) VALUES (1, 'boss', 'x', 'super_admin'), (2, 'mgr', 'x', 'manager')`);
run(`INSERT INTO artists (id, name, slug) VALUES (1, 'Ann Artist', 'ann-artist'), (2, 'Ben Singer', 'ben-singer')`);
const mgr = await signJWT({ sub: 2, username: 'mgr' }, SECRET);

const call = async (method, url, { token, body, env = FULL } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await app.fetch(new Request(`https://api.test${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const acct = (method, url, token, body, env) => call(method, `/api/v1/account${url}`, { token, body, env });
const PHONE = '+91 98765 43210';
const register = (email, extra = {}, env) => acct('POST', '/register', undefined, { email, password: 'correct horse', contact_phone: PHONE, ...extra }, env);
const google = (claims, opts, env) => idToken(claims, opts).then((credential) => acct('POST', '/google', undefined, { credential }, env));
const claimBody = { type: 'artist', slug: 'ann-artist', evidence: 'My official page https://youtube.com/@ann' };

// ─── Config ──────────────────────────────────────────────────────────────────
console.log('Config');
check(JSON.stringify((await acct('GET', '/config')).json) === JSON.stringify({ google_client_id: CLIENT_ID, email_enabled: true }), '/config tells the page about Google and email');
check(JSON.stringify((await acct('GET', '/config', undefined, undefined, NOTHING)).json) === JSON.stringify({ google_client_id: null, email_enabled: false }), '…and switches both off when they are not configured');

// ─── Register with email + password ──────────────────────────────────────────
console.log('Email + password sign-up');
const ann = await register('Ann.Singer@Example.com');
check(ann.status === 201 && ann.json.account.username === 'ann.singer' && ann.json.account.contact_email === 'ann.singer@example.com', 'no username needed: one is made from the email, which is stored lower-case');
check(ann.json.account.email_verified === false && ann.json.account.has_password === true && ann.json.account.google === false && ann.json.verification === 'sent', 'a new account starts unverified; a confirmation email went out');
check(sent.length === 1 && sent[0].to[0] === 'ann.singer@example.com' && sent[0].auth === 'Bearer re_test_key' && sent[0].from === 'MaraLyrics <noreply@maralyrics.com>' && /Confirm your email/.test(sent[0].subject), 'Resend call: right recipient, API key, sender, subject');
const verifyToken = tokenFromMail('verify');
check(verifyToken && verifyToken.length >= 40 && /^https:\/\/maralyrics\.com\/my-profile\?verify=/.test(lastLink(/href="([^"]+)" style="display:inline-block/)), 'the email carries a long random link to the site');
check(!JSON.stringify(sqlite.prepare('SELECT * FROM person_email_tokens').all()).includes(verifyToken), 'the database stores only a hash of the token, never the token');
check((await register('x', {})).status === 400 && (await register('not-an-email')).status === 400 && (await acct('POST', '/register', undefined, { email: 'a@b.co', password: 'correct horse' })).status === 400 && (await register('c@d.co', { password: 'short' })).status === 400, 'bad email / no phone / short password → 400');
check((await register('with.name@example.com', { username: 'Chosen_Name' })).json.account.username === 'chosen_name' && (await register('other@example.com', { username: 'chosen_name' })).status === 409 && (await register('bad@example.com', { username: 'a' })).status === 400, 'an explicit username still works (and is checked)');
check((await register('ann.singer@example.com', { username: 'second.try' })).status === 201, 'an address nobody has confirmed does not block anyone (it proves nothing)');
const base = sent.length;
check((await register('mail.down@example.com', {}, NO_MAIL)).json.verification === 'off' && sent.length === base, 'email not configured → no mail, verification "off", sign-up still works');
resendStatus = 500;
const failed = await register('resend.down@example.com');
resendStatus = 200;
check(failed.status === 201 && failed.json.verification === 'failed', 'Resend down → the account is still created');

// ─── Verification ────────────────────────────────────────────────────────────
console.log('Email confirmation');
const unverifiedClaim = await acct('POST', '/claims', ann.json.token, claimBody);
check(unverifiedClaim.status === 403 && unverifiedClaim.json.code === 'email_unverified', 'before confirming, claiming is refused (code email_unverified)');
check((await acct('POST', '/claims', failed.json.token, claimBody, NO_MAIL)).status !== 403, '…but only while email is configured (never lock people out of a half-set-up site)');
check((await acct('POST', '/verify-email', undefined, { token: 'nope' })).status === 400 && (await acct('POST', '/verify-email', undefined, {})).status === 400 && (await acct('POST', '/verify-email', undefined, { token: 'x'.repeat(50) })).status === 400, 'garbage tokens → 400');
const verified = await acct('POST', '/verify-email', undefined, { token: verifyToken });
check(verified.status === 200 && get(`SELECT email_verified_at FROM person_accounts WHERE username = 'ann.singer'`).email_verified_at, 'the link confirms the address');
check((await acct('POST', '/verify-email', undefined, { token: verifyToken })).status === 400, 'a link works once');
check((await acct('GET', '/me', ann.json.token)).json.account.email_verified === true, '/me shows it confirmed');
check((await register('ANN.singer@example.com')).status === 409, 'a confirmed address can only belong to one account (case-insensitive)');
const okClaim = await acct('POST', '/claims', ann.json.token, claimBody);
check(okClaim.status === 201, 'once confirmed, claiming works');

run(`INSERT INTO person_accounts (username, password_hash, contact_email, contact_phone) VALUES ('late', 'x', 'late@example.com', '+919876543210')`);
const lateId = get(`SELECT id FROM person_accounts WHERE username = 'late'`).id;
const insertToken = async (kind, email, { raw = `tok-${kind}-${Math.random()}-xxxxxxxxxxxxxxxxxxxx`, expires = '+1 hour' } = {}) => {
  const { sha256Hex } = await load('worker/lib/emailTokens.js');
  run(`INSERT INTO person_email_tokens (account_id, kind, email, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))`, lateId, kind, email, await sha256Hex(raw), expires);
  return raw;
};
check((await acct('POST', '/verify-email', undefined, { token: await insertToken('verify', 'late@example.com', { expires: '-1 minute' }) })).status === 400, 'an expired link → 400');
check((await acct('POST', '/verify-email', undefined, { token: await insertToken('verify', 'someone.else@example.com') })).status === 400, 'a link for an address that is no longer on the account → 400');
check((await acct('POST', '/verify-email', undefined, { token: await insertToken('reset', 'late@example.com') })).status === 400, 'a password-reset link cannot confirm an address');
run(`UPDATE person_accounts SET contact_email = 'ann.singer@example.com' WHERE id = ?`, lateId);
check((await acct('POST', '/verify-email', undefined, { token: await insertToken('verify', 'ann.singer@example.com') })).status === 409, 'confirming an address another account already confirmed → 409 (the unique index)');
run(`UPDATE person_accounts SET contact_email = 'late@example.com' WHERE id = ?`, lateId);

console.log('Changing the email');
const annTok = ann.json.token;
const before = sent.length;
const change = await acct('PUT', '/contact', annTok, { contact_email: 'Ann.New@Example.com', contact_phone: PHONE });
check(change.status === 200 && change.json.account.email_verified === false && change.json.account.contact_email === 'ann.new@example.com' && change.json.verification === 'sent' && sent.length === before + 1 && sent[sent.length - 1].to[0] === 'ann.new@example.com', 'a new address is unconfirmed again and gets its own email');
const samePhone = await acct('PUT', '/contact', annTok, { contact_email: 'ann.new@example.com', contact_phone: '+61 400 000 000' });
check(samePhone.status === 200 && samePhone.json.account.email_verified === false && sent.length === before + 1, 'changing only the phone sends nothing');
check((await acct('PUT', '/contact', annTok, { contact_email: 'late@example.com', contact_phone: PHONE })).status === 200, '(an unconfirmed address of someone else does not block)');
run(`UPDATE person_accounts SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ?`, lateId);
check((await acct('PUT', '/contact', failed.json.token, { contact_email: 'late@example.com', contact_phone: PHONE })).status === 409, 'taking an address another account has confirmed → 409');
run(`UPDATE person_accounts SET email_verified_at = NULL WHERE id = ?`, lateId);
await acct('PUT', '/contact', annTok, { contact_email: 'ann.new@example.com', contact_phone: PHONE });

console.log('Resending the confirmation');
run(`DELETE FROM person_email_tokens`);
const r1 = await acct('POST', '/verify-email/send', annTok);
const r2 = await acct('POST', '/verify-email/send', annTok);
const r3 = await acct('POST', '/verify-email/send', annTok);
const r4 = await acct('POST', '/verify-email/send', annTok);
check(r1.status === 200 && r2.status === 200 && r3.status === 200 && r4.status === 429, 'three emails an hour, then 429');
check((await acct('POST', '/verify-email/send', annTok, undefined, NO_MAIL)).status === 503 && (await acct('POST', '/verify-email/send')).status === 401, 'needs a sign-in; 503 when email is off');
const latest = tokenFromMail('verify');
const older = sent[sent.length - 2] && /verify=([^"&\s<]+)/.exec(sent[sent.length - 2].text)[1];
check((await acct('POST', '/verify-email', undefined, { token: decodeURIComponent(older) })).status === 400, 'asking again retires the older link');
check((await acct('POST', '/verify-email', undefined, { token: latest })).status === 200, '…and the newest one works');
check((await acct('POST', '/verify-email/send', annTok)).json.already === true, 'nothing to send once confirmed');

// ─── Login ───────────────────────────────────────────────────────────────────
console.log('Signing in');
const byEmail = await acct('POST', '/login', undefined, { email: 'ANN.NEW@example.com', password: 'correct horse' });
const byUsername = await acct('POST', '/login', undefined, { username: 'ann.singer', password: 'correct horse' });
const byIdentifier = await acct('POST', '/login', undefined, { identifier: 'ann.new@example.com', password: 'correct horse' });
check(byEmail.status === 200 && byUsername.status === 200 && byIdentifier.status === 200 && byEmail.json.account.id === byUsername.json.account.id, 'sign in with the email (any case) or the username');
check((await acct('POST', '/login', undefined, { email: 'ann.new@example.com', password: 'wrong' })).status === 401 && (await acct('POST', '/login', undefined, { email: 'nobody@example.com', password: 'wrong' })).status === 401, 'wrong password / unknown email → the same 401');
const msgA = (await acct('POST', '/login', undefined, { email: 'ann.new@example.com', password: 'wrong' })).json.error;
const msgB = (await acct('POST', '/login', undefined, { email: 'nobody@example.com', password: 'wrong' })).json.error;
check(msgA === msgB, 'and the same message, so it does not reveal who is registered');
run(`DELETE FROM login_attempts`);
for (let i = 0; i < 5; i++) await acct('POST', '/login', undefined, { email: 'lock.me@example.com', password: 'bad' });
check((await acct('POST', '/login', undefined, { email: 'lock.me@example.com', password: 'bad' })).status === 429, 'five failures lock that email for a while');
run(`DELETE FROM login_attempts`);
// two accounts share an unconfirmed address: whichever password matches gets in
const dupA = await register('shared@example.com', { password: 'password for A' });
const dupB = await register('shared@example.com', { password: 'password for B', username: 'dup.b' });
const inA = await acct('POST', '/login', undefined, { email: 'shared@example.com', password: 'password for A' });
const inB = await acct('POST', '/login', undefined, { email: 'shared@example.com', password: 'password for B' });
check(inA.status === 200 && inB.status === 200 && inA.json.account.id !== inB.json.account.id, 'two accounts on one unconfirmed address: each password opens its own account');

// ─── Forgot / reset password ─────────────────────────────────────────────────
console.log('Forgot password');
run(`DELETE FROM person_email_tokens`);
const s0 = sent.length;
const unknown = await acct('POST', '/forgot-password', undefined, { email: 'ghost@example.com' });
check(unknown.status === 200 && unknown.json.ok === true && sent.length === s0, 'unknown address: the same 200, and nothing is sent');
const known = await acct('POST', '/forgot-password', undefined, { email: 'Ann.New@example.com' });
check(known.status === 200 && JSON.stringify(known.json) === JSON.stringify(unknown.json) && sent.length === s0 + 1 && sent[s0].to[0] === 'ann.new@example.com' && /Reset your/.test(sent[s0].subject), 'known address: the identical response, and a reset email goes out');
check((await acct('POST', '/forgot-password', undefined, { email: 'nope' })).status === 400 && (await acct('POST', '/forgot-password', undefined, {})).status === 400, 'not an email → 400');
check((await acct('POST', '/forgot-password', undefined, { email: 'ann.new@example.com' }, NOTHING)).status === 503, 'email off → 503 (the page hides the link)');
for (let i = 0; i < 4; i++) await acct('POST', '/forgot-password', undefined, { email: 'ann.new@example.com' });
check(sent.length - s0 === 3, 'at most three reset emails an hour per address (the rest are silently ignored)');
const resetToken = tokenFromMail('reset');
check(/^https:\/\/maralyrics\.com\/my-profile\?reset=/.test(lastLink(/href="([^"]+)" style="display:inline-block/)), 'reset link points at the site');

console.log('Reset password');
check((await acct('POST', '/reset-password', undefined, { token: resetToken, new_password: 'short' })).status === 400, 'too-short new password → 400 (and the link is not used up)');
check((await acct('POST', '/reset-password', undefined, { token: 'nope', new_password: 'a brand new password' })).status === 400, 'bad link → 400');
const oldSession = byEmail.json.token;
check((await acct('GET', '/me', oldSession)).status === 200, '(the old session works before the reset)');
const reset = await acct('POST', '/reset-password', undefined, { token: resetToken, new_password: 'a brand new password' });
check(reset.status === 200, 'the link sets a new password');
check((await acct('POST', '/login', undefined, { email: 'ann.new@example.com', password: 'correct horse' })).status === 401 && (await acct('POST', '/login', undefined, { email: 'ann.new@example.com', password: 'a brand new password' })).status === 200, 'old password stops working, new one works');
check((await acct('GET', '/me', oldSession)).status === 401, 'every older session is signed out');
check((await acct('POST', '/reset-password', undefined, { token: resetToken, new_password: 'another password 9' })).status === 400, 'a reset link works once');
check((await acct('POST', '/reset-password', undefined, { token: await insertToken('reset', 'late@example.com', { expires: '-1 minute' }), new_password: 'another password 9' })).status === 400, 'an expired reset link → 400');
check((await acct('POST', '/reset-password', undefined, { token: await insertToken('verify', 'late@example.com'), new_password: 'another password 9' })).status === 400, 'a confirmation link cannot reset a password');
// a reset also proves the address
run(`INSERT INTO person_accounts (username, password_hash, contact_email) VALUES ('forgetful', 'x', 'forgetful@example.com')`);
const fid = get(`SELECT id FROM person_accounts WHERE username = 'forgetful'`).id;
await acct('POST', '/forgot-password', undefined, { email: 'forgetful@example.com' });
await acct('POST', '/reset-password', undefined, { token: tokenFromMail('reset'), new_password: 'forgetful new pass' });
check(get('SELECT email_verified_at FROM person_accounts WHERE id = ?', fid).email_verified_at && (await acct('POST', '/login', undefined, { email: 'forgetful@example.com', password: 'forgetful new pass' })).status === 200, 'following the emailed link also confirms the address');
for (let i = 0; i < 5; i++) await acct('POST', '/login', undefined, { email: 'forgetful@example.com', password: 'bad' });
await acct('POST', '/forgot-password', undefined, { email: 'forgetful@example.com' });
await acct('POST', '/reset-password', undefined, { token: tokenFromMail('reset'), new_password: 'forgetful third pass' });
check((await acct('POST', '/login', undefined, { email: 'forgetful@example.com', password: 'forgetful third pass' })).status === 200, 'a reset lifts a lock-out');

console.log('Changing the password');
const pwTok = (await acct('POST', '/login', undefined, { email: 'ann.new@example.com', password: 'a brand new password' })).json.token;
check((await acct('POST', '/change-password', pwTok, { current_password: 'wrong', new_password: 'whatever it is' })).status === 401 && (await acct('POST', '/change-password', pwTok, { new_password: 'whatever it is' })).status === 400, 'a password account must give its current password');
const changed = await acct('POST', '/change-password', pwTok, { current_password: 'a brand new password', new_password: 'yet another one 1' });
check(changed.status === 200 && (await acct('GET', '/me', pwTok)).status === 401 && (await acct('GET', '/me', changed.json.token)).status === 200, 'changing it signs out other sessions but hands back a fresh token');

// ─── Google ──────────────────────────────────────────────────────────────────
console.log('Sign in with Google');
const gNew = await google({});
check(gNew.status === 200 && gNew.json.created === true && gNew.json.account.contact_email === 'gina@gmail.com' && gNew.json.account.email_verified === true && gNew.json.account.google === true && gNew.json.account.has_password === false && gNew.json.account.username === 'gina', 'a new Google user gets an account: confirmed email, username from the email, no password');
check(gNew.json.account.contact_complete === false && (await acct('GET', '/me', gNew.json.token)).status === 200, 'it still needs a phone number (the page sends them to add one); the session works');
check((await acct('POST', '/claims', gNew.json.token, claimBody)).status === 400, 'claiming without a phone number → 400 (email is confirmed, the phone is missing)');
const gAgain = await google({});
check(gAgain.status === 200 && gAgain.json.created === false && gAgain.json.account.id === gNew.json.account.id, 'signing in again finds the same account');
const gMoved = await google({ email: 'gina.renamed@gmail.com' });
check(gMoved.status === 200 && gMoved.json.account.id === gNew.json.account.id && gMoved.json.account.contact_email === 'gina@gmail.com', 'the account follows Google\'s stable id, not the email (a changed Google address does not make a second account)');
check((await acct('POST', '/login', undefined, { email: 'gina@gmail.com', password: 'anything at all' })).status === 401, 'a Google-only account has no password to guess');
const setPw = await acct('POST', '/change-password', gNew.json.token, { new_password: 'gina chose this' });
check(setPw.status === 200 && (await acct('POST', '/login', undefined, { email: 'gina@gmail.com', password: 'gina chose this' })).status === 200, 'a Google-only account can set a password without a current one');

console.log('Google: linking to existing accounts');
const mine = await register('Linda@Example.com', { password: 'linda password' });
await acct('POST', '/verify-email', undefined, { token: tokenFromMail('verify') });
const linked = await google({ sub: 'g-linda', email: 'linda@example.com' });
check(linked.status === 200 && linked.json.created === false && linked.json.account.id === mine.json.account.id && linked.json.account.google === true && linked.json.password_removed === false, 'Google with the email of a CONFIRMED account joins that account (its password keeps working)');
check((await acct('POST', '/login', undefined, { email: 'linda@example.com', password: 'linda password' })).status === 200 && (await acct('GET', '/me', mine.json.token)).status === 200, '…and its sessions stay valid');
check((await google({ sub: 'g-other', email: 'linda@example.com' })).status === 409, 'a different Google account with the same email cannot take it over → 409');

const squat = await register('victim@example.com', { password: 'squatter knows this' });
const squatSession = squat.json.token;
const victim = await google({ sub: 'g-victim', email: 'victim@example.com' });
check(victim.status === 200 && victim.json.account.id === squat.json.account.id && victim.json.account.email_verified === true && victim.json.password_removed === true, 'Google with an UNCONFIRMED account\'s email: the real owner takes it over…');
check((await acct('POST', '/login', undefined, { email: 'victim@example.com', password: 'squatter knows this' })).status === 401 && (await acct('GET', '/me', squatSession)).status === 401, '…the earlier registrant\'s password is switched off and their session ended (no account takeover by pre-registering someone\'s email)');
check((await acct('GET', '/me', victim.json.token)).status === 200, 'while the real owner is signed in');

console.log('Google: forged and invalid tokens');
const bad = async (label, claims, opts, env) => check((await google(claims, opts, env)).status === 400, `rejected: ${label}`);
await bad('wrong audience (token for another site)', { aud: 'someone-else.apps.googleusercontent.com' });
await bad('wrong issuer', { iss: 'https://evil.example' });
await bad('expired', { exp: Math.floor(Date.now() / 1000) - 3600 });
await bad('issued in the future', { iat: Math.floor(Date.now() / 1000) + 3600 });
await bad('email not verified by Google', { email_verified: false });
await bad('no email', { email: undefined });
await bad('no subject', { sub: undefined });
await bad('signed with someone else\'s key', {}, { pair: otherKeys });
await bad('unknown key id', {}, { kid: 'nope' });
await bad('alg none', {}, { alg: 'none' });
await bad('HS256 forged with the public key as the secret', {}, { alg: 'HS256' });
check((await acct('POST', '/google', undefined, { credential: 'a.b.c' })).status === 400 && (await acct('POST', '/google', undefined, {})).status === 400 && (await acct('POST', '/google', undefined, { credential: 'x'.repeat(5000) })).status === 400, 'garbage credentials → 400');
const [h, p] = (await idToken()).split('.');
check((await acct('POST', '/google', undefined, { credential: `${h}.${p}.${b64u(Buffer.alloc(256))}` })).status === 400, 'a valid header + payload with a made-up signature → 400');
const [h2, p2, sig2] = (await idToken()).split('.');
const tamperedPayload = b64u(Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p2, 'base64url')), email: 'admin@victim.example' })));
check((await acct('POST', '/google', undefined, { credential: `${h2}.${tamperedPayload}.${sig2}` })).status === 400, 'a real token with an edited payload → 400');
check((await google({}, {}, NOTHING)).status === 400, 'Google not configured → 400');

console.log('Google keys');
resetGoogleKeyCache();
jwksFetches = 0;
await google({ sub: 'g-k1', email: 'k1@example.com' });
await google({ sub: 'g-k2', email: 'k2@example.com' });
check(jwksFetches === 1, `Google\'s keys are fetched once and cached (${jwksFetches} fetch)`);
servedKeys = [await jwkOf(googleKeys, 'key-2')]; // Google rotates its keys
const rotated = await google({ sub: 'g-k3', email: 'k3@example.com' }, { kid: 'key-2' });
check(rotated.status === 200 && jwksFetches === 2, 'a new key id triggers one refetch, then works');
await google({}, { kid: 'still-unknown' });
check(jwksFetches === 3, 'an unknown key id refetches once, not in a loop');

// ─── Admin + mail layer ──────────────────────────────────────────────────────
console.log('Admin view and the mail layer');
const adminClaims = await call('GET', '/api/v1/admin/claims', { token: mgr });
check(adminClaims.status === 200 && adminClaims.json.claims.some((c) => c.claimant_email === 'ann.new@example.com' && Number(c.claimant_email_verified) === 1), 'admins see whether the claimant\'s email is confirmed');
const evil = verifyEmailMessage({ link: 'https://x.example/?a="><script>alert(1)</script>' });
check(!/<script>/.test(evil.html) && /&quot;&gt;&lt;script&gt;/.test(evil.html), 'email templates escape the link');
check(/Reset my password/.test(resetPasswordMessage({ link: 'https://x.example/' }).text) && /expires in 1 hour/.test(resetPasswordMessage({ link: 'https://x.example/' }).text), 'reset email text version');
const off = await sendMail(NOTHING, { to: 'a@b.co', subject: 's', html: 'h', text: 't' });
check(off.ok === false && off.error === 'email is not configured', 'sendMail without a key does nothing');
const net = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('network down'); };
const down = await sendMail(FULL, { to: 'a@b.co', subject: 's', html: 'h', text: 't' });
globalThis.fetch = net;
check(down.ok === false, 'sendMail never throws, even if the network does');

console.log(failures ? `\n✗ ${passes} checks passed, ${failures} failed` : `\n✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
