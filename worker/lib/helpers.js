export const CATEGORIES = ['Gospel', 'Love', 'Traditional', 'Patriotic'];

export function slugify(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // strip combining diacritics (â→a, ô→o, ...) instead of deleting the letter
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function parsePagination(query, defaultLimit = 20, maxLimit = 100) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/** Maps a thrown D1 error to an HTTP status + message, or null if not a known constraint error. */
export function mapD1Error(err) {
  const msg = String(err?.message || '');
  if (msg.includes('UNIQUE constraint failed')) {
    return { status: 409, error: 'A record with that slug already exists.' };
  }
  if (msg.includes('CHECK constraint failed')) {
    return { status: 400, error: 'Invalid value: ' + msg.split('CHECK constraint failed:')[1]?.trim() };
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return { status: 400, error: 'Referenced record does not exist.' };
  }
  if (msg.includes('NOT NULL constraint failed')) {
    return { status: 400, error: 'Missing required field: ' + msg.split('NOT NULL constraint failed:')[1]?.trim() };
  }
  return null;
}

/** A trimmed string of at most `max` characters, or '' for anything that is not a string (objects, numbers, null). */
export function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export const isEmailLike = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
