-- Sign in with Google, verified email addresses and password reset for artist / composer accounts.
-- Run BEFORE deploying the matching Worker:  npm run db:migrate

-- When the owner proved they control contact_email (clicked the emailed link, or Google vouched for it). NULL = not verified.
ALTER TABLE person_accounts ADD COLUMN email_verified_at DATETIME;
-- Google's stable account id ("sub") for accounts that signed in with Google.
ALTER TABLE person_accounts ADD COLUMN google_sub TEXT;
-- Bumped on a password change/reset: session tokens carry the epoch they were issued under, so older ones stop working.
ALTER TABLE person_accounts ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_person_accounts_google_sub ON person_accounts(google_sub) WHERE google_sub IS NOT NULL;
-- One account per VERIFIED address (an unverified address proves nothing, so it can't block anyone).
CREATE UNIQUE INDEX IF NOT EXISTS idx_person_accounts_verified_email ON person_accounts(lower(contact_email)) WHERE email_verified_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_person_accounts_email ON person_accounts(lower(contact_email));

-- One-time links we email: 'verify' (confirm an address) and 'reset' (choose a new password).
-- Only a SHA-256 of the token is stored, so a database leak does not leak usable links.
CREATE TABLE IF NOT EXISTS person_email_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES person_accounts(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
    email      TEXT NOT NULL,       -- the address the link was sent to; a verify link only verifies THIS address
    token_hash TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used_at    DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_person_email_tokens_account ON person_email_tokens(account_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_person_email_tokens_email ON person_email_tokens(lower(email), kind, created_at);
