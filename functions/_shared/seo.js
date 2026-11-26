// Shared by every functions/*/[[catchall]].js SSR meta-tag injector (song, artist,
// composer, copyright-owner, article). Each of those still owns its own entity-specific
// fetch/build-SEO logic; only the "inject into the static shell" and "not found" mechanics
// live here, since those were previously copy-pasted five times and had drifted (see
// injectSeoMeta's comment for the bug that drift produced).

// Same allowlist as worker/lib/sanitizeHtml.js's SAFE_HREF / public/app.js's
// Utils.isSafeUrl — used here to keep a pre-existing bad row (saved before the
// server-side write-time check existed) out of the SSR'd sameAs/JSON-LD, even
// though it's inert JSON text rather than a clickable link.
export function isSafeUrl(url) {
  return /^(https?:|mailto:)/i.test(String(url || '').trim());
}

export const SITE_ORIGIN = 'https://maralyrics.com';
export const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og-image.png`;

export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Replaces each placeholder meta tag in `html` with the real title/description/url/schema.
// Every .replace() uses a replacer FUNCTION rather than a plain template-string replacement
// argument: String.replace treats $&, $`, $', and $1-$9 specially in a replacement STRING,
// so a title/description containing one of those sequences (e.g. a literal "$&") would
// corrupt the injected tag — and potentially the tags chained after it — if passed as a
// plain string instead of through a function, which the runtime never re-parses for `$`.
export function injectSeoMeta(html, { title, description, url, schema, image }) {
  const t = escapeHtml(title);
  // Only https images are used for social cards (a stored http/relative/data: URL would
  // be ignored or mixed-content); everything else falls back to the site's brand image.
  const img = escapeHtml(image && /^https:\/\//i.test(image) ? image : DEFAULT_OG_IMAGE);
  const d = escapeHtml(description);
  const u = escapeHtml(url);
  const jsonLd = JSON.stringify(schema, null, 2).replace(/</g, '\\u003c');

  return html
    // The bare shell is noindex; a rendered, real page must not inherit that.
    .replace(/<meta name="robots" content="noindex, follow" \/>\s*/, () => '')
    .replace(/<title id="pageTitle">[\s\S]*?<\/title>/, () => `<title id="pageTitle">${t}</title>`)
    .replace(/<meta name="description" id="metaDesc" content="[^"]*"\s*\/>/, () => `<meta name="description" id="metaDesc" content="${d}" />`)
    .replace(/<meta property="og:title" id="ogTitle" content="[^"]*"\s*\/>/, () => `<meta property="og:title" id="ogTitle" content="${t}" />`)
    .replace(/<meta property="og:description" id="ogDesc" content="[^"]*"\s*\/>/, () => `<meta property="og:description" id="ogDesc" content="${d}" />`)
    .replace(/<meta property="og:url" id="ogUrl" content="[^"]*"\s*\/>/, () => `<meta property="og:url" id="ogUrl" content="${u}" />`)
    .replace(/<meta name="twitter:title" id="twTitle" content="[^"]*"\s*\/>/, () => `<meta name="twitter:title" id="twTitle" content="${t}" />`)
    .replace(/<meta name="twitter:description" id="twDesc" content="[^"]*"\s*\/>/, () => `<meta name="twitter:description" id="twDesc" content="${d}" />`)
    .replace(/<meta property="og:image" id="ogImage" content="[^"]*"\s*\/>/, () => `<meta property="og:image" id="ogImage" content="${img}" />`)
    .replace(/<meta name="twitter:image" id="twImage" content="[^"]*"\s*\/>/, () => `<meta name="twitter:image" id="twImage" content="${img}" />`)
    .replace(/<link rel="canonical" id="canonicalUrl" href="[^"]*"\s*\/>/, () => `<link rel="canonical" id="canonicalUrl" href="${u}" />`)
    .replace(/<script type="application\/ld\+json" id="jsonLd">[\s\S]*?<\/script>/, () => `<script type="application/ld+json" id="jsonLd">\n${jsonLd}\n</script>`);
}


// ─── Server-rendered page content ────────────────────────────────────────────
// The view shells (songview.html etc.) are empty containers that app.js fills after an API
// call. Crawlers that don't run JavaScript (and social/link-preview bots) would otherwise see
// an empty page, so each function fills the same containers with the real content. app.js
// re-renders them as soon as it loads, so nothing changes for visitors beyond skipping the
// skeleton. Elements are matched by id; if a shell ever drops an id the helper is a no-op.

/** Slug from a request path like "/song/foo/" → "foo"; null for empty/malformed input. */
export function slugFromPath(pathname, prefix) {
  const raw = pathname.replace(new RegExp(`^/${prefix}/`), '').replace(/\/$/, '');
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return null; }
}

/** Replace the inner HTML of the simple (non-nested) element with the given id. */
export function setInner(html, id, inner) {
  const re = new RegExp(`(<([a-zA-Z0-9]+)\\b[^>]*\\bid="${id}"[^>]*>)[\\s\\S]*?(</\\2>)`);
  return html.replace(re, (_m, open, _tag, close) => `${open}${inner}${close}`);
}

/** Hide the loading skeleton and show the (otherwise `display:none`) detail container. */
export function revealDetail(html, { skeletonId, detailId }) {
  return html
    .replace(new RegExp(`<div id="${skeletonId}">`), () => `<div id="${skeletonId}" style="display:none;">`)
    .replace(new RegExp(`(<div id="${detailId}") style="display:none;"`), (_m, open) => open);
}

/** Show an element the shell hides, via inline `display:none` or the `hidden` attribute. */
export function unhide(html, id) {
  return html
    .replace(new RegExp(`(<[a-zA-Z0-9]+\\b[^>]*\\bid="${id}"[^>]*?) style="display:none;"`), (_m, open) => open)
    .replace(new RegExp(`(<[a-zA-Z0-9]+\\b[^>]*\\bid="${id}"[^>]*?) hidden(?=[\\s>])`), (_m, open) => open);
}

/** `<a>` links to credited people, joined with commas. */
export function personLinks(people, type) {
  return (people || [])
    .filter((p) => p && p.slug && p.name)
    .map((p) => `<a href="/${type}/${encodeURIComponent(p.slug)}" class="meta-link">${escapeHtml(p.name)}</a>`)
    .join(', ');
}

/** Plain list of links to songs, inside the profile pages' song container. */
export function songLinkList(songs, limit = 200) {
  const items = (songs || []).slice(0, limit)
    .map((s) => `<li><a href="/song/${encodeURIComponent(s.slug)}">${escapeHtml(s.title)}</a></li>`)
    .join('');
  return items ? `<ul class="seo-song-list">${items}</ul>` : '';
}

// ─── Crawlable index sections for the listing pages ──────────────────────────────────────────────
// The home page, /articles and /artists-composers fill their lists with JavaScript after an API call, so a crawler or an AI
// fetcher that does not run scripts (or whose script run has no network: the page then even says "Offline") sees only the
// page's frame and no link to a song, an article or a person. These helpers write a plain list of links into the HTML, in a
// collapsed <details> block above the footer: it is real, visible-on-demand content (not hidden text), costs no layout shift,
// and stays out of the way of the cards the script draws.

/** "Title — Artist" links to songs, A–Z, for the index block on the home page. */
export function songIndexList(songs, limit = 1000) {
  const items = (songs || []).slice(0, limit)
    .filter((s) => s && s.slug && s.title)
    .map((s) => `<li><a href="/song/${encodeURIComponent(s.slug)}">${escapeHtml(s.title)}</a>${s.artist_names ? ` <span class="seo-index__by">— ${escapeHtml(s.artist_names)}</span>` : ''}</li>`)
    .join('');
  return items ? `<ul class="seo-index__list">${items}</ul>` : '';
}

/** Links to artists or composers with how many songs each has. */
export function peopleIndexList(people, type, limit = 1000) {
  const items = (people || []).slice(0, limit)
    .filter((p) => p && p.slug && p.name)
    .map((p) => `<li><a href="/${type}/${encodeURIComponent(p.slug)}">${escapeHtml(p.name)}</a>${p.song_count ? ` <span class="seo-index__by">(${Number(p.song_count)} ${Number(p.song_count) === 1 ? 'song' : 'songs'})</span>` : ''}</li>`)
    .join('');
  return items ? `<ul class="seo-index__list">${items}</ul>` : '';
}

/** Links to articles, each with its one-line summary. */
export function articleIndexList(articles, limit = 200) {
  const items = (articles || []).slice(0, limit)
    .filter((a) => a && a.slug && a.title)
    .map((a) => `<li><a href="/article/${encodeURIComponent(a.slug)}">${escapeHtml(a.title)}</a>${a.summary ? ` <span class="seo-index__by">— ${escapeHtml(String(a.summary).replace(/\s+/g, ' ').slice(0, 160))}</span>` : ''}</li>`)
    .join('');
  return items ? `<ul class="seo-index__list">${items}</ul>` : '';
}

/**
 * Puts an index block just above the page's footer. `blocks` is [{ heading, summary, list, open }]: each a heading, a
 * collapsed (or open) <details> with the list. Returns the page unchanged when there is nothing to show or no footer.
 */
export function addIndexSection(html, { id, label, blocks }) {
  const parts = (blocks || []).filter((b) => b && b.list)
    .map((b, i) => `<details class="seo-index__block"${b.open ? ' open' : ''}><summary class="seo-index__summary"><h2 class="seo-index__heading">${escapeHtml(b.heading)}</h2><span class="seo-index__count">${escapeHtml(b.summary || '')}</span></summary>${b.list}</details>`)
    .join('');
  if (!parts || !html.includes('<footer class="footer">')) return html;
  const section = `<nav class="container seo-index" id="${escapeHtml(id)}" aria-label="${escapeHtml(label)}">${parts}</nav>\n\n  `;
  return html.replace('<footer class="footer">', () => `${section}<footer class="footer">`);
}

/** Headers for a page built from the database that sits in the edge cache for 5 minutes: browsers ask again every time (so a new deploy shows
    at once), the edge answers without the database. */
export const LIST_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=UTF-8',
  'Cache-Control': 'public, max-age=0, s-maxage=300, must-revalidate',
};

/**
 * Edge cache for a page that is built from the database on every request. The home page is the busiest page of the site and its
 * index block reads every song; a copy is kept for 5 minutes in Cloudflare's cache (the Cache API; it does nothing where it does not
 * exist, such as in tests), keyed by the path alone. Only an OK page is kept. `build()` sets the headers (LIST_PAGE_HEADERS).
 */
export async function withEdgeCache(context, build) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const url = new URL(context.request.url);
  const key = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  if (cache && context.request.method === 'GET') {
    try { const hit = await cache.match(key); if (hit) return hit; } catch { /* no cache: build it */ }
  }
  const res = await build();
  if (cache && context.request.method === 'GET' && res.status === 200 && typeof context.waitUntil === 'function') {
    context.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  }
  return res;
}

/** Lyrics as stored may contain literal "\\n" sequences — same normalisation as app.js. */
export function cleanLyrics(text = '') {
  return String(text).replace(/\\n/g, '\n');
}


// ─── Recognition badges (month / year / lifetime), English, mirrors Badges in public/app.js ──
const BADGE_RANK = { lifetime: 0, year: 1, month: 2 };
const BADGE_ICONS = { lifetime: '👑', year: '🏆', month: '🏅' };

export function sortBadges(list) {
  return [...(list || [])].sort((a, b) => BADGE_RANK[a.period] - BADGE_RANK[b.period] || String(b.period_value).localeCompare(String(a.period_value)));
}

/** Label parts: the title (custom, or the standard one) and the month/year it was earned. */
function badgeParts(role, b) {
  const base = b.title || (b.period === 'lifetime' ? 'Lifetime Achievement' : `${role === 'composer' ? 'Composer' : 'Artist'} of the ${b.period === 'year' ? 'Year' : 'Month'}`);
  let when = '';
  if (b.period === 'year') when = String(b.period_value);
  if (b.period === 'month') {
    const [y, m] = String(b.period_value).split('-').map(Number);
    when = new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  return { base, when };
}

/** "Artist of the Month · Oct 2026", "Lifetime Achievement", or the custom title (+ date). */
export function badgeText(role, b) {
  const { base, when } = badgeParts(role, b);
  return when ? `${base} · ${when}` : base;
}

/** Same markup as the client's Badges.list(), so the browser re-render is seamless. */
export function badgeChips(role, badges) {
  return sortBadges(badges).map((b) => {
    const { base, when } = badgeParts(role, b);
    return `<span class="badge-chip badge-chip--${escapeHtml(b.period)}" title="${escapeHtml(badgeText(role, b))}"><span class="badge-chip__icon" aria-hidden="true">${BADGE_ICONS[b.period] || '🏅'}</span><span>${escapeHtml(base)}</span>${when ? `<span class="badge-chip__when"> · ${escapeHtml(when)}</span>` : ''}</span>`;
  }).join('');
}


// ─── Mara Idol (English wording, identical to Idol.RESULT_SEO / updateMeta in public/app.js) ──
export const IDOL_RESULT_SEO = { winner: 'winner', runner_up: 'runner-up', second_runner_up: 'second runner-up', finalist: 'finalist', semi_finalist: 'semi-finalist', contestant: 'contestant' };
export const IDOL_RESULT_LABEL = { winner: 'Winner', runner_up: 'Runner-up', second_runner_up: '2nd Runner-up', finalist: 'Finalist', semi_finalist: 'Semi-finalist', contestant: 'Contestant' };
const IDOL_ICONS = { winner: '🏆', runner_up: '🥈', second_runner_up: '🥉', finalist: '⭐', semi_finalist: '🎤', contestant: '' };

/** Same markup as the client's Idol.resultChip(). */
export function idolResultChip(result, placement, all = false) {
  if (result === 'contestant' && !all) return '';
  const icon = IDOL_ICONS[result] ? `<span class="idol-chip__icon" aria-hidden="true">${IDOL_ICONS[result]}</span>` : '';
  return `<span class="idol-chip idol-chip--${escapeHtml(result)}">${icon}<span>${escapeHtml(IDOL_RESULT_LABEL[result] || result)}</span>${placement ? `<span class="idol-chip__place"> · #${Number(placement)}</span>` : ''}</span>`;
}

/** Plain <ul> of links (crawlable) — replaced by the real cards once app.js loads. */
export function linkList(items) {
  const li = items.map((i) => `<li><a href="${escapeHtml(i.href)}">${escapeHtml(i.text)}</a></li>`).join('');
  return li ? `<ul class="seo-song-list">${li}</ul>` : '';
}

/** D1 DATETIME ('YYYY-MM-DD HH:MM:SS', UTC) → ISO 8601 for schema.org; undefined if unusable. */
export function toIso(value) {
  if (!value) return undefined;
  let iso = String(value).trim();
  if (iso.includes(' ') && !iso.includes('T')) iso = iso.replace(' ', 'T');
  if (!/[Zz]|[+-]\d{2}:\d{2}$/.test(iso)) iso += 'Z';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** schema.org BreadcrumbList from [{ name, url }] — last item may omit `url`. */
export function breadcrumbSchema(items) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      ...(item.url ? { item: item.url } : {}),
    })),
  };
}

/** Combine several schema.org nodes into one JSON-LD document. */
export function schemaGraph(...nodes) {
  return { '@context': 'https://schema.org', '@graph': nodes.filter(Boolean) };
}

export function seoResponse(html) {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// A slug was given but the DB lookup for it came back empty — returned as a real 404
// (not the 200 a bare asset fetch would give) so crawlers correctly treat a dead or
// mistyped slug as not indexed instead of a soft-404. `assetResponse` is the already-
// fetched static view shell; reused as-is for its generic placeholder meta tags.
export async function notFoundResponse(assetResponse) {
  // The shell carries a generic canonical (e.g. /song/) and indexable robots default. A
  // 404 must not advertise either: drop the canonical and add noindex, in addition to the
  // 404 status itself, so a stale or mistyped slug can never be indexed as a page.
  const html = (await assetResponse.text())
    .replace(/<link rel="canonical"[^>]*>\s*/, '')
    .replace(/<meta name="robots"[^>]*>\s*/, '')
    .replace('</head>', '  <meta name="robots" content="noindex, nofollow" />\n</head>');
  return new Response(html, {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'public, max-age=300',
      'X-Robots-Tag': 'noindex',
    },
  });
}
