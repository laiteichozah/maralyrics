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
- Tests: `npm run test:auth`.

---

## Scripts

The important npm scripts are defined in `package.json`:

- `npm run dev` — `wrangler dev` (local development)
- `npm run deploy` — `wrangler deploy` (production deploy)
- `npm run db:create` — create a D1 database (`wrangler d1 create`)
- `npm run db:schema` / `db:schema:local` — apply `schema.sql` (idempotent; safe on a fresh or existing DB)
- `npm run db:seed:local` — load `seed.sql` sample data (local only — never run against prod)
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
