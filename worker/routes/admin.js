import { Hono } from 'hono';
import { slugify, parsePagination, mapD1Error, CATEGORIES } from '../lib/helpers.js';
import { hashPassword, verifyPassword, signJWT, requireRole } from '../lib/auth.js';
import {
  ROLES,
  CAN_CREATE_SONG,
  CAN_EDIT_SONG_DIRECT,
  CAN_SUBMIT_REVISION,
  CAN_REVIEW_REVISIONS,
  CAN_DELETE_SONG,
  CAN_MANAGE_REFERENCE_DATA,
  CAN_MANAGE_BADGES,
  CAN_VIEW_ADMIN_USERS,
  CAN_MANAGE_ADMIN_USERS,
  CAN_MANAGE_REPORTS,
  CAN_MANAGE_CONTACTS,
  CAN_VIEW_AUDIT_LOG,
  CAN_CREATE_ARTICLE,
  CAN_EDIT_ARTICLE,
  CAN_PUBLISH_ARTICLE,
  CAN_DELETE_ARTICLE,
  canGrantSuperAdmin,
  statusChangePermission,
} from '../lib/permissions.js';
import { logAudit } from '../lib/audit.js';
import { validateBadgeInput, attachBadges } from '../lib/badges.js';
import { idolSeasonsApp, idolContestantsApp } from './adminIdol.js';
import claimsApp from './adminClaims.js';
import greenApp from './adminGreen.js';
import { AVATARS } from '../lib/avatars.js';
import { isSafeLinkUrl, isSafeImageUrl, validateSocialLinks } from '../lib/profile.js';
import { normalizeBio } from '../lib/richText.js';
import { sanitizeArticleHtml, isHtmlEmpty } from '../lib/sanitizeHtml.js';

const app = new Hono();

function fail(c, err, fallbackStatus = 500) {
  const mapped = mapD1Error(err);
  if (mapped) return c.json({ error: mapped.error }, mapped.status);
  console.error(err);
  return c.json({ error: err.message || 'Internal error' }, fallbackStatus);
}

function statusAction(from, to) {
  if (to === 'published') return 'publish';
  if (to === 'archived') return 'archive';
  if (to === 'pending' && from === 'archived') return 'restore';
  return 'unpublish';
}

// Not a real account — exists only so a nonexistent username still pays the same PBKDF2 cost
// as a real one below, instead of short-circuiting instantly and leaking (via response
// timing) which usernames exist.
const DUMMY_PASSWORD_HASH = 'pbkdf2$100000$4nula02FmgoXy-aLB5wSGw$E1Lhp2PKZX5qQM5g7XTEOHkfbn_g9-q2_jSYJbAF-IY';

// ── Auth: login is public (exempted in worker.js); /me and /change-password
// run behind requireAuth like everything else under /api/v1/admin/*. ──
// Brute-force protection: lock a username out for LOGIN_LOCKOUT_WINDOW_MINUTES after
// LOGIN_LOCKOUT_THRESHOLD failed attempts within that same window. Keyed by the
// submitted username (not IP — D1 has no fast per-IP counter here, and the username is
// already what an attacker is trying to guess the password for) so this also caps how
// many password guesses a single account can be hit with, regardless of source.
const LOGIN_LOCKOUT_WINDOW_MINUTES = 15;
const LOGIN_LOCKOUT_THRESHOLD = 5;

app.post('/auth/login', async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}));
  if (!username || !password) return c.json({ error: 'Username and password are required' }, 400);

  const db = c.env.DB;

  // Prune this username's expired attempts before counting — keeps the table small
  // without a separate cleanup job, and a legitimate user's lockout clears itself over
  // time even without ever successfully logging back in.
  await db
    .prepare(`DELETE FROM login_attempts WHERE username = ? AND created_at < datetime('now', ?)`)
    .bind(username, `-${LOGIN_LOCKOUT_WINDOW_MINUTES} minutes`)
    .run();

  const { count } = await db.prepare('SELECT COUNT(*) AS count FROM login_attempts WHERE username = ?').bind(username).first();
  if (count >= LOGIN_LOCKOUT_THRESHOLD) {
    return c.json({ error: `Too many failed attempts. Try again in ${LOGIN_LOCKOUT_WINDOW_MINUTES} minutes.` }, 429);
  }

  const user = await db.prepare('SELECT * FROM admin_users WHERE username = ?').bind(username).first();
  const passwordOk = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) {
    await db.prepare('INSERT INTO login_attempts (username) VALUES (?)').bind(username).run();
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  // A successful login clears this account's slate, same as any normal lockout scheme.
  await db.prepare('DELETE FROM login_attempts WHERE username = ?').bind(username).run();

  const token = await signJWT({ sub: user.id, username: user.username, role: user.role }, c.env.JWT_SECRET);
  return c.json({ token, id: user.id, username: user.username, role: user.role, avatar: user.avatar, photo: user.photo });
});

app.get('/auth/me', async (c) => {
  const admin = c.get('admin');
  // Not part of requireAuth's per-request lookup — the photo is a few KB and only /me needs it.
  const row = await c.env.DB.prepare('SELECT photo FROM admin_users WHERE id = ?').bind(admin.sub).first();
  return c.json({ id: admin.sub, username: admin.username, role: admin.role, avatar: admin.avatar, photo: row?.photo ?? null });
});

app.post('/auth/change-password', async (c) => {
  const admin = c.get('admin');
  const { current_password, new_password } = await c.req.json().catch(() => ({}));
  if (!current_password || !new_password) {
    return c.json({ error: 'current_password and new_password are required' }, 400);
  }
  if (new_password.length < 8) return c.json({ error: 'New password must be at least 8 characters' }, 400);

  const user = await c.env.DB.prepare('SELECT * FROM admin_users WHERE id = ?').bind(admin.sub).first();
  if (!user || !(await verifyPassword(current_password, user.password_hash))) {
    return c.json({ error: 'Current password is incorrect' }, 401);
  }

  const password_hash = await hashPassword(new_password);
  await c.env.DB.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').bind(password_hash, admin.sub).run();
  return c.json({ success: true });
});

// ── Admin account management (Manager + Admin; granting/touching super_admin is Admin-only) ──
app.get('/admin-users', requireRole(...CAN_VIEW_ADMIN_USERS), async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT id, username, role, created_at, updated_at FROM admin_users ORDER BY username')
    .all();
  return c.json({ admin_users: rows.results, total: rows.results.length });
});

app.post('/admin-users', requireRole(...CAN_MANAGE_ADMIN_USERS), async (c) => {
  const { username, password, role } = await c.req.json().catch(() => ({}));
  if (!username || !password || !role) return c.json({ error: 'username, password, and role are required' }, 400);
  if (!ROLES.includes(role)) return c.json({ error: `role must be one of: ${ROLES.join(', ')}` }, 400);
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400);

  const admin = c.get('admin');
  if (role === 'super_admin' && !canGrantSuperAdmin(admin.role)) {
    return c.json({ error: 'Only an Admin (Super Admin) can grant the Admin role' }, 403);
  }

  try {
    const password_hash = await hashPassword(password);
    const result = await c.env.DB
      .prepare('INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)')
      .bind(username, password_hash, role)
      .run();
    const row = await c.env.DB
      .prepare('SELECT id, username, role, created_at, updated_at FROM admin_users WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first();
    await logAudit(c.env.DB, admin, 'admin_user.create', 'admin_user', result.meta.last_row_id, `username=${username} role=${role}`);
    return c.json(row, 201);
  } catch (err) {
    return fail(c, err);
  }
});

app.put('/admin-users/:id', requireRole(...CAN_MANAGE_ADMIN_USERS), async (c) => {
  const id = Number(c.req.param('id'));
  const { username, password, role } = await c.req.json().catch(() => ({}));
  if (!username || !role) return c.json({ error: 'username and role are required' }, 400);
  if (!ROLES.includes(role)) return c.json({ error: `role must be one of: ${ROLES.join(', ')}` }, 400);
  if (password && password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400);

  const admin = c.get('admin');
  const target = await c.env.DB.prepare('SELECT role FROM admin_users WHERE id = ?').bind(id).first();
  if (!target) return c.json({ error: 'Not found' }, 404);

  // A Manager may not grant super_admin, nor touch an account that's already super_admin.
  if (!canGrantSuperAdmin(admin.role) && (role === 'super_admin' || target.role === 'super_admin')) {
    return c.json({ error: 'Only an Admin (Super Admin) can grant or modify the Admin role' }, 403);
  }

  if (admin.sub === id && role !== 'super_admin') {
    const { count } = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM admin_users WHERE role = 'super_admin'").first();
    if (count <= 1) return c.json({ error: 'Cannot demote the last remaining Super Admin' }, 400);
  }

  try {
    if (password) {
      const password_hash = await hashPassword(password);
      await c.env.DB
        .prepare('UPDATE admin_users SET username = ?, role = ?, password_hash = ? WHERE id = ?')
        .bind(username, role, password_hash, id)
        .run();
    } else {
      await c.env.DB.prepare('UPDATE admin_users SET username = ?, role = ? WHERE id = ?').bind(username, role, id).run();
    }
    const row = await c.env.DB
      .prepare('SELECT id, username, role, created_at, updated_at FROM admin_users WHERE id = ?')
      .bind(id)
      .first();
    if (!row) return c.json({ error: 'Not found' }, 404);
    await logAudit(
      c.env.DB, admin, 'admin_user.edit', 'admin_user', id,
      target.role !== role ? `role: ${target.role} -> ${role}` : `username=${username}`
    );
    return c.json(row);
  } catch (err) {
    return fail(c, err);
  }
});

app.delete('/admin-users/:id', requireRole(...CAN_MANAGE_ADMIN_USERS), async (c) => {
  const id = Number(c.req.param('id'));
  const admin = c.get('admin');
  if (admin.sub === id) return c.json({ error: 'Cannot delete your own account' }, 400);

  try {
    const target = await c.env.DB.prepare('SELECT username, role FROM admin_users WHERE id = ?').bind(id).first();
    if (!target) return c.json({ error: 'Not found' }, 404);

    if (target.role === 'super_admin' && !canGrantSuperAdmin(admin.role)) {
      return c.json({ error: 'Only an Admin (Super Admin) can delete an Admin account' }, 403);
    }

    if (target.role === 'super_admin') {
      const { count } = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM admin_users WHERE role = 'super_admin'").first();
      if (count <= 1) return c.json({ error: 'Cannot delete the last remaining Super Admin' }, 400);
    }

    await c.env.DB.prepare('DELETE FROM admin_users WHERE id = ?').bind(id).run();
    await logAudit(c.env.DB, admin, 'admin_user.delete', 'admin_user', id, target.username);
    return c.json({ success: true });
  } catch (err) {
    return fail(c, err);
  }
});

// ── Profiles (any authenticated admin — every role, not just Manager/Admin) ──
// A lightweight directory (id/username/role/avatar only) so every role can browse who to
// view/follow, distinct from the full-detail `/admin-users` list above which stays
// restricted to Manager+Admin for account management.
app.get('/admin-users/directory', async (c) => {
  const rows = await c.env.DB
    .prepare('SELECT id, username, role, avatar, photo FROM admin_users ORDER BY username')
    .all();
  return c.json({ admin_users: rows.results, total: rows.results.length });
});

app.get('/admin-users/:id/profile', async (c) => {
  const id = Number(c.req.param('id'));
  const admin = c.get('admin');

  const user = await c.env.DB
    .prepare('SELECT id, username, role, avatar, photo, created_at FROM admin_users WHERE id = ?')
    .bind(id)
    .first();
  if (!user) return c.json({ error: 'Not found' }, 404);

  const [followers, following, isFollowing] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM admin_follows WHERE followed_id = ?').bind(id).first(),
    c.env.DB.prepare('SELECT COUNT(*) AS count FROM admin_follows WHERE follower_id = ?').bind(id).first(),
    c.env.DB.prepare('SELECT 1 FROM admin_follows WHERE follower_id = ? AND followed_id = ?').bind(admin.sub, id).first(),
  ]);

  return c.json({
    ...user,
    follower_count: followers.count,
    following_count: following.count,
    is_following: !!isFollowing,
    is_self: admin.sub === id,
  });
});

app.post('/admin-users/:id/follow', async (c) => {
  const id = Number(c.req.param('id'));
  const admin = c.get('admin');
  if (admin.sub === id) return c.json({ error: 'You cannot follow yourself' }, 400);

  const target = await c.env.DB.prepare('SELECT id FROM admin_users WHERE id = ?').bind(id).first();
  if (!target) return c.json({ error: 'Not found' }, 404);

  try {
    await c.env.DB.prepare('INSERT OR IGNORE INTO admin_follows (follower_id, followed_id) VALUES (?, ?)').bind(admin.sub, id).run();
    return c.json({ success: true });
  } catch (err) {
    return fail(c, err);
  }
});

app.delete('/admin-users/:id/follow', async (c) => {
  const id = Number(c.req.param('id'));
  const admin = c.get('admin');
  await c.env.DB.prepare('DELETE FROM admin_follows WHERE follower_id = ? AND followed_id = ?').bind(admin.sub, id).run();
  return c.json({ success: true });
});

// ── Self-service profile management (any role — username, avatar, account deletion).
// Password change is already handled by /auth/change-password above. ──
const profileApp = new Hono();

const MAX_PHOTO_CHARS = 200_000;
function isValidPhoto(v) {
  return typeof v === 'string' && v.length <= MAX_PHOTO_CHARS && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(v);
}

profileApp.put('/', async (c) => {
  const admin = c.get('admin');
  const data = await c.req.json().catch(() => ({}));
  const { username, avatar, photo } = data;

  if (username !== undefined && (typeof username !== 'string' || !username.trim())) {
    return c.json({ error: 'Username cannot be empty' }, 400);
  }
  if (avatar !== undefined && avatar !== null && !AVATARS.includes(avatar)) {
    return c.json({ error: 'Invalid avatar selection' }, 400);
  }

  // The client crops/resizes to a small JPEG before upload; the size cap keeps a hand-crafted
  // request from stuffing arbitrary blobs into the row.
  if (photo !== undefined && photo !== null && !isValidPhoto(photo)) {
    return c.json({ error: 'Photo must be a PNG, JPEG or WebP image under 200 KB' }, 400);
  }

  const current = await c.env.DB.prepare('SELECT username, avatar, photo FROM admin_users WHERE id = ?').bind(admin.sub).first();
  const newUsername = username !== undefined ? username.trim() : current.username;
  const newAvatar = avatar !== undefined ? avatar : current.avatar;
  const newPhoto = photo !== undefined ? photo : current.photo;

  try {
    await c.env.DB
      .prepare('UPDATE admin_users SET username = ?, avatar = ?, photo = ? WHERE id = ?')
      .bind(newUsername, newAvatar, newPhoto, admin.sub)
      .run();
    const row = await c.env.DB
      .prepare('SELECT id, username, role, avatar, photo, created_at, updated_at FROM admin_users WHERE id = ?')
      .bind(admin.sub)
      .first();
    await logAudit(c.env.DB, admin, 'admin_user.self_edit', 'admin_user', admin.sub, `username=${newUsername}`);
    return c.json(row);
  } catch (err) {
    return fail(c, err);
  }
});

profileApp.post('/delete', async (c) => {
  const admin = c.get('admin');
  const { password } = await c.req.json().catch(() => ({}));
  if (!password) return c.json({ error: 'Password is required to delete your account' }, 400);

  try {
    const user = await c.env.DB.prepare('SELECT * FROM admin_users WHERE id = ?').bind(admin.sub).first();
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return c.json({ error: 'Incorrect password' }, 401);
    }

    if (user.role === 'super_admin') {
      const { count } = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM admin_users WHERE role = 'super_admin'").first();
      if (count <= 1) return c.json({ error: 'Cannot delete the last remaining Super Admin' }, 400);
    }

    // Log before deleting — audit_log.admin_id has an FK on admin_users(id); logging after
    // the row is gone would fail that constraint instead of just SET NULL-ing on a future delete.
    await logAudit(c.env.DB, admin, 'admin_user.self_delete', 'admin_user', admin.sub, user.username);
    await c.env.DB.prepare('DELETE FROM admin_users WHERE id = ?').bind(admin.sub).run();
    return c.json({ success: true });
  } catch (err) {
    return fail(c, err);
  }
});

app.route('/profile', profileApp);

// ── Generic CRUD for simple "person" resources: artists, composers ──
// Read is open to any authenticated admin (all 6 roles); write (create/edit/delete)
// is restricted to Manager + Admin — the "shared reference data" owners.
function personCrud(table) {
  const sub = new Hono();
  const targetType = table.replace(/s$/, '');

  const badgeFk = `${targetType}_id`;

  sub.get('/', async (c) => {
    const rows = await c.env.DB.prepare(`SELECT * FROM ${table} ORDER BY name`).all();
    const people = await attachBadges(c.env.DB, rows.results, targetType, { withIds: true });
    return c.json({ [table]: people, total: people.length });
  });

  sub.get('/:id', async (c) => {
    const row = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(c.req.param('id')).first();
    if (!row) return c.json({ error: 'Not found' }, 404);
    const [person] = await attachBadges(c.env.DB, [row], targetType, { withIds: true });
    return c.json(person);
  });

  // ── Recognition badges (month / year / lifetime). Awarding and removing are Super Admin
  // only; requireAuth has already re-read the caller's role from the DB for this request, so a
  // demoted account loses this immediately rather than when its JWT expires. ──
  sub.post('/:id/badges', requireRole(...CAN_MANAGE_BADGES), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'Not found' }, 404);
    const person = await c.env.DB.prepare(`SELECT id, name FROM ${table} WHERE id = ?`).bind(id).first();
    if (!person) return c.json({ error: 'Not found' }, 404);

    const input = validateBadgeInput(await c.req.json().catch(() => ({})));
    if (!input.ok) return c.json({ error: input.error }, 400);
    const { period, period_value, title } = input.value;

    const duplicate = await c.env.DB
      .prepare(`SELECT id FROM person_badges WHERE ${badgeFk} = ? AND period = ? AND period_value = ?`)
      .bind(id, period, period_value)
      .first();
    if (duplicate) return c.json({ error: `${person.name} already has this ${period} badge` }, 409);

    try {
      const admin = c.get('admin');
      const result = await c.env.DB
        .prepare(`INSERT INTO person_badges (${badgeFk}, period, period_value, title, awarded_by) VALUES (?, ?, ?, ?, ?)`)
        .bind(id, period, period_value, title, admin.sub)
        .run();
      const badge = await c.env.DB
        .prepare('SELECT id, period, period_value, title, created_at FROM person_badges WHERE id = ?')
        .bind(result.meta.last_row_id)
        .first();
      await logAudit(c.env.DB, admin, 'badge.award', targetType, id, `${person.name} — ${period}${period_value ? ` ${period_value}` : ''}${title ? ` “${title}”` : ''}`);
      return c.json(badge, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  sub.delete('/:id/badges/:badgeId', requireRole(...CAN_MANAGE_BADGES), async (c) => {
    const id = Number(c.req.param('id'));
    const badgeId = Number(c.req.param('badgeId'));
    if (!Number.isInteger(id) || !Number.isInteger(badgeId)) return c.json({ error: 'Not found' }, 404);
    // Scoped to the person in the URL, so a badge id can't be removed via someone else's route.
    const badge = await c.env.DB
      .prepare(`SELECT b.period, b.period_value, p.name FROM person_badges b JOIN ${table} p ON p.id = b.${badgeFk} WHERE b.id = ? AND b.${badgeFk} = ?`)
      .bind(badgeId, id)
      .first();
    if (!badge) return c.json({ error: 'Not found' }, 404);
    await c.env.DB.prepare('DELETE FROM person_badges WHERE id = ?').bind(badgeId).run();
    await logAudit(c.env.DB, c.get('admin'), 'badge.remove', targetType, id, `${badge.name} — ${badge.period}${badge.period_value ? ` ${badge.period_value}` : ''}`);
    return c.json({ success: true });
  });

  sub.post('/', requireRole(...CAN_MANAGE_REFERENCE_DATA), async (c) => {
    const data = await c.req.json().catch(() => ({}));
    const { name, image_url, social_links } = data;
    if (!name) return c.json({ error: 'name is required' }, 400);
    const richBio = normalizeBio(data.bio);
    if (!richBio.ok) return c.json({ error: richBio.error }, 400);
    const bio = richBio.value;
    if (image_url && !isSafeImageUrl(image_url)) return c.json({ error: 'image_url must be an http(s) or data:image URL' }, 400);
    const links = validateSocialLinks(social_links);
    if (!links.ok) return c.json({ error: 'social_links must be http(s) or mailto URLs' }, 400);
    const slug = data.slug?.trim() || slugify(name);

    try {
      const result = await c.env.DB
        .prepare(`INSERT INTO ${table} (name, slug, bio, image_url, social_links) VALUES (?, ?, ?, ?, ?)`)
        .bind(name, slug, bio || null, image_url || null, links.value)
        .run();
      const row = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(result.meta.last_row_id).first();
      await logAudit(c.env.DB, c.get('admin'), `${targetType}.create`, targetType, result.meta.last_row_id, name);
      return c.json(row, 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  sub.put('/:id', requireRole(...CAN_MANAGE_REFERENCE_DATA), async (c) => {
    const id = c.req.param('id');
    const data = await c.req.json().catch(() => ({}));
    const { name, image_url, social_links } = data;
    if (!name) return c.json({ error: 'name is required' }, 400);
    const richBio = normalizeBio(data.bio);
    if (!richBio.ok) return c.json({ error: richBio.error }, 400);
    const bio = richBio.value;
    if (image_url && !isSafeImageUrl(image_url)) return c.json({ error: 'image_url must be an http(s) or data:image URL' }, 400);
    const links = validateSocialLinks(social_links);
    if (!links.ok) return c.json({ error: 'social_links must be http(s) or mailto URLs' }, 400);
    const slug = data.slug?.trim() || slugify(name);

    try {
      const result = await c.env.DB
        .prepare(`UPDATE ${table} SET name = ?, slug = ?, bio = ?, image_url = ?, social_links = ? WHERE id = ?`)
        .bind(name, slug, bio || null, image_url || null, links.value, id)
        .run();
      if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
      const row = await c.env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      await logAudit(c.env.DB, c.get('admin'), `${targetType}.edit`, targetType, Number(id), name);
      return c.json(row);
    } catch (err) {
      return fail(c, err);
    }
  });

  sub.delete('/:id', requireRole(...CAN_MANAGE_REFERENCE_DATA), async (c) => {
    const id = c.req.param('id');
    const result = await c.env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
    if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
    await logAudit(c.env.DB, c.get('admin'), `${targetType}.delete`, targetType, Number(id), null);
    return c.json({ success: true });
  });

  return sub;
}

app.route('/artists', personCrud('artists'));
app.route('/composers', personCrud('composers'));

// ── Copyright owners (read: any admin; write: Manager + Admin) ──
const CO_FIELDS = [
  'full_legal_name', 'organization', 'territory', 'email', 'website',
  'address', 'ipi_number', 'isrc_prefix', 'pro_affiliation', 'notes', 'image_url',
];

const coApp = new Hono();

coApp.get('/', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM copyright_owners ORDER BY name').all();
  return c.json({ copyright_owners: rows.results, total: rows.results.length });
});

coApp.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM copyright_owners WHERE id = ?').bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

coApp.post('/', requireRole(...CAN_MANAGE_REFERENCE_DATA), async (c) => {
  const data = await c.req.json().catch(() => ({}));
  if (!data.name) return c.json({ error: 'name is required' }, 400);
  if (data.website && !isSafeLinkUrl(data.website)) return c.json({ error: 'website must be an http(s) or mailto URL' }, 400);
  if (data.image_url && !isSafeImageUrl(data.image_url)) return c.json({ error: 'image_url must be an http(s) or data:image URL' }, 400);
  const slug = data.slug?.trim() || slugify(data.name);
  const values = CO_FIELDS.map((f) => data[f] || null);

  try {
    const result = await c.env.DB
      .prepare(
        `INSERT INTO copyright_owners (name, slug, ${CO_FIELDS.join(', ')})
         VALUES (?, ?, ${CO_FIELDS.map(() => '?').join(', ')})`
      )
      .bind(data.name, slug, ...values)
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM copyright_owners WHERE id = ?').bind(result.meta.last_row_id).first();
    await logAudit(c.env.DB, c.get('admin'), 'copyright_owner.create', 'copyright_owner', result.meta.last_row_id, data.name);
    return c.json(row, 201);
  } catch (err) {
    return fail(c, err);
  }
});

coApp.put('/:id', requireRole(...CAN_MANAGE_REFERENCE_DATA), async (c) => {
  const id = c.req.param('id');
  const data = await c.req.json().catch(() => ({}));
  if (!data.name) return c.json({ error: 'name is required' }, 400);
  if (data.website && !isSafeLinkUrl(data.website)) return c.json({ error: 'website must be an http(s) or mailto URL' }, 400);
  if (data.image_url && !isSafeImageUrl(data.image_url)) return c.json({ error: 'image_url must be an http(s) or data:image URL' }, 400);
  const slug = data.slug?.trim() || slugify(data.name);
  const values = CO_FIELDS.map((f) => data[f] || null);

  try {
    const result = await c.env.DB
      .prepare(
        `UPDATE copyright_owners SET name = ?, slug = ?, ${CO_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`
      )
      .bind(data.name, slug, ...values, id)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
    const row = await c.env.DB.prepare('SELECT * FROM copyright_owners WHERE id = ?').bind(id).first();
    await logAudit(c.env.DB, c.get('admin'), 'copyright_owner.edit', 'copyright_owner', Number(id), data.name);
    return c.json(row);
  } catch (err) {
    return fail(c, err);
  }
});

coApp.delete('/:id', requireRole(...CAN_MANAGE_REFERENCE_DATA), async (c) => {
  const id = c.req.param('id');
  const result = await c.env.DB.prepare('DELETE FROM copyright_owners WHERE id = ?').bind(id).run();
  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
  await logAudit(c.env.DB, c.get('admin'), 'copyright_owner.delete', 'copyright_owner', Number(id), null);
  return c.json({ success: true });
});

app.route('/copyright-owners', coApp);

// ── Sponsors & partners (shown on the public Project page) ──
const supApp = new Hono();
supApp.use('*', requireRole(...CAN_MANAGE_REFERENCE_DATA));

const SUPPORTER_KINDS = ['sponsor', 'partner'];

// Returns { ok: true, values: [...] } in column order (kind, name, description, logo_url,
// website_url, sort_order) or { ok: false, error }.
function readSupporter(data) {
  const kind = data.kind;
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const logo = typeof data.logo_url === 'string' ? data.logo_url.trim() : '';
  const website = typeof data.website_url === 'string' ? data.website_url.trim() : '';
  const sort = data.sort_order === undefined || data.sort_order === '' || data.sort_order === null ? 0 : Number(data.sort_order);
  if (!SUPPORTER_KINDS.includes(kind)) return { ok: false, error: 'kind must be "sponsor" or "partner"' };
  if (!name) return { ok: false, error: 'name is required' };
  if (name.length > 200) return { ok: false, error: 'name is too long (max 200 characters)' };
  if (description.length > 500) return { ok: false, error: 'description is too long (max 500 characters)' };
  if (website && !/^https?:\/\//i.test(website)) return { ok: false, error: 'website must be an http(s) URL' };
  if (logo && !isSafeImageUrl(logo)) return { ok: false, error: 'logo must be an http(s) or data:image URL' };
  if (!Number.isInteger(sort)) return { ok: false, error: 'sort_order must be a whole number' };
  return { ok: true, values: [kind, name, description || null, logo || null, website || null, sort] };
}

supApp.get('/', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM supporters ORDER BY kind, sort_order, name COLLATE NOCASE').all();
  return c.json({ supporters: rows.results });
});

supApp.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM supporters WHERE id = ?').bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

supApp.post('/', async (c) => {
  const parsed = readSupporter(await c.req.json().catch(() => ({})));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const result = await c.env.DB
      .prepare('INSERT INTO supporters (kind, name, description, logo_url, website_url, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(...parsed.values)
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM supporters WHERE id = ?').bind(result.meta.last_row_id).first();
    await logAudit(c.env.DB, c.get('admin'), 'supporter.create', 'supporter', result.meta.last_row_id, `${row.kind}: ${row.name}`);
    return c.json(row, 201);
  } catch (err) {
    return fail(c, err);
  }
});

supApp.put('/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = readSupporter(await c.req.json().catch(() => ({})));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    const result = await c.env.DB
      .prepare('UPDATE supporters SET kind = ?, name = ?, description = ?, logo_url = ?, website_url = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(...parsed.values, id)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
    const row = await c.env.DB.prepare('SELECT * FROM supporters WHERE id = ?').bind(id).first();
    await logAudit(c.env.DB, c.get('admin'), 'supporter.edit', 'supporter', Number(id), `${row.kind}: ${row.name}`);
    return c.json(row);
  } catch (err) {
    return fail(c, err);
  }
});

supApp.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const result = await c.env.DB.prepare('DELETE FROM supporters WHERE id = ?').bind(id).run();
  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
  await logAudit(c.env.DB, c.get('admin'), 'supporter.delete', 'supporter', Number(id), null);
  return c.json({ success: true });
});

app.route('/supporters', supApp);

// ── Mara Idol seasons + contestants (see adminIdol.js) ──
app.route('/claims', claimsApp);
app.route('/green', greenApp);
app.route('/idol-seasons', idolSeasonsApp);
app.route('/idol-contestants', idolContestantsApp);

// ── Songs ──
const MAX_CREDITED_PEOPLE = 20;

// Dedupes, coerces to positive integers, and caps at MAX_CREDITED_PEOPLE, preserving order.
function normalizeIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.slice(0, MAX_CREDITED_PEOPLE);
}

// Confirms every id actually exists in `table` — checked before any song write happens, so a
// bad id is rejected with a clear 400 instead of leaving a half-written song behind (the songs
// INSERT/UPDATE and the junction-table writes aren't one atomic transaction).
async function idsExist(db, table, ids) {
  if (!ids.length) return true;
  const placeholders = ids.map(() => '?').join(',');
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE id IN (${placeholders})`).bind(...ids).first();
  return row.count === ids.length;
}

// Builds the DELETE+INSERT statements that replace a song's rows in a junction table
// (song_artists / song_composers) with the given ids, in order. Returned unexecuted so
// callers can batch them together with the artist and composer side (and optionally the
// song row write itself) as a single atomic db.batch() call.
function songPeopleStmts(db, songId, table, fkColumn, ids) {
  const stmts = [db.prepare(`DELETE FROM ${table} WHERE song_id = ?`).bind(songId)];
  ids.forEach((id, i) => {
    stmts.push(db.prepare(`INSERT INTO ${table} (song_id, ${fkColumn}, position) VALUES (?, ?, ?)`).bind(songId, id, i));
  });
  return stmts;
}

// Atomically replaces both junction tables for a song in one batch.
async function writeSongPeople(db, songId, artistIds, composerIds) {
  await db.batch([
    ...songPeopleStmts(db, songId, 'song_artists', 'artist_id', artistIds),
    ...songPeopleStmts(db, songId, 'song_composers', 'composer_id', composerIds),
  ]);
}

async function getSongWithPeople(db, id) {
  const song = await db.prepare('SELECT * FROM songs WHERE id = ?').bind(id).first();
  if (!song) return null;
  const [artists, composers] = await Promise.all([
    db.prepare(
      `SELECT a.id, a.name, a.slug FROM song_artists sa JOIN artists a ON a.id = sa.artist_id
       WHERE sa.song_id = ? ORDER BY sa.position`
    ).bind(id).all(),
    db.prepare(
      `SELECT c.id, c.name, c.slug FROM song_composers sc JOIN composers c ON c.id = sc.composer_id
       WHERE sc.song_id = ? ORDER BY sc.position`
    ).bind(id).all(),
  ]);
  return { ...song, artists: artists.results, composers: composers.results };
}

const songsApp = new Hono();

songsApp.get('/', async (c) => {
  const db = c.env.DB;
  const { page, limit, offset } = parsePagination(c.req.query(), 50);
  const q = (c.req.query('q') || '').trim();

  // Search matches title, category, or any credited artist/composer — across the WHOLE
  // table, not just the current page, since the admin UI paginates in batches of 50.
  const where = q
    ? `WHERE s.title LIKE ? ESCAPE '\\' OR s.category LIKE ? ESCAPE '\\'
       OR s.id IN (SELECT sa.song_id FROM song_artists sa JOIN artists a ON a.id = sa.artist_id WHERE a.name LIKE ? ESCAPE '\\')
       OR s.id IN (SELECT sc.song_id FROM song_composers sc JOIN composers cm ON cm.id = sc.composer_id WHERE cm.name LIKE ? ESCAPE '\\')`
    : '';
  const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
  const bindings = q ? [like, like, like, like] : [];

  const [rows, countRow] = await Promise.all([
    db.prepare(
      `SELECT s.*,
         (SELECT GROUP_CONCAT(name, ', ') FROM (
            SELECT a.name AS name FROM song_artists sa JOIN artists a ON a.id = sa.artist_id
            WHERE sa.song_id = s.id ORDER BY sa.position
          )) AS artist_name,
         (SELECT GROUP_CONCAT(name, ', ') FROM (
            SELECT cm.name AS name FROM song_composers sc JOIN composers cm ON cm.id = sc.composer_id
            WHERE sc.song_id = s.id ORDER BY sc.position
          )) AS composer_name
       FROM songs s
       ${where}
       ORDER BY s.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(...bindings, limit, offset).all(),
    db.prepare(`SELECT COUNT(*) AS total FROM songs s ${where}`).bind(...bindings).first(),
  ]);

  const total = countRow.total;
  return c.json({ songs: rows.results, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

songsApp.get('/:id', async (c) => {
  const row = await getSongWithPeople(c.env.DB, c.req.param('id'));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

songsApp.post('/', requireRole(...CAN_CREATE_SONG), async (c) => {
  const data = await c.req.json().catch(() => ({}));
  const { title, lyrics, copyright_owner_id, category } = data;
  const artist_ids = normalizeIds(data.artist_ids);
  const composer_ids = normalizeIds(data.composer_ids);

  if (!title || !lyrics) return c.json({ error: 'title and lyrics are required' }, 400);
  if (category && !CATEGORIES.includes(category)) {
    return c.json({ error: `category must be one of: ${CATEGORIES.join(', ')}` }, 400);
  }
  const slug = data.slug?.trim() || slugify(title);

  try {
    const db = c.env.DB;
    const [artistsOk, composersOk] = await Promise.all([
      idsExist(db, 'artists', artist_ids),
      idsExist(db, 'composers', composer_ids),
    ]);
    if (!artistsOk) return c.json({ error: 'One or more selected artists do not exist' }, 400);
    if (!composersOk) return c.json({ error: 'One or more selected composers do not exist' }, 400);

    // New songs always start pending, regardless of what (if anything) the client sent —
    // publishing is always a separate, explicit action gated by CAN_PUBLISH_UNPUBLISH.
    const result = await db
      .prepare(
        `INSERT INTO songs (title, slug, artist_id, composer_id, copyright_owner_id, category, lyrics, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .bind(title, slug, artist_ids[0] || null, composer_ids[0] || null, copyright_owner_id || null, category || null, lyrics)
      .run();
    const songId = result.meta.last_row_id;

    await writeSongPeople(db, songId, artist_ids, composer_ids);
    await logAudit(db, c.get('admin'), 'song.create', 'song', songId, title);

    const row = await getSongWithPeople(db, songId);
    return c.json(row, 201);
  } catch (err) {
    return fail(c, err);
  }
});

songsApp.put('/:id', requireRole(...CAN_EDIT_SONG_DIRECT), async (c) => {
  const id = c.req.param('id');
  const data = await c.req.json().catch(() => ({}));
  const { title, lyrics, copyright_owner_id, category } = data;
  const artist_ids = normalizeIds(data.artist_ids);
  const composer_ids = normalizeIds(data.composer_ids);

  if (!title || !lyrics) return c.json({ error: 'title and lyrics are required' }, 400);
  if (category && !CATEGORIES.includes(category)) {
    return c.json({ error: `category must be one of: ${CATEGORIES.join(', ')}` }, 400);
  }
  const slug = data.slug?.trim() || slugify(title);

  try {
    const db = c.env.DB;
    const [artistsOk, composersOk] = await Promise.all([
      idsExist(db, 'artists', artist_ids),
      idsExist(db, 'composers', composer_ids),
    ]);
    if (!artistsOk) return c.json({ error: 'One or more selected artists do not exist' }, 400);
    if (!composersOk) return c.json({ error: 'One or more selected composers do not exist' }, 400);

    const existing = await db.prepare('SELECT id, updated_at FROM songs WHERE id = ?').bind(id).first();
    if (!existing) return c.json({ error: 'Not found' }, 404);

    // Optimistic concurrency check: the client sends back the updated_at it loaded (e.g.
    // from an offline cache). If the row has since changed server-side, refuse the write
    // instead of silently clobbering it — the client shows a conflict screen instead.
    if (data.expected_updated_at && data.expected_updated_at !== existing.updated_at) {
      const current = await getSongWithPeople(db, id);
      return c.json({ error: 'conflict', message: 'This song was changed by someone else since you loaded it.', current }, 409);
    }

    // status is deliberately never touched here — status changes go through PUT /:id/status.
    // The song row write and both junction-table rewrites run as one atomic batch so a
    // failure partway through can't leave the song out of sync with its credited people.
    const updateStmt = db
      .prepare(
        `UPDATE songs SET title = ?, slug = ?, artist_id = ?, composer_id = ?, copyright_owner_id = ?, category = ?, lyrics = ?
         WHERE id = ?`
      )
      .bind(title, slug, artist_ids[0] || null, composer_ids[0] || null, copyright_owner_id || null, category || null, lyrics, id);
    await db.batch([
      updateStmt,
      ...songPeopleStmts(db, id, 'song_artists', 'artist_id', artist_ids),
      ...songPeopleStmts(db, id, 'song_composers', 'composer_id', composer_ids),
    ]);
    await logAudit(db, c.get('admin'), 'song.edit', 'song', Number(id), title);

    const row = await getSongWithPeople(db, id);
    return c.json(row);
  } catch (err) {
    return fail(c, err);
  }
});

songsApp.delete('/:id', requireRole(...CAN_DELETE_SONG), async (c) => {
  const id = c.req.param('id');
  const result = await c.env.DB.prepare('DELETE FROM songs WHERE id = ?').bind(id).run();
  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
  await logAudit(c.env.DB, c.get('admin'), 'song.delete', 'song', Number(id), null);
  return c.json({ success: true });
});

// Publish/Set-Pending/Archive/Restore. Which permission list applies depends on whether
// 'archived' is involved (Archive/Restore) or not (Publish/Unpublish) — Editor has the
// latter but not the former, so this can't be a single static requireRole(...) middleware.
songsApp.put('/:id/status', async (c) => {
  const id = c.req.param('id');
  const { status } = await c.req.json().catch(() => ({}));
  const validStatuses = ['pending', 'published', 'archived'];
  if (!validStatuses.includes(status)) {
    return c.json({ error: `status must be one of: ${validStatuses.join(', ')}` }, 400);
  }

  const db = c.env.DB;
  const song = await db.prepare('SELECT id, status FROM songs WHERE id = ?').bind(id).first();
  if (!song) return c.json({ error: 'Not found' }, 404);
  if (song.status === status) return c.json({ error: `Song is already ${status}` }, 400);

  const admin = c.get('admin');
  const allowed = statusChangePermission(song.status, status);
  if (!allowed.includes(admin.role)) {
    return c.json({ error: 'Forbidden: your role does not have access to this resource' }, 403);
  }

  try {
    await db.prepare('UPDATE songs SET status = ? WHERE id = ?').bind(status, id).run();
    await logAudit(db, admin, statusAction(song.status, status), 'song', Number(id), `${song.status} -> ${status}`);
    const row = await getSongWithPeople(db, id);
    return c.json(row);
  } catch (err) {
    return fail(c, err);
  }
});

// Submits a proposed edit to an EXISTING song for review, instead of applying it directly.
songsApp.post('/:id/revisions', requireRole(...CAN_SUBMIT_REVISION), async (c) => {
  const songId = Number(c.req.param('id'));
  const data = await c.req.json().catch(() => ({}));
  const { title, lyrics, copyright_owner_id, category } = data;
  const artist_ids = normalizeIds(data.artist_ids);
  const composer_ids = normalizeIds(data.composer_ids);

  if (!title || !lyrics) return c.json({ error: 'title and lyrics are required' }, 400);
  if (category && !CATEGORIES.includes(category)) {
    return c.json({ error: `category must be one of: ${CATEGORIES.join(', ')}` }, 400);
  }

  const db = c.env.DB;
  const song = await db.prepare('SELECT id FROM songs WHERE id = ?').bind(songId).first();
  if (!song) return c.json({ error: 'Not found' }, 404);

  const pending = await db
    .prepare("SELECT id FROM song_revisions WHERE song_id = ? AND status = 'pending'")
    .bind(songId)
    .first();
  if (pending) return c.json({ error: 'A revision for this song is already pending review' }, 409);

  const slug = data.slug?.trim() || slugify(title);

  try {
    const [artistsOk, composersOk] = await Promise.all([
      idsExist(db, 'artists', artist_ids),
      idsExist(db, 'composers', composer_ids),
    ]);
    if (!artistsOk) return c.json({ error: 'One or more selected artists do not exist' }, 400);
    if (!composersOk) return c.json({ error: 'One or more selected composers do not exist' }, 400);

    const admin = c.get('admin');
    const result = await db
      .prepare(
        `INSERT INTO song_revisions (song_id, title, slug, lyrics, category, copyright_owner_id, artist_ids, composer_ids, submitted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        songId, title, slug, lyrics, category || null, copyright_owner_id || null,
        JSON.stringify(artist_ids), JSON.stringify(composer_ids), admin.sub
      )
      .run();

    await logAudit(db, admin, 'revision.submit', 'song_revision', result.meta.last_row_id, `song_id=${songId}`);
    const row = await db.prepare('SELECT * FROM song_revisions WHERE id = ?').bind(result.meta.last_row_id).first();
    return c.json(row, 201);
  } catch (err) {
    return fail(c, err);
  }
});

songsApp.get('/:id/revisions', requireRole(...CAN_REVIEW_REVISIONS), async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT sr.*, au.username AS submitted_by_username
       FROM song_revisions sr LEFT JOIN admin_users au ON au.id = sr.submitted_by
       WHERE sr.song_id = ? ORDER BY sr.created_at DESC`
    )
    .bind(c.req.param('id'))
    .all();
  return c.json({ revisions: rows.results, total: rows.results.length });
});

app.route('/songs', songsApp);

// ── Revisions queue: approve/reject proposed song edits ──
const revisionsApp = new Hono();
revisionsApp.use('*', requireRole(...CAN_REVIEW_REVISIONS));

revisionsApp.get('/', async (c) => {
  const status = c.req.query('status');
  const where = status ? 'WHERE sr.status = ?' : '';
  const rows = await c.env.DB
    .prepare(
      `SELECT sr.*, s.title AS song_title, s.slug AS song_slug, s.status AS song_status, au.username AS submitted_by_username
       FROM song_revisions sr
       JOIN songs s ON s.id = sr.song_id
       LEFT JOIN admin_users au ON au.id = sr.submitted_by
       ${where}
       ORDER BY sr.created_at DESC`
    )
    .bind(...(status ? [status] : []))
    .all();
  return c.json({ revisions: rows.results, total: rows.results.length });
});

revisionsApp.get('/:id', async (c) => {
  const revision = await c.env.DB
    .prepare(
      `SELECT sr.*, au.username AS submitted_by_username
       FROM song_revisions sr LEFT JOIN admin_users au ON au.id = sr.submitted_by
       WHERE sr.id = ?`
    )
    .bind(c.req.param('id'))
    .first();
  if (!revision) return c.json({ error: 'Not found' }, 404);
  const current = await getSongWithPeople(c.env.DB, revision.song_id);
  return c.json({ revision, current });
});

revisionsApp.put('/:id/approve', async (c) => {
  const id = c.req.param('id');
  const { reviewer_note } = await c.req.json().catch(() => ({}));
  const db = c.env.DB;

  const revision = await db.prepare('SELECT * FROM song_revisions WHERE id = ?').bind(id).first();
  if (!revision) return c.json({ error: 'Not found' }, 404);
  if (revision.status !== 'pending') return c.json({ error: 'This revision has already been reviewed' }, 400);

  const artist_ids = JSON.parse(revision.artist_ids || '[]');
  const composer_ids = JSON.parse(revision.composer_ids || '[]');

  try {
    // Re-validate — an artist/composer could've been deleted since this revision was submitted.
    const [artistsOk, composersOk] = await Promise.all([
      idsExist(db, 'artists', artist_ids),
      idsExist(db, 'composers', composer_ids),
    ]);
    if (!artistsOk) return c.json({ error: 'One or more selected artists no longer exist' }, 400);
    if (!composersOk) return c.json({ error: 'One or more selected composers no longer exist' }, 400);

    const admin = c.get('admin');
    const songUpdateStmt = db
      .prepare(
        `UPDATE songs SET title = ?, slug = ?, artist_id = ?, composer_id = ?, copyright_owner_id = ?, category = ?, lyrics = ?
         WHERE id = ?`
      )
      .bind(
        revision.title, revision.slug, artist_ids[0] || null, composer_ids[0] || null,
        revision.copyright_owner_id, revision.category, revision.lyrics, revision.song_id
      );
    const revisionUpdateStmt = db
      .prepare(
        `UPDATE song_revisions SET status = 'approved', reviewer_id = ?, reviewer_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`
      )
      .bind(admin.sub, reviewer_note || null, id);

    // Song row, both junction tables, and the revision's own status all commit as one
    // atomic batch — a failure partway through can't leave any of them out of sync.
    await db.batch([
      songUpdateStmt,
      ...songPeopleStmts(db, revision.song_id, 'song_artists', 'artist_id', artist_ids),
      ...songPeopleStmts(db, revision.song_id, 'song_composers', 'composer_id', composer_ids),
      revisionUpdateStmt,
    ]);

    await logAudit(db, admin, 'revision.approve', 'song_revision', Number(id), `song_id=${revision.song_id}`);

    const row = await getSongWithPeople(db, revision.song_id);
    return c.json(row);
  } catch (err) {
    return fail(c, err);
  }
});

revisionsApp.put('/:id/reject', async (c) => {
  const id = c.req.param('id');
  const { reviewer_note } = await c.req.json().catch(() => ({}));
  if (!reviewer_note) return c.json({ error: 'reviewer_note is required when rejecting a revision' }, 400);

  const db = c.env.DB;
  const revision = await db.prepare('SELECT * FROM song_revisions WHERE id = ?').bind(id).first();
  if (!revision) return c.json({ error: 'Not found' }, 404);
  if (revision.status !== 'pending') return c.json({ error: 'This revision has already been reviewed' }, 400);

  const admin = c.get('admin');
  await db
    .prepare(
      `UPDATE song_revisions SET status = 'rejected', reviewer_id = ?, reviewer_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    .bind(admin.sub, reviewer_note, id)
    .run();

  await logAudit(db, admin, 'revision.reject', 'song_revision', Number(id), reviewer_note);
  return c.json({ success: true });
});

app.route('/revisions', revisionsApp);

// ── Reports ("Reports" tab — status: pending | reviewed | resolved | dismissed) ──
// Handling reports is open to everyone but Viewer.
const reportsApp = new Hono();
reportsApp.use('*', requireRole(...CAN_MANAGE_REPORTS));

reportsApp.get('/', async (c) => {
  const status = c.req.query('status');
  const where = status ? 'WHERE status = ?' : '';
  const rows = await c.env.DB
    .prepare(`SELECT * FROM reports ${where} ORDER BY created_at DESC`)
    .bind(...(status ? [status] : []))
    .all();
  return c.json({ reports: rows.results, total: rows.results.length });
});

reportsApp.put('/:id', async (c) => {
  const data = await c.req.json().catch(() => ({}));
  const validStatuses = ['pending', 'reviewed', 'resolved', 'dismissed'];
  if (!validStatuses.includes(data.status)) {
    return c.json({ error: `status must be one of: ${validStatuses.join(', ')}` }, 400);
  }

  try {
    const result = await c.env.DB
      .prepare('UPDATE reports SET status = ? WHERE id = ?')
      .bind(data.status, c.req.param('id'))
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
    return c.json({ success: true });
  } catch (err) {
    return fail(c, err);
  }
});

reportsApp.delete('/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM reports WHERE id = ?').bind(c.req.param('id')).run();
  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

app.route('/reports', reportsApp);

// ── Contacts ("Feedback Inbox" tab — status: unread | read | archived) — Admin only ──
const contactsApp = new Hono();
contactsApp.use('*', requireRole(...CAN_MANAGE_CONTACTS));

contactsApp.get('/', async (c) => {
  const status = c.req.query('status');
  const where = status ? 'WHERE status = ?' : '';
  const rows = await c.env.DB
    .prepare(`SELECT * FROM contacts ${where} ORDER BY created_at DESC`)
    .bind(...(status ? [status] : []))
    .all();
  return c.json({ contacts: rows.results, total: rows.results.length });
});

contactsApp.put('/:id', async (c) => {
  const data = await c.req.json().catch(() => ({}));
  const validStatuses = ['unread', 'read', 'archived'];
  if (!validStatuses.includes(data.status)) {
    return c.json({ error: `status must be one of: ${validStatuses.join(', ')}` }, 400);
  }

  try {
    const result = await c.env.DB
      .prepare('UPDATE contacts SET status = ? WHERE id = ?')
      .bind(data.status, c.req.param('id'))
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
    return c.json({ success: true });
  } catch (err) {
    return fail(c, err);
  }
});

contactsApp.delete('/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM contacts WHERE id = ?').bind(c.req.param('id')).run();
  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ success: true });
});

app.route('/contacts', contactsApp);

// ── Audit log (Reviewer + Manager + Admin) ──
const auditApp = new Hono();
auditApp.use('*', requireRole(...CAN_VIEW_AUDIT_LOG));

auditApp.get('/', async (c) => {
  const { page, limit, offset } = parsePagination(c.req.query(), 50);
  const targetType = c.req.query('target_type');
  const adminId = c.req.query('admin_id');

  const conditions = [];
  const bindings = [];
  if (targetType) { conditions.push('target_type = ?'); bindings.push(targetType); }
  if (adminId) {
    const parsedAdminId = Number(adminId);
    if (!Number.isInteger(parsedAdminId)) return c.json({ error: 'admin_id must be an integer' }, 400);
    conditions.push('admin_id = ?');
    bindings.push(parsedAdminId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const [rows, countRow] = await Promise.all([
      c.env.DB.prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...bindings, limit, offset).all(),
      c.env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_log ${where}`).bind(...bindings).first(),
    ]);

    const total = countRow.total;
    return c.json({ audit_log: rows.results, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    return fail(c, err);
  }
});

app.route('/audit-log', auditApp);

// ── Articles: no revision workflow (unlike songs) — direct create/edit, gated by
// role. Publishing (draft -> published) is the "send notification" action: it's what
// makes an article show up on the public site and in the client-side notification
// poller (title + author), so there's no separate send step to build. ──
const articlesApp = new Hono();

function articleStatusAction(from, to) {
  return to === 'published' ? 'publish' : 'unpublish';
}

articlesApp.get('/', async (c) => {
  const db = c.env.DB;
  const { page, limit, offset } = parsePagination(c.req.query());
  const status = c.req.query('status');
  const q = (c.req.query('q') || '').trim();

  const conditions = [];
  const bindings = [];
  if (status && ['draft', 'published'].includes(status)) {
    conditions.push('status = ?');
    bindings.push(status);
  }
  if (q) {
    conditions.push('(title LIKE ? OR author_name LIKE ?)');
    bindings.push(`%${q}%`, `%${q}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countRow] = await Promise.all([
    db.prepare(`SELECT * FROM articles ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, limit, offset).all(),
    db.prepare(`SELECT COUNT(*) AS total FROM articles ${where}`).bind(...bindings).first(),
  ]);

  const total = countRow.total;
  return c.json({ articles: rows.results, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

articlesApp.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(c.req.param('id')).first();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

articlesApp.post('/', requireRole(...CAN_CREATE_ARTICLE), async (c) => {
  const data = await c.req.json().catch(() => ({}));
  const { title, author_name, summary } = data;
  const content = await sanitizeArticleHtml(data.content);

  if (!title || !author_name || isHtmlEmpty(content)) {
    return c.json({ error: 'title, author_name, and content are required' }, 400);
  }
  const slug = data.slug?.trim() || slugify(title);

  try {
    const db = c.env.DB;
    const result = await db
      .prepare(`INSERT INTO articles (title, slug, author_name, summary, content, status) VALUES (?, ?, ?, ?, ?, 'draft')`)
      .bind(title, slug, author_name, summary || '', content)
      .run();
    const articleId = result.meta.last_row_id;

    await logAudit(db, c.get('admin'), 'article.create', 'article', articleId, title);

    const row = await db.prepare('SELECT * FROM articles WHERE id = ?').bind(articleId).first();
    return c.json(row, 201);
  } catch (err) {
    return fail(c, err);
  }
});

articlesApp.put('/:id', requireRole(...CAN_EDIT_ARTICLE), async (c) => {
  const id = c.req.param('id');
  const data = await c.req.json().catch(() => ({}));
  const { title, author_name, summary } = data;
  const content = await sanitizeArticleHtml(data.content);

  if (!title || !author_name || isHtmlEmpty(content)) {
    return c.json({ error: 'title, author_name, and content are required' }, 400);
  }
  const slug = data.slug?.trim() || slugify(title);

  try {
    const db = c.env.DB;
    const existing = await db.prepare('SELECT id, updated_at FROM articles WHERE id = ?').bind(id).first();
    if (!existing) return c.json({ error: 'Not found' }, 404);

    // Same optimistic concurrency check as songs — see comment there.
    if (data.expected_updated_at && data.expected_updated_at !== existing.updated_at) {
      const current = await db.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();
      return c.json({ error: 'conflict', message: 'This article was changed by someone else since you loaded it.', current }, 409);
    }

    // status/published_at are deliberately never touched here — status changes go
    // through PUT /:id/status, same split as songs.
    await db
      .prepare('UPDATE articles SET title = ?, slug = ?, author_name = ?, summary = ?, content = ? WHERE id = ?')
      .bind(title, slug, author_name, summary || '', content, id)
      .run();
    await logAudit(db, c.get('admin'), 'article.edit', 'article', Number(id), title);

    const row = await db.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();
    return c.json(row);
  } catch (err) {
    return fail(c, err);
  }
});

articlesApp.delete('/:id', requireRole(...CAN_DELETE_ARTICLE), async (c) => {
  const id = c.req.param('id');
  const result = await c.env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(id).run();
  if (result.meta.changes === 0) return c.json({ error: 'Not found' }, 404);
  await logAudit(c.env.DB, c.get('admin'), 'article.delete', 'article', Number(id), null);
  return c.json({ success: true });
});

// Publish / unpublish. Publishing for the first time stamps published_at (kept stable
// across later unpublish/republish cycles, like a "first went live" date).
articlesApp.put('/:id/status', requireRole(...CAN_PUBLISH_ARTICLE), async (c) => {
  const id = c.req.param('id');
  const { status } = await c.req.json().catch(() => ({}));
  const validStatuses = ['draft', 'published'];
  if (!validStatuses.includes(status)) {
    return c.json({ error: `status must be one of: ${validStatuses.join(', ')}` }, 400);
  }

  const db = c.env.DB;
  const article = await db.prepare('SELECT id, status FROM articles WHERE id = ?').bind(id).first();
  if (!article) return c.json({ error: 'Not found' }, 404);
  if (article.status === status) return c.json({ error: `Article is already ${status}` }, 400);

  try {
    await db
      .prepare(
        `UPDATE articles SET status = ?, published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN datetime('now') ELSE published_at END WHERE id = ?`
      )
      .bind(status, status, id)
      .run();
    await logAudit(db, c.get('admin'), articleStatusAction(article.status, status), 'article', Number(id), `${article.status} -> ${status}`);

    const row = await db.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();
    return c.json(row);
  } catch (err) {
    return fail(c, err);
  }
});

app.route('/articles', articlesApp);

export default app;
