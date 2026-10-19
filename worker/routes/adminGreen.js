import { Hono } from 'hono';
import { requireRole } from '../lib/auth.js';
import { CAN_MANAGE_GREEN } from '../lib/permissions.js';
import { logAudit } from '../lib/audit.js';
import { PLAN_MONTHS, ORDER_STATUSES, NOTE_MAX, centsToPrice, validateSettings, activateMark } from '../lib/green.js';

// Super Admin only — this is where money is checked and the Green mark is switched on.
//   GET/PUT  /settings          currency, how-to-pay text, plan prices + on/off
//   GET      /orders            ?status=pending|approved|rejected|cancelled
//   GET      /orders/:id        one order with its receipt image
//   PUT      /orders/:id/approve | /reject   (reject needs a note)
//   GET      /marks             every mark with its expiry
//   POST     /marks             grant / extend by hand { type, id, months }  (free, comp'd, or correcting a mistake)
//   DELETE   /marks/:id         switch a mark off
const app = new Hono();
app.use('*', requireRole(...CAN_MANAGE_GREEN));

const TYPES = { artist: { table: 'artists', fk: 'artist_id' }, composer: { table: 'composers', fk: 'composer_id' } };
const idParam = (c) => {
  const n = Number(c.req.param('id'));
  return Number.isInteger(n) && n > 0 ? n : null;
};

// ── Settings ──
async function readSettings(db) {
  const s = (await db.prepare('SELECT currency, payment_instructions FROM green_settings WHERE id = 1').first()) || { currency: 'USD', payment_instructions: null };
  const plans = (await db.prepare('SELECT months, price_cents, enabled FROM green_plans ORDER BY months').all()).results;
  return {
    currency: s.currency,
    payment_instructions: s.payment_instructions || '',
    plans: plans.map((p) => ({ months: p.months, price: centsToPrice(p.price_cents), price_cents: p.price_cents, enabled: !!p.enabled })),
  };
}

app.get('/settings', async (c) => c.json(await readSettings(c.env.DB)));

app.put('/settings', async (c) => {
  const parsed = validateSettings(await c.req.json().catch(() => ({})));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const db = c.env.DB;
  await db.prepare('UPDATE green_settings SET currency = ?, payment_instructions = ? WHERE id = 1').bind(parsed.currency, parsed.instructions).run();
  for (const p of parsed.plans) {
    await db.prepare('UPDATE green_plans SET price_cents = ?, enabled = ? WHERE months = ?').bind(p.price_cents, p.enabled, p.months).run();
  }
  await logAudit(db, c.get('admin'), 'green.settings_edit', 'green', null,
    parsed.plans.map((p) => `${p.months}m: ${p.enabled ? centsToPrice(p.price_cents) : 'off'}`).join(', ') + ` ${parsed.currency}`);
  return c.json(await readSettings(db));
});

// ── Orders ──
const ORDER_SELECT = `
  SELECT o.id, o.months, o.amount_cents, o.currency, o.method, o.reference, o.note, o.status, o.review_note,
         o.created_at, o.reviewed_at, (o.receipt IS NOT NULL) AS has_receipt,
         CASE WHEN o.artist_id IS NOT NULL THEN 'artist' ELSE 'composer' END AS type,
         COALESCE(a.name, p.name) AS name, COALESCE(a.slug, p.slug) AS slug,
         acc.username AS buyer, acc.contact_email AS buyer_email, acc.contact_phone AS buyer_phone, (acc.email_verified_at IS NOT NULL) AS buyer_email_verified, r.username AS reviewed_by_username,
         COALESCE(ma.expires_at, mp.expires_at) AS mark_expires_at
  FROM green_orders o
  JOIN person_accounts acc ON acc.id = o.account_id
  LEFT JOIN artists a ON a.id = o.artist_id
  LEFT JOIN composers p ON p.id = o.composer_id
  LEFT JOIN green_marks ma ON ma.artist_id = o.artist_id
  LEFT JOIN green_marks mp ON mp.composer_id = o.composer_id
  LEFT JOIN admin_users r ON r.id = o.reviewed_by`;

app.get('/orders', async (c) => {
  const status = c.req.query('status');
  const where = ORDER_STATUSES.includes(status) ? 'WHERE o.status = ?' : '';
  const stmt = c.env.DB.prepare(`${ORDER_SELECT} ${where} ORDER BY CASE o.status WHEN 'pending' THEN 0 ELSE 1 END, o.created_at DESC, o.id DESC`);
  const rows = await (where ? stmt.bind(status) : stmt).all();
  return c.json({ orders: rows.results.map((o) => ({ ...o, has_receipt: !!o.has_receipt, buyer_email_verified: !!o.buyer_email_verified })), total: rows.results.length });
});

app.get('/orders/:id', async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: 'Not found' }, 404);
  const order = await c.env.DB.prepare(`${ORDER_SELECT} WHERE o.id = ?`).bind(id).first();
  if (!order) return c.json({ error: 'Not found' }, 404);
  const receipt = await c.env.DB.prepare('SELECT receipt FROM green_orders WHERE id = ?').bind(id).first();
  return c.json({ ...order, has_receipt: !!order.has_receipt, receipt: receipt?.receipt ?? null });
});

function note(data, required) {
  const text = typeof data.note === 'string' ? data.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  if (required && !text) return { error: 'A note is required — the buyer will see it' };
  if (text.length > NOTE_MAX) return { error: `Keep the note under ${NOTE_MAX} characters` };
  return { text: text || null };
}

async function loadOrder(db, id) {
  return db.prepare(`SELECT o.*, acc.username AS buyer, COALESCE(a.name, p.name) AS name
                     FROM green_orders o JOIN person_accounts acc ON acc.id = o.account_id
                     LEFT JOIN artists a ON a.id = o.artist_id LEFT JOIN composers p ON p.id = o.composer_id WHERE o.id = ?`).bind(id).first();
}

app.put('/orders/:id/approve', async (c) => {
  const id = idParam(c);
  const db = c.env.DB;
  const order = id ? await loadOrder(db, id) : null;
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (order.status !== 'pending') return c.json({ error: `Only a pending order can be approved (this one is ${order.status})` }, 409);
  const n = note(await c.req.json().catch(() => ({})), false);
  if (n.error) return c.json({ error: n.error }, 400);

  const type = order.artist_id ? 'artist' : 'composer';
  const profileId = order.artist_id ?? order.composer_id;
  const t = TYPES[type];
  // The buyer must still own the profile — if their claim was revoked meanwhile, don't hand the mark to a stranger.
  const owner = await db.prepare(`SELECT 1 FROM person_claims WHERE account_id = ? AND ${t.fk} = ? AND status = 'approved'`).bind(order.account_id, profileId).first();
  if (!owner) return c.json({ error: 'The buyer no longer owns this profile (their claim was revoked). Reject this order and refund them.' }, 409);

  const admin = c.get('admin');
  // The status guard makes this safe against two Super Admins approving at once.
  const claimed = await db
    .prepare(`UPDATE green_orders SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`)
    .bind(n.text, admin.sub, id)
    .run();
  if (claimed.meta.changes === 0) return c.json({ error: 'This order was just reviewed by someone else' }, 409);
  try {
    await activateMark(db, type, profileId, order.months);
  } catch (err) {
    // Never leave an approved order without its mark: put it back to pending so it can be retried.
    await db.prepare(`UPDATE green_orders SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL WHERE id = ?`).bind(id).run();
    throw err;
  }
  await logAudit(db, admin, 'green.order_approve', type, profileId, `${order.name} — ${order.months} months — ${centsToPrice(order.amount_cents)} ${order.currency} — ref ${order.reference} — ${order.buyer}`);
  const mark = await db.prepare(`SELECT expires_at FROM green_marks WHERE ${t.fk} = ?`).bind(profileId).first();
  return c.json({ id, status: 'approved', mark_expires_at: mark?.expires_at ?? null });
});

app.put('/orders/:id/reject', async (c) => {
  const id = idParam(c);
  const db = c.env.DB;
  const order = id ? await loadOrder(db, id) : null;
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (order.status !== 'pending') return c.json({ error: `Only a pending order can be rejected (this one is ${order.status})` }, 409);
  const n = note(await c.req.json().catch(() => ({})), true);
  if (n.error) return c.json({ error: n.error }, 400);
  const admin = c.get('admin');
  const result = await db
    .prepare(`UPDATE green_orders SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`)
    .bind(n.text, admin.sub, id)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'This order was just reviewed by someone else' }, 409);
  await logAudit(db, admin, 'green.order_reject', order.artist_id ? 'artist' : 'composer', order.artist_id ?? order.composer_id, `${order.name} — ${order.months} months — ref ${order.reference} — “${n.text}”`);
  return c.json({ id, status: 'rejected' });
});

// ── Marks ──
app.get('/marks', async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT m.id, m.expires_at, (m.expires_at > datetime('now')) AS active,
              CASE WHEN m.artist_id IS NOT NULL THEN 'artist' ELSE 'composer' END AS type,
              COALESCE(a.name, p.name) AS name, COALESCE(a.slug, p.slug) AS slug
       FROM green_marks m LEFT JOIN artists a ON a.id = m.artist_id LEFT JOIN composers p ON p.id = m.composer_id
       ORDER BY m.expires_at DESC`
    )
    .all();
  return c.json({ marks: rows.results.map((m) => ({ ...m, active: !!m.active })), total: rows.results.length });
});

app.post('/marks', async (c) => {
  const data = await c.req.json().catch(() => ({}));
  const t = TYPES[data.type];
  const months = Number(data.months);
  const profileId = Number(data.id);
  if (!t) return c.json({ error: 'type must be artist or composer' }, 400);
  if (!PLAN_MONTHS.includes(months)) return c.json({ error: `months must be one of ${PLAN_MONTHS.join(', ')}` }, 400);
  if (!Number.isInteger(profileId) || profileId < 1) return c.json({ error: 'choose a profile' }, 400);
  const profile = await c.env.DB.prepare(`SELECT id, name FROM ${t.table} WHERE id = ?`).bind(profileId).first();
  if (!profile) return c.json({ error: 'That profile does not exist' }, 404);
  await activateMark(c.env.DB, data.type, profileId, months);
  await logAudit(c.env.DB, c.get('admin'), 'green.mark_grant', data.type, profileId, `${profile.name} — +${months} months (by hand)`);
  const mark = await c.env.DB.prepare(`SELECT id, expires_at FROM green_marks WHERE ${t.fk} = ?`).bind(profileId).first();
  return c.json(mark, 201);
});

app.delete('/marks/:id', async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: 'Not found' }, 404);
  const mark = await c.env.DB
    .prepare(`SELECT m.id, m.artist_id, m.composer_id, COALESCE(a.name, p.name) AS name FROM green_marks m LEFT JOIN artists a ON a.id = m.artist_id LEFT JOIN composers p ON p.id = m.composer_id WHERE m.id = ?`)
    .bind(id)
    .first();
  if (!mark) return c.json({ error: 'Not found' }, 404);
  await c.env.DB.prepare('DELETE FROM green_marks WHERE id = ?').bind(id).run();
  await logAudit(c.env.DB, c.get('admin'), 'green.mark_remove', mark.artist_id ? 'artist' : 'composer', mark.artist_id ?? mark.composer_id, mark.name);
  return c.json({ success: true });
});

export default app;
