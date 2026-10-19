/**
 * Validation shared by everything that writes an artist / composer profile: the admin dashboard
 * (Manager + Super Admin) and claimed-profile owners (artist accounts). One set of rules, so a
 * link or image that is unsafe for one path is unsafe for both.
 */
import { SAFE_HREF } from './sanitizeHtml.js';
import { normalizeBio, BIO_TEXT_MAX } from './richText.js';

// A data: URI is legitimate for an image (the crop/upload tools produce one), unlike an <a href> link,
// which only ever needs to be a real web/mail address — so images get their own, wider allowlist.
export const SAFE_IMAGE_SRC = /^(https?:|data:image\/)/i;

export const BIO_MAX = BIO_TEXT_MAX; // visible characters; the bio itself is rich text (see richText.js)
// An uploaded profile photo is stored in the row as a data: URL; cap it (a 400×400 JPEG is ~30–60 KB).
export const IMAGE_MAX_CHARS = 400000;
export const SOCIAL_LINKS_MAX = 10;

// Rejects (rather than silently stripping) an unsafe scheme like javascript: — these end up rendered
// as a public <a href> / <img src>, so a bad value is stored XSS waiting for a visitor to click it.
export function isSafeLinkUrl(url) {
  return typeof url === 'string' && SAFE_HREF.test(url.trim());
}
export function isSafeImageUrl(url) {
  return typeof url === 'string' && SAFE_IMAGE_SRC.test(url.trim());
}

/**
 * social_links is stored as a JSON-encoded array of URL strings. Accepts that JSON string (what the admin
 * dashboard sends) or a plain array. → { ok: true, value } with trimmed, de-emptied JSON (or null), or { ok: false }.
 */
export function validateSocialLinks(raw) {
  if (!raw) return { ok: true, value: null };
  let links = raw;
  if (typeof raw === 'string') {
    try { links = JSON.parse(raw); } catch { return { ok: false }; }
  }
  if (!Array.isArray(links)) return { ok: false };
  const cleaned = links.map((u) => String(u || '').trim()).filter(Boolean);
  if (!cleaned.every(isSafeLinkUrl)) return { ok: false };
  return { ok: true, value: cleaned.length ? JSON.stringify(cleaned) : null };
}

/**
 * What a claimed-profile owner may change: bio, photo, social links — never the name or URL slug (those
 * stay with the admins so links keep working). → { ok: true, values } | { ok: false, error }
 */
export function validateOwnerEdit(data = {}) {
  const bio = normalizeBio(data.bio);
  if (!bio.ok) return { ok: false, error: bio.error };

  const image = typeof data.image_url === 'string' ? data.image_url.trim() : '';
  if (image && !isSafeImageUrl(image)) return { ok: false, error: 'photo must be an http(s) or data:image URL' };
  if (image.length > IMAGE_MAX_CHARS) return { ok: false, error: 'that photo is too large — choose a smaller image' };

  const links = validateSocialLinks(data.social_links);
  if (!links.ok) return { ok: false, error: 'social links must be http(s) or mailto URLs' };
  if (links.value && JSON.parse(links.value).length > SOCIAL_LINKS_MAX) return { ok: false, error: `at most ${SOCIAL_LINKS_MAX} social links` };

  return { ok: true, values: { bio: bio.value, image_url: image || null, social_links: links.value } };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Contact details of a profile claimant: BOTH are compulsory (claiming is a real-identity step and the review team
 * has to be able to reach the person). The phone is stored without spaces/dashes/brackets, as + and digits.
 * → { ok: true, email, phone } | { ok: false, error }
 */
export function validateContact(data = {}) {
  const email = typeof data.contact_email === 'string' ? data.contact_email.trim() : '';
  if (!email || email.length > 200 || !EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address' };
  const raw = typeof data.contact_phone === 'string' ? data.contact_phone.trim() : '';
  const phone = raw.replace(/[\s().-]/g, '').replace(/^00/, '+');
  if (!/^\+?\d{8,15}$/.test(phone)) return { ok: false, error: 'Enter a valid phone number with your country code, for example +91 98765 43210' };
  return { ok: true, email: email.toLowerCase(), phone };
}
