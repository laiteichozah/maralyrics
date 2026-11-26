-- Mara Idol contestants whose slug was made from a pasted address: "https://maralyrics.com/artist/hc-teresa-ngiano" had become
-- "httpsmaralyricscomartisthc-teresa-ngiano" (so the page was /mara-idol/mara-idol-season-7/httpsmaralyricscomartisthc-teresa-ngiano).
-- This keeps what comes after the address: "hc-teresa-ngiano". A row is left alone if that slug is already taken in its season.
-- Run BEFORE or after deploying (the pages read the slug from the database):  npm run db:migrate
-- The old addresses stop working; nothing links to them but the sitemap, which lists the new ones.
UPDATE idol_contestants
   SET slug = substr(slug, length('httpsmaralyricscomartist') + 1)
 WHERE slug LIKE 'httpsmaralyricscomartist%'
   AND length(slug) > length('httpsmaralyricscomartist')
   AND NOT EXISTS (SELECT 1 FROM idol_contestants x WHERE x.season_id = idol_contestants.season_id AND x.slug = substr(idol_contestants.slug, length('httpsmaralyricscomartist') + 1));

UPDATE idol_contestants
   SET slug = substr(slug, length('httpsmaralyricscomcomposer') + 1)
 WHERE slug LIKE 'httpsmaralyricscomcomposer%'
   AND length(slug) > length('httpsmaralyricscomcomposer')
   AND NOT EXISTS (SELECT 1 FROM idol_contestants x WHERE x.season_id = idol_contestants.season_id AND x.slug = substr(idol_contestants.slug, length('httpsmaralyricscomcomposer') + 1));
