/**
 * Mara Idol: validation and shared constants for seasons (editions) and contestants.
 * Used by the admin routes (write) and the public routes (read).
 */
import { slugify, slugFromInput } from './helpers.js';

export const IDOL_RESULTS = ['winner', 'runner_up', 'second_runner_up', 'finalist', 'semi_finalist', 'contestant'];
export const SEASON_STATUSES = ['draft', 'published'];

// Same allowlist the admin routes use for stored images (http(s) or an uploaded data:image).
const SAFE_IMAGE_SRC = /^(https?:|data:image\/)/i;
const HTTP_URL = /^https?:\/\//i;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MAX_VIDEOS = 10;
// An uploaded thumbnail is stored in the row as a data: URL (480×270 JPEG ≈ 30–60 KB); cap it so 10 of them stay far below D1's 2 MB row limit.
const MAX_THUMB_CHARS = 120000;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function isRealDate(value) {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Accepts an array (or its JSON string) of { title?, url, thumb? }. `thumb` is an optional manually uploaded
 *  thumbnail (http(s) or data:image); without it the page falls back to the video platform's own thumbnail.
 *  → { ok, value: JSON string | null } */
export function normalizeVideos(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return { ok: false, error: 'videos must be a list of links' }; }
  }
  if (!Array.isArray(list)) return { ok: false, error: 'videos must be a list of links' };
  const cleaned = [];
  for (const item of list) {
    const url = str(item && item.url);
    if (!url) continue; // blank rows from the form are dropped
    if (!HTTP_URL.test(url)) return { ok: false, error: 'each video link must be an http(s) URL' };
    if (url.length > 500) return { ok: false, error: 'a video link is too long (max 500 characters)' };
    const title = str(item.title).replace(/[\u0000-\u001f\u007f]/g, ' ');
    if (title.length > 100) return { ok: false, error: 'a video title is too long (max 100 characters)' };
    const thumb = str(item.thumb);
    if (thumb && !SAFE_IMAGE_SRC.test(thumb)) return { ok: false, error: 'a video thumbnail must be an http(s) or data:image URL' };
    if (thumb.length > MAX_THUMB_CHARS) return { ok: false, error: 'a video thumbnail is too large — upload a smaller image' };
    cleaned.push({ ...(title ? { title } : {}), url, ...(thumb ? { thumb } : {}) });
  }
  if (cleaned.length > MAX_VIDEOS) return { ok: false, error: `at most ${MAX_VIDEOS} video links` };
  return { ok: true, value: cleaned.length ? JSON.stringify(cleaned) : null };
}

/** Parses the stored JSON back into an array (never throws; bad data → []). */
export function parseVideos(text) {
  if (!text) return [];
  try {
    const list = JSON.parse(text);
    return Array.isArray(list)
      ? list.filter((v) => v && HTTP_URL.test(String(v.url || ''))).map((v) => (v.thumb && !SAFE_IMAGE_SRC.test(String(v.thumb)) ? { ...v, thumb: undefined } : v))
      : [];
  } catch {
    return [];
  }
}

/** → { ok: true, values: {...columns} } | { ok: false, error } */
export function validateSeason(data = {}) {
  const title = str(data.title);
  if (!title) return { ok: false, error: 'title is required' };
  if (title.length > 150) return { ok: false, error: 'title is too long (max 150 characters)' };

  const slug = str(data.slug) ? slugFromInput(data.slug) : slugify(title);
  if (!slug) return { ok: false, error: 'slug could not be generated from the title — enter one using letters or numbers' };

  const year = Number(data.year);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return { ok: false, error: 'year must be a 4-digit year (1900–2100)' };

  const description = str(data.description);
  if (description.length > 5000) return { ok: false, error: 'description is too long (max 5000 characters)' };
  const venue = str(data.venue);
  if (venue.length > 200) return { ok: false, error: 'venue is too long (max 200 characters)' };

  const start = str(data.start_date);
  const end = str(data.end_date);
  if (start && !isRealDate(start)) return { ok: false, error: 'start_date must be a real date (YYYY-MM-DD)' };
  if (end && !isRealDate(end)) return { ok: false, error: 'end_date must be a real date (YYYY-MM-DD)' };
  if (end && !start) return { ok: false, error: 'set a start_date before an end_date' };
  if (start && end && end < start) return { ok: false, error: 'end_date cannot be before start_date' };

  const cover = str(data.cover_url);
  if (cover && !SAFE_IMAGE_SRC.test(cover)) return { ok: false, error: 'cover image must be an http(s) or data:image URL' };
  const photo = str(data.photo_url);
  if (photo && !SAFE_IMAGE_SRC.test(photo)) return { ok: false, error: 'photo must be an http(s) or data:image URL' };

  const videos = normalizeVideos(data.videos);
  if (!videos.ok) return videos;

  const status = data.status === undefined || data.status === '' ? 'draft' : data.status;
  if (!SEASON_STATUSES.includes(status)) return { ok: false, error: 'status must be draft or published' };

  return {
    ok: true,
    values: { title, slug, year, description: description || null, venue: venue || null, start_date: start || null, end_date: end || null, cover_url: cover || null, photo_url: photo || null, videos: videos.value, status },
  };
}

/** → { ok: true, values } | { ok: false, error }. Existence of season_id/artist_id is checked by the route. */
export function validateContestant(data = {}) {
  const name = str(data.name);
  if (!name) return { ok: false, error: 'name is required' };
  if (name.length > 150) return { ok: false, error: 'name is too long (max 150 characters)' };

  const slug = str(data.slug) ? slugFromInput(data.slug) : slugify(name);
  if (!slug) return { ok: false, error: 'slug could not be generated from the name — enter one using letters or numbers' };

  const season = Number(data.season_id);
  if (!Number.isInteger(season) || season < 1) return { ok: false, error: 'season_id is required' };

  const bio = str(data.bio);
  if (bio.length > 5000) return { ok: false, error: 'bio is too long (max 5000 characters)' };

  const photo = str(data.photo_url);
  if (photo && !SAFE_IMAGE_SRC.test(photo)) return { ok: false, error: 'photo must be an http(s) or data:image URL' };

  const result = data.result === undefined || data.result === '' ? 'contestant' : data.result;
  if (!IDOL_RESULTS.includes(result)) return { ok: false, error: `result must be one of: ${IDOL_RESULTS.join(', ')}` };

  let placement = null;
  if (data.placement !== undefined && data.placement !== null && data.placement !== '') {
    placement = Number(data.placement);
    if (!Number.isInteger(placement) || placement < 1 || placement > 999) return { ok: false, error: 'placement must be a whole number from 1 to 999' };
  }

  const videos = normalizeVideos(data.videos);
  if (!videos.ok) return videos;

  let artistId = null;
  if (data.artist_id !== undefined && data.artist_id !== null && data.artist_id !== '') {
    artistId = Number(data.artist_id);
    if (!Number.isInteger(artistId) || artistId < 1) return { ok: false, error: 'artist_id must be an artist id' };
  }

  const sort = data.sort_order === undefined || data.sort_order === '' || data.sort_order === null ? 0 : Number(data.sort_order);
  if (!Number.isInteger(sort)) return { ok: false, error: 'sort_order must be a whole number' };

  return {
    ok: true,
    values: { season_id: season, name, slug, bio: bio || null, photo_url: photo || null, result, placement, videos: videos.value, artist_id: artistId, sort_order: sort },
  };
}

/** SQL ORDER BY for contestants: result tier, then placement, then manual order, then name. */
export const CONTESTANT_ORDER = `CASE c.result WHEN 'winner' THEN 0 WHEN 'runner_up' THEN 1 WHEN 'second_runner_up' THEN 2
  WHEN 'finalist' THEN 3 WHEN 'semi_finalist' THEN 4 ELSE 5 END,
  CASE WHEN c.placement IS NULL THEN 1 ELSE 0 END, c.placement, c.sort_order, c.name COLLATE NOCASE`;
