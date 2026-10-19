/**
 * "Sign in with Google": the page gets a Google ID token (a signed JWT) from Google Identity Services and sends it
 * here. We check Google's RS256 signature against Google's published keys, then that it was issued for OUR client id,
 * is fresh, and carries a verified email. No client secret is involved. GOOGLE_CLIENT_ID (a public value) switches it on.
 */
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const LEEWAY_SECONDS = 60;
const KEYS_TTL_MS = 60 * 60 * 1000;

let keyCache = { at: 0, keys: null };

const b64urlToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
};
const decodeJson = (part) => JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));

async function loadKeys(force) {
  if (!force && keyCache.keys && Date.now() - keyCache.at < KEYS_TTL_MS) return keyCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`Google keys unavailable (${res.status})`);
  const { keys } = await res.json();
  keyCache = { at: Date.now(), keys: Array.isArray(keys) ? keys : [] };
  return keyCache.keys;
}

export const googleEnabled = (env) => !!(env && env.GOOGLE_CLIENT_ID);
export const resetGoogleKeyCache = () => { keyCache = { at: 0, keys: null }; };

/** → { ok: true, sub, email, name, picture } | { ok: false, error } */
export async function verifyGoogleIdToken(idToken, env) {
  if (!googleEnabled(env)) return { ok: false, error: 'Google sign-in is not configured' };
  const bad = (error = 'Google sign-in failed') => ({ ok: false, error });
  if (typeof idToken !== 'string' || idToken.length > 4096) return bad();
  const parts = idToken.split('.');
  if (parts.length !== 3) return bad();
  try {
    const header = decodeJson(parts[0]);
    if (header.alg !== 'RS256' || !header.kid) return bad();

    let keys = await loadKeys(false);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) { keys = await loadKeys(true); jwk = keys.find((k) => k.kid === header.kid); } // Google rotated its keys
    if (!jwk) return bad();

    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return bad();

    const claims = decodeJson(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    if (!ISSUERS.has(claims.iss)) return bad();
    if (claims.aud !== env.GOOGLE_CLIENT_ID) return bad('This Google sign-in was not issued for MaraLyrics');
    if (typeof claims.exp !== 'number' || claims.exp < now - LEEWAY_SECONDS) return bad('Google sign-in expired — please try again');
    if (typeof claims.iat === 'number' && claims.iat > now + LEEWAY_SECONDS) return bad();
    if (!claims.sub || typeof claims.email !== 'string' || !claims.email) return bad();
    if (claims.email_verified !== true && claims.email_verified !== 'true') return bad('Your Google email address is not verified');
    return { ok: true, sub: String(claims.sub), email: claims.email.trim().toLowerCase(), name: claims.name || '', picture: claims.picture || '' };
  } catch (err) {
    console.error(`Google token check failed: ${err && err.message}`);
    return bad();
  }
}
