import { Hono } from 'hono';
import { hashPassword, verifyPassword } from '../lib/auth.js';
import { signPersonToken, requirePerson } from '../lib/personAuth.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { mailEnabled, siteOrigin, sendMail } from '../lib/mail.js';
import { verifyEmailMessage, resetPasswordMessage } from '../lib/mailTemplates.js';
import { createToken, consumeToken, recentCount, MAX_EMAILS_PER_HOUR } from '../lib/emailTokens.js';
import { googleEnabled, verifyGoogleIdToken } from '../lib/google.js';
import { validateOwnerEdit, validateContact } from '../lib/profile.js';
import { logAudit } from '../lib/audit.js';
import { bioToHtml, bioPlain } from '../lib/richText.js';
import { loadOffer, validateOrderInput } from '../lib/green.js';

// Artist / composer accounts, mounted at /api/v1/account. Anyone can register an account, but an account can
// change nothing until a Manager / Super Admin approves a claim on a profile (see adminClaims.js).
//   POST   /register  /login               → { token, account }
//   GET    /me                             → the account and its claims
//   POST   /change-password
//   POST   /claims                         → ask to claim an artist / composer profile (pending review)
//   DELETE /claims/:id                     → withdraw a pending claim
//   GET    /claims/:id/profile  PUT …      → read / edit an APPROVED claim's profile (bio, photo, social links)
//   GET    /green                          → Green mark: plans, how to pay, my profiles' marks and my orders
//   POST   /green/orders  DELETE /green/orders/:id   → order a plan (reviewed by a Super Admin) / cancel a pending order
const app = new Hono();

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const EVIDENCE_MIN = 10;
const EVIDENCE_MAX = 1000;
const MAX_OPEN_CLAIMS = 5;       // pending + approved per account
const MAX_NEW_CLAIMS_PER_DAY = 5;

const LOCKOUT_WINDOW_MINUTES = 15;
const LOCKOUT_THRESHOLD = 5;
// Same shape as a real hash, so a login for an unknown username costs the same as a wrong password.
const DUMMY_PASSWORD_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const TYPES = { artist: { table: 'artists', fk: 'artist_id' }, composer: { table: 'composers', fk: 'composer_id' } };
const ip = (c) => c.req.header('CF-Connecting-IP');

// 'password_hash' of an account that has no password (it only signs in with Google). Not a valid hash, so no password matches it.
const NO_PASSWORD = '!';
const hasPassword = (a) => !!a.password_hash && a.password_hash !== NO_PASSWORD;
const ACCOUNT_COLS = 'id, username, password_hash, contact_email, contact_phone, email_verified_at, google_sub, session_epoch';

const publicAccount = (a) => ({
  id: a.id, username: a.username, contact_email: a.contact_email ?? null, contact_phone: a.contact_phone ?? null,
  contact_complete: !!(a.contact_email && a.contact_phone),
  email_verified: !!a.email_verified_at,
  has_password: hasPassword(a),
  google: !!a.google_sub,
});

const normEmail = (e) => String(e || '').trim().toLowerCase();
const isEmailLike = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const loadAccount = (db, id) => db.prepare(`SELECT ${ACCOUNT_COLS} FROM person_accounts WHERE id = ?`).bind(id).first();

/** A free username derived from an email address ("ann.lee+x@gmail.com" → "ann.lee", "ann.lee4821" if taken). */
async function freeUsername(db, email) {
  let base = normEmail(email).split('@')[0].replace(/[^a-z0-9._-]/g, '.').replace(/^[^a-z0-9]+/, '').slice(0, 24);
  if (base.length < 3) base = `${base}user`.slice(0, 24);
  for (let i = 0; i < 20; i++) {
    const name = i === 0 ? base : `${base}${Math.floor(1000 + Math.random() * 9000)}`;
    if (!(await db.prepare('SELECT 1 FROM person_accounts WHERE username = ?').bind(name).first())) return name;
  }
  return `${base}${Date.now().toString(36)}`.slice(0, 30);
}

const verifiedEmailTaken = (db, email, exceptId = 0) => db
  .prepare('SELECT 1 FROM person_accounts WHERE lower(contact_email) = ? AND email_verified_at IS NOT NULL AND id != ?').bind(normEmail(email), exceptId).first();

/**
 * Emails a confirmation link for the account's current address. → 'sent' | 'limited' | 'failed' | 'off'.
 * Never throws: a mail problem must not break registration.
 */
async function sendVerification(c, account) {
  if (!mailEnabled(c.env)) return 'off';
  if (!account.contact_email) return 'failed';
  const db = c.env.DB;
  if ((await recentCount(db, { accountId: account.id, email: account.contact_email, kind: 'verify' })) >= MAX_EMAILS_PER_HOUR) return 'limited';
  const token = await createToken(db, { accountId: account.id, email: account.contact_email, kind: 'verify' });
  const msg = verifyEmailMessage({ link: `${siteOrigin(c.env)}/my-profile?verify=${encodeURIComponent(token)}` });
  return (await sendMail(c.env, { to: account.contact_email, ...msg })).ok ? 'sent' : 'failed';
}

/** An account that must confirm its email before claiming or ordering (only once email sending is configured). */
const mustVerify = (env, account) => mailEnabled(env) && !account.email_verified_at;
const UNVERIFIED = { error: 'Please confirm your email address first. We emailed you a link — you can ask for a new one in the Account tab.', code: 'email_unverified' };

// What the page needs to know before it draws the sign-in box.
app.get('/config', (c) => c.json({ google_client_id: googleEnabled(c.env) ? c.env.GOOGLE_CLIENT_ID : null, email_enabled: mailEnabled(c.env) }));

app.post('/register', async (c) => {
  const data = await c.req.json().catch(() => ({}));
  const password = String(data.password || '');
  if (password.length < PASSWORD_MIN) return c.json({ error: `Password must be at least ${PASSWORD_MIN} characters` }, 400);
  if (password.length > PASSWORD_MAX) return c.json({ error: 'Password is too long' }, 400);
  // Real identity: email AND phone are compulsory.
  const contact = validateContact({ contact_email: data.email ?? data.contact_email, contact_phone: data.contact_phone });
  if (!contact.ok) return c.json({ error: contact.error }, 400);
  // The username is optional now (people sign in with their email); one is made from the email when it is left out.
  const wanted = String(data.username || '').trim().toLowerCase();
  if (wanted && !USERNAME_RE.test(wanted)) return c.json({ error: 'Username must be 3–30 characters: letters, numbers, dot, dash or underscore' }, 400);
  if (!(await verifyTurnstile(data.turnstile_token, c.env, ip(c)))) return c.json({ error: 'Security check failed. Please try again.' }, 400);

  const db = c.env.DB;
  if (wanted && (await db.prepare('SELECT 1 FROM person_accounts WHERE username = ?').bind(wanted).first())) {
    return c.json({ error: 'That username is already taken' }, 409);
  }
  if (await verifiedEmailTaken(db, contact.email)) {
    return c.json({ error: 'An account with this email already exists. Sign in, or use "Forgot password" if you need a new password.' }, 409);
  }
  const username = wanted || (await freeUsername(db, contact.email));
  let result;
  try {
    result = await db
      .prepare('INSERT INTO person_accounts (username, password_hash, contact_email, contact_phone) VALUES (?, ?, ?, ?)')
      .bind(username, await hashPassword(password), contact.email, contact.phone)
      .run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) return c.json({ error: 'That username is already taken' }, 409);
    throw err;
  }
  const account = await loadAccount(db, result.meta.last_row_id);
  const verification = await sendVerification(c, account);
  return c.json({ token: await signPersonToken(account, c.env), account: publicAccount(account), verification }, 201);
});

app.post('/login', async (c) => {
  // Accepts an email address or a username (old accounts were made with a username).
  const body = await c.req.json().catch(() => ({}));
  const identifier = String(body.identifier ?? body.email ?? body.username ?? '').trim().toLowerCase();
  const password = body.password;
  if (!identifier || !password) return c.json({ error: 'Email and password are required' }, 400);

  const db = c.env.DB;
  // Brute-force lockout, same scheme as the admin login (own key prefix so the two never share a counter).
  const key = `person:${identifier}`;
  await db.prepare(`DELETE FROM login_attempts WHERE username = ? AND created_at < datetime('now', ?)`).bind(key, `-${LOCKOUT_WINDOW_MINUTES} minutes`).run();
  const { count } = await db.prepare('SELECT COUNT(*) AS count FROM login_attempts WHERE username = ?').bind(key).first();
  if (count >= LOCKOUT_THRESHOLD) return c.json({ error: `Too many failed attempts. Try again in ${LOCKOUT_WINDOW_MINUTES} minutes.` }, 429);

  const candidates = identifier.includes('@')
    ? (await db.prepare(`SELECT ${ACCOUNT_COLS} FROM person_accounts WHERE lower(contact_email) = ? ORDER BY (email_verified_at IS NULL), id LIMIT 3`).bind(identifier).all()).results
    : [await db.prepare(`SELECT ${ACCOUNT_COLS} FROM person_accounts WHERE username = ?`).bind(identifier).first()].filter(Boolean);

  let account = null;
  for (const candidate of candidates) {
    if (hasPassword(candidate) && (await verifyPassword(String(password), candidate.password_hash))) { account = candidate; break; }
  }
  // Same cost whether the account exists, only signs in with Google, or the password is wrong.
  if (!account && !candidates.some(hasPassword)) await verifyPassword(String(password), DUMMY_PASSWORD_HASH);
  if (!account) {
    await db.prepare('INSERT INTO login_attempts (username) VALUES (?)').bind(key).run();
    return c.json({ error: 'Invalid email or password' }, 401);
  }
  await db.prepare('DELETE FROM login_attempts WHERE username = ?').bind(key).run();
  return c.json({ token: await signPersonToken(account, c.env), account: publicAccount(account) });
});

// Sign in / sign up with Google. The page sends the ID token Google gave it; see worker/lib/google.js.
app.post('/google', async (c) => {
  const { credential } = await c.req.json().catch(() => ({}));
  const g = await verifyGoogleIdToken(credential, c.env);
  if (!g.ok) return c.json({ error: g.error }, 400);
  const db = c.env.DB;

  let account = await db.prepare(`SELECT ${ACCOUNT_COLS} FROM person_accounts WHERE google_sub = ?`).bind(g.sub).first();
  let created = false;
  let passwordRemoved = false;

  if (!account) {
    const byEmail = (await db.prepare(`SELECT ${ACCOUNT_COLS} FROM person_accounts WHERE lower(contact_email) = ? ORDER BY (email_verified_at IS NULL), id LIMIT 1`).bind(g.email).first()) || null;
    if (byEmail) {
      if (byEmail.google_sub) return c.json({ error: 'This email is already linked to a different Google account.' }, 409);
      // Google vouches that the person signing in owns this address, so the account is theirs.
      // If the address was never verified, somebody else may have registered it first: switch their password off and
      // end their sessions, so only the real owner (via Google, or "Forgot password" by email) gets in.
      const unverified = !byEmail.email_verified_at;
      passwordRemoved = unverified && hasPassword(byEmail);
      await db
        .prepare(`UPDATE person_accounts SET google_sub = ?, email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
                  password_hash = CASE WHEN ? THEN ? ELSE password_hash END, session_epoch = session_epoch + (CASE WHEN ? THEN 1 ELSE 0 END),
                  updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(g.sub, passwordRemoved ? 1 : 0, NO_PASSWORD, passwordRemoved ? 1 : 0, byEmail.id)
        .run();
      account = await loadAccount(db, byEmail.id);
    } else {
      const username = await freeUsername(db, g.email);
      try {
        const r = await db
          .prepare(`INSERT INTO person_accounts (username, password_hash, contact_email, email_verified_at, google_sub) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)`)
          .bind(username, NO_PASSWORD, g.email, g.sub)
          .run();
        account = await loadAccount(db, r.meta.last_row_id);
        created = true;
      } catch (err) {
        if (/UNIQUE/i.test(String(err.message))) return c.json({ error: 'Could not create your account — please try again.' }, 409);
        throw err;
      }
    }
  }
  return c.json({ token: await signPersonToken(account, c.env), account: publicAccount(account), created, password_removed: passwordRemoved });
});

// ── Email links (no sign-in needed: the link itself is the proof) ──
app.post('/verify-email', async (c) => {
  const { token } = await c.req.json().catch(() => ({}));
  const spent = await consumeToken(c.env.DB, { token, kind: 'verify' });
  if (!spent) return c.json({ error: 'This link has expired or was already used. Sign in and ask for a new one in the Account tab.' }, 400);
  const account = await loadAccount(c.env.DB, spent.account_id);
  if (!account || normEmail(account.contact_email) !== normEmail(spent.email)) {
    return c.json({ error: 'This link is for an email address that is no longer on your account.' }, 400);
  }
  if (!account.email_verified_at) {
    try {
      await c.env.DB.prepare('UPDATE person_accounts SET email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND email_verified_at IS NULL').bind(account.id).run();
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message))) return c.json({ error: 'That email address is already confirmed on another account.' }, 409);
      throw err;
    }
  }
  return c.json({ ok: true, email: account.contact_email });
});

app.post('/forgot-password', async (c) => {
  const data = await c.req.json().catch(() => ({}));
  if (!mailEnabled(c.env)) return c.json({ error: 'Password reset by email is not available right now. Please contact us.' }, 503);
  const email = normEmail(data.email);
  if (!isEmailLike(email) || email.length > 200) return c.json({ error: 'Enter the email address of your account' }, 400);
  if (!(await verifyTurnstile(data.turnstile_token, c.env, ip(c)))) return c.json({ error: 'Security check failed. Please try again.' }, 400);

  const db = c.env.DB;
  const account = await db.prepare(`SELECT ${ACCOUNT_COLS} FROM person_accounts WHERE lower(contact_email) = ? ORDER BY (email_verified_at IS NULL), id LIMIT 1`).bind(email).first();
  if (account && (await recentCount(db, { accountId: account.id, email, kind: 'reset' })) < MAX_EMAILS_PER_HOUR) {
    const token = await createToken(db, { accountId: account.id, email, kind: 'reset' });
    await sendMail(c.env, { to: account.contact_email, ...resetPasswordMessage({ link: `${siteOrigin(c.env)}/my-profile?reset=${encodeURIComponent(token)}` }) });
  }
  // The same answer whether or not an account exists, so this can't be used to find out who is registered.
  return c.json({ ok: true });
});

app.post('/reset-password', async (c) => {
  const { token, new_password } = await c.req.json().catch(() => ({}));
  const password = String(new_password || '');
  if (password.length < PASSWORD_MIN) return c.json({ error: `New password must be at least ${PASSWORD_MIN} characters` }, 400);
  if (password.length > PASSWORD_MAX) return c.json({ error: 'Password is too long' }, 400);
  const db = c.env.DB;
  const spent = await consumeToken(db, { token, kind: 'reset' });
  if (!spent) return c.json({ error: 'This link has expired or was already used. Ask for a new one.' }, 400);
  const account = await loadAccount(db, spent.account_id);
  if (!account || normEmail(account.contact_email) !== normEmail(spent.email)) return c.json({ error: 'This link is for an email address that is no longer on your account.' }, 400);

  await db.prepare('UPDATE person_accounts SET password_hash = ?, session_epoch = session_epoch + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(await hashPassword(password), account.id).run();
  // Following the emailed link proves they own the address.
  if (!account.email_verified_at) {
    await db.prepare('UPDATE person_accounts SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ? AND email_verified_at IS NULL').bind(account.id).run().catch(() => {});
  }
  await db.prepare('DELETE FROM login_attempts WHERE username IN (?, ?)').bind(`person:${account.username}`, `person:${normEmail(account.contact_email)}`).run();
  return c.json({ ok: true });
});

// ── Everything below needs a signed-in artist account ──
app.use('/me', requirePerson);
app.use('/change-password', requirePerson);
app.use('/contact', requirePerson);
app.use('/verify-email/send', requirePerson);
app.use('/claims', requirePerson);
app.use('/claims/*', requirePerson);
app.use('/green', requirePerson);
app.use('/green/*', requirePerson);

async function loadClaims(db, accountId) {
  const rows = await db
    .prepare(
      `SELECT c.id, c.status, c.evidence, c.review_note, c.created_at, c.reviewed_at,
              CASE WHEN c.artist_id IS NOT NULL THEN 'artist' ELSE 'composer' END AS type,
              COALESCE(a.name, p.name) AS name, COALESCE(a.slug, p.slug) AS slug
       FROM person_claims c
       LEFT JOIN artists a ON a.id = c.artist_id
       LEFT JOIN composers p ON p.id = c.composer_id
       WHERE c.account_id = ? ORDER BY c.created_at DESC, c.id DESC`
    )
    .bind(accountId)
    .all();
  return rows.results;
}

app.get('/me', async (c) => {
  const person = c.get('person');
  return c.json({ account: publicAccount(await loadAccount(c.env.DB, person.id)), claims: await loadClaims(c.env.DB, person.id) });
});

app.post('/verify-email/send', async (c) => {
  if (!mailEnabled(c.env)) return c.json({ error: 'Email is not available right now.' }, 503);
  const account = await loadAccount(c.env.DB, c.get('person').id);
  if (account.email_verified_at) return c.json({ ok: true, already: true });
  const result = await sendVerification(c, account);
  if (result === 'limited') return c.json({ error: 'We already sent you a few emails. Please check your inbox (and spam folder), or try again in an hour.' }, 429);
  if (result !== 'sent') return c.json({ error: 'We could not send the email just now. Please try again in a few minutes.' }, 502);
  return c.json({ ok: true });
});

app.put('/contact', async (c) => {
  const contact = validateContact(await c.req.json().catch(() => ({})));
  if (!contact.ok) return c.json({ error: contact.error }, 400);
  const db = c.env.DB;
  const before = await loadAccount(db, c.get('person').id);
  const emailChanged = normEmail(before.contact_email) !== contact.email;
  if (emailChanged && (await verifiedEmailTaken(db, contact.email, before.id))) {
    return c.json({ error: 'That email address belongs to another account.' }, 409);
  }
  // A new address has to be confirmed again.
  await db
    .prepare('UPDATE person_accounts SET contact_email = ?, contact_phone = ?, email_verified_at = CASE WHEN ? THEN NULL ELSE email_verified_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(contact.email, contact.phone, emailChanged ? 1 : 0, before.id)
    .run();
  const account = await loadAccount(db, before.id);
  const verification = emailChanged ? await sendVerification(c, account) : undefined;
  return c.json({ account: publicAccount(account), verification });
});

app.post('/change-password', async (c) => {
  const person = c.get('person');
  const { current_password, new_password } = await c.req.json().catch(() => ({}));
  if (!new_password) return c.json({ error: 'new_password is required' }, 400);
  if (String(new_password).length < PASSWORD_MIN) return c.json({ error: `New password must be at least ${PASSWORD_MIN} characters` }, 400);
  if (String(new_password).length > PASSWORD_MAX) return c.json({ error: 'Password is too long' }, 400);
  const account = await loadAccount(c.env.DB, person.id);
  // An account that only signs in with Google has no current password to check: it may simply set one.
  if (hasPassword(account)) {
    if (!current_password) return c.json({ error: 'current_password and new_password are required' }, 400);
    if (!(await verifyPassword(String(current_password), account.password_hash))) return c.json({ error: 'Current password is incorrect' }, 401);
  }
  await c.env.DB.prepare('UPDATE person_accounts SET password_hash = ?, session_epoch = session_epoch + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(await hashPassword(String(new_password)), person.id).run();
  // Other sessions are signed out (the epoch moved on); this one gets a fresh token.
  return c.json({ success: true, token: await signPersonToken(await loadAccount(c.env.DB, person.id), c.env) });
});

app.post('/claims', async (c) => {
  const person = c.get('person');
  const data = await c.req.json().catch(() => ({}));
  const type = TYPES[data.type];
  if (!type) return c.json({ error: 'type must be artist or composer' }, 400);
  const evidence = String(data.evidence || '').trim();
  if (evidence.length < EVIDENCE_MIN) return c.json({ error: 'Tell us how we can verify it is you (a link to your official page or social account, for example)' }, 400);
  if (evidence.length > EVIDENCE_MAX) return c.json({ error: `Please keep it under ${EVIDENCE_MAX} characters` }, 400);
  // Both email and phone are compulsory for a claim. The email is the account's own (change it in the Account tab, where
  // it is confirmed again); the phone comes from the form, else from what the account already has.
  const have = await loadAccount(c.env.DB, person.id);
  if (mustVerify(c.env, have)) return c.json(UNVERIFIED, 403);
  const contact = validateContact({ contact_email: have.contact_email ?? data.contact_email, contact_phone: data.contact_phone ?? have.contact_phone });
  if (!contact.ok) return c.json({ error: contact.error }, 400);
  if (!(await verifyTurnstile(data.turnstile_token, c.env, ip(c)))) return c.json({ error: 'Security check failed. Please try again.' }, 400);

  const db = c.env.DB;
  const profile = await db.prepare(`SELECT id, name, slug FROM ${type.table} WHERE slug = ?`).bind(String(data.slug || '')).first();
  if (!profile) return c.json({ error: 'That profile does not exist' }, 404);

  if (await db.prepare(`SELECT 1 FROM person_claims WHERE ${type.fk} = ? AND status = 'approved'`).bind(profile.id).first()) {
    return c.json({ error: 'This profile has already been claimed. If you think that is a mistake, contact us.' }, 409);
  }
  if (await db.prepare(`SELECT 1 FROM person_claims WHERE account_id = ? AND ${type.fk} = ? AND status IN ('pending', 'approved')`).bind(person.id, profile.id).first()) {
    return c.json({ error: 'You already have a claim on this profile' }, 409);
  }
  const open = await db.prepare(`SELECT COUNT(*) AS n FROM person_claims WHERE account_id = ? AND status IN ('pending', 'approved')`).bind(person.id).first();
  if (open.n >= MAX_OPEN_CLAIMS) return c.json({ error: `You can have at most ${MAX_OPEN_CLAIMS} claims open at once` }, 429);
  const today = await db.prepare(`SELECT COUNT(*) AS n FROM person_claims WHERE account_id = ? AND created_at > datetime('now', '-1 day')`).bind(person.id).first();
  if (today.n >= MAX_NEW_CLAIMS_PER_DAY) return c.json({ error: 'Too many claims today. Try again tomorrow.' }, 429);

  if (contact.email !== have.contact_email || contact.phone !== have.contact_phone) {
    await db.prepare('UPDATE person_accounts SET contact_email = ?, contact_phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(contact.email, contact.phone, person.id).run();
  }
  try {
    const result = await db.prepare(`INSERT INTO person_claims (account_id, ${type.fk}, evidence) VALUES (?, ?, ?)`).bind(person.id, profile.id, evidence).run();
    return c.json({ id: result.meta.last_row_id, status: 'pending', type: data.type, name: profile.name, slug: profile.slug }, 201);
  } catch (err) {
    // Lost a race against another claim or this account's duplicate (the unique indexes are the real guard).
    if (/UNIQUE/i.test(String(err.message))) return c.json({ error: 'This profile cannot be claimed right now' }, 409);
    throw err;
  }
});

const claimId = (c) => {
  const n = Number(c.req.param('id'));
  return Number.isInteger(n) && n > 0 ? n : null;
};

app.delete('/claims/:id', async (c) => {
  const id = claimId(c);
  if (!id) return c.json({ error: 'Not found' }, 404);
  const result = await c.env.DB
    .prepare(`DELETE FROM person_claims WHERE id = ? AND account_id = ? AND status = 'pending'`)
    .bind(id, c.get('person').id)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

/** The approved claim (and profile row) this account may edit — re-checked on every request. */
async function ownedProfile(c) {
  const id = claimId(c);
  if (!id) return null;
  const claim = await c.env.DB
    .prepare(`SELECT id, artist_id, composer_id FROM person_claims WHERE id = ? AND account_id = ? AND status = 'approved'`)
    .bind(id, c.get('person').id)
    .first();
  if (!claim) return null;
  const type = claim.artist_id ? 'artist' : 'composer';
  const t = TYPES[type];
  const profile = await c.env.DB.prepare(`SELECT id, name, slug, bio, image_url, social_links FROM ${t.table} WHERE id = ?`).bind(claim.artist_id ?? claim.composer_id).first();
  return profile ? { type, table: t.table, profile } : null;
}

const profileView = ({ type, profile }) => ({
  type, name: profile.name, slug: profile.slug, bio: profile.bio || '', bio_html: bioToHtml(profile.bio), image_url: profile.image_url || '',
  social_links: (() => { try { return JSON.parse(profile.social_links || '[]'); } catch { return []; } })(),
});

app.get('/claims/:id/profile', async (c) => {
  const owned = await ownedProfile(c);
  if (!owned) return c.json({ error: 'Not found' }, 404);
  return c.json(profileView(owned));
});

app.put('/claims/:id/profile', async (c) => {
  const owned = await ownedProfile(c);
  if (!owned) return c.json({ error: 'Not found' }, 404);
  const parsed = validateOwnerEdit(await c.req.json().catch(() => ({})));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { bio, image_url, social_links } = parsed.values;
  const before = owned.profile;

  await c.env.DB
    .prepare(`UPDATE ${owned.table} SET bio = ?, image_url = ?, social_links = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(bio, image_url, social_links, before.id)
    .run();

  // Visible in the admin Audit Log (as "artist:<username>"), with what changed. Photos are named, not copied.
  const changed = [];
  if (bioToHtml(before.bio) !== (bio || '')) changed.push(`bio (was: ${bioPlain(before.bio).replace(/\s+/g, ' ').slice(0, 120) || '—'})`);
  if ((before.image_url || null) !== image_url) changed.push('photo');
  if ((before.social_links || null) !== social_links) changed.push(`social links (was: ${before.social_links || '—'})`);
  if (changed.length) {
    await logAudit(c.env.DB, { sub: null, username: `${owned.type}:${c.get('person').username}` }, 'profile.owner_edit', owned.type, before.id, `${before.name} — ${changed.join('; ')}`);
  }
  const fresh = await c.env.DB.prepare(`SELECT id, name, slug, bio, image_url, social_links FROM ${owned.table} WHERE id = ?`).bind(before.id).first();
  return c.json(profileView({ type: owned.type, profile: fresh }));
});

// ── Green mark ──────────────────────────────────────────────────────────────────────
const MAX_ORDERS_PER_DAY = 5;

app.get('/green', async (c) => {
  const db = c.env.DB;
  const person = c.get('person');
  const offer = await loadOffer(db);
  // Only profiles this account owns (approved claim) can get a mark.
  const profiles = (await db
    .prepare(
      `SELECT c.id AS claim_id,
              CASE WHEN c.artist_id IS NOT NULL THEN 'artist' ELSE 'composer' END AS type,
              COALESCE(a.name, p.name) AS name, COALESCE(a.slug, p.slug) AS slug,
              COALESCE(ma.expires_at, mp.expires_at) AS expires_at,
              (COALESCE(ma.expires_at, mp.expires_at) > datetime('now')) AS active,
              EXISTS (SELECT 1 FROM green_orders o WHERE o.account_id = c.account_id AND o.status = 'pending'
                        AND ((c.artist_id IS NOT NULL AND o.artist_id = c.artist_id) OR (c.composer_id IS NOT NULL AND o.composer_id = c.composer_id))) AS has_pending
       FROM person_claims c
       LEFT JOIN artists a ON a.id = c.artist_id LEFT JOIN composers p ON p.id = c.composer_id
       LEFT JOIN green_marks ma ON ma.artist_id = c.artist_id LEFT JOIN green_marks mp ON mp.composer_id = c.composer_id
       WHERE c.account_id = ? AND c.status = 'approved' ORDER BY name COLLATE NOCASE`
    )
    .bind(person.id)
    .all()).results.map((r) => ({ ...r, active: !!r.active, has_pending: !!r.has_pending, expires_at: r.expires_at || null }));
  const orders = (await db
    .prepare(
      `SELECT o.id, o.months, o.amount_cents, o.currency, o.method, o.reference, o.status, o.review_note, o.created_at,
              COALESCE(a.name, p.name) AS name
       FROM green_orders o LEFT JOIN artists a ON a.id = o.artist_id LEFT JOIN composers p ON p.id = o.composer_id
       WHERE o.account_id = ? ORDER BY o.created_at DESC, o.id DESC LIMIT 50`
    )
    .bind(person.id)
    .all()).results;
  return c.json({ ...offer, profiles, orders });
});

app.post('/green/orders', async (c) => {
  const db = c.env.DB;
  const person = c.get('person');
  const data = await c.req.json().catch(() => ({}));
  const parsed = validateOrderInput(data);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { months, reference, note, receipt } = parsed.values;

  // The profile must be one this account owns right now.
  const claimRef = Number(data.claim_id);
  const claim = Number.isInteger(claimRef) && claimRef > 0
    ? await db.prepare(`SELECT artist_id, composer_id FROM person_claims WHERE id = ? AND account_id = ? AND status = 'approved'`).bind(claimRef, person.id).first()
    : null;
  if (!claim) return c.json({ error: 'Choose one of your approved profiles' }, 404);

  const who = await loadAccount(db, person.id);
  if (mustVerify(c.env, who)) return c.json(UNVERIFIED, 403);
  if (!who?.contact_email || !who?.contact_phone) return c.json({ error: 'Add your email and phone number in the Account tab first, so we can reach you about your payment' }, 400);

  const offer = await loadOffer(db);
  const plan = offer.plans.find((p) => p.months === months);
  if (!plan) return c.json({ error: 'That plan is not available right now' }, 400);

  const recent = await db.prepare(`SELECT COUNT(*) AS n FROM green_orders WHERE account_id = ? AND created_at > datetime('now', '-1 day')`).bind(person.id).first();
  if (recent.n >= MAX_ORDERS_PER_DAY) return c.json({ error: 'Too many orders today. Try again tomorrow.' }, 429);

  const fk = claim.artist_id ? 'artist_id' : 'composer_id';
  try {
    const result = await db
      .prepare(`INSERT INTO green_orders (account_id, ${fk}, months, amount_cents, currency, method, reference, note, receipt) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?)`)
      .bind(person.id, claim.artist_id ?? claim.composer_id, months, plan.price_cents, offer.currency, reference, note, receipt)
      .run();
    return c.json({ id: result.meta.last_row_id, status: 'pending', months, amount_cents: plan.price_cents, currency: offer.currency }, 201);
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) return c.json({ error: 'You already have an order waiting for review for this profile' }, 409);
    throw err;
  }
});

app.delete('/green/orders/:id', async (c) => {
  const id = claimId(c);
  if (!id) return c.json({ error: 'Not found' }, 404);
  const result = await c.env.DB
    .prepare(`UPDATE green_orders SET status = 'cancelled' WHERE id = ? AND account_id = ? AND status = 'pending'`)
    .bind(id, c.get('person').id)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

export default app;
