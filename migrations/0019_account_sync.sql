-- Sync for reader accounts: favourites, pinned songs, downloaded songs and a few preferences follow the account to every device.
-- Run BEFORE deploying the matching Worker:  npm run db:migrate

-- One row per (account, kind, key). `deleted` rows are kept (a tombstone) so a removal on one device reaches the others;
-- the newest `updated_at` (the device's clock, clamped by the server) wins. `rev` is the account's change counter at the
-- time of the write: devices ask for "everything after the rev I last saw".
CREATE TABLE IF NOT EXISTS person_sync_items (
    account_id INTEGER NOT NULL REFERENCES person_accounts(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('favorite', 'pin', 'download', 'pref')),
    key        TEXT NOT NULL,          -- a song slug, or the preference name
    value      TEXT,                   -- pin position / preference value; NULL for favourites and downloads
    deleted    INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,       -- milliseconds since 1970
    rev        INTEGER NOT NULL,
    PRIMARY KEY (account_id, kind, key)
);
CREATE INDEX IF NOT EXISTS idx_person_sync_items_rev ON person_sync_items(account_id, rev);

CREATE TABLE IF NOT EXISTS person_sync_state (
    account_id INTEGER PRIMARY KEY REFERENCES person_accounts(id) ON DELETE CASCADE,
    rev        INTEGER NOT NULL DEFAULT 0
);
