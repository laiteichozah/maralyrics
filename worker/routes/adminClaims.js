import { Hono } from 'hono';
import { requireRole } from '../lib/auth.js';
import { CAN_REVIEW_CLAIMS } from '../lib/permissions.js';
import { logAudit } from '../lib/audit.js';

// Admin review of profile claims, mounted at /api/v1/admin/claims (Manager + Super Admin).
//   GET  /               ?status=pending|approved|rejected|revoked  (default: all, pending first)
//   PUT  /:id/approve    makes the claimant the profile's owner (any other pending claims on it are closed)
//   PUT  /:id/reject     needs a note (shown to the claimant)
//   PUT  /:id/revoke     takes ownership away again (needs a note)
const app = new Hono();
app.use('*', requireRole(...CAN_REVIEW_CLAIMS));

const STATUSES = ['pending', 'approved', 'rejected', 'revoked'];
const NOTE_MAX = 500;

app.get('/', async (c) => {
  const status = c.req.query('status');
  const where = STATUSES.includes(status) ? 'WHERE c.status = ?' : '';
  const stmt = c.env.DB.prepare(
    `SELECT c.id, c.status, c.evidence, c.review_note, c.created_at, c.reviewed_at,
            CASE WHEN c.artist_id IS NOT NULL THEN 'artist' ELSE 'composer' END AS type,
            COALESCE(a.name, p.name) AS name, COALESCE(a.slug, p.slug) AS slug,
            acc.username AS claimant, acc.contact_email AS claimant_email, acc.contact_phone AS claimant_phone, (acc.email_verified_at IS NOT NULL) AS claimant_email_verified, r.username AS reviewed_by_username,
            (SELECT COUNT(*) FROM person_claims o WHERE o.status = 'approved'
               AND ((c.artist_id IS NOT NULL AND o.artist_id = c.artist_id) OR (c.composer_id IS NOT NULL AND o.composer_id = c.composer_id))) AS has_owner
     FROM person_claims c
     JOIN person_accounts acc ON acc.id = c.account_id
     LEFT JOIN artists a ON a.id = c.artist_id
     LEFT JOIN composers p ON p.id = c.composer_id
     LEFT JOIN admin_users r ON r.id = c.reviewed_by
     ${where}
     ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.created_at DESC, c.id DESC`
  );
  const rows = await (where ? stmt.bind(status) : stmt).all();
  return c.json({ claims: rows.results, total: rows.results.length });
});

const loadClaim = (db, id) => db
  .prepare(
    `SELECT c.*, acc.username AS claimant, COALESCE(a.name, p.name) AS name,
            CASE WHEN c.artist_id IS NOT NULL THEN 'artist' ELSE 'composer' END AS type
     FROM person_claims c JOIN person_accounts acc ON acc.id = c.account_id
     LEFT JOIN artists a ON a.id = c.artist_id LEFT JOIN composers p ON p.id = c.composer_id WHERE c.id = ?`
  )
  .bind(id)
  .first();

function note(data, required) {
  const text = typeof data.note === 'string' ? data.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  if (required && !text) return { error: 'A note is required — it is shown to the claimant' };
  if (text.length > NOTE_MAX) return { error: `Keep the note under ${NOTE_MAX} characters` };
  return { text: text || null };
}

async function review(c, { from, to, action, noteRequired }) {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: 'Not found' }, 404);
  const claim = await loadClaim(c.env.DB, id);
  if (!claim) return c.json({ error: 'Not found' }, 404);
  if (claim.status !== from) return c.json({ error: `Only a ${from} claim can be ${to === 'revoked' ? 'revoked' : to}` }, 409);
  const n = note(await c.req.json().catch(() => ({})), noteRequired);
  if (n.error) return c.json({ error: n.error }, 400);

  const admin = c.get('admin');
  const db = c.env.DB;
  try {
    // The status guard in the WHERE makes this safe against two admins reviewing at once.
    const result = await db
      .prepare(`UPDATE person_claims SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`)
      .bind(to, n.text, admin.sub, id, from)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'This claim was just reviewed by someone else' }, 409);
  } catch (err) {
    // The unique "one owner per profile" index: someone else already owns it.
    if (/UNIQUE/i.test(String(err.message))) return c.json({ error: 'This profile already has an owner — revoke that claim first' }, 409);
    throw err;
  }
  if (to === 'approved') {
    const fk = claim.artist_id ? 'artist_id' : 'composer_id';
    await db
      .prepare(`UPDATE person_claims SET status = 'rejected', review_note = 'Another claim on this profile was approved.', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE ${fk} = ? AND status = 'pending' AND id != ?`)
      .bind(admin.sub, claim.artist_id ?? claim.composer_id, id)
      .run();
  }
  await logAudit(db, admin, action, claim.type, claim.artist_id ?? claim.composer_id, `${claim.name} — ${claim.claimant}${n.text ? ` — “${n.text}”` : ''}`);
  return c.json(await loadClaim(db, id).then(({ id: cid, status, review_note }) => ({ id: cid, status, review_note })));
}

app.put('/:id/approve', (c) => review(c, { from: 'pending', to: 'approved', action: 'claim.approve', noteRequired: false }));
app.put('/:id/reject', (c) => review(c, { from: 'pending', to: 'rejected', action: 'claim.reject', noteRequired: true }));
app.put('/:id/revoke', (c) => review(c, { from: 'approved', to: 'revoked', action: 'claim.revoke', noteRequired: true }));

export default app;
