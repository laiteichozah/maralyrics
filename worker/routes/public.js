import { Hono } from 'hono';
import { parsePagination } from '../lib/helpers.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { buildOrPrefixQuery, matchPercent } from '../lib/fuzzySearch.js';
import { attachBadges } from '../lib/badges.js';
import { attachGreen } from '../lib/green.js';
import { shapeBio } from '../lib/richText.js';
import idolRoutes from './publicIdol.js';

const SONG_COLUMNS = `
  s.id, s.title, s.slug, s.category, s.lyrics, s.views, s.created_at, s.updated_at,
  co.name AS copyright_owner_name, co.slug AS copyright_owner_slug,
  (SELECT json_group_array(json_object('name', x.name, 'slug', x.slug)) FROM (
     SELECT a.name AS name, a.slug AS slug FROM song_artists sa JOIN artists a ON a.id = sa.artist_id
     WHERE sa.song_id = s.id ORDER BY sa.position
   ) x) AS artists_json,
  (SELECT json_group_array(json_object('name', x.name, 'slug', x.slug)) FROM (
     SELECT c.name AS name, c.slug AS slug FROM song_composers sc JOIN composers c ON c.id = sc.composer_id
     WHERE sc.song_id = s.id ORDER BY sc.position
   ) x) AS composers_json
`;

const SONG_JOINS = `
  FROM songs s
  LEFT JOIN copyright_owners co ON s.copyright_owner_id = co.id
`;

// Turns the raw artists_json/composers_json text columns into real arrays,
// and derives the legacy singular artist_name/artist_slug/composer_name/
// composer_slug fields (first credited person) for backward compatibility.
function parseSongPeople(song) {
  if (!song) return song;
  const artists = song.artists_json ? JSON.parse(song.artists_json) : [];
  const composers = song.composers_json ? JSON.parse(song.composers_json) : [];
  const { artists_json, composers_json, ...rest } = song;
  return {
    ...rest,
    artists,
    composers,
    artist_name: artists[0]?.name || null,
    artist_slug: artists[0]?.slug || null,
    composer_name: composers[0]?.name || null,
    composer_slug: composers[0]?.slug || null,
  };
}

const app = new Hono();

app.get('/version', async (c) => {
  const row = await c.env.DB
    .prepare(
      `SELECT
         MAX(updated_at) AS updated_at,
         (SELECT COUNT(*) FROM songs) AS songs,
         (SELECT COUNT(*) FROM artists) AS artists,
         (SELECT COUNT(*) FROM composers) AS composers,
         (SELECT COUNT(*) FROM copyright_owners) AS copyright_owners
       FROM (
         SELECT updated_at FROM songs
         UNION ALL SELECT updated_at FROM artists
         UNION ALL SELECT updated_at FROM composers
         UNION ALL SELECT updated_at FROM copyright_owners
       )`
    )
    .first();

  return c.json({
    version: 1,
    updated_at: row.updated_at,
    counts: {
      songs: row.songs,
      artists: row.artists,
      composers: row.composers,
      copyright_owners: row.copyright_owners,
    },
  });
});

app.get('/stats', async (c) => {
  const row = await c.env.DB
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM songs) AS songs,
         (SELECT COUNT(*) FROM artists) AS artists,
         (SELECT COUNT(*) FROM composers) AS composers,
         (SELECT COUNT(*) FROM copyright_owners) AS copyright_owners,
         (SELECT COUNT(DISTINCT category) FROM songs WHERE category IS NOT NULL AND category != '') AS categories,
         (SELECT COALESCE(SUM(views), 0) FROM songs) AS total_views`
    )
    .first();

  return c.json(row);
});

app.get('/contributors', async (c) => {
  const cache = caches.default;
  const cacheKey = new Request('https://api.maralyrics.com/api/v1/contributors?v=3', c.req.raw);

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const ghRes = await fetch('https://api.github.com/repos/laiteichozah/maralyrics/contributors', {
    headers: {
      'User-Agent': 'maralyrics-worker',
      Accept: 'application/vnd.github+json',
      ...(c.env.GITHUB_TOKEN ? { Authorization: `Bearer ${c.env.GITHUB_TOKEN}` } : {}),
    },
  });

  if (!ghRes.ok) {
    return c.json({ error: 'Failed to fetch contributors' }, 502);
  }

  const contributors = (await ghRes.json())
    .filter((u) => u.type !== 'Bot')
    .map((u) => ({
      login: u.login,
      avatar_url: u.avatar_url,
      html_url: u.html_url,
      contributions: u.contributions,
    }));

  const response = c.json({ contributors }, 200, { 'Cache-Control': 'public, max-age=3600' });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

// Site team shown under Project > Contributors: the accounts that edit content (Editor and
// above). Only public-safe fields — never password hashes or anything account-related.
app.get('/team', async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT username, role, avatar, photo FROM admin_users
       WHERE role IN ('editor', 'manager', 'super_admin')
       ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, username COLLATE NOCASE`
    )
    .all();
  return c.json({ team: rows.results }, 200, { 'Cache-Control': 'public, max-age=300' });
});

// Sponsors and partners for the Project page. Either list may be empty — the page hides a
// section until it has at least one entry.
app.get('/supporters', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT kind, name, description, logo_url, website_url FROM supporters ORDER BY sort_order, name COLLATE NOCASE')
    .all();
  const sponsors = rows.results.filter((r) => r.kind === 'sponsor');
  const partners = rows.results.filter((r) => r.kind === 'partner');
  return c.json({ sponsors, partners }, 200, { 'Cache-Control': 'public, max-age=300' });
});

app.route('/mara-idol', idolRoutes);

app.get('/bootstrap', async (c) => {
  const db = c.env.DB;
  // `since` is a datetime string in the same format as the `updated_at` fields this
  // endpoint (and /version) return, e.g. "2026-07-08 12:34:56" — pass back the value
  // from a previous /version or /bootstrap call to fetch only what changed since then.
  const since = c.req.query('since') || null;
  const songsWhere = since ? "WHERE s.updated_at > ? AND s.status = 'published'" : "WHERE s.status = 'published'";
  const peopleWhere = since ? 'WHERE updated_at > ?' : '';
  const bindings = since ? [since] : [];

  const [songs, artists, composers, copyrightOwners, counts] = await Promise.all([
    db.prepare(`SELECT ${SONG_COLUMNS} ${SONG_JOINS} ${songsWhere} ORDER BY s.title`).bind(...bindings).all(),
    db.prepare(`SELECT * FROM artists ${peopleWhere} ORDER BY name`).bind(...bindings).all(),
    db.prepare(`SELECT * FROM composers ${peopleWhere} ORDER BY name`).bind(...bindings).all(),
    db.prepare(`SELECT * FROM copyright_owners ${peopleWhere} ORDER BY name`).bind(...bindings).all(),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM songs) AS songs,
         (SELECT COUNT(*) FROM artists) AS artists,
         (SELECT COUNT(*) FROM composers) AS composers,
         (SELECT COUNT(*) FROM copyright_owners) AS copyright_owners`
    ).first(),
  ]);

  // `counts` are the CURRENT total rows in each table, unaffected by `since`. Since
  // deletions aren't tracked with tombstones, a delta bootstrap can't tell the caller
  // what was removed — comparing these counts against locally stored totals is how the
  // caller detects that something disappeared and a full re-sync (no `since`) is needed.
  return c.json({
    version: 1,
    since,
    counts,
    songs: songs.results.map(parseSongPeople),
    artists: artists.results.map((p) => shapeBio(p)),
    composers: composers.results.map((p) => shapeBio(p)),
    copyright_owners: copyrightOwners.results,
  });
});

// NOTE: static sub-paths (popular, of-the-day) must be registered before the /:slug param route.
app.get('/songs/popular', async (c) => {
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit'), 10) || 6));
  const songs = await c.env.DB
    .prepare(`SELECT ${SONG_COLUMNS} ${SONG_JOINS} WHERE s.status = 'published' ORDER BY s.views DESC LIMIT ?`)
    .bind(limit)
    .all();
  return c.json({ songs: songs.results.map(parseSongPeople) });
});

// "Song of the Day" — one song, picked at random the first time a given UTC date is
// requested, then reused for every visitor for the rest of that day (daily_song_picks).
// A song deleted (or unpublished) after being picked simply isn't shown — the next
// request for that date will re-pick from whatever's currently published.
app.get('/songs/of-the-day', async (c) => {
  const db = c.env.DB;
  const today = new Date().toISOString().slice(0, 10); // UTC 'YYYY-MM-DD'

  let songId = (await db.prepare('SELECT song_id FROM daily_song_picks WHERE date = ?').bind(today).first())?.song_id;

  if (!songId) {
    const picked = await db.prepare(
      `SELECT id FROM songs WHERE status = 'published' ORDER BY RANDOM() LIMIT 1`
    ).first();
    if (!picked) return c.json({ error: 'No songs available' }, 404);

    // INSERT OR IGNORE so a race between two concurrent first-requests-of-the-day
    // can't error out — whichever insert wins, re-read it so every caller agrees.
    await db.prepare('INSERT OR IGNORE INTO daily_song_picks (date, song_id) VALUES (?, ?)')
      .bind(today, picked.id)
      .run();
    songId = (await db.prepare('SELECT song_id FROM daily_song_picks WHERE date = ?').bind(today).first()).song_id;
  }

  const song = await db
    .prepare(`SELECT ${SONG_COLUMNS} ${SONG_JOINS} WHERE s.id = ? AND s.status = 'published'`)
    .bind(songId)
    .first();
  if (!song) return c.json({ error: 'No songs available' }, 404);

  return c.json(parseSongPeople(song));
});

// Whitelisted sort keys → ORDER BY clause. `s.id` is a tiebreaker for stable pagination
// (views/created_at both have plenty of duplicate values across songs).
const SONG_SORTS = {
  name_asc: 's.title COLLATE NOCASE ASC, s.id ASC',
  name_desc: 's.title COLLATE NOCASE DESC, s.id DESC',
  views_asc: 's.views ASC, s.id ASC',
  views_desc: 's.views DESC, s.id DESC',
  created_asc: 's.created_at ASC, s.id ASC',
  created_desc: 's.created_at DESC, s.id DESC',
};
const DEFAULT_SONG_SORT = 'name_asc';

app.get('/songs', async (c) => {
  const db = c.env.DB;
  const { page, limit, offset } = parsePagination(c.req.query());
  const category = c.req.query('category') || null;
  const sortKey = SONG_SORTS[c.req.query('sort')] ? c.req.query('sort') : DEFAULT_SONG_SORT;
  const orderBy = SONG_SORTS[sortKey];

  const where = category ? "WHERE s.category = ? AND s.status = 'published'" : "WHERE s.status = 'published'";
  const bindings = category ? [category] : [];

  const [rows, countRow] = await Promise.all([
    db.prepare(`SELECT ${SONG_COLUMNS} ${SONG_JOINS} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .bind(...bindings, limit, offset)
      .all(),
    db.prepare(`SELECT COUNT(*) AS total FROM songs s ${where}`)
      .bind(...bindings)
      .first(),
  ]);

  const total = countRow.total;
  return c.json({ songs: rows.results.map(parseSongPeople), total, page, totalPages: Math.max(1, Math.ceil(total / limit)), sort: sortKey });
});

app.get('/songs/:slug', async (c) => {
  const song = await c.env.DB
    .prepare(`SELECT ${SONG_COLUMNS} ${SONG_JOINS} WHERE s.slug = ? AND s.status = 'published'`)
    .bind(c.req.param('slug'))
    .first();

  if (!song) return c.json({ error: 'Song not found' }, 404);
  return c.json(parseSongPeople(song));
});

app.post('/songs/:slug/view', async (c) => {
  const result = await c.env.DB
    .prepare('UPDATE songs SET views = views + 1 WHERE slug = ?')
    .bind(c.req.param('slug'))
    .run();

  if (result.meta.changes === 0) return c.json({ error: 'Song not found' }, 404);
  return c.json({ success: true });
});

const SUGGESTION_LIMIT = 7;

// "Did you mean" fallback for when the strict (implicit-AND) FTS query finds nothing —
// e.g. the user typed a half-remembered lyric line rather than the song's title. Casts
// a much wider net (any song containing ANY query word, in title OR lyrics), scores each
// candidate by what fraction of the query's words it actually contains, and returns the
// closest matches so a lyric fragment like "Martha nah Mari Zisu aw ei" can still surface
// the right song even though none of those words appear in its title.
async function fuzzySuggestions(db, query) {
  const orQuery = buildOrPrefixQuery(query);
  if (!orQuery) return [];

  const candidates = await db
    .prepare(
      `SELECT s.slug, s.title, s.lyrics
       FROM songs_fts f
       JOIN songs s ON s.id = f.rowid
       WHERE songs_fts MATCH ? AND s.status = 'published'
       ORDER BY rank
       LIMIT 40`
    )
    .bind(orQuery)
    .all()
    .catch(() => ({ results: [] }));

  return candidates.results
    .map((song) => ({
      slug: song.slug,
      title: song.title,
      match_percent: matchPercent(query, `${song.title}\n${song.lyrics}`),
    }))
    .filter((s) => s.match_percent > 0)
    .sort((a, b) => b.match_percent - a.match_percent)
    .slice(0, SUGGESTION_LIMIT);
}

app.get('/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q) return c.json({ results: [], suggestions: [] });

  const ftsQuery = q
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(' ');

  const results = await c.env.DB
    .prepare(
      `SELECT ${SONG_COLUMNS}
       FROM songs_fts f
       JOIN songs s ON s.id = f.rowid
       LEFT JOIN copyright_owners co ON s.copyright_owner_id = co.id
       WHERE songs_fts MATCH ? AND s.status = 'published'
       ORDER BY (LOWER(s.title) != LOWER(?)), bm25(songs_fts, 10.0, 1.0)
       LIMIT 30`
    )
    // songs_fts's default rank weighs the title and lyrics columns equally,
    // so a song whose (much longer) lyrics merely mention the query more
    // often could outrank a song whose title matches exactly. Weighting
    // title 10x over lyrics fixes that for near-matches, and the exact
    // (case-insensitive) title comparison guarantees a literal title match
    // always sorts first, regardless of what bm25 makes of the lyrics.
    .bind(ftsQuery, q)
    .all()
    .catch(() => ({ results: [] })); // malformed FTS query (e.g. bare punctuation) — fall back to no results

  let suggestions = [];
  if (results.results.length === 0) {
    suggestions = await fuzzySuggestions(c.env.DB, q);
  }

  return c.json({ results: results.results.map(parseSongPeople), suggestions });
});

app.get('/categories', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT DISTINCT category FROM songs WHERE category IS NOT NULL AND category != \'\' ORDER BY category')
    .all();
  return c.json({ categories: rows.results.map((r) => r.category) });
});

// Each person carries a song_count (published songs they are credited on) so the
// directory pages can show and sort by it without N extra requests.
const PEOPLE_JUNCTIONS = {
  artists: ['song_artists', 'artist_id'],
  composers: ['song_composers', 'composer_id'],
};

async function listPeople(c, table) {
  const [junction, fk] = PEOPLE_JUNCTIONS[table];
  const rows = await c.env.DB
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM ${junction} j
                 JOIN songs s ON s.id = j.song_id AND s.status = 'published'
                WHERE j.${fk} = p.id) AS song_count
       FROM ${table} p ORDER BY p.name`
    )
    .all();
  // Recognition badges (month / year / lifetime), most prestigious first. No ids or awarder.
  const type = table.replace(/s$/, '');
  const people = (await attachGreen(c.env.DB, await attachBadges(c.env.DB, rows.results, type), type)).map((p) => shapeBio(p));
  return c.json({ [table]: people, total: people.length });
}

async function getPerson(c, table, junctionTable, junctionFk) {
  const db = c.env.DB;
  const person = await db.prepare(`SELECT * FROM ${table} WHERE slug = ?`).bind(c.req.param('slug')).first();
  if (!person) return c.json({ error: 'Not found' }, 404);

  const songs = await db
    .prepare(
      `SELECT ${SONG_COLUMNS} ${SONG_JOINS}
       WHERE s.id IN (SELECT song_id FROM ${junctionTable} WHERE ${junctionFk} = ?) AND s.status = 'published'
       ORDER BY s.title`
    )
    .bind(person.id)
    .all();

  const [withBadges] = await attachGreen(db, await attachBadges(db, [person], table.replace(/s$/, '')), table.replace(/s$/, ''));
  // Whether someone already owns this profile (hides the "Claim this profile" link). Nothing about who.
  // (Tolerates the table not existing yet: Pages/Worker deploy on push, migrations are run by hand.)
  let owner = null;
  try {
    owner = await db.prepare(`SELECT 1 FROM person_claims WHERE ${junctionFk} = ? AND status = 'approved'`).bind(person.id).first();
  } catch { /* migration 0015 not applied yet */ }
  return c.json({ ...shapeBio(withBadges, { withHtml: true }), claimed: !!owner, songs: songs.results.map(parseSongPeople) });
}

app.get('/artists', (c) => listPeople(c, 'artists'));
app.get('/artists/:slug', (c) => getPerson(c, 'artists', 'song_artists', 'artist_id'));
app.get('/composers', (c) => listPeople(c, 'composers'));
app.get('/composers/:slug', (c) => getPerson(c, 'composers', 'song_composers', 'composer_id'));

app.get('/copyright-owners', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM copyright_owners ORDER BY name').all();
  return c.json({ copyright_owners: rows.results, total: rows.results.length });
});

app.get('/copyright-owners/:slug', async (c) => {
  const db = c.env.DB;
  const owner = await db.prepare('SELECT * FROM copyright_owners WHERE slug = ?').bind(c.req.param('slug')).first();
  if (!owner) return c.json({ error: 'Not found' }, 404);

  const songs = await db
    .prepare(`SELECT ${SONG_COLUMNS} ${SONG_JOINS} WHERE s.copyright_owner_id = ? AND s.status = 'published' ORDER BY s.title`)
    .bind(owner.id)
    .all();

  return c.json({ owner, songs: songs.results.map(parseSongPeople) });
});

// Whitelisted sort keys, same pattern as SONG_SORTS — created_desc is what the
// site's notification poller uses to find newly published articles.
const ARTICLE_SORTS = {
  published_desc: 'a.published_at DESC, a.id DESC',
  created_desc: 'a.created_at DESC, a.id DESC',
};
const DEFAULT_ARTICLE_SORT = 'published_desc';

app.get('/articles', async (c) => {
  const db = c.env.DB;
  const { page, limit, offset } = parsePagination(c.req.query());
  const sortKey = ARTICLE_SORTS[c.req.query('sort')] ? c.req.query('sort') : DEFAULT_ARTICLE_SORT;
  const orderBy = ARTICLE_SORTS[sortKey];

  const [rows, countRow] = await Promise.all([
    db.prepare(
      `SELECT id, title, slug, author_name, summary, published_at, created_at
       FROM articles a WHERE status = 'published' ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    ).bind(limit, offset).all(),
    db.prepare(`SELECT COUNT(*) AS total FROM articles WHERE status = 'published'`).first(),
  ]);

  const total = countRow.total;
  return c.json({ articles: rows.results, total, page, totalPages: Math.max(1, Math.ceil(total / limit)), sort: sortKey });
});

app.get('/articles/:slug', async (c) => {
  const article = await c.env.DB
    .prepare(`SELECT * FROM articles WHERE slug = ? AND status = 'published'`)
    .bind(c.req.param('slug'))
    .first();

  if (!article) return c.json({ error: 'Article not found' }, 404);
  return c.json(article);
});

app.post('/reports', async (c) => {
  const data = await c.req.json().catch(() => ({}));
  const { song_slug, song_title, song_artist, reporter_name, reporter_email, body, turnstile_token } = data;

  if (!song_slug || !body) {
    return c.json({ success: false, error: 'Missing required fields' }, 400);
  }

  const ok = await verifyTurnstile(turnstile_token, c.env, c.req.header('CF-Connecting-IP'));
  if (!ok) return c.json({ success: false, error: 'Security check failed. Please try again.' }, 400);

  const song = await c.env.DB.prepare('SELECT id FROM songs WHERE slug = ?').bind(song_slug).first();

  await c.env.DB
    .prepare(
      `INSERT INTO reports (song_id, song_slug, song_title, song_artist, reporter_name, reporter_email, body, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .bind(song?.id ?? null, song_slug, song_title || '', song_artist || '', reporter_name || '', reporter_email || '', body)
    .run();

  return c.json({ success: true, message: 'Report submitted successfully' }, 201);
});

app.post('/contacts', async (c) => {
  const data = await c.req.json().catch(() => ({}));
  const { name, email, subject, message, turnstile_token } = data;

  if (!name || !email || !message) {
    return c.json({ success: false, error: 'Missing required fields' }, 400);
  }

  const ok = await verifyTurnstile(turnstile_token, c.env, c.req.header('CF-Connecting-IP'));
  if (!ok) return c.json({ success: false, error: 'Security check failed. Please try again.' }, 400);

  await c.env.DB
    .prepare(`INSERT INTO contacts (name, email, subject, message, status) VALUES (?, ?, ?, ?, 'unread')`)
    .bind(name, email, subject || 'General', message)
    .run();

  return c.json({ success: true, message: 'Message sent successfully' }, 201);
});

export default app;
