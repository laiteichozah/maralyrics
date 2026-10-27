/**
 * Admin auth: per-account username/password login backed by the admin_users
 * table, sessions represented as signed JWTs (HS256). Replaces the old
 * single shared ADMIN_TOKEN bearer secret with individual accounts that
 * each carry a role (viewer / translator / reviewer / editor / manager / super_admin).
 */

const encoder = new TextEncoder();
const JWT_TTL_SECONDS = 12 * 60 * 60; // 12 hours
const PBKDF2_ITERATIONS = 100000;

function base64UrlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a, b) {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let result = 0;
  for (let i = 0; i < bufA.length; i++) result |= bufA[i] ^ bufB[i];
  return result === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// ─── JWT (HS256) ─────────────────────────────────────
export async function signJWT(payload, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const fullPayload = { ...payload, iat: now, exp: now + JWT_TTL_SECONDS };

  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(fullPayload)));
  const data = `${headerB64}.${payloadB64}`;

  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return `${data}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function verifyJWT(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlDecode(sigB64),
    encoder.encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ─── Password hashing (PBKDF2-HMAC-SHA256) ──────────
async function pbkdf2(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(new Uint8Array(hash))}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = parseInt(parts[1], 10);
  const salt = base64UrlDecode(parts[2]);
  const expected = parts[3];

  const hash = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(base64UrlEncode(new Uint8Array(hash)), expected);
}

/**
 * A short fingerprint of an account's current password hash. Sessions carry it (`pv`), and requireAuth compares it with
 * the account's present hash, so changing or resetting a password ends every session signed before the change.
 * (It reveals nothing useful: it is a truncated SHA-256 of a salted hash, inside a token only the account's owner holds.)
 */
export async function passwordVersion(passwordHash) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(passwordHash || '')));
  return base64UrlEncode(new Uint8Array(digest)).slice(0, 16);
}

// ─── Middleware ──────────────────────────────────────
/** Requires `Authorization: Bearer <jwt>`; on success, `c.get('admin')` is `{ sub, username, role, avatar, iat, exp }`. */
export async function requireAuth(c, next) {
  if (!c.env.JWT_SECRET) {
    return c.json({ error: 'Admin API is not configured (JWT_SECRET missing).' }, 500);
  }

  const header = c.req.header('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Re-check against the DB (indexed PK lookup, cheap) so a deleted or role-changed account
  // can't keep acting on a still-valid JWT until it naturally expires (up to 12h) — otherwise
  // e.g. self-deleting your own account wouldn't actually revoke access until token expiry.
  const user = await c.env.DB.prepare('SELECT username, role, avatar, password_hash FROM admin_users WHERE id = ?').bind(payload.sub).first();
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  // A password change ends older sessions. (Sessions signed before this check existed have no `pv`; they simply run out
  // within their 12 hours.)
  if (payload.pv !== undefined && payload.pv !== (await passwordVersion(user.password_hash))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('admin', { ...payload, username: user.username, role: user.role, avatar: user.avatar });
  await next();
}

/** Restricts a route to specific roles. Must run after requireAuth. */
export function requireRole(...roles) {
  return async (c, next) => {
    const admin = c.get('admin');
    if (!admin || !roles.includes(admin.role)) {
      return c.json({ error: 'Forbidden: your role does not have access to this resource' }, 403);
    }
    await next();
  };
}
