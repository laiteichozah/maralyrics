import {
  injectSeoMeta, seoResponse, notFoundResponse, escapeHtml, setInner, revealDetail, unhide,
  songLinkList, breadcrumbSchema, schemaGraph, slugFromPath, isSafeUrl, badgeChips, badgeText, sortBadges, SITE_ORIGIN,
} from '../_shared/seo.js';
import { bioPlain, bioToHtml } from '../../worker/lib/richText.js';

function parseSocialLinks(raw) {
  if (!raw) return undefined;
  try {
    const links = JSON.parse(raw);
    if (!Array.isArray(links)) return undefined;
    const safe = links.filter(isSafeUrl);
    return safe.length ? safe : undefined;
  } catch {
    return undefined;
  }
}

// Title/description are kept byte-identical to ProfilePage.updateMeta in public/app.js.
function buildComposerSeo(composer, songs, badges = []) {
  const songCount = songs.length;
  const title = `${composer.name} — Mara Composer | MaraLyrics`;
  const countText = songCount === 1 ? '1 song' : `${songCount} songs`;
  const plainBio = bioPlain(composer.bio).replace(/\s+/g, ' ');
  const bio = plainBio ? ` ${plainBio}` : '';
  const description = `Explore ${countText} composed by ${composer.name} on MaraLyrics.${bio}`.trim().slice(0, 300);
  const url = `${SITE_ORIGIN}/composer/${encodeURIComponent(composer.slug)}`;
  const sameAs = parseSocialLinks(composer.social_links);

  const entity = {
    '@type': 'Person',
    '@id': `${url}#composer`,
    name: composer.name,
    url,
    ...(composer.image_url && /^https:\/\//i.test(composer.image_url) ? { image: composer.image_url } : {}),
    ...(sameAs ? { sameAs } : {}),
    // Site-given recognition (Super Admin awards), only what was actually awarded.
    ...(badges.length ? { award: badges.map((b) => badgeText('composer', b)) } : {}),
  };
  const crumbs = breadcrumbSchema([
    { name: 'Home', url: `${SITE_ORIGIN}/` },
    { name: 'Artists & Composers', url: `${SITE_ORIGIN}/artists-composers` },
    { name: composer.name },
  ]);

  return { title, description, url, image: composer.image_url, schema: schemaGraph(entity, crumbs) };
}

async function fetchComposer(db, slug) {
  const composer = await db.prepare('SELECT * FROM composers WHERE slug = ?').bind(slug).first();
  if (!composer) return null;
  const songs = await fetchSongsFor(db, 'song_composers', 'composer_id', composer.id);
  const badges = (await db.prepare('SELECT period, period_value, title FROM person_badges WHERE composer_id = ?').bind(composer.id).all()).results || [];
  return { composer, songs, badges: sortBadges(badges) };
}

async function fetchSongsFor(db, junction, fk, id) {
  const rows = await db
    .prepare(
      `SELECT s.title AS title, s.slug AS slug FROM ${junction} j
       JOIN songs s ON s.id = j.song_id
       WHERE j.${fk} = ? AND s.status = 'published' ORDER BY s.title`
    )
    .bind(id)
    .all();
  return rows.results || [];
}

// Real content for crawlers that don't execute JS; app.js re-renders the same containers.
function renderComposerPage(html, composer, songs, badges = []) {
  let out = html;
  out = revealDetail(out, { skeletonId: 'profileSkeleton', detailId: 'profileDetail' });
  out = setInner(out, 'profileName', escapeHtml(composer.name));
  out = setInner(out, 'breadcrumbName', escapeHtml(composer.name));
  out = setInner(out, 'avatarFallback', escapeHtml((composer.name || '?').charAt(0)));
  if (composer.bio) out = setInner(out, 'profileBio', bioToHtml(composer.bio));
  if (badges.length) {
    out = out.replace('id="profileBadges" hidden>', 'id="profileBadges">');
    out = setInner(out, 'profileBadges', badgeChips('composer', badges));
  }
  out = setInner(out, 'songCount', `(${songs.length})`);
  out = setInner(out, 'profileSongGrid', songLinkList(songs));
  return out;
}

// Catch-all Pages Function for /composer/* routes.
export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const slug = slugFromPath(requestUrl.pathname, 'composer');

  const assetUrl = new URL(context.request.url);
  assetUrl.pathname = '/composerview.html';
  const assetResponse = await context.env.ASSETS.fetch(assetUrl);

  // "/composer/" with no slug is not a page — a real 404, not a 200 empty shell.
  if (!slug) return notFoundResponse(assetResponse);

  const result = await fetchComposer(context.env.DB, slug);
  if (!result) return notFoundResponse(assetResponse);

  const html = await assetResponse.text();
  const seo = buildComposerSeo(result.composer, result.songs, result.badges);
  return seoResponse(injectSeoMeta(renderComposerPage(html, result.composer, result.songs, result.badges), seo));
}
