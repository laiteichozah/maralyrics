#!/usr/bin/env node
// Checks for rich-text bios (bold, italic, links, lists, new lines) on artists and composers.   npm run test:richtext
//
// 1. The sanitizer itself (worker/lib/richText.js): XSS vectors, structure, legacy plain-text bios.
// 2. Every write path (admin dashboard + claimed-profile owners) stores only sanitized HTML and enforces the limits.
// 3. Every read path: the public API keeps `bio` as plain text (older apps), adds `bio_html`; the SSR pages render it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { default: app } = await load('worker/worker.js');
const { signJWT } = await load('worker/lib/auth.js');
const R = await load('worker/lib/richText.js');

let passes = 0;
let failures = 0;
const check = (cond, msg) => { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } };
const S = R.sanitizeBioHtml;

// ─── Sanitizer ────────────────────────────────────────────────────────────────
console.log('Allowed formatting');
check(S('<p>Hello <b>bold</b>, <i>it</i>, <u>under</u></p>') === '<p>Hello <strong>bold</strong>, <em>it</em>, <u>under</u></p>', 'bold / italic / underline kept (b→strong, i→em)');
check(S('<div>one</div><div>two<br>three</div>') === '<p>one</p><p>two<br>three</p>', 'divs (what a browser editor produces) become paragraphs; <br> kept');
check(S('first line<br>second line') === '<p>first line<br>second line</p>', 'loose text is wrapped in a paragraph');
check(S('<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>') === '<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>', 'bullet and numbered lists kept');
check(S('<blockquote>q1</blockquote><blockquote>q2</blockquote>') === '<blockquote>q1<br>q2</blockquote>', 'consecutive quoted lines form one quote');
check(S('<a href="https://ok.example/a?b=1&c=2">x</a>') === '<p><a href="https://ok.example/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">x</a></p>', 'https link kept, opens in a new tab with rel=noopener noreferrer nofollow, & escaped');
check(/href="mailto:me@x\.com"/.test(S('<a href="mailto:me@x.com">mail</a>')), 'mailto link kept');
check(S('<h2>Title</h2><p>text</p>') === '<p>Title</p><p>text</p>' && S('<span style="color:red">words</span>') === '<p>words</p>', 'headings / spans / styles are flattened, the words stay');
check(S('<p>a</p>\n\n   \n<p>b</p>') === '<p>a</p><p>b</p>' && S('<p></p><p><br></p>') === '', 'empty paragraphs and whitespace between blocks are dropped');
check(S('<b>unclosed <i>nest</b> after</i>') === '<p><strong>unclosed <em>nest</em></strong> after</p>', 'badly nested tags are repaired');

console.log('Hostile input');
const attacks = [
  '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">x</a>', '<a href=" JaVaScRiPt:alert(1)">x</a>', '<a href="java\tscript:alert(1)">x</a>', '<a href="data:text/html,<script>alert(1)</script>">x</a>',
  '<a href="vbscript:x">x</a>', '<p onclick="alert(1)">x</p>', '<a href="https://ok.example" onmouseover="alert(1)">x</a>', '<style>body{display:none}</style>x',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>', '<<script>script>alert(1)//<</script>/script>', '<a href="https://ok.example"><script>alert(1)</script></a>',
  '<object data="javascript:alert(1)"></object>', '<form action="javascript:alert(1)"><button>x</button></form>', '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="https://ok.example" target="_self" rel="opener">x</a>', '<p style="background:url(javascript:alert(1))">x</p>', '<!--<img src=x onerror=alert(1)>-->x',
  '<img src="x" onerror="alert(1)"//>', '<a href="https://x.example"x onclick="alert(1)">y</a>', '<div style="x:expression(alert(1))">x</div>',
];
for (const a of attacks) {
  const out = S(a);
  const bad = /<(?!\/?(p|strong|em|u|s|ul|ol|li|blockquote|br|a)\b)[a-z!]/i.test(out) || /\son[a-z]+\s*=/i.test(out) || /href="(?!https?:|mailto:)/i.test(out) || /javascript:/i.test(out.replace(/&[a-z#0-9]+;/g, '')) && /href/.test(out);
  check(!bad, `neutralised: ${a.slice(0, 50)} → ${out.slice(0, 70)}`);
  check(S(out) === out, `sanitizing is idempotent: ${a.slice(0, 40)}`);
}
check(!/script|alert/.test(S('<script>alert(1)</script>ok')) && S('<script>alert(1)</script>ok') === '<p>ok</p>', 'script content disappears entirely (not shown as text)');
check(S('&lt;script&gt;alert(1)&lt;/script&gt;') === '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>', 'escaped markup stays visible text, never becomes markup');
check(S('1 < 2 && 3 > 2 <3') === '<p>1 &lt; 2 &amp;&amp; 3 &gt; 2 &lt;3</p>', 'stray < > & are escaped');
check(S('<a href="javascript:alert(1)">words</a>') === '<p>words</p>', 'an unsafe link loses the link, keeps the words');
check(S('x'.repeat(50) + '<a '.repeat(2000)).length > 0, 'a pile of unterminated tags is handled');
const t0 = Date.now();
S('<a href="'.repeat(20000)); S('<b>'.repeat(20000) + 'x'); S('<'.repeat(50000));
check(Date.now() - t0 < 2000, `pathological input is fast (${Date.now() - t0} ms)`);

console.log('Old plain-text bios');
check(!R.looksLikeHtml('Just text <b>with a tag</b>') && R.looksLikeHtml('<p>x</p>') && R.looksLikeHtml('  <ul><li>x</li></ul>'), 'plain vs rich detection');
check(R.bioToHtml('Line one\nline two\n\nSecond <b>para</b> & more') === '<p>Line one<br>line two</p><p>Second &lt;b&gt;para&lt;/b&gt; &amp; more</p>', 'plain text: blank line = paragraph, newline = <br>, markup shown literally');
check(R.bioPlain('Old\ntext') === 'Old\ntext', 'a plain bio is returned unchanged as plain text');
check(R.bioPlain('<p>A <b>b</b> &amp; c</p><ul><li>x</li><li>y</li></ul><p>z<br>w</p>') === 'A b & c\n• x\n• y\n\nz\nw', 'rich → plain text: paragraphs, bullets, line breaks, entities decoded');

console.log('Limits');
check(R.normalizeBio('   ').value === null && R.normalizeBio('<p><br></p>').value === null && R.normalizeBio(null).value === null && R.normalizeBio('').value === null, 'empty (or visually empty) bio → null');
check(R.normalizeBio('<p>' + 'x'.repeat(5000) + '</p>').ok && !R.normalizeBio('<p>' + 'x'.repeat(5001) + '</p>').ok, '5000 visible characters allowed, 5001 not');
check(R.normalizeBio('<p>' + '<b>x</b>'.repeat(4000) + '</p>').ok === false || R.normalizeBio('<p>' + '<b>x</b>'.repeat(4000) + '</p>').value.length <= 20000, 'markup does not count as text, but stored size is capped');
check(!R.normalizeBio('x'.repeat(200000)).ok && !R.normalizeBio({ a: 1 }).ok, 'huge or non-text input refused');
check(R.normalizeBio('Plain from an old client\nsecond line').value === '<p>Plain from an old client<br>second line</p>', 'plain text from an old client is converted');

// ─── Database + worker ───────────────────────────────────────────────────────
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
run(`INSERT INTO admin_users (id, username, password_hash, role) VALUES (1, 'boss', 'x', 'super_admin'), (2, 'mgr', 'x', 'manager'), (3, 'edi', 'x', 'editor')`);
const tok = { boss: await signJWT({ sub: 1, username: 'boss' }, SECRET), mgr: await signJWT({ sub: 2, username: 'mgr' }, SECRET), edi: await signJWT({ sub: 3, username: 'edi' }, SECRET) };
run(`INSERT INTO artists (id, name, slug, bio) VALUES (1, 'Ann Artist', 'ann-artist', 'Old plain bio\nsecond line'), (2, 'Ben Singer', 'ben-singer', NULL)`);
run(`INSERT INTO composers (id, name, slug, bio) VALUES (1, 'Cy Composer', 'cy-composer', NULL)`);
const call = async (method, url, { token, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await app.fetch(new Request(`https://api.test${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { DB, JWT_SECRET: SECRET });
  return { status: res.status, json: await res.json().catch(() => null) };
};

console.log('Admin dashboard writes');
const EVIL = '<p>Hi <b>there</b> <a href="https://ann.example">site</a></p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a>';
const put = await call('PUT', '/api/v1/admin/artists/2', { token: tok.mgr, body: { name: 'Ben Singer', slug: 'ben-singer', bio: EVIL } });
const stored = get('SELECT bio FROM artists WHERE id = 2').bio;
check(put.status === 200 && stored === '<p>Hi <strong>there</strong> <a href="https://ann.example" target="_blank" rel="noopener noreferrer nofollow">site</a></p><p>bad</p>', `admin edit stores sanitized HTML (${stored})`);
check(put.json.bio === stored, 'the response is the stored value');
const created = await call('POST', '/api/v1/admin/composers', { token: tok.boss, body: { name: 'Dee Writer', bio: '<ul><li>one</li><li>two</li></ul><script>x</script>' } });
check(created.status === 201 && created.json.bio === '<ul><li>one</li><li>two</li></ul>', 'admin create sanitizes too');
check((await call('POST', '/api/v1/admin/artists', { token: tok.boss, body: { name: 'Plain Poster', bio: 'Old\nclient' } })).json.bio === '<p>Old<br>client</p>', 'an old client sending plain text is converted to paragraphs');
const tooLong = await call('PUT', '/api/v1/admin/artists/2', { token: tok.mgr, body: { name: 'Ben Singer', slug: 'ben-singer', bio: '<p>' + 'x'.repeat(5001) + '</p>' } });
check(tooLong.status === 400 && /too long/.test(tooLong.json.error) && get('SELECT bio FROM artists WHERE id = 2').bio === stored, 'admin: over-long bio → 400, nothing changed');
check((await call('PUT', '/api/v1/admin/artists/2', { token: tok.edi, body: { name: 'Ben Singer', slug: 'ben-singer', bio: '<p>nope</p>' } })).status === 403, 'editors still cannot edit artists');
check((await call('PUT', '/api/v1/admin/artists/2', { token: tok.mgr, body: { name: 'Ben Singer', slug: 'ben-singer', bio: '<p><br></p>' } })).json.bio === null, 'clearing the editor stores null');
await call('PUT', '/api/v1/admin/artists/2', { token: tok.mgr, body: { name: 'Ben Singer', slug: 'ben-singer', bio: EVIL } });

console.log('Public API');
const one = await call('GET', '/api/v1/artists/ben-singer');
check(one.status === 200 && one.json.bio === 'Hi there site\n\nbad' && /^<p>Hi <strong>there<\/strong>/.test(one.json.bio_html), '/artists/:slug → bio is PLAIN text (older apps keep working), bio_html is the rich version');
check(!/<[a-z]/i.test(one.json.bio), 'plain bio contains no markup');
const legacy = await call('GET', '/api/v1/artists/ann-artist');
check(legacy.json.bio === 'Old plain bio\nsecond line' && legacy.json.bio_html === '<p>Old plain bio<br>second line</p>', 'an old plain bio is served as before, with bio_html built from it');
const list = await call('GET', '/api/v1/artists');
const listBen = list.json.artists.find((a) => a.slug === 'ben-singer');
check(listBen.bio === 'Hi there site\n\nbad' && !('bio_html' in listBen), 'directory list: plain bio only (keeps the payload small and search working)');
const boot = await call('GET', '/api/v1/bootstrap');
check(boot.json.artists.find((a) => a.slug === 'ben-singer').bio === 'Hi there site\n\nbad' && boot.json.composers.some((c) => c.slug === 'dee-writer' && c.bio === '• one\n• two'), 'bootstrap (mobile app sync): plain bios');
check((await call('GET', '/api/v1/artists/ben-singer')).json.name === 'Ben Singer' && (await call('GET', '/api/v1/composers/cy-composer')).json.bio === null, 'people without a bio still have null');

console.log('Claimed-profile owners');
const reg = await call('POST', '/api/v1/account/register', { body: { username: 'ann_real', password: 'correct horse', contact_email: 'ann@example.com', contact_phone: '+919876543210' } });
const atok = reg.json.token;
const claim = await call('POST', '/api/v1/account/claims', { token: atok, body: { type: 'artist', slug: 'ann-artist', evidence: 'My official page: https://youtube.com/@ann', contact_email: 'ann@example.com', contact_phone: '+919876543210' } });
check(claim.status === 201, `claim created (${claim.status} ${JSON.stringify(claim.json)})`);
check((await call('PUT', `/api/v1/admin/claims/${claim.json.id}/approve`, { token: tok.mgr, body: {} })).status === 200, 'claim approved');
const owned = await call('GET', `/api/v1/account/claims/${claim.json.id}/profile`, { token: atok });
check(owned.json.bio === 'Old plain bio\nsecond line' && owned.json.bio_html === '<p>Old plain bio<br>second line</p>', 'owner editor gets the old bio as paragraphs (bio_html)');
const edit = await call('PUT', `/api/v1/account/claims/${claim.json.id}/profile`, { token: atok, body: { bio: `<p>New <b>bio</b></p><ol><li>first</li></ol>${EVIL}`, image_url: '', social_links: [] } });
check(edit.status === 200 && get('SELECT bio FROM artists WHERE id = 1').bio === '<p>New <strong>bio</strong></p><ol><li>first</li></ol><p>Hi <strong>there</strong> <a href="https://ann.example" target="_blank" rel="noopener noreferrer nofollow">site</a></p><p>bad</p>', 'owner edit stores sanitized HTML');
check(!/<script|onerror|javascript:/i.test(get('SELECT bio FROM artists WHERE id = 1').bio), 'no script, handler or javascript: link survived');
const over = await call('PUT', `/api/v1/account/claims/${claim.json.id}/profile`, { token: atok, body: { bio: '<p>' + 'x'.repeat(5001) + '</p>', image_url: '', social_links: [] } });
check(over.status === 400 && /too long/.test(over.json.error), 'owner: over-long bio → 400');
const log = get(`SELECT detail FROM audit_log WHERE action = 'profile.owner_edit' ORDER BY id DESC LIMIT 1`);
check(log && /bio \(was: Old plain bio second line\)/.test(log.detail) && !/<p>/.test(log.detail), 'audit log shows the previous bio as plain text, not markup');
const before = get(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile.owner_edit'`).n;
await call('PUT', `/api/v1/account/claims/${claim.json.id}/profile`, { token: atok, body: { bio: get('SELECT bio FROM artists WHERE id = 1').bio, image_url: '', social_links: [] } });
check(get(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile.owner_edit'`).n === before, 'saving the same bio again writes no audit entry');
// a legacy bio re-saved with identical words is not reported as a change
run(`UPDATE artists SET bio = 'Same words' WHERE id = 1`);
const n0 = get(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile.owner_edit'`).n;
await call('PUT', `/api/v1/account/claims/${claim.json.id}/profile`, { token: atok, body: { bio: '<p>Same words</p>', image_url: '', social_links: [] } });
check(get(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile.owner_edit'`).n === n0, 'converting an old plain bio to rich text with the same words is not logged as an edit');

console.log('Server-rendered profile pages');
const html = fs.readFileSync(path.join(ROOT, 'public/artistview.html'), 'utf8');
const ASSETS = { fetch: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) };
const artistMod = await load('functions/artist/[[catchall]].js');
run(`UPDATE artists SET bio = ? WHERE id = 2`, S(EVIL + '<ul><li>x</li></ul>'));
const page = await (await artistMod.onRequest({ request: new Request('https://maralyrics.com/artist/ben-singer'), env: { DB, ASSETS } })).text();
const bioBlock = /id="profileBio"[^>]*>([\s\S]*?)<\/div>\s*\n/.exec(page);
check(bioBlock && /<strong>there<\/strong>/.test(bioBlock[1]) && /<ul><li>x<\/li><\/ul>/.test(bioBlock[1]) && /<a href="https:\/\/ann\.example"/.test(bioBlock[1]), 'SSR page shows the formatted bio (for crawlers without JS)');
check(!/<script>alert|onerror=|javascript:alert/.test(page), 'SSR page contains no injected script');
const desc = /<meta[^>]*name="description"[^>]*content="([^"]*)"/.exec(page);
check(desc && /Hi there site/.test(desc[1]) && !/&lt;|<p>|\n/.test(desc[1]), `meta description uses plain text on one line (${desc && desc[1].slice(0, 90)})`);
run(`UPDATE artists SET bio = 'Legacy\ntext & <b>no tags</b>' WHERE id = 2`);
const page2 = await (await artistMod.onRequest({ request: new Request('https://maralyrics.com/artist/ben-singer'), env: { DB, ASSETS } })).text();
check(/<p>Legacy<br>text &amp; &lt;b&gt;no tags&lt;\/b&gt;<\/p>/.test(page2), 'SSR: an old plain bio is escaped and shown as paragraphs');

console.log(failures ? `\n✗ ${passes} checks passed, ${failures} failed` : `\n✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
