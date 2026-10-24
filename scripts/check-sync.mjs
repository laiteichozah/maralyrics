#!/usr/bin/env node
// Checks for account sync (favourites, pins, downloads, preferences across devices) and reader sign-up.   npm run test:sync
// Runs the real Hono worker against an in-memory SQLite database; "devices" are just callers with their own `since`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: app } = await import(pathToFileURL(path.join(ROOT, 'worker/worker.js')).href);
const { normalizeOps, MAX_OPS, MAX_ITEMS } = await import(pathToFileURL(path.join(ROOT, 'worker/lib/sync.js')).href);

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
  // D1's batch() is one transaction.
  async batch(statements) {
    sqlite.exec('BEGIN');
    try { const out = []; for (const s of statements) out.push(await s.run()); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};
const ENV = { DB, JWT_SECRET: 'test-secret' };
const call = async (method, p, body, token) => {
  const res = await app.fetch(new Request(`https://api.test/api/v1/account${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  }), ENV);
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const sync = (token, body) => call('POST', '/sync', body, token);
const T = 1_700_000_000_000;
const op = (kind, key, at, extra = {}) => ({ kind, key, at, ...extra });
const live = (res) => res.json.items.filter((i) => !i.deleted).map((i) => `${i.kind}:${i.key}`).sort();

// ─── Reader sign-up: email + password only ────────────────────────────────────
const reg = await call('POST', '/register', { email: 'Reader@Example.com', password: 'longenough1', reader: true });
check(reg.status === 201 && reg.json.token, 'a reader can sign up with just an email and a password');
check(reg.json.account.contact_email === 'reader@example.com' && reg.json.account.contact_phone === null && reg.json.account.contact_complete === false, 'no phone is stored, and the account is not "contact complete"');
const artistNoPhone = await call('POST', '/register', { email: 'artist@example.com', password: 'longenough1' });
check(artistNoPhone.status === 400 && /phone/i.test(artistNoPhone.json.error), 'the artist sign-up still requires a phone number');
const badPhone = await call('POST', '/register', { email: 'x@example.com', password: 'longenough1', reader: true, contact_phone: '12' });
check(badPhone.status === 400, 'a reader who does give a phone must give a valid one');
const withPhone = await call('POST', '/register', { email: 'y@example.com', password: 'longenough1', reader: true, contact_phone: '+91 98765 43210' });
check(withPhone.status === 201 && withPhone.json.account.contact_phone === '+919876543210', 'a reader may add a valid phone at sign-up');
check((await call('POST', '/register', { email: 'bad', password: 'longenough1', reader: true })).status === 400, 'a reader still needs a valid email');
const login = await call('POST', '/login', { identifier: 'reader@example.com', password: 'longenough1' });
check(login.status === 200, 'and can sign in with it');
const A = reg.json.token;

// A reader cannot claim a profile without a phone number (claiming is the real-identity step).
sqlite.prepare(`INSERT INTO artists (name, slug) VALUES ('Dee', 'dee')`).run();
const claim = await call('POST', '/claims', { type: 'artist', slug: 'dee', evidence: 'https://example.com/dee-official-page' }, A);
check(claim.status === 400 && /phone/i.test(claim.json.error), 'claiming a profile still needs a phone number');

// ─── Auth ─────────────────────────────────────────────────────────────────────
check((await sync(undefined, { ops: [] })).status === 401, 'sync needs a signed-in account');
check((await sync('garbage', { ops: [] })).status === 401, '…and a valid token');
const empty = await sync(A, { since: 0 });
check(empty.status === 200 && empty.json.rev === 0 && empty.json.items.length === 0 && empty.json.more === false, 'a new account has nothing to sync');

// ─── Two devices ──────────────────────────────────────────────────────────────
const phone = await sync(A, { since: 0, ops: [op('favorite', 'song-a', T), op('favorite', 'song-b', T + 1), op('download', 'song-a', T + 2), op('pin', 'song-a', T + 3, { value: 0 }), op('pref', 'theme', T + 4, { value: 'light' })] });
check(phone.status === 200 && phone.json.rev === 1 && phone.json.items.length === 5, 'the phone uploads 5 changes in one revision');
let phoneRev = phone.json.rev;

const laptop = await sync(A, { since: 0, ops: [] });
check(JSON.stringify(live(laptop)) === JSON.stringify(['download:song-a', 'favorite:song-a', 'favorite:song-b', 'pin:song-a', 'pref:theme']), 'a new device gets all of them');
check(laptop.json.items.find((i) => i.kind === 'pref').value === 'light' && laptop.json.items.find((i) => i.kind === 'pin').value === '0', 'values come with them (preference, pin position)');
let laptopRev = laptop.json.rev;

// The laptop adds one, removes one; the phone sees exactly that.
const l2 = await sync(A, { since: laptopRev, ops: [op('favorite', 'song-c', T + 10), op('favorite', 'song-b', T + 11, { deleted: true })] });
laptopRev = l2.json.rev;
const p2 = await sync(A, { since: phoneRev, ops: [] });
phoneRev = p2.json.rev;
check(p2.json.items.length === 2 && p2.json.items.some((i) => i.key === 'song-c' && !i.deleted) && p2.json.items.some((i) => i.key === 'song-b' && i.deleted), 'the phone receives only what changed: an addition and a removal');
check((await sync(A, { since: phoneRev })).json.items.length === 0, 'and then nothing more');

// ─── Conflicts: the newest change wins, wherever it arrives from ─────────────
const added = await sync(A, { since: phoneRev, ops: [op('favorite', 'song-d', T + 100)] });
phoneRev = added.json.rev; // this device is now fully up to date, so only the reconcile rows can tell it about song-d
const late = await sync(A, { since: phoneRev, ops: [op('favorite', 'song-d', T + 50, { deleted: true })] }); // older removal, arrives later
const lost = late.json.items.find((i) => i.key === 'song-d');
check(lost && lost.deleted === false && lost.at === T + 100, 'an older change that arrives late loses, and the reply carries the winner so that device corrects itself');
const stillThere = await sync(A, { since: 0 });
check(stillThere.json.items.some((i) => i.key === 'song-d' && !i.deleted), 'the favourite is still there for everyone');
await sync(A, { since: phoneRev, ops: [op('favorite', 'song-d', T + 200, { deleted: true })] });
await sync(A, { since: phoneRev, ops: [op('favorite', 'song-d', T + 150)] }); // older re-add must not resurrect it
check((await sync(A, { since: 0 })).json.items.find((i) => i.key === 'song-d').deleted === true, 'an older re-add does not bring back a newer removal');
// "at: 0" (a device\'s items from before it signed in) loses against any known change but is added when unknown.
const first = await sync(A, { since: 0, ops: [op('favorite', 'song-d', 0), op('favorite', 'old-local', 0)] });
check(first.json.items.find((i) => i.key === 'song-d').deleted === true, 'items a device had before signing in do not undo a removal made on the account');
check((await sync(A, { since: 0 })).json.items.some((i) => i.key === 'old-local' && !i.deleted), 'but items the account never heard of are added');

// Same op twice does not churn the revision.
const r1 = (await sync(A, { since: 0 })).json.rev;
await sync(A, { since: 0, ops: [op('favorite', 'old-local', T + 300)] });
check((await sync(A, { since: 0 })).json.rev === r1, 'sending a change that matches what the account already has does not make a new revision');
await sync(A, { since: 0, ops: [op('pref', 'theme', T + 400, { value: 'dark' })] });
check((await sync(A, { since: 0 })).json.items.find((i) => i.key === 'theme').value === 'dark', 'a newer preference replaces the old one');

// Removing something that never existed writes nothing.
const rr = (await sync(A, { since: 0 })).json.rev;
await sync(A, { since: 0, ops: [op('favorite', 'never-there', T + 500, { deleted: true })] });
check((await sync(A, { since: 0 })).json.rev === rr, 'removing something the account never had leaves no trace');

// ─── Accounts are separate ────────────────────────────────────────────────────
const B = withPhone.json.token;
check((await sync(B, { since: 0 })).json.items.length === 0, "another account sees none of this account's data");
await sync(B, { since: 0, ops: [op('favorite', 'song-a', T)] });
check(live(await sync(A, { since: 0 })).includes('favorite:song-a') && (await sync(B, { since: 0 })).json.items.length === 1, 'the same song can be a favourite of both');

// ─── Validation ───────────────────────────────────────────────────────────────
const bad = async (ops, what) => { const r = await sync(A, { ops }); check(r.status === 400 && typeof r.json.error === 'string', `rejects ${what}`); };
await bad('nope', 'ops that are not a list');
await bad([op('movie', 'x', T)], 'an unknown kind');
await bad([op('favorite', '', T)], 'an empty key');
await bad([op('favorite', 'x'.repeat(201), T)], 'a key over 200 characters');
await bad([op('favorite', 'a\nb', T)], 'a key with control characters');
await bad([op('favorite', 'x', 'yesterday')], 'a time that is not a number');
await bad([op('favorite', 'x', -5)], 'a negative time');
await bad([op('pref', 'colour', T, { value: 'red' })], 'an unknown preference');
await bad([op('pref', 'theme', T, { value: 'neon' })], 'an invalid theme');
await bad([op('pref', 'lang', T, { value: 'xx' })], 'an invalid language');
await bad([op('pin', 'x', T, { value: 'first' })], 'a pin position that is not a number');
await bad([null], 'a change that is not an object');
await bad(Array.from({ length: MAX_OPS + 1 }, (_, i) => op('favorite', `s${i}`, T)), `more than ${MAX_OPS} changes at once`);
check((await sync(A, { ops: Array.from({ length: MAX_OPS }, (_, i) => op('favorite', `bulk-${i}`, T + 1000)) })).status === 200, `exactly ${MAX_OPS} changes at once is fine`);
check(live(await sync(A, { since: 0 })).filter((k) => k.startsWith('favorite:bulk-')).length === MAX_OPS, '…and all of them are stored (several database statements)');
check(normalizeOps(undefined).ops.length === 0, 'no ops at all is fine');
const fut = normalizeOps([op('favorite', 'x', Date.now() + 10 * 24 * 3600 * 1000)]);
check(fut.ops[0].at <= Date.now() + 61_000, 'a clock far in the future is clamped, so it cannot win forever');
const dup = normalizeOps([op('favorite', 'x', T), op('favorite', 'x', T + 5, { deleted: true }), op('favorite', 'x', T + 2)]);
check(dup.ops.length === 1 && dup.ops[0].deleted === 1 && dup.ops[0].at === T + 5, 'several changes to one item in one request collapse to the newest');
check(normalizeOps([op('pin', 'x', T, { value: 3 })]).ops[0].value === '3' && normalizeOps([op('favorite', 'x', T, { value: 'junk' })]).ops[0].value === null, 'pin positions are kept, values on other kinds are dropped');

// ─── Paging and the size cap ──────────────────────────────────────────────────
sqlite.exec('DELETE FROM person_sync_items WHERE account_id = 2');
for (let n = 0; n < 7; n++) { // 7 revisions of 150 = 1050 items: the first page (1000) ends in the middle of the last revision
  await sync(B, { ops: Array.from({ length: 150 }, (_, i) => op('download', `page-${n}-${i}`, T + 2000)) });
}
const got = new Set();
let since = 0, pages = 0, more = true;
while (more && pages < 10) { const r = await sync(B, { since }); r.json.items.forEach((i) => got.add(i.key)); since = r.json.rev; more = r.json.more; pages++; }
check(pages === 2 && more === false, `a big account arrives in several pages (${pages})`);
check(got.size === 1050, `…and nothing is lost where a page ends in the middle of a revision (${got.size} of 1050)`);

sqlite.exec(`DELETE FROM person_sync_items WHERE account_id = 2`);
const fill = sqlite.prepare(`INSERT INTO person_sync_items (account_id, kind, key, deleted, updated_at, rev) VALUES (2, 'favorite', ?, 0, 1, 1)`);
sqlite.exec('BEGIN');
for (let i = 0; i < MAX_ITEMS; i++) fill.run(`fill-${i}`);
sqlite.exec('COMMIT');
const capped = await sync(B, { ops: [op('favorite', 'one-too-many', T + 3000)] });
check(capped.status === 200 && capped.json.truncated === true && !get1("SELECT 1 AS x FROM person_sync_items WHERE key = 'one-too-many'"), `an account stops growing at ${MAX_ITEMS} items and says so`);
function get1(sql) { return sqlite.prepare(sql).get(); }
const upd = await sync(B, { ops: [op('favorite', 'fill-1', T + 3001, { deleted: true })] });
check(upd.status === 200 && upd.json.truncated === false, 'existing items can still be changed when the account is full');

// ─── Sessions ─────────────────────────────────────────────────────────────────
await call('POST', '/change-password', { current_password: 'longenough1', new_password: 'another-pass-2' }, A);
check((await sync(A, { since: 0 })).status === 401, 'changing the password signs old devices out of sync too');

// ─── Deleting the account removes its data (foreign keys) ─────────────────────
const before = get1('SELECT COUNT(*) AS n FROM person_sync_items WHERE account_id = 1').n;
sqlite.prepare('DELETE FROM person_accounts WHERE id = 1').run();
check(before > 0 && get1('SELECT COUNT(*) AS n FROM person_sync_items WHERE account_id = 1').n === 0 && !get1('SELECT 1 AS x FROM person_sync_state WHERE account_id = 1'), 'deleting an account deletes its synced data');

console.log(failures ? `\n✗ ${failures} failed, ${passes} passed` : `✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
