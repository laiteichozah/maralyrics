/**
 * Per-IP brute-force guard for the sign-in endpoints, on top of the per-account lockout. The per-account counter stops
 * guessing one name; this one stops a single address from spraying guesses over many names (and from filling the
 * login_attempts table with made-up names). It reuses login_attempts, keyed `ip:<scope>:<address>`. With no address
 * (local tests) it does nothing.
 */
export const IP_WINDOW_MINUTES = 15;
export const IP_FAILURE_LIMIT = 30;

const key = (scope, ip) => `ip:${scope}:${ip}`;

export const RETENTION_HOURS = 24;

/** → true when this address has already failed too many sign-ins in the window. Also prunes its expired rows, and (so no
 *  address or name is kept for longer than the Privacy Policy says) every attempt record older than RETENTION_HOURS. */
export async function ipThrottled(db, scope, ip) {
  await db.prepare(`DELETE FROM login_attempts WHERE created_at < datetime('now', ?)`).bind(`-${RETENTION_HOURS} hours`).run();
  if (!ip) return false;
  await db.prepare(`DELETE FROM login_attempts WHERE username = ? AND created_at < datetime('now', ?)`).bind(key(scope, ip), `-${IP_WINDOW_MINUTES} minutes`).run();
  const { count } = await db.prepare('SELECT COUNT(*) AS count FROM login_attempts WHERE username = ?').bind(key(scope, ip)).first();
  return count >= IP_FAILURE_LIMIT;
}

export async function recordIpFailure(db, scope, ip) {
  if (!ip) return;
  await db.prepare('INSERT INTO login_attempts (username) VALUES (?)').bind(key(scope, ip)).run();
}
