# SEO guide — maralyrics.com

How search-engine optimisation is built into this project, how to verify it, and what still needs
a human with the right accounts. Nothing here guarantees rankings or indexing speed.

## How it works

The site is static HTML + `public/app.js` on **Cloudflare Pages**, with **Pages Functions** in
`functions/` and a Worker API on `api.maralyrics.com`.

| Concern | Where |
| --- | --- |
| Per-page `<title>`, description, canonical, Open Graph / Twitter tags | Static pages: in each `public/*.html`. Song / artist / composer / copyright-owner / article / Mara Idol pages: injected on the server by `functions/<type>/[[catchall]].js` via `functions/_shared/seo.js` |
| Page content for crawlers | The same functions also fill the view shell with the real content (title, credited people as links, lyrics, bio, song lists, article body). `app.js` re-renders the same containers once it loads, so visitors see no change |
| Structured data (JSON-LD) | Home: `WebSite` (+ working `SearchAction`, `/?q=`) and `Organization`. Entity pages: `MusicRecording` / `MusicGroup` / `Person` / `Organization` / `Article` plus `BreadcrumbList`. Mara Idol: `CollectionPage` (index), `Event` (season), `Person` (idol; `award` only when a result is recorded). Built from database fields only — no ratings, reviews or invented authors |
| Links for crawlers that do not run scripts | The home page, `/articles` and `/artists-composers` draw their lists with `app.js`, so `functions/index.js`, `functions/articles.js` and `functions/artists-composers.js` serve the same pages with a plain list of links (every published song A–Z with its artists; every article; every artist and composer that has a published song) in a collapsed block above the footer. Cached at the edge for 5 minutes; if the database is down the page is served as it is |
| 404s | Unknown slugs (and bare `/song/`, `/artist/`, …) return a real **404** with `noindex` and no canonical |
| Sitemap | `functions/sitemap.xml.js` → `/sitemap.xml`. Published songs/articles, published Mara Idol seasons and their idols (draft seasons never), plus artists, composers and copyright owners **that have at least one published song**. `<lastmod>` only where a real date exists |
| Crawl rules | `public/robots.txt`; `public/_headers` adds `X-Robots-Tag` for `/admin/*` and `/downloads` |
| Mara Idol | `/mara-idol`, `/mara-idol/:season`, `/mara-idol/:season/:idol` are all served by `functions/mara-idol/[[catchall]].js`; draft seasons and unknown slugs return a real 404 with `noindex` |
| Not indexed | `/admin/*` (login-protected), `/downloads` (per-device), `/report` (form), `/my-profile` (artist/composer sign-in and claim page), bare view shells, 404 page |
| Share image | `public/og-image.png` (1200×630). An artist/composer's own `https` image is used when they have one |

Deliberate choices:

* Titles/descriptions of entity pages stay **English** and are identical on the server and in
  `app.js`, so crawlers and browsers see the same text. Page *content* follows the visitor's language.
* `/report` and `/downloads` are **not** in `robots.txt`: Google can only honour `noindex` on a page it is
  allowed to crawl. `robots.txt` is not access control — the admin area is protected by login.
* `changefreq` / `priority` are omitted from the sitemap (Google ignores them) and there is no
  `keywords` meta tag.
* Structured data for copyright owners does not include their email address.

## Verify locally

```bash
npm run seo:check    # ~1,090 checks, no network, exits 1 on any failure
npm run i18n:check   # translation coverage
```

`seo:check` validates every page's title/description/canonical/social tags/headings/JSON-LD/images/internal
links, `robots.txt`, and **runs the real Pages Functions against an in-memory SQLite database built from
`schema.sql`** — status codes, canonicals, rendered content, JSON-LD, 404/`noindex`, draft content hidden,
and sitemap validity. It cannot check what only Google can tell you (see below).

## Manual steps (need your accounts)

1. **Deploy** the Pages site (push to the production branch). The `functions/` changes ship with it.
2. **Google Search Console** → add `https://maralyrics.com` as a *Domain* property (DNS TXT record at your
   registrar) or *URL-prefix* property (HTML tag / file).
3. **Sitemaps** → *Add a new sitemap* → `sitemap.xml` → Submit. Status should read *Success*; open
   `https://maralyrics.com/sitemap.xml` yourself first to confirm it loads.
4. **URL Inspection** → paste the home page, a song page, an artist page → *Test live URL* → check
   "URL is available to Google", the rendered HTML shows the content, and *Page indexing* has no `noindex`
   or "Blocked by robots.txt". Then *Request indexing* for a few key pages. (Requests are rate-limited and
   indexing is not instant or guaranteed.)
5. **Rich Results Test** (<https://search.google.com/test/rich-results>) on a song and an article URL —
   confirms the JSON-LD is parsed. Breadcrumb rich results appear only if Google chooses to show them.
6. **Bing Webmaster Tools** → import from Search Console or add the site and submit the same sitemap.
7. **Redirect `www` → apex** (if you serve `www.maralyrics.com`): Cloudflare → Rules → Redirect Rules → 301 to
   `https://maralyrics.com`. Keep one canonical host. Cloudflare Pages normally redirects `/page.html` → `/page` (confirm on the live site)
   and strips `/index.html`.
8. **Performance**: run <https://pagespeed.web.dev> on the home and a song page after deploy; Search Console's
   *Core Web Vitals* report fills in from real-user data after a few weeks.
9. **Worker deploy** (`npm run deploy`) is separate from Pages — it is not needed for SEO.

## Ongoing checklist

**Every change**
- [ ] `npm run seo:check` passes (CI-friendly: exit code 1 on failure).
- [ ] New public page → add it to `STATIC_PAGES` in `functions/sitemap.xml.js`, give it a unique title (≤ 70 chars),
      description (50–170 chars), canonical, one `<h1>`, the shared Open Graph/Twitter block, and a link from the footer or nav.
- [ ] New private/utility page → add `<meta name="robots" content="noindex, follow">` (do **not** Disallow it).
- [ ] New route handled by a Pages Function → return 404 (not an empty 200) for unknown slugs.
- [ ] Changed `app.js`/`style.css`/shell HTML → bump `CACHE_VERSION` in `public/sw.js`.
- [ ] Changed an entity page's title/description wording → change it in the function (a song page the function rendered keeps what the server wrote: `app.js` only writes the title, description and canonical for a bare shell) and in `app.js` for the entity types that still set them.

**Monthly**
- [ ] Search Console → *Pages*: investigate "Crawled – not indexed", "Soft 404", "Duplicate without user-selected canonical".
- [ ] Search Console → *Sitemaps*: submitted vs discovered URL counts roughly match `/sitemap.xml`.
- [ ] Spot-check 3 random song pages with URL Inspection → *View crawled page*.
- [ ] Search Console → *Core Web Vitals* and *Experience*: no new "Poor" URL groups.

**When content grows**
- [ ] If `/sitemap.xml` approaches 50,000 URLs (or 50 MB), split into a sitemap index (the function logs a warning).
- [ ] Artists/composers/owners with no published songs stay out of the sitemap automatically; consider whether a
      long tail of near-empty profiles should also be `noindex`.

## Live audit, 26 November 2026

Run against https://maralyrics.com/ with Googlebot's user agent (no JavaScript), from outside Cloudflare's network:

| Check | Result |
| --- | --- |
| `/robots.txt` | 200 `text/plain`, for 15 user agents (Googlebot and its inspection tool, Bingbot, GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Applebot, Yandex, DuckDuckBot, curl, python-requests, Go, Wget). `User-agent: *`, `Allow: /`, `Disallow: /admin/`, the sitemap line. No Cloudflare "managed robots.txt" additions |
| `/sitemap.xml` | 200 `application/xml; charset=UTF-8`, 390 URLs: 235 songs, 76 artists, 61 composers, 2 articles, the static pages, Mara Idol |
| Every sitemap URL | 390 of 390 return 200; none has `noindex` (meta or `X-Robots-Tag`); every one has a title, a description and a canonical that is its own address |
| Song pages (235) | Lyrics in the HTML of all of them, one `<h1>`, artist and composer links, JSON-LD (`MusicRecording`, `MusicComposition` where there is a composer, `BreadcrumbList`) |
| Bot blocking | No Cloudflare challenge or block seen for any user agent above. `BLOCKED_COUNTRIES` (worker/worker.js) is commented out in `wrangler.toml`: nothing is refused by country, and it would only ever affect the API, not the pages |

What the audit found, and what changed:

* **The lists had no links in the HTML.** The home page, `/articles` and `/artists-composers` showed a crawler that does not run scripts no song, article or person link (only the sitemap led to them). They now carry a crawlable index (see the table above).
* **Song JSON-LD had no `lyrics`.** The `MusicComposition` is now always present and carries `lyrics` (a `CreativeWork` with the lyrics as `text` and the song page as `url`), the composers when there are any, and `inLanguage: mrh`. There is no separate lyricist in the data (a song has artists and composers), so none is claimed.
* **Two pairs of songs shared a `<title>`** ("A ngiatiah va na", "Dinô"). A song that shares its title with another now carries its artist in the title, `og:title` and `twitter:title`: "Dinô (Artist) Lyrics – Mara Song | MaraLyrics". Descriptions were already unique.
* **Three Mara Idol contestants had URLs like `/mara-idol/mara-idol-season-7/httpsmaralyricscomartisthc-teresa-ngiano`.** An address had been pasted into the slug box and `slugify()` glued it together. A pasted address now gives its last part as the slug, and `migrations/0022_fix_idol_slugs.sql` repairs the rows (run `npm run db:migrate`; the old three addresses stop working).
* **"• Offline", an empty song list, 0 search results and "song not found" in some tools.** All of it came from `navigator.onLine`, which headless browsers, page renderers, remote-browser tools and sandboxes report as `false` although the page came over the network. The page believed it and never asked the API (the Featured Artists row, which did not check, still loaded: the pattern an AI browser tool reported). The page now asks once (`Utils.settleOnline`) and believes `false` only when a real request to the API fails too. If the song service really cannot be reached, the home page draws its first page of cards from the server-written A–Z index, and a song page keeps the lyrics the server wrote. `npm run test:e2e:offline` reproduces both situations in Chromium (it fails on the old code: no song card ever appears).

### If a tool still reports `PERMISSION_DENIED` for robots.txt

The file itself is public and the site sends 200 to every user agent tried, so a refusal comes from somewhere in front of the site or from the tool. Things only someone with the Cloudflare account can check:

1. **Cloudflare → Security → Events**: filter by the tool's user agent or IP and look for *Block* or *Managed Challenge* on `/robots.txt`.
2. **Security → Bots**: *Bot Fight Mode* / *Super Bot Fight Mode* — verified bots (Googlebot, Bingbot) must be *Allow*; AI crawlers are blocked by the *Block AI bots* switch and by *AI Crawl Control* (turn them off if AI search tools should fetch the site).
3. **Security → WAF → Custom rules / Rate limiting rules**, and **Security → Settings → Security level / Under Attack Mode**: none should challenge `/robots.txt`, `/sitemap.xml` or `/song/*`.
4. **Overview → Managed robots.txt**: if on, Cloudflare adds its own AI-bot rules to `robots.txt`; the live file currently has none.
5. **Search Console → Settings → Crawl stats → robots.txt** and **URL Inspection → Test live URL** show what Google itself gets.
6. A `PERMISSION_DENIED` string is not an HTTP status Cloudflare or Pages sends; it is what some AI and fetch tools print when they cannot read a page for their own reasons (their policy, their network, a robots rule they apply). If the tool names no HTTP status, ask its vendor which one it received.

## Known limits / not verified here

* Nothing has been submitted to or verified by Google or Bing from this repository; indexing status is unknown
  until you check Search Console.
* Core Web Vitals / PageSpeed scores were not measured (needs a deployed URL and Lighthouse). The build has no
  minification step; `style.css` and `app.js` are served as written.
* Page `<title>`/description are English only; there are no per-language URLs (`hreflang`) because the language
  is a client-side setting on one URL.
