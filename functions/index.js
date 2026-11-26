import { addIndexSection, songIndexList, withEdgeCache, LIST_PAGE_HEADERS } from './_shared/seo.js';

// The home page. public/index.html is a frame: its song lists are drawn by app.js after an API call. A crawler or an AI fetcher that
// does not run scripts (or whose script run cannot reach the API, so the page says "Offline") would see no song at all. This function
// serves the same page with an A–Z index of every published song, as plain links, in a collapsed block above the footer.
// If the database is down the page is served as it is: the home page never breaks because of this.
const MAX_SONGS = 1000;

async function fetchSongIndex(db) {
  const rows = await db
    .prepare(
      `SELECT s.slug AS slug, s.title AS title,
              (SELECT GROUP_CONCAT(name, ', ') FROM (
                 SELECT a.name AS name FROM song_artists sa JOIN artists a ON a.id = sa.artist_id WHERE sa.song_id = s.id ORDER BY sa.position
               )) AS artist_names
       FROM songs s
       WHERE s.status = 'published' AND s.slug IS NOT NULL AND s.slug != ''
       ORDER BY s.title COLLATE NOCASE, s.id
       LIMIT ${MAX_SONGS}`
    )
    .all();
  return rows.results || [];
}

export async function onRequest(context) {
  const assetUrl = new URL(context.request.url);
  assetUrl.pathname = '/index.html';
  const assetResponse = await context.env.ASSETS.fetch(assetUrl);
  if (!assetResponse.ok || (context.request.method !== 'GET' && context.request.method !== 'HEAD')) return assetResponse;
  const html = await assetResponse.text();

  return withEdgeCache(context, async () => {
    try {
      const songs = await fetchSongIndex(context.env.DB);
      const out = addIndexSection(html, {
        id: 'songIndex',
        label: 'All song lyrics',
        blocks: [{ heading: 'All song lyrics, A–Z', summary: `${songs.length} ${songs.length === 1 ? 'song' : 'songs'}`, list: songIndexList(songs, MAX_SONGS) }],
      });
      return new Response(out, { headers: LIST_PAGE_HEADERS });
    } catch (error) {
      console.error('Home page index failed:', error);
      return new Response(html, { status: assetResponse.status, headers: assetResponse.headers });
    }
  });
}
