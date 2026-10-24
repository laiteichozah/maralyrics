#!/usr/bin/env node
// Checks for the Previous / Next song buttons' server side: GET /songs/:slug/neighbors.   npm run test:songnav
// (The buttons themselves are checked in a real browser; this is the A–Z fallback used when a song is opened from a
// shared link rather than from a list.) The order must match the default song list: title, case-insensitive, then id.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: app } = await import(pathToFileURL(path.join(ROOT, 'worker/worker.js')).href);

let passes = 0;
let failures = 0;
const check = (cond, msg) => { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } };

const sqlite = new DatabaseSync(':memory:');
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
const add = (title, slug, status = 'published') => sqlite.prepare(`INSERT INTO songs (title, slug, lyrics, status) VALUES (?, ?, 'la', ?)`).run(title, slug, status);
add('banana', 'banana');
add('Apple', 'apple');
add('cherry', 'cherry');
add('Cherry', 'cherry-2');      // same title (any case): tie broken by id
add('Zebra', 'zebra');
add('Aardvark (draft)', 'aardvark', 'pending');
add('Middle (archived)', 'middle', 'archived');
const get = async (slug) => {
  const res = await app.fetch(new Request(`https://api.test/api/v1/songs/${slug}/neighbors`), { DB, JWT_SECRET: 's' });
  return { status: res.status, json: await res.json() };
};

const list = await (await app.fetch(new Request('https://api.test/api/v1/songs?limit=50'), { DB, JWT_SECRET: 's' })).json();
const order = list.songs.map((s) => s.slug);
check(JSON.stringify(order) === JSON.stringify(['apple', 'banana', 'cherry', 'cherry-2', 'zebra']), `(setup) default list order: ${order.join(', ')}`);

// Walking the neighbours must reproduce the default list exactly, in both directions.
const forward = [];
let cur = order[0];
for (let i = 0; i < 20 && cur; i++) { forward.push(cur); cur = (await get(cur)).json.next?.slug; }
check(JSON.stringify(forward) === JSON.stringify(order), `walking Next from the first song gives the whole list in order (${forward.join(', ')})`);
const backward = [];
cur = order[order.length - 1];
for (let i = 0; i < 20 && cur; i++) { backward.push(cur); cur = (await get(cur)).json.prev?.slug; }
check(JSON.stringify(backward) === JSON.stringify([...order].reverse()), 'walking Previous from the last song gives it in reverse');

const first = await get('apple');
check(first.status === 200 && first.json.prev === null && first.json.next.slug === 'banana' && first.json.next.title === 'banana', 'the first song has no previous (no wrap-around), and its next carries slug + title');
check((await get('zebra')).json.next === null && (await get('zebra')).json.prev.slug === 'cherry-2', 'the last song has no next');
check((await get('banana')).json.prev.title === 'Apple' && (await get('banana')).json.next.slug === 'cherry', 'case-insensitive: "banana" sits between "Apple" and "cherry"');
check((await get('cherry')).json.next.slug === 'cherry-2' && (await get('cherry-2')).json.prev.slug === 'cherry', 'songs with the same title (any case) are ordered by id');
check((await get('aardvark')).status === 404 && (await get('middle')).status === 404 && (await get('nope')).status === 404, 'draft, archived and unknown songs → 404');
sqlite.prepare(`UPDATE songs SET status = 'published' WHERE slug = 'aardvark'`).run();
check((await get('apple')).json.prev?.slug === 'aardvark', 'a song that gets published joins the order');
const sneaky = await get("x'%20OR%201=1--");
check(sneaky.status === 404, 'a hostile slug is just "not found"');

console.log(failures ? `\n✗ ${passes} checks passed, ${failures} failed` : `\n✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
