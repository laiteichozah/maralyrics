import { addIndexSection, peopleIndexList, withEdgeCache, LIST_PAGE_HEADERS } from './_shared/seo.js';

// /artists-composers: public/artists-composers.html is a frame whose cards app.js draws after an API call. This serves it with every
// artist and composer that has a published song as plain links (the same people the sitemap lists), in collapsed blocks above the
// footer. If the database is down the page is served as it is.
const people = (db, table, junction, fk) => db
  .prepare(
    `SELECT p.slug AS slug, p.name AS name,
            (SELECT COUNT(*) FROM ${junction} j JOIN songs s ON s.id = j.song_id AND s.status = 'published' WHERE j.${fk} = p.id) AS song_count
     FROM ${table} p
     WHERE p.slug IS NOT NULL AND p.slug != ''
       AND EXISTS (SELECT 1 FROM ${junction} j JOIN songs s ON s.id = j.song_id AND s.status = 'published' WHERE j.${fk} = p.id)
     ORDER BY p.name COLLATE NOCASE, p.id
     LIMIT 1000`
  )
  .all();

export async function onRequest(context) {
  const assetUrl = new URL(context.request.url);
  assetUrl.pathname = '/artists-composers.html';
  const assetResponse = await context.env.ASSETS.fetch(assetUrl);
  if (!assetResponse.ok || (context.request.method !== 'GET' && context.request.method !== 'HEAD')) return assetResponse;
  const html = await assetResponse.text();

  return withEdgeCache(context, async () => {
    try {
      const [artists, composers] = await Promise.all([
        people(context.env.DB, 'artists', 'song_artists', 'artist_id'),
        people(context.env.DB, 'composers', 'song_composers', 'composer_id'),
      ]);
      const a = artists.results || [];
      const c = composers.results || [];
      const out = addIndexSection(html, {
        id: 'peopleIndex',
        label: 'All artists and composers',
        blocks: [
          { heading: 'Mara artists', summary: `${a.length} ${a.length === 1 ? 'artist' : 'artists'}`, list: peopleIndexList(a, 'artist') },
          { heading: 'Mara composers', summary: `${c.length} ${c.length === 1 ? 'composer' : 'composers'}`, list: peopleIndexList(c, 'composer') },
        ],
      });
      return new Response(out, { headers: LIST_PAGE_HEADERS });
    } catch (error) {
      console.error('Artists and composers page index failed:', error);
      return new Response(html, { status: assetResponse.status, headers: assetResponse.headers });
    }
  });
}
