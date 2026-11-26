import { addIndexSection, articleIndexList, withEdgeCache, LIST_PAGE_HEADERS } from './_shared/seo.js';

// /articles: public/articles.html is a frame whose list app.js draws after an API call. This serves it with the published articles
// as plain links (open, since there are few), so the page has real links for a crawler that does not run scripts.
// If the database is down the page is served as it is.
export async function onRequest(context) {
  const assetUrl = new URL(context.request.url);
  assetUrl.pathname = '/articles.html';
  const assetResponse = await context.env.ASSETS.fetch(assetUrl);
  if (!assetResponse.ok || (context.request.method !== 'GET' && context.request.method !== 'HEAD')) return assetResponse;
  const html = await assetResponse.text();

  return withEdgeCache(context, async () => {
    try {
      const rows = await context.env.DB
        .prepare(`SELECT slug, title, summary FROM articles WHERE status = 'published' AND slug IS NOT NULL AND slug != '' ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT 200`)
        .all();
      const articles = rows.results || [];
      const out = addIndexSection(html, {
        id: 'articleIndex',
        label: 'All articles',
        blocks: [{ heading: 'All articles', summary: `${articles.length} ${articles.length === 1 ? 'article' : 'articles'}`, list: articleIndexList(articles), open: true }],
      });
      return new Response(out, { headers: LIST_PAGE_HEADERS });
    } catch (error) {
      console.error('Articles page index failed:', error);
      return new Response(html, { status: assetResponse.status, headers: assetResponse.headers });
    }
  });
}
