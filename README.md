# MaraLyrics

A modern, lightweight Mara song lyrics website. The project serves a static frontend from `public/` and uses Cloudflare Workers + D1 for dynamic pages and data.

---

## Project layout

```
maralyrics/
├── public/                 # Static site assets (HTML, CSS, JS)
│   ├── index.html
│   ├── songview.html
│   ├── artistview.html
│   ├── composerview.html
│   ├── copyrightownerview.html
│   ├── style.css
│   └── app.js
├── functions/              # Cloudflare Pages Functions / route handlers
│   ├── sitemap.xml.js      # /sitemap.xml
│   ├── song/[[catchall]].js
│   ├── artist/[[catchall]].js
│   ├── composer/[[catchall]].js
│   └── copyright-owner/[[catchall]].js
├── worker/                 # Standalone REST API Worker (api.maralyrics.com)
│   ├── worker.js           # Entry point — CORS, country block, route mounting
│   ├── routes/public.js    # Public API: /api/v1/*
│   ├── routes/admin.js     # Admin API: /api/v1/admin/* (Bearer token required)
│   └── lib/                # auth.js, turnstile.js, helpers.js
├── schema.sql              # D1 database schema (idempotent, safe to re-run anytime)
├── seed.sql                # Sample data for local development only — never run against prod
├── migrations/             # Versioned migrations for upgrading an existing database
├── wrangler.toml           # Cloudflare configuration (site + D1 bindings)
├── package.json            # npm scripts (dev, deploy, db tasks)
└── README.md               # This file
```

---

## Prerequisites

- Node.js v18+
- Wrangler CLI v3+ (`npm install -g wrangler` or use the locally installed `wrangler`)
- A Cloudflare account with D1 access (or local D1 for development)

---

## Quick start (local)

1. Install dependencies

```bash
npm install
```

2. Login to Cloudflare

```bash
npx wrangler login
```

3. Create a D1 database (one-time)

```bash
npm run db:create
```

Copy the printed `database_id` and update the `[[d1_databases]]` entry in `wrangler.toml`.

4. Apply the schema locally (and optionally seed sample data)

```bash
npm run db:schema:local
npm run db:seed:local   # optional — adds sample artists/composers/songs
```

5. Start local dev server (wrangler dev serves the `public/` site and functions)

```bash
npm run dev
```

Open http://localhost:8787 in your browser.

---

## Deploy

```bash
npm run deploy
```

This uses `wrangler deploy` and the config in `wrangler.toml` (site bucket, D1 bindings, routes).

---

## Routing & behavior

- Static content is served from `public/` as a Cloudflare Site.
- Dynamic page handlers live in `functions/` — each catch-all serves the corresponding view (`songview.html`, `artistview.html`, etc.) and injects SEO metadata when available. These run as Cloudflare Pages Functions and talk to D1 directly via the `DB` binding.
- A sitemap is generated at `/sitemap.xml` by `functions/sitemap.xml.js` using the D1 `songs` table.
- `worker/` is a separate, standalone REST API (deployed via `npm run deploy`, live at `api.maralyrics.com` — a custom domain bound to the `maralyrics-api` Worker) that the frontend (`public/app.js`, `public/admin/index.js`) calls cross-origin for everything else: song/artist/composer/copyright-owner listings, search, view counts, report/contact submission, and the full admin CRUD API.

### API (worker/)

All routes are versioned under `/api/v1`. Public routes (songs, artists, composers, copyright-owners, search, categories, reports, contacts) require no auth. Everything under `/api/v1/admin/*` requires `Authorization: Bearer <ADMIN_TOKEN>`.

Required secrets (never committed — see `.dev.vars.example` for local dev):

- `ADMIN_TOKEN` — bearer token for the admin API. Set with `wrangler secret put ADMIN_TOKEN`. The admin panel (`/admin`) prompts for this token on first load and stores it in `localStorage`.
- `TURNSTILE_SECRET_KEY` — verifies the Cloudflare Turnstile challenge on `/api/v1/reports` and `/api/v1/contacts`. Set with `wrangler secret put TURNSTILE_SECRET_KEY`. If unset, verification is skipped (logged as a warning) — safe for local dev, but should be set in production.

#### Artist accounts: Google sign-in and email (Resend)

Artists and composers sign in on `/my-profile` ("For Artists") with **Google** or with **email + password**. Email goes out through [Resend](https://resend.com): a confirmation link when someone signs up or changes their address, and "Forgot password" links. Both are optional and switch on by configuration:

- **Resend** — create an API key, verify your sending domain in Resend (DNS records), then `wrangler secret put RESEND_API_KEY` and check `MAIL_FROM` / `SITE_ORIGIN` in `wrangler.toml`. With no key, no email is sent, nobody is asked to confirm an address and "Forgot password" is hidden.
- **Google** — in Google Cloud Console create an OAuth client of type *Web application*, add `https://maralyrics.com` (and `https://www.maralyrics.com` if used) under *Authorised JavaScript origins*, and put the client id in `GOOGLE_CLIENT_ID` in `wrangler.toml`. No client secret is needed (the Worker checks Google's signed ID token). Empty = no Google button.
- Run `npm run db:migrate` **before** `npm run deploy` (migration `0018` adds email confirmation, Google ids and the one-time-link table).
- When a Manager approves, rejects or revokes a claim, the claimant gets an email with the decision and the team's note (only to a confirmed address; rivals closed by an approval are told too). The admin toast says whether it was sent.
- Tests: `npm run test:auth`.

#### Reader accounts: sync across devices

Anyone can create an account on `/account` ("Sign in & sync" in the header) with **Google** or **email + password** (it is the same account system as the artists' one — no phone number is needed to read). Signed-in devices share their **favorites, pinned songs, downloaded songs, theme and language**: changes are queued on the device, sent to `POST /api/v1/account/sync`, and the account's other devices are pulled in (the newest change to an item wins; removals are kept as tombstones). Downloaded songs are copied to the other devices in the background (a switch on `/account` turns that off per device). The code is the `Sync` module in `public/app.js`, `worker/lib/sync.js` and `public/account-page.js`.

- Run `npm run db:migrate` **before** `npm run deploy` (migration `0019` adds `person_sync_items` and `person_sync_state`).
- Tests: `npm run test:sync`.

#### Guitar Node: chords above the lyrics, and instant transposing

A song can carry an **original key** and **guitar chords**. On its page, Guitar Node draws each chord directly above the word or syllable it belongs to, and the visitor can move the whole song to another key (a key list of the 12 keys of the song's mode, − / + Semitone buttons, Reset, Show / Hide chords) without a reload. The choice is remembered per song in the browser only; the song itself is never changed. Songs without chords look exactly as before.

- **Data** (migration `0021`): `songs.original_key` (`'C'`, `'F#'`, `'Bb'` for major, `'Am'`, `'F#m'` for minor; `NULL` = unknown — never guessed) and `songs.chords` (JSON `{"v":1,"lines":{"<lyric line index>":[[<character offset>,"<chord>"],…]}}`; `NULL` = none). `song_revisions` carries the same two columns plus `has_chord_data`. The lyrics column is untouched, so search, SEO and every other page are unchanged; song lists do not include the chords (only a single song's page API does).
- **Chord engine** `public/chords.js` (pure, no dependency; shared by the browser, the Worker and the tests): parses chords (root with # / b, quality and extensions from a known token set — `m maj7 sus4 add9 dim aug 7 9 b5 #11 (b9) 6/9 …` — and a bass note `C/E`), transposes them **by interval with correct spelling** (borrowed chords too: bVI of C is Bb in D, not A#), keeps everything but the root and the bass note as written, and never touches text that is not a chord. Unknown / malformed notation is shown as written and refused when saving.
- **Editing** (admin dashboard → song form → *Guitar Node*): choose the original key (or leave it unknown), tick *This song has guitar chords* and write the **chord sheet**: `[C]Wise men [Em]say only [Am]fools rush in` (a line of only chords is an intro / solo: `[C] [G] [Am] [F]`; `[Chorus]` / `[x2]` stay in the lyrics). A palette of the key's chords, a live preview (with a try-it-in-another-key list) and a *Convert "chords above the words" text* button for sheets that have the chords printed above each line are included. The chord sheet is the one place the lyrics are typed while chords are on; saving splits it into plain lyrics + structured positions. Translators send the same data through the revision queue. A request that does not mention the key / chords keeps the stored ones; if it changes the lyrics without sending chords, the chords are dropped (their positions would no longer fit) and the response says `chords_cleared`.
- **Copy** gives the lyrics with the chords above them, in the key being shown (and the lyrics alone when the chords are hidden).
- **Tests**: `npm run test:chords` (engine: parsing, every key to every key, qualities, slash chords, minor keys, malformed input, validation, chord sheet), `npm run test:guitar` (server: save / validate / revisions / backward compatibility); both are part of `npm test`. `npm run test:e2e:guitar` is the browser test (real Chromium): chords measured above their words, transposing, reset, remembered key, minor and unknown keys, songs without chords, copy, keyboard, phone, and the admin editor.
- **Deploy**: `npm run db:migrate` (migration `0021`) **before** `npm run deploy`; the site files deploy with Pages. Nothing has to be converted: existing songs keep both columns `NULL`.

#### Account page: profile, preferences, security, your data, Cloudflare challenges

Signed in, `/account` has five tabs: **Overview** (sync status), **Profile** (name, photo, username, email, optional phone), **Preferences** (language, theme, card/list view — and the default calendar in Settings — all synced), **Security** (change or set a password, connect / disconnect Google, sign out of all devices) and **Your data** (download everything we hold as JSON; delete the account, which needs the password or a fresh Google sign-in and is refused while the account manages an artist/composer page).

**Cloudflare Turnstile** protects every way to create an account (email sign-up, and a *new* account created through Google), "Forgot password", claims, and sign-in after two wrong passwords (on both `/account` and `/my-profile`). It is checked only when the `TURNSTILE_SECRET_KEY` secret exists (`npx wrangler secret put TURNSTILE_SECRET_KEY`); without it the check is skipped, which is meant for local development only.

- Run `npm run db:migrate` **before** `npm run deploy` (migration `0020` adds `display_name` and `avatar`).
- Tests: `npm run test:account`.
- **Photo cropper** (`public/photo-cropper.js`): choosing a profile photo — on `/account` and in the artist / composer editor on `/my-profile` — opens a dialog where the person drags the picture to frame it and zooms with a slider, the mouse wheel, the +/- buttons or the keys (arrows move, `+`/`-` zoom, Enter/Escape use/cancel). The result is a square JPEG (256 px for accounts, 400 px for artist pages).
- **Browser test of every account feature**: `npm run test:e2e` drives a real Chromium through sign-up, the Cloudflare challenges, two-device sync (also offline), profile and the photo crop (pixel-checked), preferences, security, data download / deletion and a phone screen, against the real Worker with Google and Turnstile stubbed. It needs Playwright with Chromium (it skips with a message when there is none) and is not part of `npm test`. `E2E_SHOTS=dir` saves screenshots of the crop dialog; `E2E_DEBUG=dir` saves every page if the test stops early.

---

## Scripts

The important npm scripts are defined in `package.json`:

- `npm run dev` — `wrangler dev` (local development)
- `npm run deploy` — `wrangler deploy` (production deploy)
- `npm run db:create` — create a D1 database (`wrangler d1 create`)
- `npm run db:schema` / `db:schema:local` — apply `schema.sql` (idempotent; safe on a fresh or existing DB)
- `npm run db:seed:local` — load `seed.sql` sample data (local only — never run against prod)
- `npm test` — runs every check: the integration suites (`test:claims`, `test:green`, `test:social`, `test:idol`, `test:badges`, `test:richtext`, `test:auth`, `test:songnav`, `test:sync`, `test:account`, `test:chords`, `test:guitar`), then `seo:check` and `i18n:check`. They run the real Worker against an in-memory SQLite database; no network or Cloudflare account needed.
- `npm run changelog` — regenerates [CHANGELOG.md](CHANGELOG.md) (every version with its full commit log) and `public/releases.json` (the "Version history" on the Project page, with GitHub links) from `scripts/releases.json`; `npm test` fails if either is out of date; add `-- --tag` to create the annotated release tags (`vX.Y.Z`), or `-- --notes 1.4.0` to print one version's notes. GitHub Releases are published from the same notes by `.github/workflows/release.yml` (`scripts/publish-releases.mjs`): pushing a `vX.Y.Z` tag creates its release, and Actions → *Publish releases* → *Run workflow* back-fills the missing ones (tick *update* to rewrite existing ones). See the header of `scripts/changelog.mjs` for how to cut a release.
- `npm run db:migrate` / `db:migrate:local` — apply any pending files in `migrations/` via `wrangler d1 migrations apply` (tracked, runs each migration once)

---

## Adding songs

You can insert songs directly into the D1 `songs` table. `artist_id` / `composer_id` reference the `artists` / `composers` tables, and `category` must be one of `Gospel`, `Love`, `Traditional`, `Patriotic` (enforced by a `CHECK` constraint). Example SQL:

```sql
INSERT INTO songs (title, slug, artist_id, category, lyrics) VALUES
('Song Title', 'song-title-slug', 1, 'Traditional', 'Lyrics line 1' || char(10) || 'Line 2');
```

You can execute ad-hoc commands with Wrangler:

```bash
npx wrangler d1 execute maralyrics-db --command="INSERT INTO songs ..."
```

---

## Notes

- `wrangler.toml` in this repository contains the D1 binding and site bucket. Update `database_id` after creating your D1 instance.
- This project serves pre-rendered HTML views and uses client-side JS to fetch and render data where appropriate.

---

## License

MIT License — Copyright (c) 2026 Maralyrics
