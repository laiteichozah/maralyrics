/**
 * Account sync: the favourites, pinned songs, downloaded songs and a few preferences of a signed-in reader, kept per
 * account so every device they sign in on shows the same thing.
 *
 * Model: one row per (kind, key) in person_sync_items. A device sends the changes it made since it last synced (ops) and
 * the account's revision it last saw (`since`); the newest change per item wins (`at` is the device's clock, clamped so a
 * wrong clock can't win forever), and the reply holds everything that changed after `since`, plus the current row of any
 * item whose change lost. Removals are kept as `deleted` rows so they reach the other devices too.
 */

export const KINDS = ['favorite', 'pin', 'download', 'pref'];
export const MAX_OPS = 200;          // per request (keeps one request well inside the database's per-request limits)
export const MAX_ITEMS = 6000;       // rows per account, tombstones included
const PAGE = 1000;                   // rows returned per request; the device asks again while `more` is true
const KEY_MAX = 200;
const CLOCK_SLACK_MS = 60 * 1000;    // a change dated further ahead than this is treated as "now"
const PREFS = { theme: ['dark', 'light', 'system', 'time'], lang: ['en', 'mrh', 'my'] };
const CONTROL = /[\u0000-\u001f\u007f]/;

/** → { ops, error } — normalised, de-duplicated changes (the newest per item), or an error message. */
export function normalizeOps(input, now = Date.now()) {
  if (input === undefined || input === null) return { ops: [] };
  if (!Array.isArray(input)) return { error: 'ops must be a list' };
  if (input.length > MAX_OPS) return { error: `Send at most ${MAX_OPS} changes at a time` };
  const latest = new Map();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { error: 'Each change must be an object' };
    const kind = raw.kind;
    const key = raw.key;
    if (!KINDS.includes(kind)) return { error: 'Unknown kind of change' };
    if (typeof key !== 'string' || !key || key.length > KEY_MAX || CONTROL.test(key)) return { error: 'Invalid key' };
    const deleted = raw.deleted === true || raw.deleted === 1;
    let value = null;
    if (kind === 'pref') {
      if (!Object.prototype.hasOwnProperty.call(PREFS, key)) return { error: 'Unknown preference' };
      if (!deleted) {
        if (!PREFS[key].includes(raw.value)) return { error: 'Invalid preference value' };
        value = raw.value;
      }
    } else if (kind === 'pin' && !deleted) {
      const n = Number(raw.value ?? 0);
      if (!Number.isInteger(n) || n < 0 || n > 99999) return { error: 'Invalid pin position' };
      value = String(n);
    }
    const at = Number(raw.at);
    if (!Number.isFinite(at) || at < 0) return { error: 'Invalid time' };
    const op = { kind, key, value, deleted: deleted ? 1 : 0, at: Math.min(Math.floor(at), now + CLOCK_SLACK_MS) };
    const id = `${kind}\u0000${key}`;
    const prev = latest.get(id);
    if (!prev || op.at >= prev.at) latest.set(id, op);
  }
  return { ops: [...latest.values()] };
}

const shape = (r) => ({ kind: r.kind, key: r.key, value: r.value ?? null, deleted: !!r.deleted, at: r.updated_at });

async function existingRows(db, accountId, ops) {
  const byKind = new Map();
  for (const op of ops) byKind.set(op.kind, [...(byKind.get(op.kind) || []), op.key]);
  const found = new Map();
  for (const [kind, keys] of byKind) {
    for (let i = 0; i < keys.length; i += 80) {
      const chunk = keys.slice(i, i + 80);
      const rows = await db
        .prepare(`SELECT kind, key, value, deleted, updated_at FROM person_sync_items WHERE account_id = ? AND kind = ? AND key IN (${chunk.map(() => '?').join(',')})`)
        .bind(accountId, kind, ...chunk)
        .all();
      for (const r of rows.results) found.set(`${r.kind}\u0000${r.key}`, r);
    }
  }
  return found;
}

/**
 * Applies a device's changes and returns what it needs to catch up.
 * → { rev, more, items: [{ kind, key, value, deleted, at }], truncated }
 */
export async function syncAccount(db, accountId, { since = 0, ops = [] } = {}) {
  const id = Number(accountId);
  const cursor = Number.isInteger(Number(since)) && Number(since) > 0 ? Number(since) : 0;
  const lost = [];
  let truncated = false;

  if (ops.length) {
    const existing = await existingRows(db, id, ops);
    const winners = [];
    let room = MAX_ITEMS - (await db.prepare('SELECT COUNT(*) AS n FROM person_sync_items WHERE account_id = ?').bind(id).first()).n;
    for (const op of ops) {
      const ex = existing.get(`${op.kind}\u0000${op.key}`);
      if (ex) {
        if (ex.updated_at > op.at) { lost.push(shape(ex)); continue; }       // someone changed it more recently
        if (!!ex.deleted === !!op.deleted && (ex.value ?? null) === op.value) continue; // nothing new
      } else {
        if (op.deleted) continue;                                              // removing what was never there
        if (room <= 0) { truncated = true; continue; }
        room--;
      }
      winners.push(op);
    }
    if (winners.length) {
      const statements = [db.prepare('INSERT INTO person_sync_state (account_id, rev) VALUES (?, 1) ON CONFLICT(account_id) DO UPDATE SET rev = rev + 1').bind(id)];
      const rev = `(SELECT rev FROM person_sync_state WHERE account_id = ${id})`; // the id is a number from our own table
      for (let i = 0; i < winners.length; i += 16) {
        const chunk = winners.slice(i, i + 16);
        statements.push(
          db
            .prepare(
              `INSERT INTO person_sync_items (account_id, kind, key, value, deleted, updated_at, rev) VALUES ${chunk.map(() => `(?, ?, ?, ?, ?, ?, ${rev})`).join(', ')}
               ON CONFLICT(account_id, kind, key) DO UPDATE SET value = excluded.value, deleted = excluded.deleted, updated_at = excluded.updated_at, rev = excluded.rev
               WHERE excluded.updated_at >= person_sync_items.updated_at`
            )
            .bind(...chunk.flatMap((o) => [id, o.kind, o.key, o.value, o.deleted, o.at]))
        );
      }
      await db.batch(statements);
    }
  }

  const state = await db.prepare('SELECT rev FROM person_sync_state WHERE account_id = ?').bind(id).first();
  const rows = (await db
    .prepare('SELECT kind, key, value, deleted, updated_at, rev FROM person_sync_items WHERE account_id = ? AND rev > ? ORDER BY rev, kind, key LIMIT ?')
    .bind(id, cursor, PAGE)
    .all()).results;
  const more = rows.length === PAGE;
  const items = new Map(rows.map((r) => [`${r.kind}\u0000${r.key}`, shape(r)]));
  for (const r of lost) items.set(`${r.kind}\u0000${r.key}`, r);
  return {
    rev: more ? Math.max(cursor, rows[rows.length - 1].rev - 1) : (state?.rev || 0),
    more,
    items: [...items.values()],
    truncated,
  };
}
