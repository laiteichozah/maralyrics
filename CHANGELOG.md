# Changelog

Every released version of MaraLyrics, newest first, with its full commit log. Versions follow [semantic versioning](https://semver.org) and each one is a git tag (`vX.Y.Z`) on the commit it names.
This file is generated: edit `scripts/releases.json` and run `npm run changelog`. A version's log lists every commit since the previous version; merge commits are counted, not listed.

## Unreleased

Merged after the latest version; it ships with the next one.

- Song pages show an "Open in the Mara Lyrics app" button on Android browsers (a real link to an Android intent URL for that song; with no app installed it opens the Google Play page); `/.well-known/assetlinks.json` now also vouches for the app `com.maralyrics.laitei` (add the Play App Signing SHA-256 from Play Console to its fingerprint list); the song page action buttons wrap instead of running off the card on phones

## v1.10.0 — Accounts and Guitar Node (2026-10-27)

Reader accounts that sync across devices, a full account page with Cloudflare challenges, profile photo cropping, and Guitar Node: guitar chords above the lyrics with instant transposing.

**Highlights**
- Reader accounts: sign in on /account with Google or email + password to keep favorites, pinned songs, downloads, theme and language in step on every device (migration 0019; run `npm run db:migrate` then `npm run deploy`)
- Account page: Profile (name, photo, username, optional phone), Preferences (language, theme, list view, default calendar — synced), Security (password, Google, sign out everywhere) and Your data (download, delete); Cloudflare challenges on every way to create an account and on sign-in after repeated failures (migration 0020)
- Profile photos open a crop dialog (drag, zoom, wheel, keyboard) on the account page and in the artist editor; `npm run test:e2e` is a browser test of every account feature
- Guitar Node: songs can carry an original key and guitar chords, shown above the lyrics; visitors change the key on the page (key list, semitone buttons, reset) and the chords transpose with correct sharps / flats; editors write the chords in the admin song form (chord sheet, palette, live preview, converter for chords-above-words text) (migration 0021: run `npm run db:migrate` then `npm run deploy`)
- Admin song form: adding a chord from the palette no longer throws the cursor to the end or scrolls the sheet and dialog; it goes in at the cursor, the cursor stays after it, and Ctrl+Z takes it back
- The admin dashboard now fetches its scripts and styles from the network first (its offline copy is only a fallback), so a deploy is never half-applied; the note under the Lyrics box in the song form only shows when chords are on
- Dark all the way: the admin dashboard's scrollbars, dropdown lists and checkboxes are drawn dark (no white strips), the Guitar Node box is tidier, and the key list on the song page follows the theme
- The Project page (/project) shows the version history: every version with its highlights and full commit log, each linking to GitHub (data generated into public/releases.json by `npm run changelog`)
- GitHub Releases for every version, published from the same notes by the "Publish releases" workflow (scripts/publish-releases.mjs); the Project page links to them
- This changelog, with the full commit log of every version, and the release tags v1.0.0–v1.10.0, generated with `npm run changelog` (see scripts/changelog.mjs)
- `npm test` runs every check in one go (all test suites, SEO and i18n); a project-wide check found no failures
- hono updated to 4.13.13 (fixes a moderate advisory in a feature this project does not use)
- .gitignore now also keeps keystores and .env files out of git

**Deploy notes:** Run `npm run db:migrate` (migrations 0019 account sync, 0020 account profile, 0021 Guitar Node) and then `npm run deploy` for the new account and chord endpoints. The Cloudflare Turnstile challenges need the `TURNSTILE_SECRET_KEY` secret.

**Database migrations:** `0019_account_sync.sql`, `0020_account_profile.sql`, `0021_guitar_node.sql`

11 commits (1 merge commits not listed) · 2 authors · 48 files changed, 8463 insertions(+), 96 deletions(-)

<details><summary>Full log — 11 commits</summary>

- `02d3057` 2026-10-24 Add changelog with full logs and release tooling; npm test; patch hono; harden .gitignore (#82) — Laitei
- `00448e8` 2026-10-24 Show the version history on the Project page, with full logs and GitHub links (#83) — Laitei
- `1beda3d` 2026-10-24 Publish a GitHub Release for every version tag (#84) — Laitei
- `f0e773b` 2026-10-24 Reader accounts: sign in with Google or email + password and sync favorites, pins, downloads, theme and language across devices (#85) — Laitei
- `e64abc3` 2026-10-24 Account page: profile, preferences, security, your data; Cloudflare challenges on account creation and repeated sign-in failures (#86) — Laitei
- `4d39b60` 2026-10-24 Photo crop dialog for profile photos, and a browser test of every account feature (#87) — Laitei
- `5013ec2` 2026-10-26 Guitar Node: guitar chords above the lyrics, with instant transposing (#88) — Laitei
- `ab8f2e4` 2026-10-26 Fixed bugs. 	modified:   CHANGELOG.md 	modified:   public/releases.json — Laitei40
- `f907cd9` 2026-10-26 Fix the admin song form showing a half-updated Guitar Node box after a deploy (#89) — Laitei
- `7642e13` 2026-10-27 Dark all the way: no white scrollbars, dropdown lists or checkboxes in the admin dialogs; tidier Guitar Node box (#90) — Laitei
- `2f85b3d` 2026-10-27 Admin chord palette: keep the cursor and scroll where they were when a chord is added (#91) — Laitei

</details>

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

180 commits (30 merge commits not listed) · 4 authors · 63 files changed, 20004 insertions(+)

<details><summary>Full log — 180 commits</summary>

- `a9a5803` 2026-02-13 Initial commit: MaraLyrics - Cloudflare Workers + D1 lyrics website — Laitei
- `71fac51` 2026-02-13 feat: add admin dashboard with full CRUD for songs — Laitei
- `2c9dbca` 2026-02-13 chore: move admin assets into admin folder — Laitei
- `6ed0151` 2026-02-13 Update wrangler.toml — Laitei
- `0cb0c78` 2026-02-13 Fix API base URL for production deployment on Cloudflare Pages — Laitei
- `1317a3b` 2026-02-13 Updated Admin page — Laitei
- `79c6e58` 2026-02-14 Fix admin Pages: copy style.css + icon.svg, update paths for separate domain — Laitei
- `b4e0525` 2026-02-14 Add _redirects for Pages SPA routing on /song/* URLs — Laitei
- `146406e` 2026-02-14 Fix song page: move to song/index.html to prevent Pages 308 redirect — Laitei
- `3f90661` 2026-02-14 Rename song page to songview.html to avoid Pages /song/ path conflict — Laitei
- `9deed77` 2026-02-14 Add Pages Function for /song/* routing instead of _redirects — Laitei
- `b8feac0` 2026-02-15 Updated UI, Backend, and System — Laitei
- `5a754ed` 2026-02-15 Add social links + image upload/crop for artists & composers — Laitei
- `da36e1f` 2026-02-15 Add Report Error feature with form + API + D1 storage — Laitei
- `a2f2614` 2026-02-15 Polish report button + MailChannels email — Laitei
- `d819d84` 2026-02-15 Fix report email sending via MailChannels — Laitei
- `3308332` 2026-02-15 Add /report route to serve report.html — Laitei
- `4bd5f0f` 2026-02-15 Remove MailChannels, add Reports tab to admin dashboard — Laitei
- `26b3b02` 2026-02-15 Fix reports API response format — Laitei
- `e2b5d53` 2026-02-15 Rename Report Error to Feedback — Laitei
- `4075efd` 2026-02-15 Add Cloudflare Turnstile to feedback form, add feedback detail modal to admin — Laitei
- `933f898` 2026-02-15 Professional Send Feedback button with gradient and hover effects — Laitei
- `f8e465a` 2026-02-15 Remove Turnstile secret from wrangler.toml, use Worker secret instead — Laitei
- `81f06e6` 2026-02-15 feat: add i18n support for Mara and Burmese with Crowdin integration — Laitei
- `e4f32ab` 2026-02-15 fix: use correct ISO 639-3 code mrh for Mara language — Laitei
- `bbe8b6a` 2026-02-15 New translations en.json (Burmese) — Laitei
- `b015e32` 2026-02-15 New translations en.json (Mara) — Laitei
- `d4e3b74` 2026-02-15 Add settings dropdown with theme system (Dark/Light/System/Time) — Laitei
- `70ef67e` 2026-02-15 Improve light theme: proper text/bg contrast across all components — Laitei
- `3c23a07` 2026-02-15 Fix active category text color in light mode — Laitei
- `e420b59` 2026-02-15 Add static pages (privacy, terms, copyright), new footer, /api/contact endpoint — Laitei
- `2803b0e` 2026-02-15 Footer bottom: horizontal on desktop, stacked on mobile — Laitei
- `4aa16a6` 2026-02-15 Add YouTube and Facebook social icons to footer — Laitei
- `c6979ed` 2026-02-15 Add i18n support to static pages, update all locale files, remove (Lai) references — Laitei
- `6014adf` 2026-02-15 New translations en.json (Burmese) — Laitei
- `47a29d6` 2026-02-15 New translations en.json (Mara) — Laitei
- `49f9c1a` 2026-02-15 Update email addresses: contact@ → info@ for general, copyright@ → contact@ for copyright claims — Laitei
- `2754ca3` 2026-02-15 New translations en.json (Burmese) — Laitei
- `c4c4aea` 2026-02-15 New translations en.json (Mara) — Laitei
- `b50fc6f` 2026-02-15 Added copyright features — Laitei
- `2423043` 2026-02-15 Fix copyright owner 404 on Pages, move copyright to song footer — Laitei
- `9467021` 2026-02-15 Fix copyright owner slug extraction in getSlugFromUrl regex — Laitei
- `0471a27` 2026-02-15 Simplify copyright owner display on song page — Laitei
- `e23edc2` 2026-02-15 Move copyright owner to footer row beside Feedback button — Laitei
- `855554c` 2026-02-15 Lyrics+fuzzy search, debounce, and suggestions for no results — Laitei
- `0cb9272` 2026-02-15 Add lyrics search, fuzzy matching, and song suggestions — Laitei
- `5bf7919` 2026-02-15 Support custom domains (maralyrics.com, admin.maralyrics.com) — Laitei
- `218214b` 2026-02-15 New translations en.json (Mara) — Laitei
- `6751d1c` 2026-02-16 Fix admin View Song links to use absolute main site URL — Laitei
- `ed51d1a` 2026-02-16 Fix all admin view links to use absolute main site URLs — Laitei
- `d186910` 2026-02-16 Add Service Worker for smart offline caching — Laitei
- `9e54465` 2026-02-16 Add search history and cookie consent banner — Laitei
- `9f932e3` 2026-02-16 Fix SW ERR_FAILED: add missing await on caches.match fallbacks — Laitei
- `a3fe7f6` 2026-02-16 Fix search history: z-index and intermediate keystroke saving — Laitei
- `2a616b5` 2026-02-16 Fix SW ERR_FAILED on song pages + save search history on result click — Laitei
- `8bc2b19` 2026-02-16 Add reusable toast system, header offline badge, and UI feedback toasts — Laitei
- `ca8845d` 2026-02-16 Convert all hardcoded strings to I18n — Laitei
- `9f090a3` 2026-02-16 New translations en.json (Burmese) — Laitei
- `2ed2536` 2026-02-16 New translations en.json (Mara) — Laitei
- `6028e63` 2026-02-24 New translations en.json (Burmese) — Laitei
- `74b3b15` 2026-02-24 New translations en.json (Burmese) — Laitei
- `8ec9d0e` 2026-02-24 New translations en.json (Mara) — Laitei
- `abdf674` 2026-02-24 chore(i18n): remove -MM locale duplicates, map mrh-MM/my-MM to mrh/my in Crowdin — Laitei40
- `2bda9e5` 2026-02-24 fix(i18n): always persist language to localStorage, not gated by cookie consent — Laitei40
- `4f106b0` 2026-02-25 New translations en.json (Burmese) — Laitei
- `4d411cf` 2026-02-25 New translations en.json (Mara) — Laitei
- `e0fb199` 2026-02-25 feat: optimistic delete, session persistence, auto-draft for songs/artists/composers — Laitei40
- `45b621f` 2026-02-26 Add modern mobile drawer navigation for Home and Popular — Laitei
- `72c6590` 2026-02-26 Add language and theme controls to mobile drawer — Laitei
- `8cf7f56` 2026-02-26 Use settings button inside mobile drawer and support multiple toggles — Laitei
- `8350270` 2026-02-26 Fix mobile drawer variable redeclaration conflict — Laitei
- `18c4029` 2026-02-26 Move settings-toggle into mobile drawer on small screens; preserve language & theme controls for mobile — Laitei40
- `619d5b5` 2026-02-26 Allow multi-artist/composer/copyright associations (up to 40); add junction tables; admin multi-select UI — Laitei40
- `c06f686` 2026-02-26 Support multi associations (artists/composers/copyright owners) up to 40: DB junction tables, API helpers, admin multi-select UI — Laitei40
- `4741992` 2026-02-26 Fix admin select dropdown colors for dark theme — Laitei40
- `1c21cca` 2026-02-26 Support up to 40 song associations and fix admin select contrast — Laitei
- `a65ac5f` 2026-02-26 Revert "Support up to 40 song associations and fix admin dropdown contrast" — Laitei
- `a7a1cd1` 2026-02-26 Revert "Merge branch 'Laitei40'" — Laitei
- `a869828` 2026-02-26 Fix admin dropdown contrast and add glass drawer panel — Laitei
- `bdcbc0d` 2026-02-28 Update my.json — Laitei
- `2052a2f` 2026-02-28 Update my.json — Laitei
- `d3d9c20` 2026-03-07 Add files via upload — Laitei
- `812682d` 2026-03-07 Add dynamic D1-backed sitemap XML endpoint — Laitei
- `8bc4dd5` 2026-03-06 Delete public/sitemap.xml — Laitei
- `7984266` 2026-03-06 Create sitemap.xml.js — Laitei
- `0a551b6` 2026-03-07 Improve dynamic sitemap lastmod and song SEO metadata — Laitei
- `02ca64d` 2026-03-06 Update wrangler.toml — Laitei
- `2eeaae5` 2026-03-06 Update sitemap.xml.js — Laitei
- `f3deac7` 2026-03-07 Update sitemap.xml.js — Laitei
- `f8781bf` 2026-03-22 Initial plan — copilot-swe-agent[bot]
- `23aba63` 2026-03-22 Fix drawer theme adaptation and prevent overscroll reveal — copilot-swe-agent[bot]
- `0effea4` 2026-03-22 Initial plan — copilot-swe-agent[bot]
- `29f2ef8` 2026-03-22 fix: cookie consent banner too wide on mobile devices — copilot-swe-agent[bot]
- `001b28a` 2026-03-22 Initial plan — copilot-swe-agent[bot]
- `13b3942` 2026-03-22 fix: move mobile drawer outside header to fix full-screen display and scroll issues — copilot-swe-agent[bot]
- `0492c5f` 2026-03-22 Initial plan — copilot-swe-agent[bot]
- `4de3690` 2026-03-22 fix: replace overflow:hidden with overflow:clip on .mobile-drawer to fix page scroll — copilot-swe-agent[bot]
- `bfd7e7f` 2026-03-22 Fix blocked page scrolling on mobile drawer — Laitei
- `2ee4ec1` 2026-03-22 Fix page scrolling and simplify mobile drawer — Laitei
- `1e0e458` 2026-05-02 Add live settings script to index.html — Laitei
- `9bc0e62` 2026-05-08 Remove live settings and Transifex script — Laitei
- `f19cfcd` 2026-05-08 New translations en.json (Mara) — Laitei
- `b936058` 2026-05-08 New translations en.json (Mara) — Laitei
- `6b07b8a` 2026-05-08 Update language mapping in crowdin.yml — Laitei
- `5f96373` 2026-05-09 New translations en.json (Mara) — Laitei
- `56a1a8b` 2026-05-08 Delete public/locales/mrh-MM.json — Laitei
- `50ea7e8` 2026-05-08 Delete public/locales/my-MM.json — Laitei
- `956a6ba` 2026-05-09 New translations en.json (Burmese) — Laitei
- `eec0995` 2026-05-09 New translations en.json (Burmese) — Laitei
- `fd5d5ef` 2026-05-08 Update issue templates — Laitei
- `85dbbec` 2026-05-09 New translations en.json (Burmese) — Laitei
- `b7677bf` 2026-05-09 New translations en.json (Burmese) (#23) — Laitei
- `f29bd50` 2026-05-14 New translations en.json (Burmese) (#24) — Laitei
- `9c311a8` 2026-05-14 Improved Localization system. — Laitei40
- `be0e790` 2026-05-14 i18n: add brand.name and clean locale files; use brand.name in header/meta — Laitei40
- `0f5362d` 2026-05-14 fix(locales): repair en.json syntax; add brand.name — Laitei40
- `218bf0c` 2026-05-14 Updated Localization. — Laitei40
- `8307ada` 2026-05-14 New Crowdin updates (#25) — Laitei
- `62e9c85` 2026-05-14 Updated redirects, and workers. — Laitei40
- `4eb2e1e` 2026-05-14 Updated redirects. — laitei40
- `148cae9` 2026-05-14 New Crowdin updates (#26) — Laitei
- `705e8aa` 2026-05-14 Updated routing. — laitei40
- `b4e5ff4` 2026-05-14 Bugs fixed. — laitei40
- `26ea520` 2026-05-14 Updated Route.json — laitei40
- `100b6a5` 2026-05-14 Fixed Bugs. — laitei40
- `f43a46a` 2026-05-14 Updated route system. — laitei40
- `3d003a2` 2026-05-14 Updated features. — laitei40
- `19317aa` 2026-05-14 New translations en.json (Burmese) (#27) — Laitei
- `a4d6dcd` 2026-05-14 Modify footer brand link for internationalization — Laitei
- `1abcf74` 2026-05-14 Updated features. — Laitei40
- `380e029` 2026-05-14 Addded schema.sql — Laitei40
- `9d57012` 2026-05-14 Fixed bug. — laitei40
- `83022a8` 2026-05-14 Updated route features. — laitei40
- `377f43e` 2026-05-14 Route updated. — laitei40
- `7711cff` 2026-05-14 Fixed bug. — laitei40
- `47a77c9` 2026-05-14 Fixed Artist, and Composer route. — laitei40
- `001f91e` 2026-05-14 Fixed bug. — laitei40
- `1619ef9` 2026-05-14 Rolled back. — laitei40
- `4f0d2c7` 2026-05-14 Functions folder liata ypazy panano. — laitei40
- `3013f11` 2026-05-14 Crowding data eima pathlai. — laitei40
- `80c1e0a` 2026-05-14 A parohpa eima so. — laitei40
- `0e5e5c0` 2026-05-14 Dateleted some data. — Laitei40
- `4737d3a` 2026-05-14 Added Clean data. — Laitei40
- `1da9e72` 2026-06-19 Added LICENSE file. — Laitei40
- `823f9e2` 2026-06-19 Updated README. — Laitei40
- `8d9317b` 2026-06-22 Add Transifex configuration for translations — Laitei
- `1122450` 2026-06-22 Update transifex.yml — Laitei
- `fdddcfa` 2026-07-04 Updated wrangler.toml — Laitei40
- `4353afb` 2026-07-04 Updated Admin Dashbard. — Laitei40
- `4632f45` 2026-07-04 Updated the admin page. — Laitei40
- `87cd82e` 2026-07-04 Moved Admin site out if the Public directory. — Laitei40
- `0693325` 2026-07-04 Deleted worker.js — Laitei40
- `9ba7710` 2026-07-04 Moved admin to public — Laitei40
- `d86c242` 2026-07-08 Add versioned REST API worker with admin auth, and safe D1 migrations — Laitei40
- `8dd751a` 2026-07-08 Modernize view page UI: fix broken copyright card, SVG icons, copy/share — Laitei40
- `5307ca0` 2026-07-08 Increase spacing above Go Home button in empty states — Laitei40
- `a3dedce` 2026-07-08 Further increase Go Home button spacing (previous bump was too subtle) — Laitei40
- `596959f` 2026-07-08 Update footer tagline to "Proudly Made in Maraland" — Laitei40
- `cac38d7` 2026-07-08 Replace footer Facebook link with Reddit community link — Laitei40
- `02d628e` 2026-07-08 Add "The Project" page: live stats and GitHub contributors — Laitei40
- `12842fe` 2026-07-08 Add professional SEO system: per-page metadata, sitemap, robots.txt — Laitei40
- `ac98afe` 2026-07-08 Proxy GitHub contributors through the worker instead of the browser — Laitei40
- `4d981de` 2026-07-08 Filter out bot accounts (e.g. GitHub Copilot) from contributors list — Laitei40
- `c7e3f02` 2026-07-08 Complete i18n coverage across the site (excluding actual content data) — Laitei40
- `e918d73` 2026-07-08 Optimize i18n architecture: dedupe strings into common.*, remove dead keys — Laitei40
- `7dbbdd0` 2026-07-08 Add incremental sync support to /version and /bootstrap — Laitei40
- `455a3b5` 2026-07-09 Fix contact/report forms sending on production domain — Laitei40
- `e56480f` 2026-07-09 Replace single shared ADMIN_TOKEN with a per-account role system — Laitei40
- `73f434c` 2026-07-09 Update local dev secrets and wrangler.toml docs for JWT_SECRET — Laitei40
- `fba0fa9` 2026-07-09 Support multiple artists/composers per song (up to 20 each) — Laitei40
- `8d8f266` 2026-07-09 Collapse multiple credited artists/composers into a "Various" popover — Laitei40
- `3d44d86` 2026-07-09 Bump service worker cache version to ship the credits popover JS — Laitei40
- `a61fa2c` 2026-07-09 Fix admin song search to run server-side across all songs — Laitei40
- `ed0754b` 2026-07-10 Replace native multi-select with checkbox lists for Artist/Composer — Laitei40
- `28a4816` 2026-07-10 Polish the artist/composer checkbox lists, add an "Unknown" option — Laitei40
- `a8deb14` 2026-07-10 Fix filter crash on the Unknown checkbox row — Laitei40
- `46ccd8f` 2026-07-11 Fix admin feedback modal padding and field layout — Laitei40
- `b44b78f` 2026-07-11 Overhaul admin roles into a 6-tier permission model with revisions and audit log — Laitei40
- `cfac46b` 2026-07-11 Add admin profile pages with follow/unfollow and self-service account management — Laitei40
- `c57e1f5` 2026-07-11 Consolidate header links into a Settings dropdown — Laitei40

</details>
