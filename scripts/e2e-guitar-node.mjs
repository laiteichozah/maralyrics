#!/usr/bin/env node
// Browser test of Guitar Node: the chords above the lyrics, the key controls and the admin editor, in a real Chromium against
// the real Worker.   npm run test:e2e:guitar
//
//   song page: chords sit above their words (measured), transposing to another key, semitone buttons, reset, hide / show,
//   remembered per song, minor keys, unknown key, songs without chords, copy, keyboard, a phone screen
//   admin: set a key, write the chord sheet (palette, live preview, mistakes), save, edit, remove the chords, the song list
//
// E2E_SHOTS=dir saves screenshots (song page, admin form); E2E_SCROLLBARS=1 shows classic scrollbars in them; E2E_DEBUG=dir saves pages if it stops early.
// Needs Playwright with a Chromium; without one it says so and skips (exit 0), unless E2E_REQUIRED=1. Not part of `npm test`.
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
  // E2E_SCROLLBARS=1 shows real (classic) scrollbars instead of hiding them, to check how the dialogs look on Windows
  const shown = process.env.E2E_SCROLLBARS ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {};
  for (const opts of [shown, { ...shown, executablePath: '/opt/pw-browsers/chromium' }]) { try { browser = await chromium.launch(opts); break; } catch { /* next */ } }
} catch { /* no playwright */ }
if (!browser) {
  console.log('e2e: skipped — Playwright with Chromium is not available here (set E2E_REQUIRED=1 to make that an error).');
  process.exit(process.env.E2E_REQUIRED ? 1 : 0);
}

const { default: app } = await import(pathToFileURL(path.join(ROOT, 'worker/worker.js')).href);
const { signJWT } = await import(pathToFileURL(path.join(ROOT, 'worker/lib/auth.js')).href);
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
const DB = {
  prepare(sql) { const st = sqlite.prepare(sql); const bound = (a) => ({ first: async () => st.get(...a) ?? null, all: async () => ({ results: st.all(...a) }), run: async () => { const r = st.run(...a); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; } }); return { ...bound([]), bind: (...a) => bound(a) }; },
  async batch(sts) { sqlite.exec('BEGIN'); try { const o = []; for (const s of sts) o.push(await s.run()); sqlite.exec('COMMIT'); return o; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
};
const SECRET = 'e2e-secret';
const ENV = { DB, JWT_SECRET: SECRET };
sqlite.prepare(`INSERT INTO admin_users (id, username, password_hash, role) VALUES (1, 'boss', 'x', 'super_admin')`).run();
const adminToken = await signJWT({ sub: 1, username: 'boss' }, SECRET);
const row = (sql, ...a) => sqlite.prepare(sql).get(...a);

// ─── Songs ────────────────────────────────────────────────────────────────────
const FALLING = 'Wise men say only fools rush in\nBut I can\'t help falling in love with you\n\nShall I stay? Would it be a sin?';
const FALLING_CHORDS = { v: 1, lines: { 0: [[0, 'C'], [9, 'Em'], [18, 'Am'], [24, 'F'], [29, 'C']], 1: [[0, 'F'], [4, 'C'], [18, 'G7'], [30, 'C']], 3: [[0, 'C'], [8, 'Em'], [20, 'Am/C'], [26, 'Dm7']] } };
const song = (title, slug, lyrics, key, chords) => sqlite.prepare(`INSERT INTO songs (title, slug, lyrics, original_key, chords, status) VALUES (?, ?, ?, ?, ?, 'published')`).run(title, slug, lyrics, key, chords ? JSON.stringify(chords) : null);
song('Falling', 'falling', FALLING, 'C', FALLING_CHORDS);
song('Sad Waltz', 'sad-waltz', 'Alone again\nWith the rain', 'Am', { v: 1, lines: { 0: [[0, 'Am'], [6, 'Dm']], 1: [[0, 'E7'], [9, 'Am']] } });
song('Mystery Key', 'mystery-key', 'Over the hill\nAnd far away', null, { v: 1, lines: { 0: [[0, 'Bb'], [9, 'F/A']], 1: [[0, 'Gm7'], [8, 'C7']] } });
song('Plain Song', 'plain-song', 'No chords here\nJust words', null, null);
song('Intro Song', 'intro-song', '\nFirst line\nSecond line', 'G', { v: 1, lines: { 0: [[0, 'G'], [0, 'D'], [0, 'Em']], 1: [[0, 'G'], [6, 'D']] } });
song('Burmese Song', 'burmese-song', 'မြန်မာနိုင်ငံ\nနောက်ဆုံး', 'D', { v: 1, lines: { 0: [[0, 'D'], [3, 'A']] } });

const MIME = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' };
let adminCssMarker = '';  // changed by the test to play "a new version was deployed"
const server = http.createServer((q, r) => {
  let p = q.url.split('?')[0];
  if (p.startsWith('/song/')) p = '/songview.html';
  else if (p === '/' ) p = '/index.html';
  else if (p === '/admin' || p === '/admin/') p = '/admin/index.html';
  else if (!path.extname(p)) p += '.html';
  fs.readFile(path.join(PUB, p), (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'text/html' }); r.end(p === '/admin/index.css' && adminCssMarker ? Buffer.concat([d, Buffer.from(adminCssMarker)]) : d); } });
}).listen(0);
const SITE = `http://localhost:${server.address().port}`;

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
async function openPage({ viewport = { width: 1100, height: 900 }, admin = false, token = '', serviceWorkers = 'block', userAgent } = {}) {
  const ctx = await browser.newContext({ serviceWorkers, viewport, permissions: [], ...(userAgent ? { userAgent } : {}) });
  await ctx.addInitScript(([admin, token]) => {
    try { localStorage.setItem('ml_cookie_consent', 'accepted'); localStorage.setItem('ml_calendar_pref_prompted', '1'); localStorage.setItem('ml_app_promo_seen', '1'); if (!localStorage.getItem('ml_lang')) localStorage.setItem('ml_lang', 'en'); } catch {}
    window.__copied = [];
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } }, configurable: true }); } catch {}
    if (admin) { localStorage.setItem('ml_admin_jwt', token); localStorage.setItem('ml_admin_info', JSON.stringify({ id: 1, username: 'boss', role: 'super_admin' })); }
  }, [admin, token]);
  await ctx.route(/calendar-api|googlesyndication|fonts\.g|challenges\.cloudflare/, (r) => r.abort());
  await ctx.route('https://api.maralyrics.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    const res = await app.fetch(new Request(`https://api.test${u.pathname}${u.search}`, { method: req.method(), headers: req.headers(), body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() }), ENV);
    route.fulfill({ status: res.status, headers: { ...cors, 'content-type': res.headers.get('content-type') || 'application/json' }, body: Buffer.from(await res.arrayBuffer()) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { fail++; console.error(`  ✗ page error: ${e.message}`); });
  return { ctx, page };
}

// What is drawn: every line as { chords: [...], texts: [...] } (the text of each column), read from the page.
const drawn = (page) => page.evaluate(() => [...document.querySelectorAll('#songLyrics .gn-line')].map((row) => ({
  cls: row.className,
  chords: [...row.querySelectorAll('.gn-chord')].map((c) => c.textContent),
  texts: [...row.querySelectorAll('.gn-text')].map((t) => t.textContent),
  plain: row.classList.contains('gn-line--plain') || row.classList.contains('gn-line--blank') ? row.textContent : null,
})));
const chordsOf = async (page) => (await drawn(page)).flatMap((l) => l.chords).filter(Boolean);
const lyricsShown = async (page) => (await drawn(page)).map((l) => (l.plain !== null ? l.plain : l.texts.join(''))).join('\n');
const openSong = async (page, slug) => { await page.goto(`${SITE}/song/${slug}`); await page.waitForSelector('#songDetail', { state: 'visible' }); await sleep(150); };
const status = (page) => page.textContent('#gnStatus').then((t) => t.trim());

try {
  // ═══ Song page: chords above the lyrics ═════════════════════════════════════
  section('Song page: chords above the lyrics');
  const { page: P } = await openPage();
  await openSong(P, 'falling');
  ok(await P.locator('#guitarNode').isVisible(), 'a song with chords shows the Guitar Node panel');
  ok((await P.textContent('#gnOriginal')).trim() === 'C Major', 'the original key is shown (C Major)');
  ok(await P.inputValue('#gnKey') === '0', 'the display key starts at the original key');
  ok((await P.locator('#gnKey option').allTextContents()).length === 12 && (await P.locator('#gnKey option').allTextContents())[0].includes('(original)'), 'the key list has 12 keys, the original marked');
  let lines = await drawn(P);
  ok(lines.length === 4, `the four lyric lines are drawn (${lines.length})`);
  ok(JSON.stringify(lines[0].chords) === JSON.stringify(['C', 'Em', 'Am', 'F', 'C']) && lines[0].texts[1].startsWith('say') && lines[0].texts[0] === 'Wise men ', 'chords are above the words they were written for (Em above "say")');
  ok(JSON.stringify(lines[1].chords) === JSON.stringify(['F', 'C', 'G7', 'C']), 'second line chords');
  ok(lines[2].plain === '' && lines[2].cls.includes('gn-line--blank'), 'the blank line between verses is kept');
  ok(JSON.stringify(lines[3].chords) === JSON.stringify(['C', 'Em', 'Am/C', 'Dm7']), 'slash and seventh chords are shown as written');
  ok(await lyricsShown(P) === FALLING, 'the lyrics shown are exactly the stored lyrics (chords added on top, nothing changed)');
  // alignment, measured: every chord sits directly above the start of its words and chords never overlap
  const geometry = await P.evaluate(() => {
    const out = { misaligned: 0, notAbove: 0, overlaps: 0, segs: 0 };
    document.querySelectorAll('#songLyrics .gn-line').forEach((row) => {
      const rects = [];
      row.querySelectorAll('.gn-seg').forEach((seg) => {
        out.segs++;
        const c = seg.querySelector('.gn-chord').getBoundingClientRect();
        const t = seg.querySelector('.gn-text').getBoundingClientRect();
        if (Math.abs(c.left - t.left) > 1.5) out.misaligned++;
        if (c.bottom > t.top + 1.5) out.notAbove++;
        if (seg.querySelector('.gn-chord').textContent) rects.push(c);
      });
      rects.sort((a, b) => a.top - b.top || a.left - b.left);
      for (let i = 1; i < rects.length; i++) if (Math.abs(rects[i].top - rects[i - 1].top) < 4 && rects[i].left < rects[i - 1].right - 0.5) out.overlaps++;
    });
    return out;
  });
  ok(geometry.segs > 8 && geometry.misaligned === 0 && geometry.notAbove === 0 && geometry.overlaps === 0, `each chord is above the start of its words, none overlap (${JSON.stringify(geometry)})`);
  if (process.env.E2E_SHOTS) await P.screenshot({ path: `${process.env.E2E_SHOTS}/gn-desktop.png` });

  // ═══ Transposing ═══════════════════════════════════════════════════════════
  section('Changing the key');
  await P.selectOption('#gnKey', '2'); // D
  ok((await chordsOf(P)).join(' ') === 'D F#m Bm G D G D A7 D D F#m Bm/D Em7', `C → D: ${(await chordsOf(P)).join(' ')}`);
  ok(await lyricsShown(P) === FALLING, 'the lyrics are unchanged after transposing');
  ok((await status(P)).includes('D Major') && (await status(P)).includes('+2'), `the status says what is shown ("${await status(P)}")`);
  await P.click('#gnUp');
  ok(await P.inputValue('#gnKey') === '3' && (await chordsOf(P)).slice(0, 3).join(' ') === 'Eb Gm Cm', `+ Semitone: D → Eb: ${(await chordsOf(P)).slice(0, 3).join(' ')}`);
  await P.click('#gnDown'); await P.click('#gnDown'); await P.click('#gnDown');
  ok(await P.inputValue('#gnKey') === '0' && (await chordsOf(P)).slice(0, 3).join(' ') === 'C Em Am', 'three − Semitone presses go back to C');
  await P.click('#gnDown');
  ok(await P.inputValue('#gnKey') === '11' && (await chordsOf(P)).slice(0, 3).join(' ') === 'B D#m G#m', `− Semitone below the original: B (${(await chordsOf(P)).slice(0, 3).join(' ')})`);
  await P.selectOption('#gnKey', '8'); // Ab
  ok((await chordsOf(P)).slice(0, 6).join(' ') === 'Ab Cm Fm Db Ab Db', `a flat key spells with flats: ${(await chordsOf(P)).slice(0, 6).join(' ')}`);
  ok(await P.locator('#gnReset').isEnabled(), 'Reset is available once the key is changed');
  await P.click('#gnReset');
  ok(await P.inputValue('#gnKey') === '0' && (await chordsOf(P)).join(' ') === 'C Em Am F C F C G7 C C Em Am/C Dm7', 'Reset restores the original chords exactly');
  ok(await P.locator('#gnReset').isDisabled() && (await status(P)).includes('original key'), 'Reset is off at the original key, and the status says "original"');
  // the stored data is never touched
  const dbRow = row(`SELECT chords, lyrics, original_key FROM songs WHERE slug = 'falling'`);
  ok(JSON.parse(dbRow.chords).lines['0'][1][1] === 'Em' && dbRow.lyrics === FALLING && dbRow.original_key === 'C', 'the song in the database is unchanged by all that');

  // ═══ Remembering, hiding ═══════════════════════════════════════════════════
  section('Remembered choices, hide / show');
  await P.selectOption('#gnKey', '7'); // G
  await P.reload(); await P.waitForSelector('#songDetail', { state: 'visible' }); await sleep(200);
  ok(await P.inputValue('#gnKey') === '7' && (await chordsOf(P))[0] === 'G', 'a reload keeps the key chosen for this song');
  await openSong(P, 'sad-waltz');
  ok((await P.textContent('#gnOriginal')).trim() === 'A Minor' && await P.inputValue('#gnKey') === '9', 'another song starts at its own original key');
  await openSong(P, 'falling');
  ok(await P.inputValue('#gnKey') === '7', '… and the first song still remembers G');
  await P.click('#gnToggle');
  ok((await P.locator('#songLyrics .gn-chord').count()) === 0 && (await P.textContent('#songLyrics')).includes('Wise men say') && await P.locator('#gnControls').isHidden(), 'Hide chords: plain lyrics, key controls hidden');
  ok((await P.getAttribute('#gnToggle', 'aria-pressed')) === 'false' && (await P.textContent('#gnToggle')).includes('Show'), '(the button now says Show chords)');
  await P.reload(); await P.waitForSelector('#songDetail', { state: 'visible' }); await sleep(200);
  ok((await P.locator('#songLyrics .gn-chord').count()) === 0, 'hidden stays hidden after a reload');
  await P.click('#gnToggle');
  ok((await chordsOf(P))[0] === 'G', 'Show chords brings them back, in the remembered key');
  await P.click('#gnReset');

  // ═══ Minor keys ════════════════════════════════════════════════════════════
  section('Minor keys, unknown keys, songs without chords');
  await openSong(P, 'sad-waltz');
  ok((await chordsOf(P)).join(' ') === 'Am Dm E7 Am', 'A minor song as written');
  await P.selectOption('#gnKey', '11'); // B minor
  ok((await P.locator('#gnKey option').allTextContents())[0].includes('C Minor'), 'a minor song is offered minor keys');
  ok((await chordsOf(P)).join(' ') === 'Bm Em F#7 Bm', `A minor → B minor keeps minor, major and seventh chords: ${(await chordsOf(P)).join(' ')}`);
  await P.selectOption('#gnKey', '0'); // C minor
  ok((await chordsOf(P)).join(' ') === 'Cm Fm G7 Cm', `A minor → C minor: ${(await chordsOf(P)).join(' ')}`);
  await P.click('#gnReset');

  await openSong(P, 'mystery-key');
  ok((await P.textContent('#gnOriginal')).trim() === 'not set' && await P.locator('#gnKeyField').isHidden(), 'a song with chords but no key: "not set", and no key list (nothing is guessed)');
  ok((await chordsOf(P)).join(' ') === 'Bb F/A Gm7 C7', 'its chords are shown as written');
  await P.click('#gnUp'); await P.click('#gnUp');
  ok((await chordsOf(P)).join(' ') === 'C G/B Am7 D7' && (await status(P)).includes('+2'), `+2 semitones: ${(await chordsOf(P)).join(' ')} (${await status(P)})`);
  await P.click('#gnReset');
  await P.click('#gnDown');
  ok((await chordsOf(P)).join(' ') === 'A E/Ab Gbm7 B7', `−1 semitone with no key keeps the flat spelling the song was written with: ${(await chordsOf(P)).join(' ')}`);
  await P.click('#gnReset');

  await openSong(P, 'plain-song');
  ok(await P.locator('#guitarNode').isHidden() && (await P.locator('#songLyrics .gn-line').count()) === 0 && (await P.textContent('#songLyrics')) === 'No chords here\nJust words', 'a song without chords looks exactly as before: no panel, plain lyrics');

  await openSong(P, 'intro-song');
  lines = await drawn(P);
  ok(lines[0].cls.includes('gn-line--chords') || lines[0].chords.length === 3, 'a line with only chords (an intro) is drawn as a row of chords');
  ok(!(await P.textContent('#songLyrics')).includes('undefined'), '(no stray text)');
  await P.click('#gnToggle');
  ok(!/^\s*\n/.test(await P.evaluate(() => document.getElementById('songLyrics').textContent)) && (await P.textContent('#songLyrics')).startsWith('First line'), 'with chords hidden, the chord-only intro line is left out of the plain lyrics');
  await P.click('#gnToggle');

  await openSong(P, 'burmese-song');
  const bur = await drawn(P);
  ok(bur[0].texts.join('') === 'မြန်မာနိုင်ငံ' && bur[0].chords.join(' ') === 'D A', 'Burmese lyrics keep their letters together when chords are placed');

  // ═══ Copy ══════════════════════════════════════════════════════════════════
  section('Copy, keyboard, downloads');
  await openSong(P, 'falling');
  await P.selectOption('#gnKey', '2');
  await P.click('#btnCopyLyrics');
  const copied = await P.evaluate(() => window.__copied.at(-1));
  ok(copied.split('\n')[0].trim().startsWith('D') && copied.includes('Wise men say only fools rush in') && copied.includes('F#m'), 'Copy gives the lyrics with the chords above them, in the key being shown');
  await P.click('#gnToggle');
  await P.click('#btnCopyLyrics');
  ok((await P.evaluate(() => window.__copied.at(-1))) === FALLING, 'with chords hidden, Copy gives just the lyrics');
  await P.click('#gnToggle'); await P.click('#gnReset');

  await P.focus('#gnKey');
  await P.keyboard.press('ArrowDown');
  ok((await P.inputValue('#gnKey')) !== '0' && (await chordsOf(P))[0] !== 'C', 'the key list works from the keyboard');
  await P.focus('#gnUp'); await P.keyboard.press('Enter');
  await P.focus('#gnReset'); await P.keyboard.press('Space');
  ok(await P.inputValue('#gnKey') === '0', 'the buttons work from the keyboard (Enter, Space)');
  ok(await P.getAttribute('#gnStatus', 'aria-live') === 'polite' && await P.getAttribute('#gnDown', 'aria-label') === 'Down one semitone', 'a polite live region announces the key, and the buttons have names');
  ok(await P.getAttribute('#songLyrics', 'role') === 'group' && (await P.getAttribute('#songLyrics', 'aria-label')).includes('chords'), 'the lyrics area is labelled for screen readers');
  const labelFor = await P.evaluate(() => document.querySelector('label[for="gnKey"]')?.textContent.trim());
  ok(labelFor === 'Display key', 'the key list has a visible label');

  await P.click('#btnDownloadSong');
  await P.waitForFunction(() => Downloads.has('falling'), null, { timeout: 5000 });
  const kept = await P.evaluate(() => Downloads.get('falling').then((s) => ({ key: s.original_key, chords: !!(s.chords && s.chords.lines) })));
  ok(kept.key === 'C' && kept.chords, 'a downloaded song keeps its key and chords for offline use');

  // ═══ Phone ═════════════════════════════════════════════════════════════════
  section('On a phone');
  const { page: M } = await openPage({ viewport: { width: 360, height: 740 } });
  await openSong(M, 'falling');
  await M.selectOption('#gnKey', '6'); // F#
  const phone = await M.evaluate(() => {
    const box = document.getElementById('songLyrics').getBoundingClientRect();
    const rects = [...document.querySelectorAll('#songLyrics .gn-chord')].filter((c) => c.textContent).map((c) => c.getBoundingClientRect());
    return {
      noSideScroll: document.documentElement.scrollWidth <= window.innerWidth,
      insideColumn: rects.every((r) => r.right <= window.innerWidth + 0.5 && r.left >= -0.5),
      buttons: [...document.querySelectorAll('.guitar-node__btn, .guitar-node__select')].map((b) => Math.round(b.getBoundingClientRect().height)),
      lineWidth: Math.round(box.width),
    };
  });
  ok(phone.noSideScroll && phone.insideColumn, `no sideways scroll, every chord inside the screen (lyrics ${phone.lineWidth}px wide)`);
  ok(phone.buttons.every((h) => h >= 44), `buttons and the key list are at least 44px tall (${phone.buttons.join(', ')})`);
  ok((await lyricsShown(M)) === FALLING, 'the lyrics are intact on a narrow screen');
  const phoneGeo = await M.evaluate(() => { let bad = 0; document.querySelectorAll('#songLyrics .gn-seg').forEach((seg) => { const c = seg.querySelector('.gn-chord').getBoundingClientRect(); const t = seg.querySelector('.gn-text').getBoundingClientRect(); if (Math.abs(c.left - t.left) > 1.5 || c.bottom > t.top + 1.5) bad++; }); return bad; });
  ok(phoneGeo === 0, 'chords stay above their words when lines wrap');
  if (process.env.E2E_SHOTS) await M.screenshot({ path: `${process.env.E2E_SHOTS}/gn-phone.png`, fullPage: true });
  const { page: T } = await openPage({ viewport: { width: 768, height: 1024 } });
  await openSong(T, 'falling');
  ok(await T.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth) && (await lyricsShown(T)) === FALLING, 'a tablet screen works too');
  // light theme: the chords are readable (not the pale dark-theme colour)
  await T.evaluate(() => Theme.setMode('light'));
  const colour = await T.evaluate(() => getComputedStyle(document.querySelector('.gn-chord')).color);
  ok(colour === 'rgb(91, 33, 182)', `light theme: darker chord colour (${colour})`);

  // ═══ Admin ═════════════════════════════════════════════════════════════════
  section('Open in the Android app');
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
  const FALLBACK = encodeURIComponent('https://play.google.com/store/apps/details?id=com.maralyrics.laitei');
  const intentFor = (slug) => `intent://maralyrics.com/song/${encodeURIComponent(slug)}#Intent;scheme=https;package=com.maralyrics.laitei;S.browser_fallback_url=${FALLBACK};end`;
  const { page: D } = await openPage();
  await openSong(D, 'falling');
  ok(await D.locator('#btnOpenInApp').isHidden(), 'the button is not shown on a desktop browser');
  const { page: AA } = await openPage({ viewport: { width: 360, height: 740 }, userAgent: ANDROID });
  let urlBefore = AA.url();
  await openSong(AA, 'falling');
  ok(await AA.locator('#btnOpenInApp').isVisible(), 'the button is shown on an Android browser');
  ok((await AA.getAttribute('#btnOpenInApp', 'href')) === intentFor('falling'), 'its link is the Android intent URL for this song');
  ok((await AA.textContent('#btnOpenInApp')).trim() === 'Open in the Mara Lyrics app' && await AA.evaluate(() => document.getElementById('btnOpenInApp').tagName === 'A'), 'it is a real link with the English text');
  if (process.env.E2E_SHOTS) { await AA.locator('#btnOpenInApp').scrollIntoViewIfNeeded(); await AA.screenshot({ path: `${process.env.E2E_SHOTS}/open-in-app.png` }); }
  await AA.focus('#btnOpenInApp');
  ok(await AA.evaluate(() => document.activeElement && document.activeElement.id === 'btnOpenInApp'), 'it can be reached with the keyboard');
  ok(await AA.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on a phone');
  ok(AA.url().endsWith('/song/falling'), 'the page does not redirect by itself');
  // real slugs are plain, but the link must still survive one that is not (space, &, =, ;, an accented letter)
  const oddHref = await AA.evaluate(() => Utils.androidAppIntentUrl('odd slug&x=1;y é'));
  ok(oddHref === intentFor('odd slug&x=1;y é') && oddHref.startsWith('intent://maralyrics.com/song/odd%20slug%26x%3D1%3By%20%C3%A9#Intent;'), `a slug that needs escaping is encoded (${oddHref.slice(0, 70)}…)`);
  await openSong(AA, 'plain-song');
  ok((await AA.getAttribute('#btnOpenInApp', 'href')) === intentFor('plain-song'), 'another song gets its own link (never the previous one)');
  const links = JSON.parse(fs.readFileSync(path.join(PUB, '.well-known/assetlinks.json'), 'utf8'));
  const pkgs = links.map((l) => l.target.package_name);
  ok(Array.isArray(links) && pkgs.includes('com.maralyrics.admin') && pkgs.includes('com.maralyrics.laitei'), 'assetlinks.json vouches for both apps');
  const laitei = links.find((l) => l.target.package_name === 'com.maralyrics.laitei');
  ok(laitei.relation.join() === 'delegate_permission/common.handle_all_urls' && laitei.target.namespace === 'android_app' && laitei.target.sha256_cert_fingerprints.length >= 1 && laitei.target.sha256_cert_fingerprints.every((f) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f)), 'the app\'s statement is well formed (31 colons per fingerprint)');

  section('Admin: key and chords in the song form');
  const { page: A } = await openPage({ admin: true, token: adminToken });
  await A.goto(`${SITE}/admin/`);
  await A.waitForSelector('#songsTableBody tr[data-id]', { timeout: 10000 });
  ok((await A.textContent('#songsTableBody')).includes('🎸'), 'the song list marks songs that have chords (🎸 and the key)');
  await A.click('#btnNewSong');
  await A.waitForSelector('#songModal', { state: 'visible' });
  ok(await A.locator('#gnAdminBody').isHidden() && await A.locator('#formLyricsChordNote').isHidden(), 'a new song starts without chords: no chord sheet, and no "lyrics are written in the chord sheet" note');
  ok(await A.evaluate(() => getComputedStyle(document.getElementById('gnAdmin')).borderTopStyle === 'solid' && getComputedStyle(document.getElementById('gnAdmin')).borderTopWidth === '1px'), 'the Guitar Node box is styled by the dashboard stylesheet (not the browser default)');
  ok((await A.locator('#formOriginalKey option').count()) === 25, 'the key list holds Unknown + 12 major + 12 minor keys');
  await A.fill('#formTitle', 'Test Hymn');
  await A.selectOption('#formOriginalKey', 'G');
  await A.check('#formChordsOn');
  ok(await A.locator('#formLyricsChordNote').isVisible(), 'the note about where the lyrics are written appears once chords are on');
  ok(await A.locator('#gnAdminBody').isVisible() && await A.locator('#formLyrics').evaluate((el) => el.readOnly), 'ticking "has guitar chords" opens the chord sheet; the Lyrics box becomes read-only');
  const palette = await A.locator('#gnPalette button').allTextContents();
  ok(palette.join(' ') === 'G Am Bm C D D7 Em F#dim', `the palette offers the chords of the key (${palette.join(' ')})`);
  await A.fill('#formChordSheet', '[G]Amazing [C]grace how [D]sweet the sound\n[G]That saved a [Em]wretch like [D]me\n\n[Chorus]\n[G] [C] [D] [G]\n[Bridgez]oops');
  await sleep(300);
  ok(await A.locator('#gnAdminErrors').isVisible() && (await A.textContent('#gnAdminErrors')).includes('Bridgez'), 'a mistyped chord is reported, naming the chord and the line');
  await A.click('#btnSubmit');
  await sleep(300);
  ok((await A.textContent('#formMessage')).includes('Fix the guitar chords') && !row(`SELECT 1 AS x FROM songs WHERE title = 'Test Hymn'`), 'saving is blocked until the mistake is fixed');
  await A.fill('#formChordSheet', '[G]Amazing [C]grace how [D]sweet the sound\n[G]That saved a [Em]wretch like [D]me\n\n[Chorus]\n[G] [C] [D] [G]');
  await sleep(300);
  ok(await A.locator('#gnAdminErrors').isHidden(), 'the message goes away when it is fixed');
  ok((await A.inputValue('#formLyrics')) === 'Amazing grace how sweet the sound\nThat saved a wretch like me\n\n[Chorus]\n', 'the Lyrics box shows the words only (the [Chorus] label stays, the chord-only line is an empty line)');
  const preview = await A.evaluate(() => [...document.querySelectorAll('#gnAdminPreview .gn-chord')].map((c) => c.textContent).filter(Boolean).join(' '));
  ok(preview === 'G C D G Em D G C D G', `the live preview draws the chords (${preview})`);
  if (process.env.E2E_SHOTS) {
    await A.evaluate(() => document.getElementById('gnAdmin').scrollIntoView({ block: 'start' }));
    await A.screenshot({ path: `${process.env.E2E_SHOTS}/gn-admin-form-top.png` });
    await A.locator('#gnAdmin').scrollIntoViewIfNeeded();
    await A.screenshot({ path: `${process.env.E2E_SHOTS}/gn-admin-form.png` });
    await A.evaluate(() => { const m = document.querySelector('#songModal .modal__content'); m.scrollTop = m.scrollHeight; });
    await A.screenshot({ path: `${process.env.E2E_SHOTS}/gn-admin-form-bottom.png` });
  }
  await A.selectOption('#gnPreviewKey', 'A');
  const previewA = await A.evaluate(() => [...document.querySelectorAll('#gnAdminPreview .gn-chord')].map((c) => c.textContent).filter(Boolean).slice(0, 4).join(' '));
  ok(previewA === 'A D E A', `…and can show it in another key without saving anything (${previewA})`);
  await A.click('#gnPalette button:nth-child(5)'); // D inserted at the cursor
  ok((await A.inputValue('#formChordSheet')).includes('[D]') && (await A.inputValue('#formChordSheet')).length > 100, 'a palette button puts the chord into the sheet');
  // a long sheet, caret in the middle: adding a chord must not throw the caret to the end or scroll the sheet / dialog
  const long = Array.from({ length: 60 }, (_, i) => `[G]Line ${i} of the [C]song goes on`).join('\n');
  await A.fill('#formChordSheet', long);
  await sleep(250);
  const caretBefore = await A.evaluate(() => {
    const a = document.getElementById('formChordSheet');
    const m = a.closest('.modal__content');
    const pos = a.value.indexOf('Line 30 ') + 4;
    a.focus(); a.setSelectionRange(pos, pos);
    a.scrollTop = 200; m.scrollTop = Math.max(0, m.scrollTop);
    return { pos, area: a.scrollTop, dialog: m.scrollTop, length: a.value.length };
  });
  await A.click('#gnPalette button:nth-child(5)');
  const caretAfter = await A.evaluate(() => {
    const a = document.getElementById('formChordSheet');
    return { start: a.selectionStart, end: a.selectionEnd, area: a.scrollTop, dialog: a.closest('.modal__content').scrollTop, value: a.value, active: document.activeElement === a };
  });
  ok(caretAfter.value.slice(caretBefore.pos, caretBefore.pos + 3) === '[D]' && caretAfter.value.length === caretBefore.length + 3, 'a palette chord goes in at the caret, not at the end');
  ok(caretAfter.start === caretBefore.pos + 3 && caretAfter.end === caretAfter.start && caretAfter.active, `the caret stays right after the chord (${caretAfter.start} vs ${caretBefore.pos + 3}), in the sheet`);
  ok(caretAfter.area === caretBefore.area, `the sheet does not scroll (${caretBefore.area} → ${caretAfter.area})`);
  ok(Math.abs(caretAfter.dialog - caretBefore.dialog) <= 1, `the dialog does not scroll (${caretBefore.dialog} → ${caretAfter.dialog})`);
  await A.keyboard.press('Control+z');
  ok((await A.inputValue('#formChordSheet')).length === caretBefore.length, 'Ctrl+Z takes the chord back');
  await A.fill('#formChordSheet', 'G       C\nAmazing grace how sweet\n\nD   G\nthe sound');
  await A.click('#gnConvert');
  ok((await A.inputValue('#formChordSheet')) === '[G]Amazing [C]grace how sweet\n\n[D]the [G]sound', 'a sheet with the chords printed above the words is converted into bracket chords');
  await A.fill('#formChordSheet', '[G]Amazing [C]grace how [D]sweet the sound\n[G]That saved a [Em]wretch like [D]me\n\n[G] [C] [D] [G]');
  await sleep(250);
  await A.click('#btnSubmit');
  await A.waitForFunction(() => document.getElementById('formMessage').textContent.includes('created'), null, { timeout: 8000 });
  const saved = row(`SELECT lyrics, original_key, chords FROM songs WHERE title = 'Test Hymn'`);
  ok(saved && saved.original_key === 'G' && !saved.lyrics.includes('[') && saved.lyrics.startsWith('Amazing grace how sweet the sound'), 'saved: the key, and lyrics without any chord brackets');
  const savedChords = JSON.parse(saved.chords);
  ok(savedChords.v === 1 && JSON.stringify(savedChords.lines['0']) === JSON.stringify([[0, 'G'], [8, 'C'], [18, 'D']]) && JSON.stringify(savedChords.lines['3']) === JSON.stringify([[0, 'G'], [0, 'C'], [0, 'D'], [0, 'G']]), 'saved: structured chord positions (and the chord-only line at the left)');

  section('Admin: editing and removing');
  await sleep(1200);
  await A.waitForSelector('#songsTableBody tr[data-id]');
  const id = row(`SELECT id FROM songs WHERE title = 'Test Hymn'`).id;
  await A.evaluate((i) => editSong(i), id);
  await A.waitForSelector('#songModal', { state: 'visible' });
  await A.waitForFunction(() => document.getElementById('formTitle').value === 'Test Hymn');
  ok(await A.inputValue('#formOriginalKey') === 'G' && await A.locator('#formChordsOn').isChecked(), 'opening the song again shows its key and that it has chords');
  ok((await A.inputValue('#formChordSheet')).startsWith('[G]Amazing [C]grace how [D]sweet the sound'), 'the chord sheet is rebuilt with every chord at its place');
  await A.fill('#formChordSheet', (await A.inputValue('#formChordSheet')).replace('[Em]wretch', '[Em7]wretch'));
  await sleep(250);
  await A.click('#btnSubmit');
  await A.waitForFunction(() => document.getElementById('formMessage').textContent.includes('updated'), null, { timeout: 8000 });
  ok(JSON.parse(row(`SELECT chords FROM songs WHERE id = ?`, id).chords).lines['1'][1][1] === 'Em7', 'a change to one chord is saved');
  await sleep(1200);
  await A.evaluate((i) => editSong(i), id);
  await A.waitForFunction(() => document.getElementById('formTitle').value === 'Test Hymn' && document.getElementById('formChordsOn').checked);
  A.once('dialog', (d) => d.accept());
  await A.uncheck('#formChordsOn');
  ok(await A.locator('#gnAdminBody').isHidden() && !(await A.locator('#formLyrics').evaluate((el) => el.readOnly)) && (await A.inputValue('#formLyrics')).startsWith('Amazing grace'), 'unticking removes the chord sheet and gives the lyrics back as plain, editable text');
  await A.click('#btnSubmit');
  await A.waitForFunction(() => document.getElementById('formMessage').textContent.includes('updated'), null, { timeout: 8000 });
  const after = row(`SELECT lyrics, original_key, chords FROM songs WHERE id = ?`, id);
  ok(after.chords === null && after.original_key === 'G' && after.lyrics.startsWith('Amazing grace how sweet the sound'), 'the chords are removed; the lyrics and the key stay');
  await sleep(1200);
  await A.evaluate((i) => editSong(i), id);
  await A.waitForFunction(() => document.getElementById('formTitle').value === 'Test Hymn');
  await A.selectOption('#formOriginalKey', '');
  await A.click('#btnSubmit');
  await A.waitForFunction(() => document.getElementById('formMessage').textContent.includes('updated'), null, { timeout: 8000 });
  ok(row(`SELECT original_key FROM songs WHERE id = ?`, id).original_key === null, 'the key can be set back to "unknown"');
  // editing a song with chords: the old song has them and the form must not lose them when only the title changes
  await sleep(1200);
  const fid = row(`SELECT id FROM songs WHERE slug = 'falling'`).id;
  await A.evaluate((i) => editSong(i), fid);
  await A.waitForFunction(() => document.getElementById('formTitle').value === 'Falling' && document.getElementById('formChordsOn').checked);
  await A.fill('#formTitle', 'Falling (edited)');
  await A.click('#btnSubmit');
  await A.waitForFunction(() => document.getElementById('formMessage').textContent.includes('updated'), null, { timeout: 8000 });
  const kept2 = row(`SELECT chords, lyrics, original_key FROM songs WHERE id = ?`, fid);
  ok(JSON.stringify(JSON.parse(kept2.chords)) === JSON.stringify(FALLING_CHORDS) && kept2.lyrics === FALLING && kept2.original_key === 'C', 'saving an edit that only changes the title keeps the chords and lyrics byte for byte');

  // ═══ The dashboard's offline copy must never be older than the page ═════════
  section('Admin: a new deploy is picked up at once (offline cache)');
  const { page: W, ctx: WC } = await openPage({ admin: true, token: adminToken, serviceWorkers: 'allow' });
  await W.goto(`${SITE}/admin/`);
  await W.waitForSelector('#songsTableBody tr[data-id]', { timeout: 10000 });
  await W.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 8000 }).catch(async () => { await W.reload(); await W.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 8000 }); });
  ok(await W.evaluate(() => !!navigator.serviceWorker.controller), 'the dashboard\'s service worker is running');
  adminCssMarker = '\n/* deployed-v2 */';
  const served = await W.evaluate(() => fetch('/admin/index.css').then((r) => r.text()));
  ok(served.includes('deployed-v2'), 'after a deploy the dashboard gets the NEW stylesheet straight away (not last version\'s copy from the cache)');
  await W.reload();
  await W.waitForSelector('#songsTableBody tr[data-id]', { timeout: 10000 });
  ok((await W.evaluate(() => fetch('/admin/index.js').then((r) => r.text()))).includes('wireGuitarNodeAdmin'), 'and the new script');
  await WC.setOffline(true);
  const offline = await W.evaluate(() => Promise.all(['/admin/index.css', '/admin/index.js', '/chords.js'].map((u) => fetch(u).then((r) => r.status).catch(() => 'failed'))));
  ok(offline.every((st) => st === 200), `offline, the dashboard still has its files from the cache (${offline.join(', ')})`);
  await WC.setOffline(false);
  adminCssMarker = '';
} catch (err) {
  fail++;
  console.error(`  ✗ the test stopped early: ${String(err && err.message || err).split('\n').slice(0, 6).join('\n    ')}`);
  if (process.env.E2E_DEBUG) { for (const [i, c] of browser.contexts().entries()) for (const [j, pg] of c.pages().entries()) await pg.screenshot({ path: `${process.env.E2E_DEBUG}/gn-fail-${i}-${j}.png` }).catch(() => {}); }
} finally {
  console.log(fail ? `\n✗ ${fail} failed, ${pass} passed` : `\n✓ ${pass} browser checks passed`);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
}
