# Changelog

Every released version of MaraLyrics, newest first, with its full commit log. Versions follow [semantic versioning](https://semver.org) and each one is a git tag (`vX.Y.Z`) on the commit it names.
This file is generated: edit `scripts/releases.json` and run `npm run changelog`. A version's log lists every commit since the previous version; merge commits are counted, not listed.

## Unreleased

Merged after the latest version; it ships with the next one.

- `npm test` runs every check in one go (all test suites, SEO and i18n); a project-wide check found no failures
- This changelog, with the full commit log of every version, and the release tags v1.0.0–v1.9.0, generated with `npm run changelog` (see scripts/changelog.mjs)
- hono updated to 4.13.13 (fixes a moderate advisory in a feature this project does not use)
- .gitignore now also keeps keystores and .env files out of git
- The Project page (/project) shows the version history: every version with its highlights and full commit log, each linking to GitHub (data generated into public/releases.json by `npm run changelog`)

## v1.9.0 — Reading flow (2026-10-24)

Previous / Next song buttons on the song page.

**Highlights**
- Tap or click the lyrics to show Previous / Next buttons; they follow the list the song was opened from, or all songs A–Z for a shared link (#81)

**Deploy notes:** Run `npm run deploy` for the new `GET /songs/:slug/neighbors` endpoint.

1 commits (0 merge commits not listed) · 1 author · 7 files changed, 347 insertions(+), 2 deletions(-)

<details><summary>Full log — 1 commits</summary>

- `f7ab52b` 2026-10-24 Previous / Next song buttons that appear when the lyrics are tapped (#81) — Laitei

</details>

## v1.8.0 — Sign in, rich text and email (2026-10-19)

Sign in with Google or email, emails through Resend, formatted bios, and a calmer account design.

**Highlights**
- Sign in or sign up with Google, or with email + password; confirmation and password-reset emails through Resend; a confirmed email is required to claim or order (#78)
- Rich-text bios (bold, italic, underline, links, lists, quotes, line breaks) in the admin dashboard and the claimed-artist editor, stored as sanitized HTML (#78)
- The account pages redesigned in a plain and calm style (#79)
- Claimants are emailed when a claim is approved, rejected or revoked (#80)

**Deploy notes:** Run `npm run db:migrate` before `npm run deploy`. Set the `RESEND_API_KEY` secret and put the Google OAuth client id in `GOOGLE_CLIENT_ID` in wrangler.toml (see the README).

**Database migrations:** `0018_account_identity.sql`

3 commits (0 merge commits not listed) · 1 author · 38 files changed, 2466 insertions(+), 564 deletions(-)

<details><summary>Full log — 3 commits</summary>

- `55e0006` 2026-10-19 Rich-text bios + sign in with Google / email (Resend confirmation and password reset) (#78) — Laitei
- `4a10400` 2026-10-19 Redesign the artist account pages: plain and calm instead of purple-and-gold 'royal' (#79) — Laitei
- `5fbd746` 2026-10-19 Email the claimant when a claim is approved, rejected or revoked (#80) — Laitei

</details>

## v1.7.0 — Artist accounts (2026-10-10)

Artists and composers can create accounts, claim their profile, edit it and buy the Green mark.

**Highlights**
- Claim your profile: accounts for artists and composers, reviewed by Managers and Super Admins; owners edit their bio, photo and social links (#75)
- Green mark: paid plans (1, 3, 6, 12 or 36 months), reviewed by hand, with a green tick on profiles (#76)
- A dedicated "For Artists" page (the Artist Court) with tabs for Profile, Green Mark, Claims and Account; email and phone are compulsory (#77)

**Database migrations:** `0015_person_claims.sql`, `0016_green_mark.sql`, `0017_person_phone.sql`

3 commits (0 merge commits not listed) · 1 author · 53 files changed, 4082 insertions(+), 97 deletions(-)

<details><summary>Full log — 3 commits</summary>

- `d2bd162` 2026-10-10 Claim your profile: artists and composers edit their own profile (#75) — Laitei
- `c81ea51` 2026-10-10 Green mark: paid plans (1/3/6/12/36 months), hand-reviewed, with a tick on profiles (#76) — Laitei
- `9bf815a` 2026-10-10 Artist Court: royal For Artists page with Green mark tab; email and phone compulsory (#77) — Laitei

</details>

## v1.6.0 — Mara Idol (2026-10-10)

A new section for the Mara Idol contest: seasons, idols, videos and their pages.

**Highlights**
- Mara Idol: seasons, idols, public pages and admin management (#69)
- Video links honour the start time of copied YouTube links; video thumbnails come from the platform or are uploaded; a video's title comes back when it is no longer active (#70, #73, #74)
- Wide cover crop and a separate square season photo (#71)
- Season pages no longer fail with Error 1101 when a migration has not been run yet (#72)

**Database migrations:** `0013_mara_idol.sql`, `0014_idol_season_photo.sql`

6 commits (0 merge commits not listed) · 1 author · 45 files changed, 3483 insertions(+), 58 deletions(-)

<details><summary>Full log — 6 commits</summary>

- `4f951c4` 2026-10-09 Add Mara Idol: seasons, idols, public pages and admin management (#69) — Laitei
- `d8a8070` 2026-10-09 Mara Idol videos: honour the start time in copied YouTube links (#70) — Laitei
- `0373a32` 2026-10-09 Mara Idol: wide cover crop and a separate square season photo (#71) — Laitei
- `87eb84e` 2026-10-10 Fix Error 1101 on Mara Idol season pages when migration 0014 has not run yet (#72) — Laitei
- `cac04e4` 2026-10-10 Mara Idol videos: thumbnails from the platform or uploaded manually (#73) — Laitei
- `ba9c3a9` 2026-10-10 Mara Idol videos: bring the title back when a video is no longer active (#74) — Laitei

</details>

## v1.5.0 — Findability and recognition (2026-10-09)

Search-engine visibility and a way to honour artists.

**Highlights**
- i18n cleanup and comprehensive SEO: server-rendered content for crawlers, structured data and a sitemap (#67)
- Recognition badges for artists and composers (month, year or lifetime), awarded by Super Admins (#68)

**Database migrations:** `0012_person_badges.sql`

2 commits (0 merge commits not listed) · 1 author · 47 files changed, 2132 insertions(+), 395 deletions(-)

<details><summary>Full log — 2 commits</summary>

- `5c6b01f` 2026-10-09 i18n cleanup + comprehensive SEO (server-rendered content, structured data, sitemap) (#67) — Laitei
- `19dc953` 2026-10-09 Add artist/composer recognition badges (month, year, lifetime), Super Admin only (#68) — Laitei

</details>

## v1.4.0 — Community and offline (2026-10-09)

People, sponsors, events and offline songs: the community side of the site.

**Highlights**
- Admin header shows an avatar and role badge; role marks beside names; admin photo upload with crop; editors listed on the Project page (#53–#55, #57)
- Inline create inside the song form; photos in name lists; View Site opens in a new tab (#54, #57)
- Sponsors & Partners on the Project page, and up to 7 pinned favorite songs that lead the list (#59, #61)
- Event detail modal from Today's Event and from event notifications; notifications list up to 5 credited artists (#58, #60)
- Explicit song downloads and a My Downloads page (#62)
- Featured artists / composers spotlight and directory page, with a styled sort dropdown (#63, #64)
- Admin dashboard loading states and toast feedback (#65); notification and settings icons stay in the header on phones (#66)
- GitHub contributor links point at laiteichozah/maralyrics (#56)

**Database migrations:** `0009_admin_photos.sql`, `0010_copyright_owner_image.sql`, `0011_supporters.sql`

14 commits (0 merge commits not listed) · 2 authors · 36 files changed, 4045 insertions(+), 624 deletions(-)

<details><summary>Full log — 14 commits</summary>

- `dd198f4` 2026-09-29 Replace admin header's "Username (ROLE)" text with an avatar + role badge (#53) — Laitei
- `236be77` 2026-10-01 Inline create in song form, role marks, admin photo upload with crop, editors on Project page (#54) — Laitei
- `c57fe3e` 2026-10-01 Drop role text next to names where the avatar role mark is shown (#55) — Laitei
- `f1efc36` 2026-10-01 Point GitHub contributors/links at laiteichozah/maralyrics (#56) — Laitei
- `7616e51` 2026-10-01 Admin-style photo crop for artists/composers/copyright owners, photos in name lists, View Site in new tab (#57) — Laitei
- `d5fbbe3` 2026-10-01 Notifications: list all credited artists (up to 5, then 'and N more') (#58) — Laitei
- `f67e171` 2026-10-02 Sponsors & Partners on the Project page + pin up to 7 favorite songs (#59) — Laitei
- `3281d88` 2026-10-02 Event detail modal from Today's Event card and event notifications (#60) — Laitei
- `ddcb3ec` 2026-10-02 Pinned songs lead the list; list-view pin spacing; "Offline" label (#61) — Laitei
- `33cdc92` 2026-10-02 Explicit song downloads, My Downloads page, nav + drawer entries (#62) — Laitei
- `fbfb402` 2026-10-05 Featured artists/composers spotlight and directory page (#63) — Bei Laitei
- `2beb427` 2026-10-05 Replace native sort select on artists/composers page with a styled dropdown (#64) — Bei Laitei
- `b1c3544` 2026-10-06 Admin dashboard: loading states and toast feedback (#65) — Bei Laitei
- `e1bcdcc` 2026-10-09 Pin notification & settings icons in the header on phones (#66) — Laitei

</details>

## v1.3.0 — Admin on the go (2026-09-29)

The admin dashboard works on phones and offline, gets its own Android app, and two security audits are fixed.

**Highlights**
- Search ranks exact and title matches above lyric mentions (#44); "is there an event today" checks bypass the cache (#43)
- Admin dashboard layout fixed for phone-width screens (#45)
- Offline-first PWA support for the admin dashboard (#46)
- High-severity findings from the technical audit fixed (#47), then High/Medium findings from the admin dashboard audit (#48)
- Android admin app as a Trusted Web Activity (#49), plus three CI fixes for building it (#50, #51, #52)

**Database migrations:** `0008_login_attempts.sql`

10 commits (0 merge commits not listed) · 1 author · 47 files changed, 2177 insertions(+), 228 deletions(-)

<details><summary>Full log — 10 commits</summary>

- `ff8d168` 2026-09-27 Bypass caching for the "is there an event today" checks (#43) — Laitei
- `ce0bb08` 2026-09-27 Rank exact and title-heavy matches above lyric mentions in search (#44) — Laitei
- `6d15927` 2026-09-27 Fix admin dashboard layout on phone-width screens (#45) — Laitei
- `8d31243` 2026-09-27 Add offline-first PWA support to the admin dashboard (#46) — Laitei
- `f6ce3e9` 2026-09-28 Fix High-severity findings from the technical audit (#47) — Laitei
- `8a2e68e` 2026-09-28 Fix High/Medium-severity findings from admin dashboard audit (#48) — Laitei
- `36f05b9` 2026-09-28 Add Android admin app (Trusted Web Activity) (#49) — Laitei
- `ecb6413` 2026-09-29 Fix CI: secrets can't be used in step if: conditions (#50) — Laitei
- `ef6da73` 2026-09-29 Fix CI: setup-android's default package list includes removed 'tools' (#51) — Laitei
- `233bdb4` 2026-09-29 Fix CI: release keystore written to wrong directory for Gradle's file() (#52) — Laitei

</details>

## v1.2.0 — Reach (2026-09-21)

Promoting the Android app, advertising, a community calendar and rich-text articles.

**Highlights**
- Android app promotion: a banner and a one-time promo dialog; default language updated
- Google AdSense integration and ads.txt; Terms and Privacy Policy updated for AdSense
- Community calendar with a year-by-year event list (#39)
- Rich-text editing for Articles, and a fix for a stale service-worker cache (#40)

**Database migrations:** `0007_articles.sql`

15 commits (2 merge commits not listed) · 2 authors · 39 files changed, 5303 insertions(+), 296 deletions(-)

<details><summary>Full log — 15 commits</summary>

- `4543e3d` 2026-09-05 Admin panel: fix slug diacritics, stale manual-slug flag, add search to all tabs (#37) — Laitei
- `a1f5453` 2026-09-05 Admin panel: fix image re-encoding, duplicate listeners, and misc bugs (#38) — Laitei
- `d973889` 2026-09-11 Added Android App Ad. — Laitei40
- `2f01f38` 2026-09-11 Updated fetching method. — Laitei40
- `6d2c947` 2026-09-11 Added App promo one time dialog. - Updated default language. - Upated translation — Laitei40
- `969a292` 2026-09-11 Update packages. — Laitei40
- `b7b2df8` 2026-09-14 Add Google AdSense meta tag to index.html — Laitei
- `13badb3` 2026-09-14 Integrate Google AdSense script in index.html — Laitei
- `b07c265` 2026-09-14 Add ads.txt for ad verification — Laitei
- `6db7757` 2026-09-14 Remove duplicate Google AdSense script tag — Laitei
- `ddfe599` 2026-09-17 Add community calendar icon with year-by-year event list (#39) — Laitei
- `cf96c87` 2026-09-20 Fix stale service worker cache and add rich text editing to Articles (#40) — Laitei
- `8bc847b` 2026-09-21 Fix unhandled Cache errors from browser extension requests (#41) — Laitei
- `ad7e32d` 2026-09-21 Deduplicate AdSense script and add it site-wide (#42) — Laitei
- `d85bb6c` 2026-09-21 Update Terms and Privacy Policy for Google AdSense — Laitei40

</details>

## v1.1.0 — Languages and everyday reading (2026-09-04)

Burmese and Mara translations, a site-wide modernization, better search and the everyday reading features people use most.

**Highlights**
- Burmese (my) and Mara (mrh) translations of the whole site
- Site-wide modernization: mobile navigation, SEO meta, i18n bug fixes, admin UX and backend hardening (#32); duplicate security headers removed
- Fuzzy "did you mean" search suggestions matched against lyrics (#34)
- Card / list display toggle, song sorting and cookie-backed favorites (#35)
- Song of the Day (a daily random pick) and a finished i18n coverage sweep (#36)

**Database migrations:** `0006_daily_song_pick.sql`

11 commits (0 merge commits not listed) · 3 authors · 38 files changed, 1927 insertions(+), 430 deletions(-)

<details><summary>Full log — 11 commits</summary>

- `0e2fec6` 2026-07-28 Fixed bugs. Improved features. — Laitei40
- `45910db` 2026-07-28 Deduplicate security response headers in _headers — Laitei40
- `2d3b980` 2026-07-28 Drop redundant security headers already set at the Cloudflare zone level — Laitei40
- `d3af9e6` 2026-08-07 Translate public/locales/en.json in my (#29) — transifex-integration[bot]
- `9aecf74` 2026-08-07 Translate public/locales/en.json in my (#30) — transifex-integration[bot]
- `b597576` 2026-09-03 Translate public/locales/en.json in mrh (#31) — transifex-integration[bot]
- `57e305d` 2026-09-03 Site-wide modernization: fix mobile nav, SEO meta, i18n bugs, admin UX, and backend hardening (#32) — Laitei
- `dfa48b4` 2026-09-04 Add fuzzy "did you mean" search suggestions matched against lyrics body (#34) — Laitei
- `b2265cf` 2026-09-04 Updates for file public/locales/en.json in mrh (#33) — transifex-integration[bot]
- `3275e84` 2026-09-04 Add Card/List display toggle, song sorting, and cookie-backed favorites (#35) — Laitei
- `50d6ad2` 2026-09-04 Add "Song of the Day" (daily random pick) + finish i18n coverage sweep (#36) — Laitei

</details>

## v1.0.0 — Foundation (2026-07-11)

The MaraLyrics lyrics site and its admin dashboard on Cloudflare Pages + Workers + D1, with a six-tier permission model.

**Highlights**
- Song, artist, composer and copyright-owner pages, search, categories and an admin dashboard for managing them
- Admin roles overhauled into a 6-tier permission model (viewer, translator, reviewer, editor, manager, super admin) with song revisions and an audit log
- Admin profile pages with follow / unfollow and self-service account management
- Header links consolidated into a Settings dropdown; polished artist / composer checkbox lists with an "Unknown" option

**Database migrations:** `0001_professional_upgrade.sql`, `0002_admin_role_system.sql`, `0003_multi_artist_composer.sql`, `0004_role_matrix_and_revisions.sql`, `0005_admin_profiles_and_follows.sql`

6 commits (0 merge commits not listed) · 1 author · 63 files changed, 20004 insertions(+)

<details><summary>Full log — 6 commits</summary>

- `28a4816` 2026-07-10 Polish the artist/composer checkbox lists, add an "Unknown" option — Laitei40
- `a8deb14` 2026-07-10 Fix filter crash on the Unknown checkbox row — Laitei40
- `46ccd8f` 2026-07-11 Fix admin feedback modal padding and field layout — Laitei40
- `b44b78f` 2026-07-11 Overhaul admin roles into a 6-tier permission model with revisions and audit log — Laitei40
- `cfac46b` 2026-07-11 Add admin profile pages with follow/unfollow and self-service account management — Laitei40
- `c57e1f5` 2026-07-11 Consolidate header links into a Settings dropdown — Laitei40

</details>
