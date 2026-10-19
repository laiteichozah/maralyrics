/**
 * Sessions for artist / composer accounts (person_accounts). Deliberately separate from the admin session:
 * the token is signed with a key derived from JWT_SECRET, so an artist token can never verify as an admin
 * token (and vice versa) even though both are HS256 JWTs — an artist account id can't be mistaken for an
 * admin user id by requireAuth. Every request re-reads the account from the DB.
 */
import { signJWT, verifyJWT } from './auth.js';

const personSecret = (env) => `${env.JWT_SECRET}:person-account`;

export const signPersonToken = (account, env) =>
  signJWT({ sub: account.id, typ: 'person', username: account.username, ep: account.session_epoch || 0 }, personSecret(env));

/** Requires `Authorization: Bearer <artist token>`; on success `c.get('person')` is `{ id, username }`. */
export async function requirePerson(c, next) {
  if (!c.env.JWT_SECRET) return c.json({ error: 'Accounts are not configured (JWT_SECRET missing).' }, 500);
  const [scheme, token] = (c.req.header('Authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) return c.json({ error: 'Unauthorized' }, 401);

  const payload = await verifyJWT(token, personSecret(c.env));
  if (!payload || payload.typ !== 'person') return c.json({ error: 'Unauthorized' }, 401);

  const account = await c.env.DB.prepare('SELECT id, username, session_epoch FROM person_accounts WHERE id = ?').bind(payload.sub).first();
  // A password change / reset moves the epoch on, which ends every older session of the account.
  if (!account || (payload.ep || 0) !== account.session_epoch) return c.json({ error: 'Unauthorized' }, 401);
  c.set('person', { id: account.id, username: account.username });
  await next();
}
