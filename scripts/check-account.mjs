#!/usr/bin/env node
// Checks for the account page's features: profile, security, data export / deletion and the Cloudflare challenges.   npm run test:account
//
// Runs the real Hono worker against an in-memory SQLite database. Resend, Google and Cloudflare Turnstile are stubbed at
// fetch(): the "Google" side is a real RSA key pair, so the signature / audience / expiry checks run for real.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { default: app } = await load('worker/worker.js');
const { resetGoogleKeyCache } = await load('worker/lib/google.js');

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
const turnstileCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://api.resend.com/emails') {
    if (resendStatus !== 200) return new Response(JSON.stringify({ message: 'nope' }), { status: resendStatus });
    sent.push({ auth: init.headers.Authorization, ...JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
  }
  if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    const token = init.body.get('response');
    turnstileCalls.push(token);
    return new Response(JSON.stringify({ success: token === 'good-token' }), { status: 200 });
  }
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') { jwksFetches++; return new Response(JSON.stringify({ keys: servedKeys }), { status: 200 }); }
  return realFetch(input, init);
};


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
  async batch(statements) { const out = []; for (const s of statements) out.push(await s.run()); return out; },
};
const get = (sql, ...a) => sqlite.prepare(sql).get(...a);
const run = (sql, ...a) => sqlite.prepare(sql).run(...a);
const SECRET = 'test-secret';
const CHALLENGED = { DB, JWT_SECRET: SECRET, GOOGLE_CLIENT_ID: CLIENT_ID, TURNSTILE_SECRET_KEY: 'ts-secret' }; // Cloudflare challenges on
const OPEN = { DB, JWT_SECRET: SECRET, GOOGLE_CLIENT_ID: CLIENT_ID };                                      // no Turnstile secret (local dev)
let ENV = CHALLENGED;
const call = async (method, p, body, token, env = ENV) => {
  const res = await app.fetch(new Request(`https://api.test/api/v1/account${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
};
const GOOD = 'good-token';

// ─── Cloudflare challenges on account creation ───────────────────────────────
console.log('Cloudflare challenges');
let r = await call('POST', '/register', { email: 'ann@example.com', password: 'longenough1', reader: true });
check(r.status === 400 && /security check/i.test(r.json.error), 'email sign-up without a challenge token is refused');
r = await call('POST', '/register', { email: 'ann@example.com', password: 'longenough1', reader: true, turnstile_token: 'bad-token' });
check(r.status === 400 && /security check/i.test(r.json.error), '…and with a token Cloudflare rejects');
check(get('SELECT COUNT(*) AS n FROM person_accounts').n === 0, '(no account was created by either)');
r = await call('POST', '/register', { email: 'ann@example.com', password: 'longenough1', reader: true, turnstile_token: GOOD });
check(r.status === 201 && r.json.token, 'with a valid token the account is created');
const ann = r.json.token;

// Google: a NEW account needs the challenge, an existing one signs in without it.
const gNew = await call('POST', '/google', { credential: await idToken({ sub: 'g-new', email: 'gina@gmail.com', name: 'Gina Lee' }) });
check(gNew.status === 403 && gNew.json.code === 'challenge_required', 'creating an account with Google asks for the challenge first');
check(get(`SELECT COUNT(*) AS n FROM person_accounts WHERE google_sub = 'g-new'`).n === 0, '(and nothing was created yet)');
const gBad = await call('POST', '/google', { credential: await idToken({ sub: 'g-new', email: 'gina@gmail.com' }), turnstile_token: 'bad-token' });
check(gBad.status === 403 && gBad.json.code === 'challenge_required', 'a bad token does not pass either');
const gOk = await call('POST', '/google', { credential: await idToken({ sub: 'g-new', email: 'gina@gmail.com', name: 'Gina Lee' }), turnstile_token: GOOD });
check(gOk.status === 200 && gOk.json.created === true && gOk.json.account.display_name === 'Gina Lee', 'with a valid token the Google account is created, named from Google');
const gAgain = await call('POST', '/google', { credential: await idToken({ sub: 'g-new', email: 'gina@gmail.com' }) });
check(gAgain.status === 200 && gAgain.json.created === false, 'the same Google account signs in again with no challenge');
// An existing password account that signs in with Google (same address) is a sign-in, not a creation.
await call('POST', '/register', { email: 'hal@example.com', password: 'longenough1', reader: true, turnstile_token: GOOD });
const turnstileBefore = turnstileCalls.length;
const gTake = await call('POST', '/google', { credential: await idToken({ sub: 'g-hal', email: 'hal@example.com' }) });
check(gTake.status === 200 && gTake.json.created === false && gTake.json.account.contact_email === 'hal@example.com' && turnstileCalls.length === turnstileBefore, 'Google sign-in to an existing account (same email) needs no challenge');

// Sign-in: a challenge appears after two wrong passwords.
r = await call('POST', '/login', { identifier: 'ann@example.com', password: 'wrong-one' });
check(r.status === 401 && !r.json.code, 'first wrong password: plain error');
r = await call('POST', '/login', { identifier: 'ann@example.com', password: 'wrong-two' });
check(r.status === 401 && r.json.code === 'challenge_required', 'second wrong password: the page is told to show the challenge');
r = await call('POST', '/login', { identifier: 'ann@example.com', password: 'longenough1' });
check(r.status === 403 && r.json.code === 'challenge_required', 'now even the right password is refused without a challenge token');
r = await call('POST', '/login', { identifier: 'ann@example.com', password: 'longenough1', turnstile_token: 'bad-token' });
check(r.status === 403, '…or with a bad one');
r = await call('POST', '/login', { identifier: 'ann@example.com', password: 'longenough1', turnstile_token: GOOD });
check(r.status === 200 && r.json.token, 'the right password with a valid token signs in');
r = await call('POST', '/login', { identifier: 'ann@example.com', password: 'longenough1' });
check(r.status === 200, 'and the counter is reset, so the next sign-in needs no challenge');
check((await call('POST', '/forgot-password', { email: 'ann@example.com', turnstile_token: 'nope' })).status !== 200, 'forgot-password still needs its challenge (mail is off here, so it stops earlier)');
const withoutSecret = await call('POST', '/register', { email: 'dev@example.com', password: 'longenough1', reader: true }, undefined, OPEN);
check(withoutSecret.status === 201, 'with no Turnstile secret configured (local dev) the challenge is skipped');
ENV = OPEN; // the remaining checks are about other things

// ─── Profile ──────────────────────────────────────────────────────────────────
console.log('Profile');
const me = await call('GET', '/me', undefined, ann);
check(me.json.account.display_name === null && me.json.account.avatar === null && me.json.account.contact_phone === null, 'a new account has no name, photo or phone');
r = await call('PUT', '/profile', { display_name: '  Ann   Lee ' }, ann);
check(r.status === 200 && r.json.account.display_name === 'Ann Lee', 'the display name is trimmed and tidied');
check((await call('PUT', '/profile', { display_name: 'x'.repeat(51) }, ann)).status === 400, 'a name over 50 characters is refused');
check((await call('PUT', '/profile', { display_name: 'bad\u0007name' }, ann)).status === 400, 'control characters are refused');
check((await call('PUT', '/profile', { display_name: '<img src=x onerror=alert(1)>' }, ann)).json.account.display_name === '<img src=x onerror=alert(1)>', 'markup is stored as plain text (the page only ever shows it as text)');
check((await call('PUT', '/profile', { display_name: '' }, ann)).json.account.display_name === null, 'an empty name clears it');
check((await call('PUT', '/profile', {}, ann)).status === 400, 'an empty update is refused');
check((await call('PUT', '/profile', { display_name: 'Ann' })).status === 401, 'sign-in is needed');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
r = await call('PUT', '/profile', { avatar: PNG }, ann);
check(r.status === 200 && r.json.account.avatar === PNG, 'a PNG / JPEG / WebP photo can be saved');
check((await call('GET', '/me', undefined, ann)).json.account.avatar === PNG, 'and comes back with the account');
for (const [bad, why] of [['data:image/svg+xml;base64,PHN2Zy8+', 'an SVG'], ['https://example.com/a.png', 'a web address'], ['javascript:alert(1)', 'a script URL'], ['data:image/png;base64,AAAA<script>', 'markup after the data'], ['data:text/html;base64,PGI+', 'HTML']]) {
  check((await call('PUT', '/profile', { avatar: bad }, ann)).status === 400, `a photo that is ${why} is refused`);
}
check((await call('PUT', '/profile', { avatar: `data:image/jpeg;base64,${'A'.repeat(100000)}` }, ann)).status === 400, 'a photo that is too large is refused');
check((await call('PUT', '/profile', { avatar: '' }, ann)).json.account.avatar === null, 'an empty photo removes it');

// username
r = await call('PUT', '/profile', { username: 'ann.lee' }, ann);
check(r.status === 200 && r.json.account.username === 'ann.lee' && r.json.token, 'the username can be changed (and a fresh session token comes back)');
const ann2 = r.json.token;
check((await call('GET', '/me', undefined, ann2)).status === 200, 'the new token works');
check((await call('POST', '/login', { identifier: 'ann.lee', password: 'longenough1' })).status === 200, 'people can sign in with the new username');
const dupe = await call('PUT', '/profile', { username: get('SELECT username FROM person_accounts WHERE id = 2').username }, ann2);
check(dupe.status === 409, 'a username that someone else has is refused');
check((await call('PUT', '/profile', { username: 'a' }, ann2)).status === 400 && (await call('PUT', '/profile', { username: 'has space' }, ann2)).status === 400, 'an invalid username is refused');

// contact: phone optional on the account page only
r = await call('PUT', '/contact', { contact_email: 'ann@example.com', contact_phone: '', phone_optional: true }, ann2);
check(r.status === 200 && r.json.account.contact_phone === null, 'a reader may keep the phone empty');
check((await call('PUT', '/contact', { contact_email: 'ann@example.com', contact_phone: '' }, ann2)).status === 400, 'the artists\' form (no phone_optional) still requires it');
check((await call('PUT', '/contact', { contact_email: 'ann@example.com', contact_phone: '12', phone_optional: true }, ann2)).status === 400, 'a phone that is given must be valid');
r = await call('PUT', '/contact', { contact_email: 'ann@example.com', contact_phone: '+91 98765 43210', phone_optional: true }, ann2);
check(r.json.account.contact_phone === '+919876543210' && r.json.account.contact_complete === true, 'a valid phone is saved');

// ─── Security ─────────────────────────────────────────────────────────────────
console.log('Security');
// Google link / unlink
const gLink = async (tok, claims) => call('POST', '/google/link', { credential: await idToken(claims) }, tok);
check((await call('POST', '/google/link', { credential: 'junk' }, ann2)).status === 400, 'linking needs a real Google sign-in');
check((await gLink(undefined, { sub: 'g-ann' })).status === 401, 'linking needs a session');
r = await gLink(ann2, { sub: 'g-ann', email: 'whatever@gmail.com' });
check(r.status === 200 && r.json.account.google === true, 'a Google account can be connected to an email account');
check((await gLink(ann2, { sub: 'g-other' })).status === 409, 'a second, different Google account cannot replace it silently');
const takenBy = await gLink(gOk.json.token, { sub: 'g-ann' });
check(takenBy.status === 409, 'a Google account that belongs to another MaraLyrics account cannot be connected twice');
check((await call('POST', '/google/unlink', { password: 'wrong' }, ann2)).status === 401, 'disconnecting needs the password');
r = await call('POST', '/google/unlink', { password: 'longenough1' }, ann2);
check(r.status === 200 && r.json.account.google === false, 'with the password it is disconnected');
check((await call('POST', '/google/unlink', { password: 'longenough1' }, ann2)).status === 400, 'nothing to disconnect the second time');
const gOnly = gOk.json.token; // Gina has only Google
check((await call('POST', '/google/unlink', { password: 'x' }, gOnly)).status === 400, 'a Google-only account cannot disconnect its only way in');

// sign out everywhere
const second = (await call('POST', '/login', { identifier: 'ann.lee', password: 'longenough1' })).json.token;
check((await call('GET', '/me', undefined, second)).status === 200, '(a second device is signed in)');
r = await call('POST', '/logout-all', {}, ann2);
check(r.status === 200 && r.json.token, 'sign out everywhere answers with a fresh token');
check((await call('GET', '/me', undefined, second)).status === 401 && (await call('GET', '/me', undefined, ann2)).status === 401, 'every older session is ended');
const ann3 = r.json.token;
check((await call('GET', '/me', undefined, ann3)).status === 200, 'but the device that asked stays signed in');

// ─── Data ─────────────────────────────────────────────────────────────────────
console.log('Data');
await call('POST', '/sync', { since: 0, ops: [{ kind: 'favorite', key: 'song-a', at: 5 }, { kind: 'download', key: 'song-b', at: 6 }, { kind: 'favorite', key: 'gone', at: 7 }, { kind: 'favorite', key: 'gone', at: 8, deleted: true }, { kind: 'pref', key: 'lang', value: 'en', at: 9 }, { kind: 'pref', key: 'display', value: 'list', at: 9 }, { kind: 'pref', key: 'calendar', value: 'mara-events', at: 9 }] }, ann3);
check((await call('POST', '/sync', { ops: [{ kind: 'pref', key: 'display', value: 'grid', at: 1 }] }, ann3)).status === 400, 'a view preference outside card / list is refused');
check((await call('POST', '/sync', { ops: [{ kind: 'pref', key: 'calendar', value: '../x', at: 1 }] }, ann3)).status === 400, 'a calendar preference must look like a slug');
r = await call('GET', '/export', undefined, ann3);
check(r.status === 200 && /attachment/.test(r.headers.get('content-disposition')) && /no-store/.test(r.headers.get('cache-control')), 'the export is a download that is never cached');
check(r.json.account.username === 'ann.lee' && r.json.account.contact_email === 'ann@example.com' && !('password_hash' in r.json.account) && !/password_hash|longenough/.test(r.text), 'it holds the account details but no password hash');
check(JSON.stringify(r.json.synced.favorites) === '["song-a"]' && JSON.stringify(r.json.synced.downloads) === '["song-b"]' && r.json.synced.preferences.display === 'list' && r.json.synced.preferences.calendar === 'mara-events', 'and the synced favorites, downloads and preferences (not removed ones)');
check((await call('GET', '/export')).status === 401, 'the export needs a session');

// delete
check((await call('POST', '/delete-account', { password: 'nope' }, ann3)).status === 401, 'deleting needs the password');
check((await call('POST', '/delete-account', {}, ann3)).status === 401, '…even when it is left out');
run(`INSERT INTO artists (name, slug) VALUES ('Dee', 'dee')`);
run(`INSERT INTO person_claims (account_id, artist_id, status, evidence) VALUES (1, 1, 'approved', 'https://example.com/dee')`);
r = await call('POST', '/delete-account', { password: 'longenough1' }, ann3);
check(r.status === 409 && r.json.code === 'owns_profile' && get('SELECT 1 AS x FROM person_accounts WHERE id = 1'), 'an account that manages a profile cannot be deleted');
run(`UPDATE person_claims SET status = 'revoked' WHERE account_id = 1`);
run(`INSERT INTO person_claims (account_id, artist_id, status, evidence) VALUES (1, 1, 'pending', 'https://example.com/dee')`);
r = await call('POST', '/delete-account', { password: 'longenough1' }, ann3);
check(r.status === 200 && !get('SELECT 1 AS x FROM person_accounts WHERE id = 1'), 'otherwise it is deleted');
check(get('SELECT COUNT(*) AS n FROM person_sync_items WHERE account_id = 1').n === 0 && get('SELECT COUNT(*) AS n FROM person_claims WHERE account_id = 1').n === 0, 'with its synced data and claims');
check((await call('GET', '/me', undefined, ann3)).status === 401, 'the old session no longer works');
check((await call('POST', '/login', { identifier: 'ann@example.com', password: 'longenough1' })).status === 401, 'and the details no longer sign in');
check(get(`SELECT COUNT(*) AS n FROM artists WHERE slug = 'dee'`).n === 1, 'the artist page itself is untouched');

// A Google-only account confirms with Google
check((await call('POST', '/delete-account', {}, gOnly)).status === 401, 'a Google-only account must confirm with Google');
check((await call('POST', '/delete-account', { credential: await idToken({ sub: 'someone-else', email: 'x@gmail.com' }) }, gOnly)).status === 401, '…with ITS Google account, not another');
r = await call('POST', '/delete-account', { credential: await idToken({ sub: 'g-new', email: 'gina@gmail.com' }) }, gOnly);
check(r.status === 200 && !get(`SELECT 1 AS x FROM person_accounts WHERE google_sub = 'g-new'`), 'with the right Google sign-in it is deleted');

// ─── App mode: the Android app signs a reader in through the phone's browser ─────────────────────────────────
// The page (public/account-page.js) opens in app mode only for ?app=android&state=<16–128 of A-Za-z0-9_->; once signed in it offers a
// button that hands the session back through an intent URL. The pure parts live in public/app-mode.js and are tested here.
console.log('App mode');
const AppMode = vm.runInNewContext(`${fs.readFileSync(path.join(ROOT, 'public/app-mode.js'), 'utf8')}; AccountAppMode`, { URLSearchParams, encodeURIComponent });
const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const APP_PACKAGE = (/APP_PACKAGE: '([^']+)'/.exec(appJs) || [])[1];
const APP_STORE_URL = (/APP_STORE_URL: '([^']+)'/.exec(appJs) || [])[1];
check(APP_PACKAGE === 'com.maralyrics.laitei' && APP_STORE_URL === 'https://play.google.com/store/apps/details?id=com.maralyrics.laitei', 'the package name and Play URL are the ones the song page uses (Utils.APP_PACKAGE / APP_STORE_URL)');
const STATE = 'Ab3-_xYz9Qw0LmNp';          // 16 characters, the shortest allowed
const LONG_STATE = 'a'.repeat(128);
check(AppMode.parse(`?app=android&state=${STATE}`)?.state === STATE, 'app=android with a well-formed state turns app mode on');
check(AppMode.parse(`?state=${STATE}&app=android&reset=x`)?.state === STATE && AppMode.parse(`?app=android&state=${LONG_STATE}`)?.state === LONG_STATE, '…in any order, with other parameters, up to 128 characters');
for (const [why, search] of [
  ['no parameters', ''], ['nothing at all', undefined], ['no state', '?app=android'], ['no app', `?state=${STATE}`],
  ['another app', `?app=ios&state=${STATE}`], ['a different case', `?app=Android&state=${STATE}`], ['an empty app', `?app=&state=${STATE}`],
  ['a state of 15 characters', `?app=android&state=${STATE.slice(1)}`], ['a state of 129 characters', `?app=android&state=${'a'.repeat(129)}`],
  ['an empty state', '?app=android&state='], ['a state with a dot', `?app=android&state=${STATE}.`], ['a state with a plus sign', `?app=android&state=${STATE.slice(1)}%2B`],
  ['a state with a space', `?app=android&state=${STATE.slice(1)}%20`], ['a state with a slash', `?app=android&state=${STATE.slice(1)}%2F`],
  ['a state with an equals sign', `?app=android&state=${STATE.slice(1)}%3D`], ['a repeated app', `?app=android&app=android&state=${STATE}`],
  ['a repeated state', `?app=android&state=${STATE}&state=${STATE}`], ['a script in the state', `?app=android&state=%3Cscript%3Ealert(1)%3C%2Fscript%3E`],
]) check(AppMode.parse(search) === null, `app mode stays off with ${why}`);

check(AppMode.cleanSearch(`?app=android&state=${STATE}`) === '' && AppMode.cleanSearch(`?verify=abc&app=android&state=${STATE}`) === '?verify=abc', 'the address bar keeps nothing of app and state');
check(AppMode.cleanSearch(`?state=${STATE}&x=1&app=android&y=two`) === '?x=1&y=two', '…and every other parameter stays');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.sig+/=;#?&é x';   // a token with every character that could break a URL
const expected = `intent://maralyrics.com/account/app-signin#Intent;scheme=https;package=com.maralyrics.laitei;S.token=${encodeURIComponent(TOKEN)};S.state=${STATE};S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.maralyrics.laitei;end`;
const intent = AppMode.intentUrl({ pkg: APP_PACKAGE, storeUrl: APP_STORE_URL, token: TOKEN, state: STATE });
check(intent === expected, 'the intent URL is built exactly: package, token, state and the Play fallback, each encoded');
const extras = intent.split('#Intent;')[1].split(';');
check(extras.length === 6 && extras[5] === 'end' && extras[0] === 'scheme=https' && extras[1] === 'package=com.maralyrics.laitei', 'it has exactly the parts it should (nothing in the token can end a parameter early)');
check(decodeURIComponent(extras[2].slice('S.token='.length)) === TOKEN && decodeURIComponent(extras[3].slice('S.state='.length)) === STATE && decodeURIComponent(extras[4].slice('S.browser_fallback_url='.length)) === APP_STORE_URL, 'the app gets the token, the state and the fallback back exactly');
check(!/https?:\/\//i.test(intent) && intent.startsWith('intent://maralyrics.com/account/app-signin#Intent;'), 'the token and state are in no https:// address: the only URL is intent:// (the Play address is encoded)');
const plain = AppMode.intentUrl({ pkg: APP_PACKAGE, storeUrl: APP_STORE_URL, token: 'abc.def.ghi', state: LONG_STATE });
check(plain.includes('S.token=abc.def.ghi;') && plain.includes(`S.state=${LONG_STATE};`), 'an ordinary token and the longest state go in as they are');
for (const [why, args] of [
  ['no token', { token: '' }], ['a token that is not text', { token: 12345 }], ['no state', { state: '' }], ['a state that is too short', { state: 'short' }],
  ['a state with a ;', { state: `${STATE};S.x=1` }], ['a package that could add parameters', { pkg: 'com.evil;S.token=x' }], ['no package', { pkg: '' }],
  ['no Play address', { storeUrl: '' }],
]) check(AppMode.intentUrl({ pkg: APP_PACKAGE, storeUrl: APP_STORE_URL, token: 'abc.def.ghi', state: STATE, ...args }) === '', `no intent URL is made with ${why}`);

// The page itself: app mode only when the address asks, the state in one variable, the token in no https:// address, nothing logged.
const pageJs = fs.readFileSync(path.join(ROOT, 'public/account-page.js'), 'utf8');
const codeLines = (src) => src.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
check(/const appMode = AccountAppMode\.parse\(location\.search\);/.test(pageJs) && /if \(appMode\) history\.replaceState\(/.test(pageJs), 'the page reads app mode from the address, and only then touches the address bar');
check(/\$\('appReturn'\)\.hidden = !appState;/.test(pageJs), 'the panel shows only in app mode, whenever the account is shown (sign-in or a page that loaded signed in)');
check(!codeLines(pageJs).concat(codeLines(fs.readFileSync(path.join(ROOT, 'public/app-mode.js'), 'utf8'))).some((l) => /console\./.test(l)), 'neither file logs anything');
check(!codeLines(pageJs).filter((l) => /appState/.test(l)).some((l) => /localStorage|sessionStorage|fetch\(|console|location\.|document\.cookie|turnstile|navigator\.|postMessage/i.test(l)), 'the state is kept in the variable only: never stored, sent or put in an address');
check(!codeLines(pageJs).filter((l) => /https?:\/\//.test(l)).some((l) => /token|TOKEN_KEY|appState|state/i.test(l)), 'no line that builds an https:// address mentions the token or the state');
check(/APP_PACKAGE/.test(pageJs) && !/package=/.test(pageJs), 'the package name comes from Utils.APP_PACKAGE (hard-coded in app.js), never from the address');
const accountHtml = fs.readFileSync(path.join(ROOT, 'public/account.html'), 'utf8');
check(accountHtml.indexOf('/app-mode.js') > 0 && accountHtml.indexOf('/app-mode.js') < accountHtml.indexOf('/account-page.js'), 'app-mode.js loads before the account page script');
check(/id="appReturn"[^>]*\bhidden\b/.test(accountHtml) && accountHtml.indexOf('id="appReturn"') < accountHtml.indexOf('class="acct-banner"') && /id="appReturnBtn" href="#"/.test(accountHtml), 'the panel sits at the top of the signed-in view, hidden, with a button that holds no address until it is tapped');
const enLocale = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/en.json'), 'utf8')).account;
check(enLocale.app_signed_in_title === "You're signed in" && enLocale.app_signed_in_text === 'Return to the Mara Lyrics app to finish signing in there.' && enLocale.app_return_btn === 'Return to the Mara Lyrics app', 'the three texts are in en.json (my and mrh fall back to English until they are translated)');

console.log(failures ? `\n✗ ${failures} failed, ${passes} passed` : `\n✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
