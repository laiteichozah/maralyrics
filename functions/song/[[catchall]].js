import {
  injectSeoMeta, seoResponse, notFoundResponse, escapeHtml, setInner, revealDetail, unhide,
  personLinks, cleanLyrics, breadcrumbSchema, schemaGraph, toIso, slugFromPath, SITE_ORIGIN,
} from '../_shared/seo.js';

// Title/description are kept byte-identical to ProfilePage/SongPage.updateMeta in public/app.js
// (crawlers see this server version first; a different client-side wording would look inconsistent).
function buildSongSeo(song) {
  const artistNames = song.artists.map((a) => a.name).join(', ') || 'Unknown Artist';
  // Two songs can share a title: the later ones carry who made them, so that no two pages have the same <title>.
  const credit = song.artists.map((a) => a.name).join(', ') || song.composers.map((c) => c.name).join(', ');
  const title = `${song.title}${song.sharesTitle && credit ? ` (${credit})` : ''} Lyrics – Mara Song | MaraLyrics`;
  const description = `Read the full lyrics of ${song.title}, a Mara song by ${artistNames}. Discover Mara music on MaraLyrics.`;
  const url = `${SITE_ORIGIN}/song/${encodeURIComponent(song.slug)}`;

  const person = (type, p) => ({ '@type': type, name: p.name, url: `${SITE_ORIGIN}/${type === 'MusicGroup' ? 'artist' : 'composer'}/${encodeURIComponent(p.slug)}` });

  const recording = {
    '@type': 'MusicRecording',
    '@id': `${url}#recording`,
    name: song.title,
    url,
    inLanguage: 'mrh',
    ...(song.artists.length ? { byArtist: song.artists.map((a) => person('MusicGroup', a)) } : {}),
    // The composition always carries the lyrics (the words, as written on this page, and the page's address as their URL).
    recordingOf: {
      '@type': 'MusicComposition',
      '@id': `${url}#composition`,
      name: song.title,
      inLanguage: 'mrh',
      ...(song.composers.length ? { composer: song.composers.map((c) => person('Person', c)) } : {}),
      lyrics: { '@type': 'CreativeWork', '@id': `${url}#lyrics`, name: `${song.title} (lyrics)`, url, inLanguage: 'mrh', text: cleanLyrics(song.lyrics) },
    },
    ...(song.category ? { genre: song.category } : {}),
    ...(toIso(song.updated_at) ? { dateModified: toIso(song.updated_at) } : {}),
    publisher: { '@type': 'Organization', name: 'MaraLyrics', url: SITE_ORIGIN },
  };
  const crumbs = breadcrumbSchema([
    { name: 'Home', url: `${SITE_ORIGIN}/` },
    { name: song.title },
  ]);

  return { title, description, url, schema: schemaGraph(recording, crumbs) };
}

async function fetchSong(db, slug) {
  const song = await db
    .prepare(
      `SELECT s.id, s.title, s.slug, s.category, s.lyrics, s.created_at, s.updated_at,
              co.name AS owner_name, co.slug AS owner_slug
       FROM songs s LEFT JOIN copyright_owners co ON co.id = s.copyright_owner_id
       WHERE s.slug = ? AND s.status = 'published'`
    )
    .bind(slug)
    .first();
  if (!song) return null;

  const [artists, composers] = await Promise.all([
    db.prepare(`SELECT a.name AS name, a.slug AS slug FROM song_artists sa JOIN artists a ON a.id = sa.artist_id WHERE sa.song_id = ? ORDER BY sa.position`).bind(song.id).all(),
    db.prepare(`SELECT c.name AS name, c.slug AS slug FROM song_composers sc JOIN composers c ON c.id = sc.composer_id WHERE sc.song_id = ? ORDER BY sc.position`).bind(song.id).all(),
  ]);
  // Does another published song have this title? (Best effort: a failure here only means the plain title is used.)
  let sharesTitle = false;
  try {
    const other = await db.prepare(`SELECT COUNT(*) AS n FROM songs WHERE status = 'published' AND id != ? AND LOWER(title) = LOWER(?)`).bind(song.id, song.title).first();
    sharesTitle = !!(other && Number(other.n) > 0);
  } catch { /* plain title */ }
  return { ...song, artists: artists.results || [], composers: composers.results || [], sharesTitle };
}

// Real content for crawlers that don't execute JS; app.js re-renders the same containers.
function renderSongPage(html, song) {
  let out = html;
  out = revealDetail(out, { skeletonId: 'songSkeleton', detailId: 'songDetail' });
  out = setInner(out, 'songTitle', escapeHtml(song.title));
  out = setInner(out, 'breadcrumbTitle', escapeHtml(song.title));
  out = setInner(out, 'songArtist', personLinks(song.artists, 'artist'));
  out = setInner(out, 'songComposer', personLinks(song.composers, 'composer'));
  if (song.category) out = setInner(out, 'songCategory', escapeHtml(song.category));
  out = setInner(out, 'songLyrics', escapeHtml(cleanLyrics(song.lyrics)));
  if (song.owner_name && song.owner_slug) {
    out = unhide(out, 'songCopyrightOwnerWrap');
    out = setInner(out, 'songCopyrightOwner', `© <a href="/copyright-owner/${encodeURIComponent(song.owner_slug)}" class="meta-link">${escapeHtml(song.owner_name)}</a>`);
  }
  return out;
}

// Catch-all Pages Function for /song/* routes.
export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const slug = slugFromPath(requestUrl.pathname, 'song');

  const assetUrl = new URL(context.request.url);
  assetUrl.pathname = '/songview.html';
  const assetResponse = await context.env.ASSETS.fetch(assetUrl);

  // "/song/" with no slug is not a page — a real 404, not a 200 empty shell.
  if (!slug) return notFoundResponse(assetResponse);

  const song = await fetchSong(context.env.DB, slug);
  if (!song) return notFoundResponse(assetResponse);

  const html = await assetResponse.text();
  return seoResponse(injectSeoMeta(renderSongPage(html, song), buildSongSeo(song)));
}
