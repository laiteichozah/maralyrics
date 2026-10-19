-- ╔══════════════════════════════════════════════════════════════╗
-- ║           MaraLyrics — Cloudflare D1 Schema                 ║
-- ╚══════════════════════════════════════════════════════════════╝
--
-- This file defines the CURRENT desired schema and is safe to run
-- against any database, new or existing — every statement is
-- idempotent (IF NOT EXISTS) and nothing is ever dropped.
--
-- • Bootstrapping a brand new database? Just run this file.
-- • Upgrading an existing database created before a given schema
--   change? Run the matching file in ./migrations first — this file
--   alone will NOT retroactively alter tables that already exist
--   under an older definition.
-- • Want sample data for local development? See ./seed.sql.

-- Artists table
CREATE TABLE IF NOT EXISTS artists (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    slug         TEXT UNIQUE NOT NULL,
    bio          TEXT,
    image_url    TEXT,
    social_links TEXT CHECK (social_links IS NULL OR json_valid(social_links)),
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Composers table
CREATE TABLE IF NOT EXISTS composers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    slug         TEXT UNIQUE NOT NULL,
    bio          TEXT,
    image_url    TEXT,
    social_links TEXT CHECK (social_links IS NULL OR json_valid(social_links)),
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Copyright Owners table (international standard fields)
CREATE TABLE IF NOT EXISTS copyright_owners (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    slug            TEXT UNIQUE NOT NULL,
    full_legal_name TEXT,
    organization    TEXT,
    territory       TEXT,
    email           TEXT,
    website         TEXT,
    address         TEXT,
    ipi_number      TEXT,
    isrc_prefix     TEXT,
    pro_affiliation TEXT,
    notes           TEXT,
    image_url       TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sponsors & partners shown on the public Project page (a section appears only once it has an entry)
CREATE TABLE IF NOT EXISTS supporters (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL CHECK (kind IN ('sponsor', 'partner')),
    name        TEXT NOT NULL,
    description TEXT,
    logo_url    TEXT,
    website_url TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_supporters_kind ON supporters(kind, sort_order);

-- Songs table
CREATE TABLE IF NOT EXISTS songs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    title               TEXT NOT NULL,
    slug                TEXT UNIQUE NOT NULL,
    artist_id           INTEGER,
    composer_id         INTEGER,
    copyright_owner_id  INTEGER,
    category            TEXT CHECK (category IS NULL OR category IN ('Gospel', 'Love', 'Traditional', 'Patriotic')),
    lyrics              TEXT NOT NULL,
    views               INTEGER DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'archived')),
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE SET NULL,
    FOREIGN KEY (composer_id) REFERENCES composers(id) ON DELETE SET NULL,
    FOREIGN KEY (copyright_owner_id) REFERENCES copyright_owners(id) ON DELETE SET NULL
);

-- Reports table (copyright / content reports filed against a song)
CREATE TABLE IF NOT EXISTS reports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id         INTEGER,
    song_slug       TEXT,
    song_title      TEXT,
    song_artist     TEXT,
    reporter_name   TEXT NOT NULL,
    reporter_email  TEXT NOT NULL,
    body            TEXT NOT NULL,
    status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved', 'dismissed')),
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE SET NULL
);

-- Contact form submissions
CREATE TABLE IF NOT EXISTS contacts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    subject    TEXT DEFAULT 'General',
    message    TEXT NOT NULL,
    status     TEXT DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'archived')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Admin accounts (role-based, 6 roles from least to most privileged:
-- viewer — read-only; translator — creates songs directly, edits existing
-- songs only via a revision for review; reviewer — approves/rejects
-- revisions, publishes/archives songs, views the audit log; editor —
-- creates/edits/publishes songs directly, no archive/restore; manager —
-- reviewer + editor combined, plus manages reference data (artists/
-- composers/copyright owners) and admin accounts (except granting
-- super_admin); super_admin — everything, plus the Feedback Inbox and
-- granting the super_admin role itself. Replaces the single shared
-- ADMIN_TOKEN bearer secret with per-user login + JWT sessions.
CREATE TABLE IF NOT EXISTS admin_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('viewer', 'translator', 'reviewer', 'editor', 'manager', 'super_admin')),
    avatar        TEXT, -- a built-in emoji identifier from worker/lib/avatars.js, or NULL (falls back to initial)
    photo         TEXT, -- uploaded, cropped profile photo as a data:image URL, or NULL (falls back to avatar)
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Failed admin login attempts, keyed by the submitted username — checked before the
-- password hash comparison in POST /auth/login to lock an account out after too many
-- attempts in a short window (brute-force protection). Rows are pruned opportunistically
-- by the same query that checks them, so this never needs its own cleanup job.
CREATE TABLE IF NOT EXISTS login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_username_created ON login_attempts(username, created_at);

-- Any admin can follow/unfollow any other admin's profile.
CREATE TABLE IF NOT EXISTS admin_follows (
    follower_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    followed_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follower_id, followed_id),
    CHECK (follower_id != followed_id)
);

-- Multi-artist / multi-composer credits (a song can have more than one of
-- each, capped at 20 in the API). songs.artist_id / composer_id remain as
-- the primary (first) credited person for backward compatibility.
CREATE TABLE IF NOT EXISTS song_artists (
    song_id   INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (song_id, artist_id)
);

CREATE TABLE IF NOT EXISTS song_composers (
    song_id     INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    composer_id INTEGER NOT NULL REFERENCES composers(id) ON DELETE CASCADE,
    position    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (song_id, composer_id)
);

-- Proposed edits to an existing song, awaiting Reviewer approval/rejection.
-- Approving applies the snapshot to the live song row; rejecting leaves it untouched.
CREATE TABLE IF NOT EXISTS song_revisions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id             INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    slug                TEXT NOT NULL,
    lyrics              TEXT NOT NULL,
    category            TEXT CHECK (category IS NULL OR category IN ('Gospel', 'Love', 'Traditional', 'Patriotic')),
    copyright_owner_id  INTEGER REFERENCES copyright_owners(id) ON DELETE SET NULL,
    artist_ids          TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artist_ids)),
    composer_ids        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(composer_ids)),
    submitted_by        INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewer_id         INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    reviewer_note       TEXT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at         DATETIME
);

-- Accountability trail for meaningful admin mutations (song lifecycle, revisions, admin accounts, reference data).
CREATE TABLE IF NOT EXISTS audit_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id       INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    admin_username TEXT NOT NULL,
    action         TEXT NOT NULL,
    target_type    TEXT NOT NULL,
    target_id      INTEGER,
    detail         TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Recognition badges awarded (Super Admin only) to an artist or composer — a month, a year or a lifetime
CREATE TABLE IF NOT EXISTS person_badges (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id    INTEGER REFERENCES artists(id) ON DELETE CASCADE,
    composer_id  INTEGER REFERENCES composers(id) ON DELETE CASCADE,
    period       TEXT NOT NULL CHECK (period IN ('month', 'year', 'lifetime')),
    period_value TEXT NOT NULL DEFAULT '',   -- 'YYYY-MM' | 'YYYY' | '' (lifetime)
    title        TEXT,                        -- optional custom label; NULL = the standard one
    awarded_by   INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- exactly one of artist / composer
    CHECK ((artist_id IS NOT NULL AND composer_id IS NULL) OR (artist_id IS NULL AND composer_id IS NOT NULL)),
    -- the value must match the period
    CHECK (
        (period = 'lifetime' AND period_value = '')
        OR (period = 'year'  AND period_value GLOB '[0-9][0-9][0-9][0-9]')
        OR (period = 'month' AND period_value GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]')
    )
);

-- One badge per person per period (partial indexes: a NULL id never collides)
CREATE UNIQUE INDEX IF NOT EXISTS uq_person_badges_artist   ON person_badges(artist_id, period, period_value)   WHERE artist_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_person_badges_composer ON person_badges(composer_id, period, period_value) WHERE composer_id IS NOT NULL;

-- Mara Idol: seasons (editions) and their contestants — a season is public only once published
CREATE TABLE IF NOT EXISTS idol_seasons (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    year        INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2100),
    description TEXT,
    venue       TEXT,
    start_date  TEXT CHECK (start_date IS NULL OR start_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
    end_date    TEXT CHECK (end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
    cover_url   TEXT,
    photo_url   TEXT,   -- square season photo/logo (migration 0014)
    videos      TEXT CHECK (videos IS NULL OR json_valid(videos)),   -- JSON array of { title, url }
    status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS idol_contestants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id  INTEGER NOT NULL REFERENCES idol_seasons(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL,
    bio        TEXT,
    photo_url  TEXT,
    result     TEXT NOT NULL DEFAULT 'contestant'
               CHECK (result IN ('winner', 'runner_up', 'second_runner_up', 'finalist', 'semi_finalist', 'contestant')),
    placement  INTEGER CHECK (placement IS NULL OR placement >= 1),   -- final position, if known
    videos     TEXT CHECK (videos IS NULL OR json_valid(videos)),     -- JSON array of { title, url }
    artist_id  INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (season_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_idol_seasons_status_year   ON idol_seasons(status, year DESC);
CREATE INDEX IF NOT EXISTS idx_idol_contestants_season    ON idol_contestants(season_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_idol_contestants_artist    ON idol_contestants(artist_id);

-- ─── Claim your profile (migration 0015) ───
CREATE TABLE IF NOT EXISTS person_accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    contact_email TEXT,   -- only the review team sees it (never returned by the public API)
    contact_phone TEXT,   -- ditto; digits with optional leading + (migration 0017)
    email_verified_at DATETIME,                    -- NULL until the owner proves control of contact_email (migration 0018)
    google_sub    TEXT,                            -- Google's account id, for "Sign in with Google" (migration 0018)
    session_epoch INTEGER NOT NULL DEFAULT 0,      -- bumped on password change/reset → older session tokens stop working
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_person_accounts_google_sub ON person_accounts(google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_person_accounts_verified_email ON person_accounts(lower(contact_email)) WHERE email_verified_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_person_accounts_email ON person_accounts(lower(contact_email));

-- One-time emailed links: 'verify' (confirm an address) / 'reset' (new password). Only a hash of the token is kept.
CREATE TABLE IF NOT EXISTS person_email_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES person_accounts(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
    email      TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used_at    DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_person_email_tokens_account ON person_email_tokens(account_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_person_email_tokens_email ON person_email_tokens(lower(email), kind, created_at);

CREATE TABLE IF NOT EXISTS person_claims (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id  INTEGER NOT NULL REFERENCES person_accounts(id) ON DELETE CASCADE,
    artist_id   INTEGER REFERENCES artists(id) ON DELETE CASCADE,
    composer_id INTEGER REFERENCES composers(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
    evidence    TEXT NOT NULL,   -- how the claimant says we can verify them
    review_note TEXT,            -- shown to the claimant
    reviewed_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    reviewed_at DATETIME,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK ((artist_id IS NOT NULL AND composer_id IS NULL) OR (artist_id IS NULL AND composer_id IS NOT NULL))
);

-- A profile has at most one owner (approved claim) ...
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_artist_owner   ON person_claims(artist_id)   WHERE status = 'approved' AND artist_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_composer_owner ON person_claims(composer_id) WHERE status = 'approved' AND composer_id IS NOT NULL;
-- ... and an account has at most one open (pending/approved) claim per profile.
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_artist_open   ON person_claims(account_id, artist_id)   WHERE status IN ('pending', 'approved') AND artist_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_composer_open ON person_claims(account_id, composer_id) WHERE status IN ('pending', 'approved') AND composer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_status ON person_claims(status, created_at);

-- ─── Green mark (migration 0016) ───
-- Plans: a plan is only offered once it has a price AND is enabled.
CREATE TABLE IF NOT EXISTS green_plans (
    months      INTEGER PRIMARY KEY CHECK (months IN (1, 3, 6, 12, 36)),
    price_cents INTEGER CHECK (price_cents IS NULL OR (price_cents > 0 AND price_cents <= 100000000)),
    enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
);
INSERT OR IGNORE INTO green_plans (months) VALUES (1), (3), (6), (12), (36);

-- One row of settings: the price currency and the how-to-pay text shown to buyers.
CREATE TABLE IF NOT EXISTS green_settings (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    currency             TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
    payment_instructions TEXT
);
INSERT OR IGNORE INTO green_settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS green_orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   INTEGER NOT NULL REFERENCES person_accounts(id) ON DELETE CASCADE,
    artist_id    INTEGER REFERENCES artists(id) ON DELETE CASCADE,
    composer_id  INTEGER REFERENCES composers(id) ON DELETE CASCADE,
    months       INTEGER NOT NULL CHECK (months IN (1, 3, 6, 12, 36)),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),   -- the price at the time of ordering
    currency     TEXT NOT NULL,
    method       TEXT NOT NULL DEFAULT 'manual' CHECK (method IN ('manual', 'card')),
    reference    TEXT NOT NULL,   -- the buyer's payment reference / transaction id
    note         TEXT,
    receipt      TEXT,            -- optional receipt image (data:image URL), only the reviewer sees it
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    review_note  TEXT,
    reviewed_by  INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    reviewed_at  DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK ((artist_id IS NOT NULL AND composer_id IS NULL) OR (artist_id IS NULL AND composer_id IS NOT NULL))
);
-- At most one open (pending) order per profile.
CREATE UNIQUE INDEX IF NOT EXISTS uq_green_order_open_artist   ON green_orders(artist_id)   WHERE status = 'pending' AND artist_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_green_order_open_composer ON green_orders(composer_id) WHERE status = 'pending' AND composer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_green_orders_status ON green_orders(status, created_at);

-- The mark itself: a profile has it while expires_at is in the future. Buying more time extends it.
CREATE TABLE IF NOT EXISTS green_marks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_id   INTEGER UNIQUE REFERENCES artists(id) ON DELETE CASCADE,
    composer_id INTEGER UNIQUE REFERENCES composers(id) ON DELETE CASCADE,
    expires_at  DATETIME NOT NULL,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK ((artist_id IS NOT NULL AND composer_id IS NULL) OR (artist_id IS NULL AND composer_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_green_marks_expires ON green_marks(expires_at);

-- ── Performance indexes ──
CREATE INDEX IF NOT EXISTS idx_songs_slug              ON songs(slug);
CREATE INDEX IF NOT EXISTS idx_songs_title              ON songs(title);
CREATE INDEX IF NOT EXISTS idx_songs_category           ON songs(category);
CREATE INDEX IF NOT EXISTS idx_songs_views              ON songs(views DESC);
CREATE INDEX IF NOT EXISTS idx_songs_artist_id          ON songs(artist_id);
CREATE INDEX IF NOT EXISTS idx_songs_composer_id        ON songs(composer_id);
CREATE INDEX IF NOT EXISTS idx_songs_copyright_owner_id ON songs(copyright_owner_id);
CREATE INDEX IF NOT EXISTS idx_songs_created_at         ON songs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artists_slug             ON artists(slug);
CREATE INDEX IF NOT EXISTS idx_composers_slug           ON composers(slug);
CREATE INDEX IF NOT EXISTS idx_copyright_owners_slug    ON copyright_owners(slug);
CREATE INDEX IF NOT EXISTS idx_reports_status           ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_song_id          ON reports(song_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status          ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_admin_users_username     ON admin_users(username);
CREATE INDEX IF NOT EXISTS idx_song_artists_artist_id   ON song_artists(artist_id);
CREATE INDEX IF NOT EXISTS idx_song_composers_composer_id ON song_composers(composer_id);
CREATE INDEX IF NOT EXISTS idx_songs_status             ON songs(status);
CREATE INDEX IF NOT EXISTS idx_song_revisions_song_id      ON song_revisions(song_id);
CREATE INDEX IF NOT EXISTS idx_song_revisions_status       ON song_revisions(status);
CREATE INDEX IF NOT EXISTS idx_song_revisions_submitted_by ON song_revisions(submitted_by);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at        ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target            ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_admin_id           ON audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_follows_followed_id    ON admin_follows(followed_id);

-- ── updated_at auto-maintenance triggers ──
CREATE TRIGGER IF NOT EXISTS trg_artists_updated_at
AFTER UPDATE ON artists
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE artists SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_composers_updated_at
AFTER UPDATE ON composers
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE composers SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_copyright_owners_updated_at
AFTER UPDATE ON copyright_owners
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE copyright_owners SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_songs_updated_at
AFTER UPDATE ON songs
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE songs SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_reports_updated_at
AFTER UPDATE ON reports
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE reports SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_contacts_updated_at
AFTER UPDATE ON contacts
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_users_updated_at
AFTER UPDATE ON admin_users
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE admin_users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- ── Full-text search over songs (title + lyrics) ──
CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
    title,
    lyrics,
    content = 'songs',
    content_rowid = 'id'
);

CREATE TRIGGER IF NOT EXISTS trg_songs_fts_insert
AFTER INSERT ON songs
BEGIN
    INSERT INTO songs_fts (rowid, title, lyrics) VALUES (NEW.id, NEW.title, NEW.lyrics);
END;

CREATE TRIGGER IF NOT EXISTS trg_songs_fts_delete
AFTER DELETE ON songs
BEGIN
    INSERT INTO songs_fts (songs_fts, rowid, title, lyrics) VALUES ('delete', OLD.id, OLD.title, OLD.lyrics);
END;

CREATE TRIGGER IF NOT EXISTS trg_songs_fts_update
AFTER UPDATE ON songs
FOR EACH ROW WHEN NEW.title IS NOT OLD.title OR NEW.lyrics IS NOT OLD.lyrics
BEGIN
    INSERT INTO songs_fts (songs_fts, rowid, title, lyrics) VALUES ('delete', OLD.id, OLD.title, OLD.lyrics);
    INSERT INTO songs_fts (rowid, title, lyrics) VALUES (NEW.id, NEW.title, NEW.lyrics);
END;

-- "Song of the Day" — one row per UTC calendar date, picked at random (SQL RANDOM())
-- the first time that date is requested and reused for every visitor for the rest of
-- that day, so it changes daily but stays consistent across page loads/reloads.
CREATE TABLE IF NOT EXISTS daily_song_picks (
    date       TEXT PRIMARY KEY,  -- 'YYYY-MM-DD', UTC
    song_id    INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- News/blog articles (Developer Dashboard → Articles). Publishing one (draft ->
-- published) is what makes it visible on the public /articles page and picked up
-- by the site's in-app notification poller — there's no separate "send" step.
CREATE TABLE IF NOT EXISTS articles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    slug         TEXT UNIQUE NOT NULL,
    author_name  TEXT NOT NULL,
    summary      TEXT,
    content      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    published_at DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_articles_slug         ON articles(slug);
CREATE INDEX IF NOT EXISTS idx_articles_status        ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_created_at    ON articles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_published_at  ON articles(published_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_articles_updated_at
AFTER UPDATE ON articles
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
    UPDATE articles SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
