/**
 * One-time emailed links (kind 'verify' | 'reset'). The raw token only ever exists in the email; the table keeps a
 * SHA-256 of it. A token works once, expires, and creating a new one retires the older unused ones of that kind.
 */
const TTL_MINUTES = { verify: 24 * 60, reset: 60 };
export const MAX_EMAILS_PER_HOUR = 3; // per account + kind, and per address + kind

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** How many links of this kind went to this account / address in the last hour (the send-rate limit). */
export async function recentCount(db, { accountId, email, kind }) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM person_email_tokens
       WHERE kind = ? AND created_at > datetime('now', '-1 hour') AND (account_id = ? OR lower(email) = lower(?))`
    )
    .bind(kind, accountId, email)
    .first();
  return row.n;
}

/** → the raw token to put in the email link. Caller has already checked the rate limit. */
export async function createToken(db, { accountId, email, kind }) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare(`UPDATE person_email_tokens SET used_at = CURRENT_TIMESTAMP WHERE account_id = ? AND kind = ? AND used_at IS NULL`).bind(accountId, kind).run();
  await db
    .prepare(`INSERT INTO person_email_tokens (account_id, kind, email, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))`)
    .bind(accountId, kind, email, await sha256Hex(token), `+${TTL_MINUTES[kind]} minutes`)
    .run();
  return token;
}

/** Spends a token. → { account_id, email } if it was valid, unused and unexpired (and is now used up), else null. */
export async function consumeToken(db, { token, kind }) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(`SELECT id, account_id, email FROM person_email_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > datetime('now')`)
    .bind(hash, kind)
    .first();
  if (!row) return null;
  // The conditional UPDATE is what makes "works once" true even if two requests race.
  const spent = await db.prepare(`UPDATE person_email_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL`).bind(row.id).run();
  return spent.meta.changes === 1 ? { account_id: row.account_id, email: row.email } : null;
}
