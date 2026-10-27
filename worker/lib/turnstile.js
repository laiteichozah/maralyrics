const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verifies a Cloudflare Turnstile token server-side.
 * Returns true if the token is valid, false otherwise.
 * If TURNSTILE_SECRET_KEY is not configured, verification is skipped
 * (fails open) so local/dev environments without the secret still work.
 */
export async function verifyTurnstile(token, env, ip) {
  if (!env.TURNSTILE_SECRET_KEY) {
    console.warn('TURNSTILE_SECRET_KEY is not set — skipping Turnstile verification.');
    return true;
  }
  if (!token) return false;

  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error(`Turnstile verification failed: ${err && err.message}`);
    return false; // Cloudflare unreachable: the check cannot pass (a person can try again)
  }
}
