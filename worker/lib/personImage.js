/**
 * Photos of artists and composers.
 *
 * They are stored in the database as data:image URLs (the admin's crop dialog produces them). Sent inside the public lists they made
 * /artists about 520 KB, all of it to draw a few 88 px thumbnails, and no browser or CDN could keep any of it. So the public answers
 * carry an ADDRESS instead: /api/v1/<artists|composers>/<slug>/image?v=<fingerprint>. The browser fetches only the photos it shows,
 * keeps each for a year (the fingerprint changes when the picture does), and the lists shrink to the text.
 *
 * Only what this can serve is turned into an address. An https address is passed on, and anything else (a picture type the route does
 * not serve, a value that does not decode) is left exactly as stored, so no picture ever disappears because of this.
 */

// png / jpeg / webp / gif, and svg (served sandboxed, see the route); the same base64 shape the admin's own checks use.
const DATA_IMAGE = /^data:(image\/(?:jpeg|png|webp|gif|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/;

/** `{ type, base64 }` for a data:image URL this can serve, else null. */
export function parseDataImage(value) {
  if (typeof value !== 'string') return null;
  const m = DATA_IMAGE.exec(value);
  return m ? { type: m[1], base64: m[2] } : null;
}

/** A short fingerprint of the stored picture (FNV-1a): it changes when the picture does. It is the address's ?v= and the ETag. */
export function imageVersion(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** What the public API shows as `image_url`: an address for a stored picture, otherwise the value exactly as it is. */
export function publicImageUrl(origin, kind, row) {
  const value = row?.image_url;
  if (!value || !parseDataImage(value)) return value ?? null;
  return `${origin}/api/v1/${kind}/${encodeURIComponent(row.slug)}/image?v=${imageVersion(value)}`;
}

/** A copy of a person row (or an unchanged row, if it has no picture) whose image_url is the public form. */
export function withPublicImage(origin, kind, row) {
  if (!row || !row.image_url) return row;
  return { ...row, image_url: publicImageUrl(origin, kind, row) };
}

/** The picture route's answer for a stored image_url; `v` is the fingerprint the caller's address carried. */
export function pictureResponse(value, v, ifNoneMatch) {
  const image = parseDataImage(value);
  if (!image) return null;
  const version = imageVersion(value);
  const etag = `"${version}"`;
  const headers = {
    'Content-Type': image.type,
    ETag: etag,
    // The address of the current picture never changes its content: keep it for a year. A missing or old fingerprint is
    // revalidated within the hour instead.
    'Cache-Control': v === version ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    // A picture (an SVG above all) opened on its own must not be able to run anything.
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Disposition': 'inline',
  };
  if (ifNoneMatch === etag) return new Response(null, { status: 304, headers });
  return new Response(decodeBase64(image.base64), { status: 200, headers });
}
