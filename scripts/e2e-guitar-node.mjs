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
async function openPage({ viewport = { width: 1100, height: 900 }, admin = false, token = '', serviceWorkers = 'block', userAgent, christmas = false } = {}) {
  const ctx = await browser.newContext({ serviceWorkers, viewport, permissions: [], ...(userAgent ? { userAgent } : {}) });
  await ctx.addInitScript(([admin, token, christmas]) => {
    try { localStorage.setItem('ml_cookie_consent', 'accepted'); localStorage.setItem('ml_calendar_pref_prompted', '1'); localStorage.setItem('ml_app_promo_seen', '1'); if (!christmas) localStorage.setItem('ml_christmas', 'off'); if (!localStorage.getItem('ml_lang')) localStorage.setItem('ml_lang', 'en'); } catch {}
    window.__copied = [];
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } }, configurable: true }); } catch {}
    if (admin) { localStorage.setItem('ml_admin_jwt', token); localStorage.setItem('ml_admin_info', JSON.stringify({ id: 1, username: 'boss', role: 'super_admin' })); }
  }, [admin, token, christmas]);
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

  section('Footer: the Mara Hymns promotion');
  const { page: H } = await openPage();
  const hymnalRequests = [];
  H.on('request', (r) => { if (/mkhb\.maralyrics\.com/.test(r.url())) hymnalRequests.push(r.url()); });
  await H.goto(`${SITE}/about`);
  await H.waitForSelector('.app-promotion--hymnal', { state: 'attached' });
  const banners = await H.evaluate(() => [...document.querySelectorAll('.footer .app-promotion')].map((b) => ({ hymnal: b.classList.contains('app-promotion--hymnal'), title: b.querySelector('.app-promotion__title').textContent.trim(), href: b.querySelector('a').getAttribute('href'), target: b.querySelector('a').target, rel: b.querySelector('a').rel, label: b.querySelector('a').textContent.trim(), labelledBy: document.getElementById(b.getAttribute('aria-labelledby'))?.textContent.trim() })));
  ok(banners.length === 2 && !banners[0].hymnal && banners[1].hymnal, 'the footer has the app banner and, under it, the Mara Hymns banner (neither replaced the other)');
  ok(banners[0].href.startsWith('https://play.google.com/store/apps/details?id=com.maralyrics.laitei'), 'the app banner still links to Google Play');
  ok(banners[1].title === 'Mara Hymns (Krizyhpa Hlabu)' && banners[1].labelledBy === banners[1].title, 'it is named Mara Hymns (Krizyhpa Hlabu), and the section is labelled by that heading');
  ok(banners[1].href === 'https://mkhb.maralyrics.com/' && banners[1].target === '_blank' && /\bnoopener\b/.test(banners[1].rel) && banners[1].label === 'Open Mara Hymns', 'it links to https://mkhb.maralyrics.com/ in a new tab (noopener) with the English text');
  ok(await H.evaluate(() => { const i = document.querySelector('.app-promotion--hymnal img'); return i.complete && i.naturalWidth > 0 && new URL(i.src).origin === location.origin; }), 'its icon is a local file that loads');
  ok(hymnalRequests.length === 0, 'the page loads nothing from mkhb.maralyrics.com (it is only a link)');
  ok(await H.evaluate(() => { const l = document.querySelector('.app-promotion--hymnal a'); const b = l.getBoundingClientRect(); return b.width >= 24 && b.height >= 24; }), 'the link is a comfortable tap target');
  await H.evaluate(() => I18n.setLanguage('my'));
  ok(await H.evaluate(() => ['.app-promotion--hymnal .app-promotion__title', '.app-promotion--hymnal .app-promotion__text', '.app-promotion--hymnal a'].every((q) => document.querySelector(q).textContent.trim().length > 0)), 'in a language that has no translation of it yet the text falls back to English instead of going blank');
  await H.evaluate(() => I18n.setLanguage('en'));
  await H.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  ok(await H.evaluate(() => getComputedStyle(document.querySelector('.app-promotion--hymnal a')).color === 'rgb(255, 255, 255)'), 'in the light theme the link keeps white text on its button');
  await H.goto(`${SITE}/`);
  await H.waitForSelector('.app-promotion--hymnal', { state: 'attached' });
  ok(await H.locator('.footer .app-promotion--hymnal').count() === 1, 'one banner on the home page too');
  const { page: HP } = await openPage({ viewport: { width: 360, height: 740 } });
  await HP.goto(`${SITE}/about`);
  await HP.waitForSelector('.app-promotion--hymnal', { state: 'attached' });
  ok(await HP.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on a phone');
  ok(await HP.evaluate(() => { const b = document.querySelector('.app-promotion--hymnal'); const l = b.querySelector('a').getBoundingClientRect(); const r = b.getBoundingClientRect(); return l.top >= b.querySelector('.app-promotion__copy').getBoundingClientRect().bottom - 1 && l.width >= r.width * 0.8; }), 'on a phone the button sits under the text, full width');
  if (process.env.E2E_SHOTS) { await HP.locator('.app-promotion--hymnal').scrollIntoViewIfNeeded(); await HP.screenshot({ path: `${process.env.E2E_SHOTS}/hymnal-promo.png` }); }

  section('Header: the logo and the brand name');
  // The logo and its name are one unit: on whole pixels, centred in the bar, lined up with the page, never squeezed or run into by the nav.
  const headerAt = async (width, theme = 'dark') => {
    const { page: HW, ctx: HC } = await openPage({ viewport: { width, height: 600 } });
    await HC.addInitScript((t) => { try { localStorage.setItem('ml_theme', t); } catch {} }, theme);
    await HW.goto(`${SITE}/`);
    await HW.waitForSelector('.header__logo');
    await sleep(250);
    const m = await HW.evaluate(() => {
      const box = (r) => ({ x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height });
      const header = document.querySelector('.header');
      const hcs = getComputedStyle(header);
      const logo = document.querySelector('.header__logo');
      const icon = logo.querySelector('.header__logo-icon');
      const range = document.createRange();
      range.selectNodeContents([...logo.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()));
      const container = document.querySelector('.container');
      const ccs = getComputedStyle(container);
      const nav = document.querySelector('.header__nav');
      const navShown = getComputedStyle(nav).display !== 'none';
      const items = navShown ? [...nav.children].filter((c) => getComputedStyle(c).display !== 'none') : [document.querySelector('.header__menu-btn')];
      return {
        header: box(header.getBoundingClientRect()), shadow: hcs.boxShadow, borderBottom: hcs.borderBottomWidth,
        logo: box(logo.getBoundingClientRect()), icon: box(icon.getBoundingClientRect()), text: box(range.getBoundingClientRect()), lines: range.getClientRects().length,
        contentLeft: container.getBoundingClientRect().left + parseFloat(ccs.paddingLeft), contentRight: container.getBoundingClientRect().right - parseFloat(ccs.paddingRight),
        firstItemLeft: Math.min(...items.map((e) => e.getBoundingClientRect().left)), lastItemRight: Math.max(...items.map((e) => e.getBoundingClientRect().right)),
        wrapped: [...document.querySelectorAll('.header__nav-link')].some((a) => getComputedStyle(nav).display !== 'none' && a.getBoundingClientRect().height > 36),
        navShown, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
      };
    });
    await HC.close();
    return m;
  };
  const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
  for (const width of [1920, 1440, 1100, 1024, 900, 840, 800, 769, 768, 600, 480, 390, 360, 320]) {
    const m = await headerAt(width);
    const innerH = m.header.h;                                   // the line under the header is inside it (an inset shadow), so this is the whole bar
    ok(m.header.h === 64 && m.borderBottom === '0px' && /inset/.test(m.shadow), `${width}px: the bar is 64px high with its line drawn inside (no border taking a pixel of the height)`);
    ok(Number.isInteger(m.logo.y) && Number.isInteger(m.icon.y) && near(m.logo.y, (innerH - 32) / 2) && near(m.icon.y, m.logo.y), `${width}px: the logo sits on whole pixels, centred in the bar (top ${m.logo.y}px, ${innerH - m.logo.b}px below)`);
    ok(near((m.text.y + m.text.b) / 2, (m.icon.y + m.icon.b) / 2, 0.6) && m.lines === 1, `${width}px: the name is centred on the logo and on one line (centres ${((m.text.y + m.text.b) / 2).toFixed(1)} and ${((m.icon.y + m.icon.b) / 2).toFixed(1)})`);
    ok(near(m.text.x - m.icon.r, 10, 0.05) && m.logo.w > 150, `${width}px: a steady 10px between the logo and its name, and the unit is never squeezed (${m.logo.w.toFixed(1)}px wide)`);
    ok(near(m.logo.x, m.contentLeft) && near(m.lastItemRight, m.contentRight, 0.6), `${width}px: the bar lines up with the page, the logo on the content's left edge (${m.logo.x}px) and the last button on its right edge`);
    ok(!m.navShown || (m.firstItemLeft - m.logo.r >= 12 && !m.wrapped), `${width}px: ${m.navShown ? `the nav keeps clear of the logo (${(m.firstItemLeft - m.logo.r).toFixed(0)}px) and no link wraps` : 'the menu button replaces the nav'}`);
    if (width <= 768) ok(near(m.logo.y, m.logo.x), `${width}px: the same 16px above the logo as at its left`);
    ok(m.scrollW <= m.innerW, `${width}px: no sideways scroll`);
  }
  { const m = await headerAt(1280, 'light'); ok(m.header.h === 64 && /inset/.test(m.shadow) && /0\.06|rgba\(0, 0, 0, 0\.06\)/.test(m.shadow), `light theme: the line under the bar is still there, in its own colour (${m.shadow.slice(0, 40)})`); }

  section('Christmas theme (13 November – 31 December 2026)');
  // The page's clock is set to a day of the test's choosing (Date only; timers keep running).
  const clockAt = (iso) => `(() => { const Real = Date; const fixed = new Real('${iso}').getTime(); class FakeDate extends Real { constructor(...a) { if (a.length === 0) super(fixed); else super(...a); } static now() { return fixed; } } window.Date = FakeDate; })();`;
  // Where the Santa hat is: its brim must lie across the top of the logo (the hat is worn, not floating beside it) and none of it may
  // be cut off by the top of the page. The hat is a 40 × 28 picture in a box placed over the logo; these are points of that picture.
  const hatPoints = (page) => page.evaluate(() => {
    const logo = document.querySelector('.header__logo');
    const icon = logo.querySelector('.header__logo-icon').getBoundingClientRect();
    const r = logo.getBoundingClientRect();
    const cs = getComputedStyle(logo, '::after');
    const left = r.left + parseFloat(cs.left);
    const top = r.top + parseFloat(cs.top);
    const w = parseFloat(cs.width);
    const h = parseFloat(cs.height);
    const [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat);
    const m = new DOMMatrix(cs.transform);
    const at = (vx, vy) => { const x = (vx * w) / 40 - ox; const y = (vy * h) / 28 - oy; return [left + ox + m.a * x + m.c * y, top + oy + m.b * x + m.d * y]; };
    return { icon: { x: icon.left, y: icon.top, w: icon.width, h: icon.height }, tip: at(22, 3.5), pom: at(35, 8.1), brimLeft: at(6, 22), brimRight: at(34, 22), brimMiddle: at(20, 22.25), shown: cs.backgroundImage.includes('svg') && cs.content !== 'none' };
  });
  const hatIsWorn = (hat) => hat.shown
    && hat.brimMiddle[0] > hat.icon.x + hat.icon.w * 0.2 && hat.brimMiddle[0] < hat.icon.x + hat.icon.w * 0.8      // across the middle of the head…
    && hat.brimMiddle[1] > hat.icon.y && hat.brimMiddle[1] < hat.icon.y + hat.icon.h * 0.45                       // …in its top part
    && hat.tip[1] < hat.icon.y && hat.pom[1] < hat.icon.y                                                         // the cone and the pom-pom rise above it
    && hat.brimLeft[0] > hat.icon.x - 8 && hat.brimRight[0] < hat.icon.x + hat.icon.w + 8;                        // and it is no wider than the head, give or take
  const hatIsInView = (hat) => [hat.tip, hat.pom, hat.brimLeft, hat.brimRight].every(([x, y]) => x >= 0 && y >= 1);
  const xmasOn = (page) => page.evaluate(() => document.documentElement.getAttribute('data-season') === 'christmas' && !!document.querySelector('.xmas-scene'));
  const visit = async (iso, url = '/', opts = {}) => {
    const made = await openPage({ christmas: true, ...opts });
    await made.ctx.addInitScript(clockAt(iso));
    await made.page.goto(`${SITE}${url}`);
    await made.page.waitForSelector('.footer', { state: 'attached' });
    await sleep(250);
    return made;
  };
  // the days either side of the season, on the real page
  for (const [iso, on, label] of [['2026-06-15T12:00:00', false, '15 June'], ['2026-11-12T23:59:00', false, '12 November, 23:59'], ['2026-11-13T00:00:00', true, '13 November, midnight (the first day)'], ['2026-11-30T12:00:00', true, '30 November'], ['2026-12-25T10:00:00', true, 'Christmas Day'], ['2026-12-31T23:59:00', true, '31 December, 23:59'], ['2027-01-01T00:00:00', false, '1 January, midnight'], ['2027-12-15T12:00:00', false, 'December 2027 (not until a new window is added)']]) {
    const { page: Y, ctx: YC } = await visit(iso);
    const state = await Y.evaluate(() => ({ season: document.documentElement.getAttribute('data-season'), snow: document.querySelectorAll('.xmas-snow').length, scene: document.querySelectorAll('.xmas-scene').length, row: document.querySelectorAll('[data-xmas-setting]').length, mark: typeof Christmas !== 'undefined' && Christmas.isActive() }));
    ok(on ? state.season === 'christmas' && state.snow === 1 && state.scene === 1 && state.row === 1 && state.mark : state.season === null && state.snow === 0 && state.scene === 0 && state.row === 0 && !state.mark, `${label}: the theme is ${on ? 'on (snow, trees, switch)' : 'not there at all (nothing added to the page)'}`);
    await YC.close();
  }

  const { page: X, ctx: XC } = await visit('2026-12-15T12:00:00');
  ok(await X.evaluate(() => getComputedStyle(document.querySelector('.xmas-snow')).pointerEvents === 'none' && getComputedStyle(document.querySelector('.xmas-snow')).position === 'fixed'), 'the snow is a fixed layer that ignores the mouse and touch');
  const frames1 = await X.evaluate(() => Christmas.frames());
  await sleep(700);
  const frames2 = await X.evaluate(() => Christmas.frames());
  ok(frames2 - frames1 >= 8, `the snow is animating (${frames2 - frames1} frames in 0.7 s)`);
  const flakesDrawn = async () => X.evaluate(() => { const c = document.querySelector('.xmas-snow'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  const painted1 = await flakesDrawn();
  ok(painted1 > 60, `flakes are drawn on the canvas (${painted1} pixels)`);
  await sleep(500);
  const moved = await X.evaluate(() => { const c = document.querySelector('.xmas-snow'); return c.toDataURL().length; });
  await sleep(500);
  ok(await X.evaluate((before) => document.querySelector('.xmas-snow').toDataURL().length !== before, moved), 'and they move (the picture changes from one moment to the next)');
  ok(await X.evaluate(() => { const el = document.elementFromPoint(window.innerWidth / 2, 200); return !!el && !el.classList.contains('xmas-snow'); }), 'a click or tap goes through the snow to what is under it');
  const scene = await X.evaluate(() => { const s = document.querySelector('.xmas-scene'); return { trees: s.querySelectorAll('.xmas-tree').length, gifts: s.querySelectorAll('.xmas-gifts').length, bulbs: s.querySelectorAll('.xmas-bulbs circle').length, stars: s.querySelectorAll('.xmas-halo').length, greeting: s.querySelector('.xmas-scene__greeting').textContent.replace(/\s+/g, ' ').trim(), before: s.nextElementSibling && s.nextElementSibling.classList.contains('footer'), hidden: s.querySelector('.xmas-scene__trees').getAttribute('aria-hidden'), ids: new Set([...s.querySelectorAll('[id]')].map((e) => e.id)).size === s.querySelectorAll('[id]').length }; });
  ok(scene.trees === 3 && scene.gifts === 1 && scene.stars === 3 && scene.bulbs === 96, `three Christmas trees with stars and lights, and the gifts (${scene.bulbs} light circles)`);
  ok(scene.before && scene.hidden === 'true' && scene.ids, 'the scene stands right above the footer, is hidden from screen readers, and its SVG ids do not clash');
  ok(/Merry Christmas from MaraLyrics/.test(scene.greeting), `it says "Merry Christmas from MaraLyrics" (${scene.greeting})`);
  ok(await X.evaluate(() => { const h = document.querySelector('.header'); return getComputedStyle(h, '::before').backgroundImage.includes('radial-gradient') && getComputedStyle(h, '::after').backgroundImage.includes('radial-gradient') && getComputedStyle(document.querySelector('.header__logo'), '::after').backgroundImage.includes('svg'); }), 'a string of lights under the header and a Santa hat on the logo');
  { const hat = await hatPoints(X); ok(hatIsWorn(hat) && hatIsInView(hat), `the Santa hat sits on the logo's head (brim across its top, cone and pom-pom above it) and is not cut off (tip y ${hat.tip[1].toFixed(1)}, pom-pom y ${hat.pom[1].toFixed(1)})`); }
  ok(await X.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-light').trim() === '#f4c55a' && getComputedStyle(document.body).backgroundColor === 'rgb(7, 19, 14)'), 'the dark theme is evergreen with gold links');
  ok(await X.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
  if (process.env.E2E_SHOTS) { await X.evaluate(() => document.querySelector('.xmas-scene').scrollIntoView({ block: 'center' })); await sleep(300); await X.screenshot({ path: `${process.env.E2E_SHOTS}/christmas-dark.png` }); await X.evaluate(() => window.scrollTo(0, 0)); await sleep(200); await X.screenshot({ path: `${process.env.E2E_SHOTS}/christmas-dark-top.png` }); }

  // the switch in Settings
  await X.click('.settings-toggle__btn');
  const sw = X.locator('.xmas-switch');
  await sw.waitFor({ state: 'visible' });     // the panel fades in
  ok(await sw.isVisible() && (await sw.getAttribute('role')) === 'switch' && (await sw.getAttribute('aria-checked')) === 'true' && /Christmas theme/.test(await X.textContent('[data-xmas-setting] .settings-panel__label')) && (await sw.textContent()).trim() === 'On', 'Settings has a "Christmas theme" switch, on, with its name and state in words');
  await sw.focus();
  await X.keyboard.press('Enter');
  await sleep(200);
  ok(!(await xmasOn(X)) && await X.locator('.xmas-snow').count() === 0 && await X.locator('.xmas-scene').count() === 0 && (await sw.getAttribute('aria-checked')) === 'false' && (await sw.textContent()).trim() === 'Off', 'turning it off with the keyboard takes away the colours, the snow, the trees and the lights; the switch stays to turn it back on');
  ok(await X.evaluate(() => localStorage.getItem('ml_christmas') === 'off'), 'the choice is remembered');
  const framesOff = await X.evaluate(() => Christmas.frames());
  await sleep(400);
  ok(await X.evaluate((n) => Christmas.frames() === n, framesOff), 'with the snow off nothing keeps drawing in the background');
  await X.reload();
  await X.waitForSelector('.footer', { state: 'attached' });
  await sleep(250);
  ok(!(await xmasOn(X)) && await X.locator('[data-xmas-setting] .xmas-switch').count() === 1, 'on the next page view it is still off, and the switch is still there');
  await X.click('.settings-toggle__btn');
  await X.locator('.xmas-switch').waitFor({ state: 'visible' });
  await X.click('.xmas-switch');
  await sleep(200);
  ok(await xmasOn(X) && await X.locator('.xmas-snow').count() === 1 && await X.evaluate(() => localStorage.getItem('ml_christmas') === null), 'turning it back on brings everything back and forgets the choice');
  await XC.close();

  // light theme: its own palette, and the snow turns icy blue so that it can be seen
  const { page: XL, ctx: XLC } = await openPage({ christmas: true });
  await XLC.addInitScript(clockAt('2026-12-15T12:00:00'));
  await XLC.addInitScript(() => { try { localStorage.setItem('ml_theme', 'light'); } catch {} });
  await XL.goto(`${SITE}/`);
  await XL.waitForSelector('.xmas-scene', { state: 'attached' });
  await sleep(500);
  ok(await XL.evaluate(() => document.documentElement.getAttribute('data-theme') === 'light' && getComputedStyle(document.documentElement).getPropertyValue('--accent-light').trim() === '#a31d24' && getComputedStyle(document.body).backgroundColor === 'rgb(244, 248, 245)'), 'the light theme has its own colours (dark red links on a snowy white)');
  ok(await XL.evaluate(() => { const c = document.querySelector('.xmas-snow'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let bluish = 0, white = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 80) { if (d[i + 2] > d[i] + 40) bluish++; else if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++; } } return bluish > 40 && white === 0; }), 'the snow is blue-grey there (white snow could not be seen on a light page)');
  if (process.env.E2E_SHOTS) { await XL.evaluate(() => document.querySelector('.xmas-scene').scrollIntoView({ block: 'center' })); await sleep(300); await XL.screenshot({ path: `${process.env.E2E_SHOTS}/christmas-light.png` }); }
  await XLC.close();

  // less motion: the lights, the trees and the colours stay; the snow does not fall
  const { page: XR, ctx: XRC } = await openPage({ christmas: true });
  await XRC.addInitScript(clockAt('2026-12-15T12:00:00'));
  await XR.emulateMedia({ reducedMotion: 'reduce' });
  await XR.goto(`${SITE}/`);
  await XR.waitForSelector('.xmas-scene', { state: 'attached' });
  await sleep(500);
  ok(await XR.locator('.xmas-snow').count() === 0 && await xmasOn(XR) && await XR.evaluate(() => Christmas.frames() === 0), 'with "reduce motion" the page gets the trees and the colours but no falling snow');
  ok(await XR.evaluate(() => getComputedStyle(document.querySelector('.xmas-bulbs')).animationName === 'none' && getComputedStyle(document.querySelector('.header'), '::before').animationName === 'none'), '…and the lights do not twinkle');
  await XR.emulateMedia({ reducedMotion: 'no-preference' });
  await sleep(300);
  ok(await XR.locator('.xmas-snow').count() === 1, 'if the device then allows motion, the snow starts');
  await XR.emulateMedia({ reducedMotion: 'reduce' });
  await sleep(300);
  ok(await XR.locator('.xmas-snow').count() === 0, '…and stops again as soon as it is asked to reduce motion');
  await XRC.close();

  // someone who did not accept preference cookies can still switch it off for the page, but nothing is stored
  const { page: XN, ctx: XNC } = await openPage({ christmas: true });
  await XNC.addInitScript(clockAt('2026-12-15T12:00:00'));
  await XNC.addInitScript(() => { try { localStorage.setItem('ml_cookie_consent', 'essential'); } catch {} });
  await XN.goto(`${SITE}/`);
  await XN.waitForSelector('.xmas-scene', { state: 'attached' });
  await XN.click('.settings-toggle__btn');
  await XN.locator('.xmas-switch').waitFor({ state: 'visible' });
  await XN.click('.xmas-switch');
  await sleep(200);
  ok(!(await xmasOn(XN)) && await XN.evaluate(() => localStorage.getItem('ml_christmas') === null), 'without preference cookies the switch works for this page and stores nothing');
  await XNC.close();

  // the preview address shows it on any day, and does not remember anything
  const { page: XP, ctx: XPC } = await visit('2026-06-15T12:00:00', '/?christmas=preview');
  ok(await xmasOn(XP) && await XP.locator('.xmas-snow').count() === 1, '/?christmas=preview shows the theme in June');
  await XP.click('.settings-toggle__btn');
  await XP.locator('.xmas-switch').waitFor({ state: 'visible' });
  await XP.click('.xmas-switch');
  await sleep(150);
  ok(!(await xmasOn(XP)) && await XP.evaluate(() => localStorage.getItem('ml_christmas') === null), 'turning the preview off stores nothing');
  await XPC.close();

  // other pages, other languages, a phone
  const { page: XA, ctx: XAC } = await visit('2026-12-15T12:00:00', '/about');
  ok(await xmasOn(XA) && await XA.locator('.xmas-snow').count() === 1 && await XA.locator('.xmas-scene').count() === 1, 'other pages (About) have it too, once');
  await XA.evaluate(() => I18n.setLanguage('my'));
  await sleep(300);
  ok(await XA.evaluate(() => ['.xmas-scene__greeting', '.xmas-switch__text'].every((q) => document.querySelector(q).textContent.trim().length > 0)), 'in a language without a translation yet the greeting and the switch fall back to English (never blank)');
  await XAC.close();
  const { page: XU, ctx: XUC } = await visit('2026-12-15T12:00:00', '/account');
  ok(!(await xmasOn(XU)) && await XU.locator('.xmas-snow').count() === 0, 'the sign-in page (/account) is left alone');
  await XUC.close();
  const { page: XM, ctx: XMC } = await visit('2026-12-15T12:00:00', '/', { viewport: { width: 360, height: 740 } });
  ok(await XM.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth) && await XM.evaluate(() => { const s = document.querySelector('.xmas-scene__trees'); return s.scrollWidth <= s.clientWidth + 1; }), 'on a phone (360 px) the trees fit and nothing scrolls sideways');
  { const hat = await hatPoints(XM); ok(hatIsWorn(hat) && hatIsInView(hat), `…and on a phone the hat is still on the logo and not cut off at the top of the screen (tip y ${hat.tip[1].toFixed(1)}, pom-pom y ${hat.pom[1].toFixed(1)})`); }
  ok(await XM.evaluate(() => { const c = document.querySelector('.xmas-snow'); return c.width >= 360 && c.getBoundingClientRect().width === window.innerWidth; }), '…and the snow covers the screen');
  if (process.env.E2E_SHOTS) { await XM.evaluate(() => document.querySelector('.xmas-scene').scrollIntoView({ block: 'center' })); await sleep(300); await XM.screenshot({ path: `${process.env.E2E_SHOTS}/christmas-phone.png` }); }
  await XMC.close();

  section('Admin: searching (any case, accents, a typo)');
  const accentedSong = Number(song('Ṭhâng Léi', 'thang-lei', 'Words of the song', null, null).lastInsertRowid);
  const accentedArtist = Number(sqlite.prepare(`INSERT INTO artists (name, slug) VALUES ('Zoé Ṭhâng', 'zoe-thang')`).run().lastInsertRowid);
  sqlite.prepare(`INSERT INTO song_artists (song_id, artist_id, position) VALUES (?, ?, 0)`).run(accentedSong, accentedArtist);
  const { page: S } = await openPage({ admin: true, token: adminToken });
  await S.goto(`${SITE}/admin/`);
  await S.waitForSelector('#songsTableBody tr[data-id]', { timeout: 10000 });
  ok(await S.evaluate(() => typeof MaraMatch === 'object'), 'the dashboard loads the shared matcher');
  const found = async (q) => {
    await S.fill('#adminSearch', q);
    await S.waitForFunction((x) => document.getElementById('adminSearch').value === x, q);
    await sleep(900);                                     // the box waits 200 ms, then asks the server
    return (await S.locator('#songsTableBody tr[data-id]').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
  };
  const has = (rows, title) => rows.some((r) => r.includes(title));
  let rows = await found('FALLING');
  ok(rows.length === 1 && has(rows, 'Falling'), 'songs: capitals find it ("FALLING")');
  rows = await found('ṬHÂNG LÉI');
  ok(rows.length === 1 && has(rows, 'Ṭhâng Léi'), 'songs: accented capitals find the accented title ("ṬHÂNG LÉI")');
  rows = await found('thang lei');
  ok(rows.length === 1 && has(rows, 'Ṭhâng Léi'), 'songs: plain letters find the accented title ("thang lei")');
  rows = await found('ZOE');
  ok(rows.length === 1 && has(rows, 'Ṭhâng Léi'), 'songs: the artist\'s name is searched too, and "ZOE" finds "Zoé"');
  rows = await found('fallng');
  ok(rows.length === 1 && has(rows, 'Falling'), 'songs: a typo finds it ("fallng")');
  rows = await found('waltz sad');
  ok(rows.length === 1 && has(rows, 'Sad Waltz'), 'songs: any word order ("waltz sad")');
  rows = await found('sad waltx');
  ok(rows.length === 1 && has(rows, 'Sad Waltz'), 'songs: a typo in one of two words ("sad waltx")');
  rows = await found('zzzzqq');
  ok(rows.length === 0 && (await S.textContent('#songsTableBody')).includes('No songs match your search'), 'songs: no match says so');
  rows = await found('');
  ok(rows.length >= 7, 'songs: clearing the box brings the whole list back');
  // tabs that hold their whole list in the browser
  await S.click('.admin__tab[data-tab="artists"]');
  await S.waitForSelector('#artistsTableBody tr[data-id]', { timeout: 10000 });
  const artistRows = async (q) => { await S.fill('#artistSearch', q); await sleep(300); return S.locator('#artistsTableBody tr[data-id]').count(); };
  ok(await artistRows('ZOÉ ṬHÂNG') === 1 && await artistRows('zoe thang') === 1 && await artistRows('thang zoe') === 1, 'artists: any case, accents and word order');
  ok(await artistRows('zoe thng') === 1 && await artistRows('zoee') === 1, 'artists: a typo finds the artist');
  ok(await artistRows('qqqq') === 0 && (await S.textContent('#artistsTableBody')).includes('match your search'), 'artists: no match says so');
  sqlite.prepare('DELETE FROM song_artists WHERE song_id = ?').run(accentedSong);
  sqlite.prepare('DELETE FROM songs WHERE id = ?').run(accentedSong);
  sqlite.prepare('DELETE FROM artists WHERE id = ?').run(accentedArtist);
  await S.close();

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
