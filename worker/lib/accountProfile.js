/** Validation for the parts of a reader account's profile that the owner edits: the display name and the photo. */

const CONTROL = /[\u0000-\u001f\u007f]/;
export const DISPLAY_NAME_MAX = 50;
// A 256×256 JPEG is ~15–40 KB; as a data: URL (base64) that is well under this.
export const AVATAR_MAX_CHARS = 90000;
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** → { ok: true, value: string | null } | { ok: false, error }. An empty name clears it. */
export function validateDisplayName(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Name must be text' };
  const name = raw.trim().replace(/\s+/g, ' ');
  if (CONTROL.test(name)) return { ok: false, error: 'Name contains characters that are not allowed' };
  if (name.length > DISPLAY_NAME_MAX) return { ok: false, error: `Please keep your name under ${DISPLAY_NAME_MAX} characters` };
  return { ok: true, value: name || null };
}

/** → { ok: true, value: dataUrl | null } | { ok: false, error }. '' / null removes the photo. */
export function validateAvatar(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string' || !AVATAR_RE.test(raw)) return { ok: false, error: 'The photo must be a JPEG, PNG or WebP image' };
  if (raw.length > AVATAR_MAX_CHARS) return { ok: false, error: 'That photo is too large — choose a smaller image' };
  return { ok: true, value: raw };
}
