// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — "app mode" of the account page    │
// └───────────────────────────────────────────────┘
// The Android app signs a reader in through the phone's browser: it opens
//   https://maralyrics.com/account?app=android&state=<state>
// and, once the reader is signed in, the page offers a button that hands the session back to the app through an Android
// intent URL (the same kind the song page's "Open in the Mara Lyrics app" button uses). This file holds the pure parts —
// reading the address, cleaning it, building the intent URL — so they can be tested without a browser
// (scripts/check-account.mjs). public/account-page.js uses it; the package name and Play URL come from Utils (app.js).
//
//   AccountAppMode.parse(search)      → { state } when app=android and a well-formed state are present, otherwise null
//   AccountAppMode.cleanSearch(search) → the query string without app and state ('' or '?x=1'), for history.replaceState
//   AccountAppMode.intentUrl({ pkg, storeUrl, token, state }) → the intent URL, or '' when anything is missing or malformed
//
// The token and the state go only into the intent URL: never into an https:// URL, a query string, a hash or a log.
const AccountAppMode = (() => {
  'use strict';
  const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
  const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i;

  function parse(search) {
    const params = new URLSearchParams(search || '');
    const app = params.getAll('app');
    const state = params.getAll('state');
    // Exactly one of each (a repeated parameter is ambiguous), and the app must be exactly "android".
    if (app.length !== 1 || app[0] !== 'android' || state.length !== 1 || !STATE_RE.test(state[0])) return null;
    return { state: state[0] };
  }

  function cleanSearch(search) {
    const params = new URLSearchParams(search || '');
    params.delete('app');
    params.delete('state');
    const rest = params.toString();
    return rest ? `?${rest}` : '';
  }

  function intentUrl({ pkg, storeUrl, token, state } = {}) {
    if (typeof token !== 'string' || !token || typeof state !== 'string' || !STATE_RE.test(state)) return '';
    if (typeof pkg !== 'string' || !PACKAGE_RE.test(pkg) || typeof storeUrl !== 'string' || !storeUrl) return '';
    // Every value is encoded: a ';' or '=' inside one would otherwise end the intent's parameter early.
    return `intent://maralyrics.com/account/app-signin#Intent;scheme=https;package=${pkg};S.token=${encodeURIComponent(token)};S.state=${encodeURIComponent(state)};S.browser_fallback_url=${encodeURIComponent(storeUrl)};end`;
  }

  return { parse, cleanSearch, intentUrl };
})();
