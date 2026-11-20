#!/usr/bin/env node
// Artist and composer photos: the public lists send an ADDRESS for each photo, not the photo itself.   npm run test:peopleimages
//
// The photos are stored in the database as data:image URLs. /artists and /composers used to carry every one of them inside the JSON
// (about 520 KB of the 550 KB the home page downloaded just to draw 88 px thumbnails, and nothing could be cached). Now each list
// and detail answer holds a short address (/api/v1/artists/<slug>/image?v=<fingerprint>) that the browser fetches only for the
// photos it shows, and keeps for a year. Anything that is not a picture this can serve stays exactly as it was stored.
//
// Runs the real Hono worker against an in-memory SQLite database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { default: app } = await load('worker/worker.js');

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
const ENV = { DB, JWT_SECRET: 'test-secret' };
const request = (p, init = {}) => app.fetch(new Request(`https://api.test${p}`, init), ENV);
const json = async (p, init) => { const res = await request(p, init); return { status: res.status, body: await res.json(), headers: res.headers }; };

// ─── fixtures: pictures of every kind the admin can store ───────────────────────────────────────────────────────────────
const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(40_000, 7)]);   // about the size of a real thumbnail
const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 9)]);
const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="5"/></svg>');
const dataUri = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`;
const JPEG = dataUri('image/jpeg', jpegBytes);
const PNG = dataUri('image/png', pngBytes);
const SVG = dataUri('image/svg+xml', svgBytes);
const BMP = dataUri('image/bmp', Buffer.alloc(50, 3));          // a type the admin accepts but the image route does not serve: left as stored
const BROKEN = 'data:image/jpeg;base64,!!!not base64!!!';        // not decodable: left as stored
const HTTPS = 'https://cdn.example.com/photos/c.jpg';

const insert = (table, slug, image) => sqlite.prepare(`INSERT INTO ${table} (name, slug, bio, image_url) VALUES (?, ?, ?, ?)`).run(`Name ${slug}`, slug, `Bio of ${slug}`, image);
for (const [slug, image] of [['jpeg', JPEG], ['png', PNG], ['svg', SVG], ['https', HTTPS], ['none', null], ['bmp', BMP], ['broken', BROKEN]]) { insert('artists', `a-${slug}`, image); insert('composers', `c-${slug}`, image); }

const ORIGIN = 'https://api.test';
const photoUrl = (kind, slug) => new RegExp(`^${ORIGIN.replace(/[.]/g, '\\.')}/api/v1/${kind}/${slug}/image\\?v=[0-9a-f]{8}$`);

// ─── the lists ────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('Lists send addresses, not pictures');
for (const kind of ['artists', 'composers']) {
  const letter = kind[0];
  const text = await (await request(`/api/v1/${kind}`)).text();
  const r = JSON.parse(text);
  const by = (slug) => r[kind].find((p) => p.slug === `${letter}-${slug}`);
  check(photoUrl(kind, `${letter}-jpeg`).test(by('jpeg').image_url), `${kind}: a JPEG photo becomes an address`);
  check(photoUrl(kind, `${letter}-png`).test(by('png').image_url), `${kind}: a PNG photo becomes an address`);
  check(photoUrl(kind, `${letter}-svg`).test(by('svg').image_url), `${kind}: an SVG picture becomes an address`);
  check(by('https').image_url === HTTPS, `${kind}: an https address is passed on as it is`);
  check(by('none').image_url === null, `${kind}: no photo stays null`);
  check(by('bmp').image_url === BMP, `${kind}: a picture type the route does not serve is left exactly as stored (nothing disappears)`);
  check(by('broken').image_url === BROKEN, `${kind}: an undecodable value is left exactly as stored`);
  check(!text.includes(jpegBytes.toString('base64').slice(100, 200)) && !text.includes(pngBytes.toString('base64').slice(20, 60)), `${kind}: the picture bytes are no longer inside the list`);
  check(text.length < 4000, `${kind}: the list is small now (${text.length} bytes instead of ~${Math.round((JPEG.length + PNG.length) / 1000)} KB of pictures)`);
  check(by('jpeg').name === `Name ${letter}-jpeg` && by('jpeg').bio === `Bio of ${letter}-jpeg`, `${kind}: the rest of each person is unchanged (name, bio)`);
  check(typeof by('jpeg').song_count === 'number' && Array.isArray(by('jpeg').badges), `${kind}: song_count and badges are still there`);
}

// ─── one person ──────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('A person');
let r = await json('/api/v1/artists/a-jpeg');
check(r.status === 200 && photoUrl('artists', 'a-jpeg').test(r.body.image_url) && 'bio_html' in r.body && Array.isArray(r.body.songs), 'the detail answer has the address and keeps its bio_html and songs');
r = await json('/api/v1/composers/c-bmp');
check(r.status === 200 && r.body.image_url === BMP, 'the detail answer leaves an unusual picture as stored');
r = await json('/api/v1/artists/a-https');
check(r.body.image_url === HTTPS, 'the detail answer passes an https address on');

// ─── the picture itself ──────────────────────────────────────────────────────────────────────────────────────────────────
console.log('The picture route');
const listed = (await json('/api/v1/artists')).body.artists.find((p) => p.slug === 'a-jpeg').image_url;
const version = new URL(listed).searchParams.get('v');
let res = await request(new URL(listed).pathname + new URL(listed).search);
const bytes = Buffer.from(await res.arrayBuffer());
check(res.status === 200 && res.headers.get('content-type') === 'image/jpeg' && bytes.equals(jpegBytes), 'it serves the original bytes with the right type');
check(res.headers.get('cache-control') === 'public, max-age=31536000, immutable', 'an address with the current fingerprint may be kept for a year');
check(res.headers.get('etag') === `"${version}"`, 'it carries the fingerprint as its ETag');
check(res.headers.get('x-content-type-options') === 'nosniff' && res.headers.get('access-control-allow-origin') === '*', 'nosniff and CORS are still on');
check(/sandbox/.test(res.headers.get('content-security-policy') || '') && /default-src 'none'/.test(res.headers.get('content-security-policy') || ''), 'a picture opened on its own cannot run anything (sandboxed, no sources)');
check(res.headers.get('cross-origin-resource-policy') === 'cross-origin' && /inline/.test(res.headers.get('content-disposition') || ''), 'other sites (the website) may show it, inline');

res = await request('/api/v1/artists/a-jpeg/image?v=00000000');
check(res.status === 200 && res.headers.get('cache-control') === 'public, max-age=3600', 'a stale or missing fingerprint still works, but is kept for an hour only');
res = await request('/api/v1/artists/a-jpeg/image');
check(res.status === 200 && res.headers.get('cache-control') === 'public, max-age=3600', 'the bare address works too');

res = await request(new URL(listed).pathname + new URL(listed).search, { headers: { 'If-None-Match': `"${version}"` } });
check(res.status === 304 && (await res.arrayBuffer()).byteLength === 0, 'a browser that already has it gets 304 and no bytes');
res = await request('/api/v1/artists/a-jpeg/image', { headers: { 'If-None-Match': '"something-else"' } });
check(res.status === 200, 'a different ETag gets the picture');

res = await request('/api/v1/artists/a-png/image');
check(res.status === 200 && res.headers.get('content-type') === 'image/png' && Buffer.from(await res.arrayBuffer()).equals(pngBytes), 'PNG is served as PNG');
res = await request('/api/v1/composers/c-jpeg/image');
check(res.status === 200 && res.headers.get('content-type') === 'image/jpeg', 'composers have the same route');
res = await request('/api/v1/artists/a-svg/image');
check(res.status === 200 && res.headers.get('content-type') === 'image/svg+xml' && /sandbox/.test(res.headers.get('content-security-policy') || '') && Buffer.from(await res.arrayBuffer()).equals(svgBytes), 'an SVG is served as SVG, and sandboxed so its script can never run');

res = await request('/api/v1/artists/a-https/image', { redirect: 'manual' });
check(res.status === 302 && res.headers.get('location') === HTTPS, 'a person whose photo is an https address is sent to it');
for (const [p, why] of [['/api/v1/artists/a-none/image', 'no photo'], ['/api/v1/artists/nobody/image', 'unknown slug'], ['/api/v1/artists/a-bmp/image', 'a type that is not served'], ['/api/v1/artists/a-broken/image', 'an undecodable value'], ['/api/v1/composers/%2e%2e/image', 'an odd slug'], ['/api/v1/composers/c-none/image', 'composer without a photo']]) {
  res = await request(p);
  check(res.status === 404, `404 for ${why}`);
}

// ─── the fingerprint follows the picture ────────────────────────────────────────────────────────────────────────────────
console.log('The fingerprint');
sqlite.prepare('UPDATE artists SET image_url = ? WHERE slug = ?').run(dataUri('image/jpeg', Buffer.concat([jpegBytes, Buffer.from('changed')])), 'a-jpeg');
const newer = new URL((await json('/api/v1/artists/a-jpeg')).body.image_url).searchParams.get('v');
check(/^[0-9a-f]{8}$/.test(newer) && newer !== version, 'a new picture gets a new fingerprint, so no cache can show the old one');
res = await request(`/api/v1/artists/a-jpeg/image?v=${version}`);
check(res.status === 200 && res.headers.get('cache-control') === 'public, max-age=3600', 'the old fingerprint is no longer treated as current');

// ─── what must not change ───────────────────────────────────────────────────────────────────────────────────────────────
console.log('Untouched');
const adminSrc = fs.readFileSync(path.join(ROOT, 'worker/routes/admin.js'), 'utf8');
check(!/personImage|withPublicImage|publicImageUrl/.test(adminSrc), 'the admin side never sees addresses: it still reads and writes the stored picture');
const stored = sqlite.prepare("SELECT image_url FROM artists WHERE slug = 'a-png'").get().image_url;
check(stored === PNG, 'the database still holds the original picture');
const bootstrap = await json('/api/v1/bootstrap');
check(bootstrap.body.artists.find((p) => p.slug === 'a-png').image_url === PNG, '/bootstrap (the sync feed for apps) is left as it was');

console.log(failures ? `\n✗ ${failures} failed, ${passes} passed` : `\n✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
