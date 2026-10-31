#!/usr/bin/env node
// Browser test of everything an account can do, in a real browser against the real Worker.   npm run test:e2e
//
//   sign up / sign in (email + password, Google)      Cloudflare challenges (sign-up, new Google account, repeated sign-in failures)
//   favorites, pins, downloads and preferences synced between two devices (also offline), a different account on one device
//   profile: name, username, optional phone, photo with the CROP dialog (drag, zoom, wheel, keyboard, cancel) here and in the
//   artist / composer editor        security: change password, connect / disconnect Google, sign out everywhere
//   your data: download, delete      phone layout (no sideways scroll, the crop dialog fits)
//
// Needs Playwright with a Chromium (`require('playwright')`); without one the test says so and skips (exit 0), unless
// E2E_REQUIRED=1. Google, Cloudflare Turnstile and Resend are replaced by stubs; the Worker and its SQLite database are real.
// E2E_SHOTS=dir saves screenshots of the crop dialog; E2E_DEBUG=dir saves a screenshot of every page if the test stops early.
// Not part of `npm test` (it needs a browser) — run it before changing anything on /account, /my-profile or the sync code.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error(`  ✗ ${msg}`); } };
const section = (name) => console.log(`\n${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');

// ─── Playwright + a browser (skip politely when there is none) ───────────────
let browser;
try {
  const { chromium } = require('playwright');
  for (const opts of [{}, { executablePath: '/opt/pw-browsers/chromium' }]) {
    try { browser = await chromium.launch(opts); break; } catch { /* try the next way */ }
  }
} catch { /* no playwright */ }
if (!browser) {
  console.log('e2e: skipped — Playwright with Chromium is not available here (set E2E_REQUIRED=1 to make that an error).');
  process.exit(process.env.E2E_REQUIRED ? 1 : 0);
}

// ─── Stubs on the Worker's side: Google and Cloudflare Turnstile ─────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const CLIENT_ID = 'e2e-client.apps.googleusercontent.com';
const mkCred = (sub, email, name) => {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
  const bd = b64u(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub, email, email_verified: true, name, iat: now, exp: now + 3600 }));
  return `${h}.${bd}.${b64u(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${bd}`), privateKey))}`;
};
const realFetch = globalThis.fetch;
const siteverify = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') { const tok = init.body.get('response'); siteverify.push(tok); return new Response(JSON.stringify({ success: tok === 'ok' }), { status: 200 }); }
  return realFetch(input, init);
};

// ─── The real Worker on an in-memory database; the real static files ─────────
const { default: app } = await import(pathToFileURL(path.join(ROOT, 'worker/worker.js')).href);
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
for (const t of ['Alpha', 'Bravo', 'Charlie', 'Delta']) sqlite.prepare(`INSERT INTO songs (title, slug, lyrics, status, category) VALUES (?, ?, ?, 'published', 'Gospel')`).run(t, t.toLowerCase(), `Lyrics of ${t}`);
const DB = {
  prepare(sql) { const st = sqlite.prepare(sql); const bound = (a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { const r = st.run(...a); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; } }); return { ...bound([]), bind: (...a) => bound(a) }; },
  async batch(sts) { sqlite.exec('BEGIN'); try { const o = []; for (const s of sts) o.push(await s.run()); sqlite.exec('COMMIT'); return o; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
};
const ENV = { DB, JWT_SECRET: 'e2e-secret', GOOGLE_CLIENT_ID: CLIENT_ID, TURNSTILE_SECRET_KEY: 'ts' };
const row = (sql, ...a) => sqlite.prepare(sql).get(...a);
const prefs = () => sqlite.prepare(`SELECT key, value FROM person_sync_items WHERE kind = 'pref' AND deleted = 0 ORDER BY key`).all().map((r) => `${r.key}=${r.value}`).join();
const synced = (kind) => sqlite.prepare(`SELECT key, deleted FROM person_sync_items WHERE kind = ? ORDER BY key`).all(kind).map((r) => `${r.key}${r.deleted ? '(x)' : ''}`);

const MIME = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((q, r) => {
  let p = q.url.split('?')[0];
  if (p === '/') p = '/index.html'; else if (!path.extname(p)) p += '.html';
  fs.readFile(path.join(PUB, p), (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'text/html' }); r.end(d); } });
}).listen(0);
const SITE = `http://localhost:${server.address().port}`;

// ─── Test pictures (a small PNG encoder, so the crop can be checked pixel by pixel) ───
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, colorAt) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = colorAt(x, y); const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; }
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const RED = [255, 0, 0], BLUE = [0, 0, 255], GREEN = [0, 200, 0], YELLOW = [255, 220, 0];
const WIDE = { name: 'wide.png', mimeType: 'image/png', buffer: png(600, 300, (x) => (x < 300 ? RED : BLUE)) };   // red | blue
const TALL = { name: 'tall.png', mimeType: 'image/png', buffer: png(300, 600, (x, y) => (y < 300 ? GREEN : YELLOW)) }; // green over yellow

// ─── Devices: a browser profile each, with the page's outside world stubbed ──
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
async function device(name, viewport = { width: 1100, height: 900 }) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport, acceptDownloads: true });
  await ctx.exposeFunction('mkCred', (sub, email, nm) => mkCred(sub, email, nm));
  await ctx.addInitScript(() => {
    try { localStorage.setItem('ml_cookie_consent', 'accepted'); localStorage.setItem('ml_calendar_pref_prompted', '1'); localStorage.setItem('ml_app_promo_seen', '1'); if (!localStorage.getItem('ml_lang')) localStorage.setItem('ml_lang', 'en'); } catch { /* storage blocked */ }
    // Cloudflare Turnstile: a widget with a callback "solves itself"; the others answer getResponse().
    window.__ts = 'ok'; window.__tsRendered = [];
    window.turnstile = { render(sel, opts) { window.__tsRendered.push(sel); if (opts && opts.callback) setTimeout(() => opts.callback('ok'), 60); return window.__tsRendered.length; }, getResponse() { return window.__ts; }, reset() {}, remove() {} };
    // Google Identity Services: a button that "signs in" as window.__gUser.
    window.__gUser = ['g-gina', 'gina@gmail.com', 'Gina Lee'];
    window.google = { accounts: { id: { initialize(o) { window.__gcb = o.callback; }, renderButton(el) { const b = document.createElement('button'); b.type = 'button'; b.className = 'fake-google'; b.textContent = 'Continue with Google'; b.onclick = async () => window.__gcb({ credential: await window.mkCred(...window.__gUser) }); el.appendChild(b); }, disableAutoSelect() {} } } };
  });
  await ctx.route(/calendar-api|googlesyndication|challenges\.cloudflare|fonts\.g|accounts\.google/, (r) => r.abort());
  await ctx.route('https://api.maralyrics.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    const res = await app.fetch(new Request(`https://api.test${u.pathname}${u.search}`, { method: req.method(), headers: req.headers(), body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() }), ENV);
    route.fulfill({ status: res.status, headers: { ...cors, 'content-type': res.headers.get('content-type') || 'application/json', ...(res.headers.get('content-disposition') ? { 'content-disposition': res.headers.get('content-disposition') } : {}) }, body: Buffer.from(await res.arrayBuffer()) });
  });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => { fail++; console.error(`  ✗ ${name}: page error: ${e.message}`); });
  return { ctx, pg };
}
const signedIn = (pg) => pg.waitForSelector('#syncHome:not([hidden])', { timeout: 8000 });
const signedOutView = (pg) => pg.waitForSelector('#syncAuth:not([hidden])', { timeout: 8000 });
const chooseSignin = (pg) => pg.evaluate(() => document.getElementById('tabSignin').click());
const chooseRegister = (pg) => pg.evaluate(() => document.getElementById('tabRegister').click());
const status = (pg) => pg.evaluate(() => fetch('https://api.maralyrics.com/api/v1/account/me', { headers: { Authorization: `Bearer ${Sync.token()}` } }).then((r) => r.status));

// Pixel at (x, y) of a data: URL (as a CSS colour name for readability).
async function pixels(pg, dataUrl, points) {
  return pg.evaluate(async ([url, pts]) => {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, px: pts.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3)) };
  }, [dataUrl, points]);
}
const near = (rgb, want, tol = 60) => rgb.every((v, i) => Math.abs(v - want[i]) <= tol);

try {
  // ═══ 1. Sign-up and the Cloudflare challenges ═══════════════════════════════
  section('Sign up, and the Cloudflare challenges');
  const A = await device('A'); const P = A.pg;
  await P.goto(`${SITE}/account`);
  await signedOutView(P);
  ok(await P.locator('.account-toggle__btn').count() === 1 && await P.locator('.account-toggle__btn.is-signed-in').count() === 0, 'every page has an Account button in the header (signed out)');
  await chooseRegister(P);
  ok(await P.evaluate(() => window.__tsRendered.includes('#regTurnstile')), 'the sign-up form shows the Cloudflare challenge');
  ok(await P.locator('#regPhone').count() === 0, 'a reader is not asked for a phone number');
  await P.fill('#regEmail', 'reader@example.com'); await P.fill('#regPass', 'longenough1');
  await P.evaluate(() => { window.__ts = ''; });
  await P.click('#regBtn'); await sleep(300);
  ok(await P.locator('#regMsg').isVisible() && !row('SELECT 1 AS x FROM person_accounts'), 'with the challenge unsolved the account is not created');
  await P.evaluate(() => { window.__ts = 'ok'; });
  await P.click('#regBtn');
  await signedIn(P);
  ok(siteverify.includes('ok') && row('SELECT contact_phone FROM person_accounts WHERE id = 1').contact_phone === null, 'solved: the account is created (no phone), and the server checked the token with Cloudflare');
  ok(await P.locator('.account-toggle__btn.is-signed-in').count() === 1, 'the header button shows signed in');

  // ═══ 2. Sync between two devices ════════════════════════════════════════════
  section('Favorites, pins, downloads and preferences follow the account');
  await P.goto(`${SITE}/`);
  await P.waitForSelector('.song-card__favorite[data-slug="alpha"]');
  await P.click('.song-card__favorite[data-slug="alpha"]');
  await P.click('.song-card__favorite[data-slug="bravo"]');
  await P.click('.song-card__pin[data-slug="alpha"]');
  await P.click('.song-card__download[data-slug="charlie"]');
  await P.waitForFunction(() => Downloads.has('charlie'));
  await sleep(2500);
  ok(synced('favorite').join() === 'alpha,bravo' && synced('download').join() === 'charlie' && synced('pin').join() === 'alpha', `the server has the favorites, the download and the pin (${synced('favorite')} | ${synced('download')} | ${synced('pin')})`);

  const B = await device('B'); const Q = B.pg;
  await Q.goto(`${SITE}/account`);
  await signedOutView(Q);
  await Q.fill('#signinUser', 'reader@example.com'); await Q.fill('#signinPass', 'longenough1');
  await Q.click('#signinBtn');
  await signedIn(Q);
  await Q.waitForFunction(() => Downloads.has('charlie'), null, { timeout: 8000 });
  ok(JSON.stringify((await Q.evaluate(() => Favorites.getAll())).sort()) === '["alpha","bravo"]' && JSON.stringify(await Q.evaluate(() => Pins.getAll())) === '["alpha"]', 'device B receives the favorites and the pin');
  ok(await Q.evaluate(() => Downloads.has('charlie')), 'device B downloads the song in the background');
  ok((await Q.textContent('#statFav')).trim() === '2' && (await Q.textContent('#statDl')).trim() === '1', 'the Overview counts match');
  await Q.goto(`${SITE}/`);
  await Q.waitForSelector('.song-card__favorite[data-slug="alpha"].active');
  ok(await Q.locator('.song-card__favorite[data-slug="charlie"].active').count() === 0 && await Q.locator('.song-card__download[data-slug="charlie"].active').count() >= 1, 'B draws the hearts and the download marks on the right songs');

  Q.on('dialog', (d) => d.accept());
  await Q.click('.song-card__favorite[data-slug="alpha"]');
  await Q.click('.song-card__favorite[data-slug="delta"]');
  await Q.click('.song-card__download[data-slug="charlie"]');
  await Q.waitForFunction(() => !Downloads.has('charlie'));
  await sleep(2500);
  await P.evaluate(() => Sync.run({ force: true })); await sleep(800);
  ok(JSON.stringify((await P.evaluate(() => Favorites.getAll())).sort()) === '["bravo","delta"]' && (await P.evaluate(() => Pins.getAll())).length === 0, "A catches up: B's changes arrive (the un-favorited song loses its pin too)");
  ok((await P.evaluate(() => [...Downloads.slugs])).length === 0, "and B's removal of the download reaches A");

  await B.ctx.setOffline(true);
  await Q.evaluate(() => Favorites.toggle('charlie')); await sleep(1800);
  ok(!synced('favorite').includes('charlie') && await Q.evaluate(() => Object.keys(Sync.queue()).length) >= 1, 'a change made offline waits in the queue');
  await B.ctx.setOffline(false);
  await Q.evaluate(() => Sync.run({ force: true })); await sleep(1500);
  ok(synced('favorite').includes('charlie'), '…and is sent when the device is back online');

  // ═══ 3. Profile and the photo cropper ═══════════════════════════════════════
  section('Profile, and the photo crop dialog');
  await P.goto(`${SITE}/account`);
  await signedIn(P);
  await P.click('#tabProfile');
  ok((await P.inputValue('#contactEmail')) === 'reader@example.com', 'the Profile tab shows the contact email');
  await P.fill('#profName', 'Rita Reader');
  await P.fill('#profUser', 'rita.reader');
  await P.setInputFiles('#photoFile', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await sleep(200);
  ok(await P.locator('.crop').count() === 0 && await P.locator('#profMsg').isVisible(), 'a file that is not a picture is refused (no crop dialog)');

  const cropOf = async (file, act) => { // opens the cropper with `file`, lets `act` frame it, uses the photo, returns the draft's pixels
    await P.setInputFiles('#photoFile', file);
    await P.waitForSelector('.crop__panel');
    if (act) await act();
    await P.click('[data-crop-use]');
    await P.waitForSelector('.crop', { state: 'detached' });
    return P.getAttribute('#profAvatar img', 'src');
  };
  const stageBox = async () => P.locator('.crop__stage').boundingBox();
  const drag = async (dx, dy) => { const b = await stageBox(); const cx = b.x + b.width / 2, cy = b.y + b.height / 2; await P.mouse.move(cx, cy); await P.mouse.down(); await P.mouse.move(cx + dx / 2, cy + dy / 2, { steps: 4 }); await P.mouse.move(cx + dx, cy + dy, { steps: 4 }); await P.mouse.up(); };

  await P.setInputFiles('#photoFile', WIDE);
  await P.waitForSelector('.crop__panel');
  ok(await P.getAttribute('.crop__panel', 'role') === 'dialog' && await P.getAttribute('.crop__panel', 'aria-modal') === 'true', 'choosing a photo opens a crop dialog (role dialog, modal)');
  ok(await P.evaluate(() => document.querySelector('.crop').contains(document.activeElement)), 'the focus moves into the dialog');
  const box = await stageBox();
  if (process.env.E2E_SHOTS) await P.screenshot({ path: `${process.env.E2E_SHOTS}/crop-desktop.png` });
  ok(Math.abs(box.width - box.height) < 1 && box.width >= 200, `the crop window is a square (${Math.round(box.width)}px)`);
  const tfm = () => P.evaluate(() => { const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(document.querySelector('.crop__img').style.transform); return [Number(m[1]), Number(m[2])]; });
  const [ox0] = await tfm();
  ok(ox0 < -50, 'a wide picture starts centred (its sides are cut off equally)');
  // keyboard: arrows move it
  await P.focus('.crop__stage');
  await P.keyboard.press('ArrowRight');
  ok((await tfm())[0] > ox0, 'the arrow keys move the picture');
  // wheel + slider + buttons zoom
  const z0 = Number(await P.inputValue('.crop__range'));
  await P.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await P.mouse.wheel(0, -400); await sleep(100);
  const z1 = Number(await P.inputValue('.crop__range'));
  ok(z1 > z0, 'the mouse wheel zooms in');
  await P.click('[data-crop-out]'); await P.click('[data-crop-out]'); await P.click('[data-crop-out]'); await P.click('[data-crop-out]');
  ok(Number(await P.inputValue('.crop__range')) === 1, 'the minus button zooms out, down to the whole picture and no further');
  await P.fill('.crop__range', '2.5');
  ok(Number(await P.inputValue('.crop__range')) === 2.5, 'the slider zooms');
  for (let i = 0; i < 7; i++) await P.press('.crop__stage', '+');
  ok(Number(await P.inputValue('.crop__range')) === 4, 'the plus key zooms in, up to the limit');
  // Escape cancels
  await P.keyboard.press('Escape');
  await P.waitForSelector('.crop', { state: 'detached' });
  ok(await P.locator('#profAvatar img').count() === 0, 'Escape closes the dialog and keeps the old photo (none)');
  // Cancel button
  await P.setInputFiles('#photoFile', WIDE);
  await P.waitForSelector('.crop__panel');
  await P.click('.crop__actions [data-crop-cancel]');
  await P.waitForSelector('.crop', { state: 'detached' });
  ok(await P.locator('#profAvatar img').count() === 0 && await P.evaluate(() => document.body.contains(document.activeElement)), 'Cancel changes nothing, and the focus is not lost inside the closed dialog');

  // default framing = the centre: red on the left half, blue on the right half
  let url = await cropOf(WIDE);
  let r = await pixels(P, url, [[20, 128], [236, 128], [128, 20], [128, 236]]);
  ok(r.w === 256 && r.h === 256, `the result is a 256×256 picture (${r.w}×${r.h})`);
  ok(near(r.px[0], RED) && near(r.px[1], BLUE), 'unmoved, the centre of the picture is kept (red | blue)');
  // dragging to either end shows only that end, however far the finger goes
  url = await cropOf(WIDE, () => drag(600, 0));
  r = await pixels(P, url, [[20, 128], [236, 128]]);
  ok(near(r.px[0], RED) && near(r.px[1], RED), 'dragged to the left end: all red (the picture cannot be pulled off its edge)');
  url = await cropOf(WIDE, () => drag(-600, 0));
  r = await pixels(P, url, [[20, 128], [236, 128]]);
  ok(near(r.px[0], BLUE) && near(r.px[1], BLUE), 'dragged to the right end: all blue');
  // zoomed in on the middle: only the colours at the join
  url = await cropOf(WIDE, async () => { await P.fill('.crop__range', '4'); });
  r = await pixels(P, url, [[20, 128], [236, 128]]);
  ok(near(r.px[0], RED) && near(r.px[1], BLUE), 'zoomed in on the centre: still the join of red and blue');
  url = await cropOf(WIDE, async () => { await P.fill('.crop__range', '4'); await drag(600, 0); });
  r = await pixels(P, url, [[20, 20], [236, 236]]);
  ok(near(r.px[0], RED) && near(r.px[1], RED), 'zoomed in and dragged to an end: that colour fills the frame');
  // a tall picture is dragged up and down
  url = await cropOf(TALL, () => drag(0, 600));
  r = await pixels(P, url, [[128, 20], [128, 236]]);
  ok(near(r.px[0], GREEN) && near(r.px[1], GREEN), 'a tall picture can be dragged to its top (all green)');
  url = await cropOf(TALL, () => drag(0, -600));
  r = await pixels(P, url, [[128, 20], [128, 236]]);
  ok(near(r.px[0], YELLOW) && near(r.px[1], YELLOW), '…and to its bottom (all yellow)');

  // save the last framing for real
  await P.click('#profSave');
  await P.waitForSelector('#profMsg.acct-message--ok');
  const acc = row('SELECT username, display_name, avatar FROM person_accounts WHERE id = 1');
  ok(acc.username === 'rita.reader' && acc.display_name === 'Rita Reader' && /^data:image\/jpeg;base64,/.test(acc.avatar), 'name, username and the cropped JPEG are saved');
  ok((await P.textContent('#syncName')).trim() === 'Rita Reader' && await P.locator('.account-toggle__avatar:not([hidden])').count() === 1, 'the banner greets by name and the header button shows the photo');
  await P.fill('#contactPhone', '+91 98765 43210');
  await P.click('#contactSave');
  await P.waitForSelector('#contactMsg.acct-message--ok');
  ok(row('SELECT contact_phone FROM person_accounts WHERE id = 1').contact_phone === '+919876543210', 'the optional phone is saved');
  await P.fill('#profUser', 'x'); await P.click('#profSave'); await sleep(300);
  ok(await P.locator('#profMsg').isVisible() && !(await P.locator('#profMsg.acct-message--ok').count()), "an invalid username shows the server's message");
  await P.fill('#profUser', 'rita.reader');
  await P.click('#photoRemove'); await P.click('#profSave');
  await P.waitForSelector('#profMsg.acct-message--ok');
  ok(row('SELECT avatar FROM person_accounts WHERE id = 1').avatar === null && await P.locator('.account-toggle__avatar:not([hidden])').count() === 0, 'the photo can be removed');

  // ═══ 4. Preferences ═════════════════════════════════════════════════════════
  section('Preferences');
  await P.click('#tabPrefs');
  await P.click('#prefLang [data-lang="my"]');
  await P.click('#prefTheme [data-theme="light"]');
  await P.click('#prefView [data-view="list"]');
  await sleep(2600);
  ok(prefs() === 'display=list,lang=my,theme=light', `the preferences are on the account (${prefs()})`);
  ok(await P.locator('#prefLang [data-lang="my"].active').count() === 1 && await P.locator('#prefTheme [data-theme="light"].active').count() === 1 && await P.locator('#prefView [data-view="list"].active').count() === 1, 'the chosen buttons are marked');
  await Q.goto(`${SITE}/account`);
  await signedIn(Q); await sleep(1500);
  ok(await Q.evaluate(() => I18n.getLang() === 'my' && Theme.getMode() === 'light' && DisplayMode.current === 'list'), 'device B picks up language, theme and list view');
  await P.evaluate(() => I18n.setLanguage('en'));

  // ═══ 5. Security ════════════════════════════════════════════════════════════
  section('Security');
  await P.click('#tabSecurity');
  ok(await P.locator('#pwCurrentField').isVisible(), 'an account with a password is asked for its current password');
  await P.fill('#pwCurrent', 'longenough1'); await P.fill('#pwNew', 'another-pass-2');
  await P.click('#pwSave');
  await P.waitForSelector('#pwMsg.acct-message--ok');
  ok(await status(P) === 200, 'this device stays signed in after the password changes');
  await Q.evaluate(() => Sync.run({ force: true })); await sleep(600);
  ok(await status(Q) === 401, '…and the other device is signed out');
  await P.evaluate(() => { window.__gUser = ['g-rita', 'rita.g@gmail.com', 'Rita']; });
  await P.click('#googleLinkBtn .fake-google');
  await P.waitForSelector('#googleMsg.acct-message--ok');
  ok(row('SELECT google_sub FROM person_accounts WHERE id = 1').google_sub === 'g-rita' && await P.locator('#unlinkForm').isVisible(), 'Google can be connected (and then disconnected with the password)');
  await P.fill('#unlinkPass', 'another-pass-2'); await P.click('#unlinkBtn');
  await P.waitForSelector('#googleMsg.acct-message--ok');
  ok(row('SELECT google_sub FROM person_accounts WHERE id = 1').google_sub === null, 'Google was disconnected');
  P.once('dialog', (d) => d.accept());
  await P.click('#logoutAll');
  await P.waitForSelector('#sessionsMsg.acct-message--ok');
  ok(await status(P) === 200, 'sign out of all devices keeps this one signed in');

  // ═══ 6. Your data ═══════════════════════════════════════════════════════════
  section('Your data');
  await P.click('#tabData');
  const [dl] = await Promise.all([P.waitForEvent('download'), P.click('#exportBtn')]);
  const exported = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  ok(dl.suggestedFilename() === 'maralyrics-account.json' && exported.account.username === 'rita.reader' && exported.synced.preferences.lang === 'my' && exported.synced.favorites.length > 0, 'the data file downloads, with the account, favorites and preferences');
  await P.fill('#deletePass', 'wrong-password');
  P.once('dialog', (d) => d.accept());
  await P.click('#deleteBtn');
  await P.waitForSelector('#deleteMsg:not([hidden])');
  ok(!!row('SELECT 1 AS x FROM person_accounts WHERE id = 1'), 'a wrong password does not delete the account');
  await P.fill('#deletePass', 'another-pass-2');
  P.once('dialog', (d) => d.accept());
  await P.click('#deleteBtn');
  await signedOutView(P);
  ok(!row('SELECT 1 AS x FROM person_accounts WHERE id = 1') && row('SELECT COUNT(*) AS n FROM person_sync_items').n === 0 && await P.locator('#pageNotice:not([hidden])').count() === 1, 'with the right password the account and its synced data are deleted, and the page says so');

  // ═══ 7. Google, and sign-in challenges ══════════════════════════════════════
  section('Google sign-up, and the sign-in challenge');
  const before = siteverify.length;
  await P.evaluate(() => { window.__gUser = ['g-gina', 'gina@gmail.com', 'Gina Lee']; window.__tsRendered.length = 0; });
  await P.click('#googleBtn .fake-google');
  await signedIn(P);
  ok(await P.evaluate(() => window.__tsRendered.includes('#googleTurnstile')) && siteverify.length > before, 'a NEW account made with Google shows the Cloudflare challenge first');
  ok(row(`SELECT display_name FROM person_accounts WHERE google_sub = 'g-gina'`)?.display_name === 'Gina Lee', '…and is named from Google');
  await P.click('#tabSecurity');
  ok(!(await P.locator('#pwCurrentField').isVisible()), 'a Google-only account is offered "set a password", not "change"');
  await P.click('#tabData');
  ok(await P.locator('#deleteGoogleBlock').isVisible() && !(await P.locator('#deletePassField').isVisible()), '…and confirms a deletion with Google');
  await P.click('#tabOverview'); await P.click('#signoutKeep');
  await signedOutView(P);
  await P.evaluate(() => { window.__tsRendered.length = 0; });
  await P.click('#googleBtn .fake-google');
  await signedIn(P);
  ok(!(await P.evaluate(() => window.__tsRendered.includes('#googleTurnstile'))), 'signing in again with Google shows no challenge');

  await P.click('#signoutKeep'); await signedOutView(P);
  await chooseRegister(P);
  await P.fill('#regEmail', 'bob@example.com'); await P.fill('#regPass', 'longenough1'); await P.click('#regBtn');
  await signedIn(P);
  await P.click('#signoutKeep'); await signedOutView(P);
  await chooseSignin(P);
  await P.evaluate(() => { window.__tsRendered.length = 0; });
  await P.fill('#signinUser', 'bob@example.com');
  for (const pw of ['nope-1', 'nope-2']) { await P.fill('#signinPass', pw); await P.click('#signinBtn'); await sleep(350); }
  ok(await P.evaluate(() => window.__tsRendered.includes('#signinTurnstile')), 'after two wrong passwords the sign-in form shows the challenge');
  await P.evaluate(() => { window.__ts = ''; });
  await P.fill('#signinPass', 'longenough1'); await P.click('#signinBtn'); await sleep(400);
  ok(await P.locator('#syncAuth').isVisible(), 'the right password is still refused until the challenge is solved');
  await P.evaluate(() => { window.__ts = 'ok'; });
  await P.click('#signinBtn');
  await signedIn(P);

  // ═══ 8. Different account on one device, and signing out ════════════════════
  section('Shared devices');
  await P.goto(`${SITE}/`);
  await P.waitForSelector('.song-card__favorite[data-slug="alpha"]');
  await P.click('.song-card__favorite[data-slug="alpha"]'); await sleep(2200);
  ok(synced('favorite').includes('alpha'), '(bob favorites a song)');
  await P.goto(`${SITE}/account`); await signedIn(P);
  await P.click('#signoutKeep'); await signedOutView(P);
  ok(await P.evaluate(() => Favorites.getAll().length) > 0 && await P.locator('.account-toggle__btn.is-signed-in').count() === 0, 'signing out keeps the lists on the device and the header goes back to signed out');
  await P.evaluate(() => { window.__gUser = ['g-carol', 'carol@gmail.com', 'Carol']; });
  await P.click('#googleBtn .fake-google');
  await signedIn(P); await sleep(800);
  ok(await P.evaluate(() => Favorites.getAll().length) === 0 && row(`SELECT COUNT(*) AS n FROM person_sync_items WHERE account_id = (SELECT id FROM person_accounts WHERE google_sub = 'g-carol')`).n === 0, "a different account on the same device starts clean: it does not inherit the previous person's favorites");
  await P.goto(`${SITE}/`);
  await P.waitForSelector('.song-card__favorite[data-slug="alpha"]');
  await P.click('.song-card__favorite[data-slug="alpha"]'); await sleep(2200);
  await P.goto(`${SITE}/account`); await signedIn(P);
  P.once('dialog', (d) => d.accept());
  await P.click('#signoutWipe');
  await signedOutView(P);
  ok(await P.evaluate(() => Favorites.getAll().length) === 0 && synced('favorite').includes('alpha'), '"Sign out and clear this device" empties the device but not the account');

  // ═══ 8b. /app-auth: the stand-alone sign-in page the Android app opens ══════════════════════════════
  section('The Android app sign-in page (/app-auth)');
  const STATE = 'Qw3rTy_uIo-pAs9d';                     // what the app puts in ?state= (16–128 of A-Za-z0-9_-)
  const APP_AUTH = `${SITE}/app-auth?state=${STATE}`;
  const AM = await device('app auth', { width: 390, height: 800 }); const AP = AM.pg;
  const requested = [];                                  // every address the page asks for after it has loaded (the first load IS the address the app opened)
  AP.on('request', (req) => { if (!req.isNavigationRequest()) requested.push(req.url()); });
  const cards = () => AP.evaluate(() => ['invalidCard', 'signinCard', 'successCard'].filter((id) => !document.getElementById(id).hidden));
  const waitCard = (id) => AP.waitForFunction((x) => !document.getElementById(x).hidden, id, { timeout: 8000 });
  const chrome = () => AP.evaluate(() => document.querySelectorAll('header, nav, footer, aside, .header, .footer, .lang-switcher, .mobile-drawer, .settings-toggle, .notif-toggle').length);
  const sideways = () => AP.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const intentOf = async () => {
    // The button's address is made at the tap; the test reads it in a listener that runs after the page's own and stops the real jump.
    await AP.evaluate(() => { window.__intent = null; if (!window.__intentSpy) { window.__intentSpy = true; document.getElementById('returnBtn').addEventListener('click', (e) => { window.__intent = e.currentTarget.getAttribute('href'); e.preventDefault(); }); } });
    await AP.click('#returnBtn');
    return AP.evaluate(() => window.__intent);
  };
  const intentFor = (token) => `intent://maralyrics.com/account/app-signin#Intent;scheme=https;package=com.maralyrics.laitei;S.token=${encodeURIComponent(token)};S.state=${STATE};S.browser_fallback_url=${encodeURIComponent('https://play.google.com/store/apps/details?id=com.maralyrics.laitei')};end`;

  // No usable state: the card says so, with no form
  for (const [why, url] of [['no state', `${SITE}/app-auth`], ['a state that is too short', `${SITE}/app-auth?state=short`], ['a state with a forbidden character', `${SITE}/app-auth?state=${STATE}.x`]]) {
    await AP.goto(url); await waitCard('invalidCard');
    ok((await cards()).join() === 'invalidCard' && await AP.locator('input:visible, form:visible, button:visible').count() === 0, `${why}: only the "link isn't valid" card shows, with no form`);
  }
  ok((await AP.textContent('#invalidCard')).trim() === "This sign-in link isn't valid. Open the Mara Lyrics app and tap Continue with Google to start again.", '…and it says what to do');
  if (process.env.E2E_SHOTS) await AP.screenshot({ path: `${process.env.E2E_SHOTS}/app-auth-invalid.png` });

  // A valid state, signed out
  await AP.goto(APP_AUTH); await waitCard('signinCard');
  ok(new URL(AP.url()).search === '' && !AP.url().includes(STATE), 'the state is taken out of the address bar at once');
  ok((await cards()).join() === 'signinCard' && await chrome() === 0, 'a valid state shows the sign-in card, and the page has no site header, menu, footer or language bar');
  ok(await AP.evaluate(() => typeof CONFIG === 'undefined' && typeof Sync === 'undefined'), 'the site\'s app.js is not loaded');
  await sleep(1700);
  ok(await AP.locator('.app-promo-dialog, .calendar-prompt, .cookie-banner, .app-promotion').count() === 0, 'none of the site\'s dialogs or banners appear');
  ok((await AP.textContent('#signinTitle')).trim() === 'Sign in to MaraLyrics' && await AP.locator('#googleBtn .fake-google').isVisible() && (await AP.textContent('.aa-or')).includes('or use your email'), 'it offers Google and, under "or use your email", the email form');
  ok(await AP.locator('label[for="signinUser"]').isVisible() && await AP.locator('label[for="signinPass"]').isVisible() && (await AP.textContent('#signinBtn')).trim() === 'Sign in', 'with email-or-username and password fields and a Sign in button');
  ok((await AP.getAttribute('.aa-switch a', 'href')) === '/account' && (await AP.textContent('.aa-switch')).replace(/\s+/g, ' ').trim() === 'New here? Create an account', 'and a small "New here? Create an account" link to /account');
  ok(await sideways() <= 0, 'no sideways scroll on a 390 px phone');
  if (process.env.E2E_SHOTS) await AP.screenshot({ path: `${process.env.E2E_SHOTS}/app-auth-signin.png` });

  // Wrong passwords: plain messages, then the Cloudflare challenge
  await AP.fill('#signinUser', 'bob@example.com'); await AP.fill('#signinPass', 'nope-1'); await AP.click('#signinBtn');
  await AP.waitForSelector('#signinMsg:not([hidden])');
  ok((await AP.textContent('#signinMsg')).includes('Invalid email or password') && (await cards()).join() === 'signinCard', 'a wrong password gets the same plain message as /account');
  await AP.evaluate(() => { window.__tsRendered.length = 0; });
  await AP.fill('#signinPass', 'nope-2'); await AP.click('#signinBtn'); await sleep(450);
  ok(await AP.evaluate(() => window.__tsRendered.includes('#signinTurnstile')), 'after two wrong passwords the Cloudflare challenge appears');
  await AP.evaluate(() => { window.__ts = ''; });
  await AP.fill('#signinPass', 'longenough1'); await AP.click('#signinBtn'); await sleep(450);
  ok((await cards()).join() === 'signinCard', 'the right password is still refused until the challenge is solved');
  await AP.evaluate(() => { window.__ts = 'ok'; });
  await AP.click('#signinBtn');
  await waitCard('successCard');

  // Signed in: the success card
  ok((await cards()).join() === 'successCard', 'after email + password the success card replaces the form');
  ok((await AP.textContent('#successTitle')).trim().toUpperCase() === 'LOGIN SUCCESSFUL' && (await AP.evaluate(() => getComputedStyle(document.getElementById('successTitle')).textTransform)) === 'uppercase', 'it says LOGIN SUCCESSFUL');
  ok((await AP.textContent('#successCard .aa-text')).trim() === "You're signed in. Return to the Mara Lyrics app to finish signing in there." && await AP.locator('#successCard .aa-check').isVisible(), '…with the teal check and "You\'re signed in. Return to the Mara Lyrics app to finish signing in there."');
  ok(await AP.locator('#successCard a:visible, #successCard button:visible').count() === 1 && (await AP.textContent('#returnBtn')).trim().toUpperCase() === 'RETURN TO THE APP', 'there is exactly one button: RETURN TO THE APP');
  const btn = await AP.locator('#returnBtn').boundingBox(); const card = await AP.locator('#successCard').boundingBox();
  ok(btn.height === 48 && btn.width > card.width - 80 && btn.x >= card.x && btn.x + btn.width <= card.x + card.width && card.x >= 0 && card.x + card.width <= 390, `the button is 48 px high and fills the card on a phone (${Math.round(btn.width)} px in a ${Math.round(card.width)} px card), which fits the screen`);
  ok(await sideways() <= 0, 'no sideways scroll');
  ok((await AP.getAttribute('#returnBtn', 'href')) === '#' && await AP.locator('#returnHint').isHidden(), 'until the tap the button holds no address and the hint is hidden');
  if (process.env.E2E_SHOTS) await AP.screenshot({ path: `${process.env.E2E_SHOTS}/app-auth-success.png` });
  const token = await AP.evaluate(() => localStorage.getItem('ml_account_token'));
  const intent = await intentOf();
  ok(token && intent === intentFor(token), 'the tap makes the intent URL with the session token, the state and the Play fallback, encoded');
  ok(await AP.evaluate(() => fetch('https://api.maralyrics.com/api/v1/account/me', { headers: { Authorization: `Bearer ${localStorage.getItem('ml_account_token')}` } }).then((r) => r.status)) === 200, '(that token is a working session)');
  ok(await AP.locator('#returnHint').isVisible() && (await AP.textContent('#returnHint')).trim() === 'Nothing happened? Make sure the Mara Lyrics app is installed and up to date.', 'after the tap, "Nothing happened? Make sure the Mara Lyrics app is installed and up to date." shows under the button');
  await sleep(1800);
  ok((await AP.getAttribute('#returnBtn', 'href')) === '#', 'a moment later the address is taken out of the page again');
  ok(!requested.some((u) => u.includes(token) || u.includes(STATE)) && !AP.url().includes(token) && !AP.url().includes(STATE), 'neither the token nor the state appears in any address the page asked for, or in the page address');

  // A session the browser already holds
  await AP.goto(APP_AUTH); await waitCard('successCard');
  ok((await cards()).join() === 'successCard' && new URL(AP.url()).search === '', 'a page that loads with a session shows the success card straight away');
  ok((await intentOf()) === intentFor(await AP.evaluate(() => localStorage.getItem('ml_account_token'))), '…and its button hands that session back');

  // A session the server no longer accepts
  await AP.evaluate(() => localStorage.setItem('ml_account_token', 'not.a.real.session'));
  await AP.goto(APP_AUTH); await waitCard('signinCard');
  ok((await cards()).join() === 'signinCard' && await AP.evaluate(() => localStorage.getItem('ml_account_token')) === null, 'a session the server refuses is dropped, and the sign-in card shows');

  // Google: an existing account, then a NEW one (which needs the challenge first)
  await AP.evaluate(() => { window.__gUser = ['g-gina', 'gina@gmail.com', 'Gina Lee']; });
  await AP.click('#googleBtn .fake-google'); await waitCard('successCard');
  ok((await cards()).join() === 'successCard', 'signing in with Google shows the success card');
  await AP.evaluate(() => localStorage.removeItem('ml_account_token'));
  await AP.goto(APP_AUTH); await waitCard('signinCard');
  await AP.evaluate(() => { window.__gUser = ['g-newapp', 'newapp@gmail.com', 'New App']; window.__tsRendered.length = 0; });
  await AP.click('#googleBtn .fake-google'); await waitCard('successCard');
  ok(await AP.evaluate(() => window.__tsRendered.includes('#googleTurnstile')) && row(`SELECT 1 AS x FROM person_accounts WHERE google_sub = 'g-newapp'`), 'a NEW Google account gets the Cloudflare challenge first, then the success card');
  ok((await intentOf()) === intentFor(await AP.evaluate(() => localStorage.getItem('ml_account_token'))), '…and the tap hands back that new session');

  // /account is a normal page again
  await AP.goto(`${SITE}/account?app=android&state=${STATE}`);
  await signedIn(AP);
  ok(await AP.locator('#appReturn').count() === 0 && new URL(AP.url()).search === `?app=android&state=${STATE}`, '/account ignores ?app=android&state=…: no panel, and the address is left alone');
  await AP.evaluate(() => Sync.signedOut()); // (the device is left clean for the next section)
  await AM.ctx.close();

  // ═══ 9. The crop dialog in the artist / composer editor ═════════════════════
  section('Photo crop in the artist editor (For Artists)');
  sqlite.prepare(`INSERT INTO artists (name, slug) VALUES ('Dee Dancer', 'dee-dancer')`).run();
  const bob = row(`SELECT id FROM person_accounts WHERE lower(contact_email) = 'bob@example.com'`).id;
  sqlite.prepare(`INSERT INTO person_claims (account_id, artist_id, status, evidence) VALUES (?, 1, 'approved', 'https://example.com/dee')`).run(bob);
  await P.goto(`${SITE}/my-profile`);
  await P.waitForSelector('#accountAuth:not([hidden])');
  await P.fill('#signinUser', 'bob@example.com'); await P.fill('#signinPass', 'longenough1'); await P.click('#signinBtn');
  await P.waitForSelector('#accountHome:not([hidden])', { timeout: 8000 });
  await P.click('#courtTabs [data-tab="profile"]');       // (an account with no phone number lands on the Account tab)
  await P.waitForSelector('#editorSave', { state: 'visible' });
  await P.setInputFiles('#editorPhotoFile', WIDE);
  await P.waitForSelector('.crop__panel');
  ok(true, 'choosing the artist photo opens the same crop dialog');
  await P.fill('.crop__range', '2');
  const bx = await stageBox(); await P.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2); await P.mouse.down(); await P.mouse.move(bx.x + bx.width / 2 + 600, bx.y + bx.height / 2, { steps: 6 }); await P.mouse.up();
  await P.click('[data-crop-use]');
  await P.waitForSelector('.crop', { state: 'detached' });
  await P.click('#editorSave');
  await P.waitForSelector('#editorMsg.acct-message--ok', { timeout: 8000 });
  const artistPhoto = row(`SELECT image_url FROM artists WHERE slug = 'dee-dancer'`).image_url;
  r = await pixels(P, artistPhoto, [[20, 200], [380, 200]]);
  ok(r.w === 400 && r.h === 400 && near(r.px[0], RED) && near(r.px[1], RED), `the artist photo is saved 400×400, framed as chosen (${r.w}×${r.h}, red)`);
  await P.setInputFiles('#editorPhotoFile', WIDE);
  await P.waitForSelector('.crop__panel');
  await P.keyboard.press('Escape');
  await P.waitForSelector('.crop', { state: 'detached' });
  ok(row(`SELECT image_url FROM artists WHERE slug = 'dee-dancer'`).image_url === artistPhoto, 'cancelling leaves the artist photo as it was');

  // ═══ 10. A phone ════════════════════════════════════════════════════════════
  section('On a phone');
  const M = await device('M', { width: 390, height: 844 }); const S = M.pg;
  await S.goto(`${SITE}/account`);
  await signedOutView(S);
  await S.fill('#signinUser', 'bob@example.com'); await S.fill('#signinPass', 'longenough1'); await S.click('#signinBtn');
  await signedIn(S);
  for (const tabName of ['overview', 'profile', 'preferences', 'security', 'data']) {
    await S.click(`.acct-tab[data-tab="${tabName}"]`);
    ok(await S.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no sideways scroll (${tabName} tab)`);
  }
  await S.click('.acct-tab[data-tab="profile"]');
  await S.setInputFiles('#photoFile', TALL);
  await S.waitForSelector('.crop__panel');
  if (process.env.E2E_SHOTS) await S.screenshot({ path: `${process.env.E2E_SHOTS}/crop-phone.png` });
  const pb = await S.locator('.crop__panel').boundingBox();
  const sb = await S.locator('.crop__stage').boundingBox();
  ok(pb.x >= 0 && pb.x + pb.width <= 390 && sb.width <= 330 && Math.abs(sb.width - sb.height) < 1, `the crop dialog fits a 390px screen (panel ${Math.round(pb.width)}px, window ${Math.round(sb.width)}px)`);
  // a finger drag
  const fb = await S.locator('.crop__stage').boundingBox();
  const cdp = await M.ctx.newCDPSession(S);
  const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: fb.x + fb.width / 2, y }] });
  const [, y0] = await S.evaluate(() => { const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(document.querySelector('.crop__img').style.transform); return [Number(m[1]), Number(m[2])]; });
  await touch('touchStart', fb.y + 40); await touch('touchMove', fb.y + 90); await touch('touchMove', fb.y + 140); await touch('touchEnd');
  const [, y1] = await S.evaluate(() => { const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(document.querySelector('.crop__img').style.transform); return [Number(m[1]), Number(m[2])]; });
  ok(y1 > y0, 'a finger drags the picture');
  await S.click('.crop__actions [data-crop-cancel]');
} catch (err) {
  fail++;
  console.error(`  ✗ the test stopped early: ${String(err && err.message || err).split('\n').slice(0, 6).join('\n    ')}`);
  if (process.env.E2E_DEBUG) { for (const [i, c] of browser.contexts().entries()) for (const [j, pg] of c.pages().entries()) await pg.screenshot({ path: `${process.env.E2E_DEBUG}/e2e-fail-${i}-${j}.png` }).catch(() => {}); }
} finally {
  console.log(fail ? `\n✗ ${fail} failed, ${pass} passed` : `\n✓ ${pass} browser checks passed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
}
