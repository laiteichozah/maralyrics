#!/usr/bin/env node
// Browser test of the "am I online?" logic, in a real Chromium against the real Worker and the real Pages Functions.   npm run test:e2e:offline
//
// Headless browsers, page renderers, remote-browser tools and some sandboxes report navigator.onLine === false although the page came
// over the network. The site used to believe that: an empty song list, a red "Offline" badge and "song not found" instead of the lyrics.
//
//   navigator.onLine is false but the network works  → songs load from the API, no Offline badge, the lyrics come from the API
//   the song service is truly unreachable            → the server-written A–Z list becomes the cards, the badge says so, a song page keeps
//                                                      its server-written lyrics; a song that really is gone still says so
//
// E2E_SHOTS=dir saves screenshots. Needs Playwright with a Chromium; without one it says so and skips (exit 0), unless E2E_REQUIRED=1.
// Not part of `npm test`.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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

let browser;
try {
  const { chromium } = require('playwright');
  for (const opts of [{}, { executablePath: '/opt/pw-browsers/chromium' }]) { try { browser = await chromium.launch(opts); break; } catch { /* next */ } }
} catch { /* no playwright */ }
if (!browser) {
  console.log('e2e: skipped — Playwright with Chromium is not available here (set E2E_REQUIRED=1 to make that an error).');
  process.exit(process.env.E2E_REQUIRED ? 1 : 0);
}

const { default: app } = await import(pathToFileURL(path.join(ROOT, 'worker/worker.js')).href);
const homeFn = await import(pathToFileURL(path.join(ROOT, 'functions/index.js')).href);
const songFn = await import(pathToFileURL(path.join(ROOT, 'functions/song/[[catchall]].js')).href);
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
const DB = {
  prepare(sql) { const st = sqlite.prepare(sql); const bound = (a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { const r = st.run(...a); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; } }); return { ...bound([]), bind: (...a) => bound(a) }; },
  async batch(sts) { sqlite.exec('BEGIN'); try { const o = []; for (const s of sts) o.push(await s.run()); sqlite.exec('COMMIT'); return o; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
};
const ENV = { DB, JWT_SECRET: 'e2e-secret' };

const LYRICS = 'Khazoh ngiachhiena\nRônah chai a nô\n\nPâhno hmâ ka hlâ';
sqlite.prepare(`INSERT INTO artists (name, slug) VALUES ('Test Singers', 'test-singers')`).run();
const add = (title, slug, lyrics) => {
  const id = Number(sqlite.prepare(`INSERT INTO songs (title, slug, lyrics, status) VALUES (?, ?, ?, 'published')`).run(title, slug, lyrics).lastInsertRowid);
  sqlite.prepare(`INSERT INTO song_artists (song_id, artist_id, position) VALUES (?, 1, 0)`).run(id);
};
add('Khazoh ngiachhiena', 'khazoh-ngiachhiena', LYRICS);
add('Ei beipa nata', 'ei-beipa-nata', 'Ei beipa nata ei Khazohpa');
add('Zion Hla', 'zion-hla', 'Zion hla ka sa');

// The site: the two pages that have a Pages Function run it (so the HTML carries what a crawler is given); the rest is static.
const MIME = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
const ASSETS = { fetch: async (url) => new Response(fs.readFileSync(path.join(PUB, new URL(url).pathname)), { headers: { 'Content-Type': 'text/html' } }) };
const server = http.createServer(async (q, r) => {
  let p = q.url.split('?')[0];
  try {
    if (p === '/' || p.startsWith('/song/')) {
      const fn = p === '/' ? homeFn : songFn;
      const res = await fn.onRequest({ request: new Request(`http://site.test${p}`), env: { DB, ASSETS } });
      r.writeHead(res.status, { 'content-type': 'text/html; charset=UTF-8' });
      r.end(Buffer.from(await res.arrayBuffer()));
      return;
    }
  } catch (e) { r.writeHead(500); r.end(String(e)); return; }
  if (!path.extname(p)) p += '.html';
  fs.readFile(path.join(PUB, p), (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'text/html' }); r.end(d); } });
}).listen(0);
const SITE = `http://localhost:${server.address().port}`;

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
// `claimOffline`: the browser says navigator.onLine === false. `apiDown`: every request to the API fails, as when it is truly unreachable.
async function openPage({ claimOffline = false, apiDown = false } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(([claimOffline]) => {
    try { localStorage.setItem('ml_cookie_consent', 'accepted'); localStorage.setItem('ml_calendar_pref_prompted', '1'); localStorage.setItem('ml_app_promo_seen', '1'); localStorage.setItem('ml_christmas', 'off'); if (!localStorage.getItem('ml_lang')) localStorage.setItem('ml_lang', 'en'); } catch {}
    if (claimOffline) Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false, configurable: true });
  }, [claimOffline]);
  await ctx.route(/calendar-api|googlesyndication|fonts\.g|challenges\.cloudflare/, (r) => r.abort());
  await ctx.route('https://api.maralyrics.com/**', async (route) => {
    if (apiDown) return route.abort('connectionrefused');
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (req.method() === 'HEAD') return route.fulfill({ status: 404, headers: cors });
    const u = new URL(req.url());
    const res = await app.fetch(new Request(`https://api.test${u.pathname}${u.search}`, { method: req.method(), headers: req.headers() }), ENV);
    route.fulfill({ status: res.status, headers: { ...cors, 'content-type': res.headers.get('content-type') || 'application/json' }, body: Buffer.from(await res.arrayBuffer()) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { fail++; console.error(`  ✗ page error: ${e.message}`); });
  return { ctx, page };
}
const homeState = (page) => page.evaluate(() => ({
  onLine: navigator.onLine,
  cards: [...document.querySelectorAll('#songGrid .song-card .song-card__title')].map((t) => t.textContent.trim()),
  badge: !!document.querySelector('#offlineHeaderBadge.visible'),
  empty: getComputedStyle(document.getElementById('emptyState')).display !== 'none',
}));
const songState = (page) => page.evaluate(() => ({
  detail: getComputedStyle(document.getElementById('songDetail')).display !== 'none',
  error: getComputedStyle(document.getElementById('songError')).display !== 'none',
  lyrics: document.getElementById('songLyrics').textContent,
  badge: !!document.querySelector('#offlineHeaderBadge.visible'),
}));

try {
  // ═══ The browser says "offline", the network works ═════════════════════════════
  section('navigator.onLine is false, the network works (a headless browser, a page renderer)');
  {
    const { ctx, page } = await openPage({ claimOffline: true });
    await page.goto(`${SITE}/`);
    await page.waitForSelector('#songGrid .song-card', { timeout: 15000 });
    await sleep(500);
    const h = await homeState(page);
    ok(h.onLine === false, 'setup: the browser really claims to be offline');
    ok(h.cards.length === 3 && h.cards.includes('Khazoh ngiachhiena'), `the song list is loaded from the API (${h.cards.join(', ')})`);
    ok(!h.empty && !h.badge, 'no "no songs yet", and no Offline badge');
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/offline-hint-home.png` });
    // search works too (it used to answer "no results" without asking)
    await page.fill('#searchInput', 'Khazoh');
    await page.waitForSelector('#searchResultsSection:not([style*="display: none"])', { timeout: 8000 }).catch(() => {});
    await sleep(900);
    const found = await page.evaluate(() => [...document.querySelectorAll('#searchGrid .song-card__title, #searchResults .song-card__title')].map((t) => t.textContent.trim()));
    ok(found.includes('Khazoh ngiachhiena'), `searching "Khazoh" finds the song (${found.join(', ') || 'nothing'})`);
    await ctx.close();

    const s = await openPage({ claimOffline: true });
    await s.page.goto(`${SITE}/song/khazoh-ngiachhiena`);
    await s.page.waitForSelector('#songDetail', { state: 'visible' });
    await sleep(700);
    const st = await songState(s.page);
    ok(st.detail && !st.error && st.lyrics.includes('Rônah chai a nô') && !st.badge, 'the song page shows the lyrics, not "song not found", and no Offline badge');
    await s.ctx.close();
  }

  // ═══ The song service really is unreachable ═══════════════════════════════════
  section('The song service is unreachable (nothing answers)');
  for (const claimOffline of [false, true]) {
    const label = claimOffline ? 'the browser also says offline' : 'the browser says online';
    const { ctx, page } = await openPage({ claimOffline, apiDown: true });
    await page.goto(`${SITE}/`);
    await page.waitForSelector('#songGrid .song-card', { timeout: 15000 });
    await sleep(800);
    const h = await homeState(page);
    ok(JSON.stringify(h.cards) === JSON.stringify(['Ei beipa nata', 'Khazoh ngiachhiena', 'Zion Hla']), `${label}: the cards are the server-written A–Z list (${h.cards.join(', ')})`);
    ok(!h.empty, `${label}: not the empty "no songs yet" state`);
    ok(h.badge, `${label}: the Offline badge says the song service cannot be reached`);
    const href = await page.getAttribute('#songGrid .song-card[data-slug="khazoh-ngiachhiena"] a.song-card__link', 'href');
    ok(href === '/song/khazoh-ngiachhiena', `${label}: a card links to its song page (${href})`);
    if (process.env.E2E_SHOTS && !claimOffline) await page.screenshot({ path: `${process.env.E2E_SHOTS}/offline-hint-home-down.png` });

    await page.goto(`${SITE}/song/khazoh-ngiachhiena`);
    await sleep(1200);
    const st = await songState(page);
    ok(st.detail && !st.error && st.lyrics.includes('Khazoh ngiachhiena') && st.lyrics.includes('Pâhno hmâ ka hlâ'), `${label}: the song page keeps the lyrics the server wrote`);
    ok(st.badge, `${label}: the Offline badge is shown on the song page`);
    await ctx.close();
  }

  // ═══ A song that is gone is still reported as gone ════════════════════════════
  section('A song that does not exist');
  {
    const { ctx, page } = await openPage();
    await page.goto(`${SITE}/song/no-such-song`);
    await sleep(1200);
    const st = await songState(page);
    ok(st.error && !st.detail, 'an unknown song still says "not found" (the server shell has no lyrics, and the API answers 404)');
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
