// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — handing a sign-in back to the app │
// └───────────────────────────────────────────────┘
// The Android app signs a reader in through the phone's browser: it opens
//   https://maralyrics.com/app-auth?state=<state>
// (public/app-auth.html), and once the reader is signed in that page offers a button that hands the session back to the app
// through an Android intent URL (the same kind the song page's "Open in the Mara Lyrics app" button uses). This file holds the
// pure parts — reading the address, cleaning it, building the intent URL — so they can be tested without a browser
// (scripts/check-app-auth.mjs). public/app-auth.js uses it. The page does not load app.js, so the app's package name and Play
// address are kept here too; they are the same two values as Utils.APP_PACKAGE / Utils.APP_STORE_URL in app.js (the song page's
// button), and a test keeps the two in step.
//
//   AccountAppMode.parse(search)       → { state } when the address has exactly one well-formed state, otherwise null
//   AccountAppMode.cleanSearch(search) → the query string without state (and app), '' or '?x=1', for history.replaceState
//   AccountAppMode.intentUrl({ token, state }) → the intent URL, or '' when anything is missing or malformed
//
// The token and the state go only into the intent URL: never into an https:// URL, a query string, a hash or a log. The package
// name is hard-coded below and never read from the address.
const AccountAppMode = (() => {
  'use strict';
  const APP_PACKAGE = 'com.maralyrics.laitei';
  const APP_STORE_URL = 'https://play.google.com/store/apps/details?id=com.maralyrics.laitei';
  const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
  const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i;

  function parse(search) {
    const state = new URLSearchParams(search || '').getAll('state');
    // Exactly one state (a repeated parameter is ambiguous), and a well-formed one.
    if (state.length !== 1 || !STATE_RE.test(state[0])) return null;
    return { state: state[0] };
  }

  function cleanSearch(search) {
    const params = new URLSearchParams(search || '');
    params.delete('state');
    params.delete('app');
    const rest = params.toString();
    return rest ? `?${rest}` : '';
  }

  // `pkg` and `storeUrl` are only there for tests; the page always uses the two values above.
  function intentUrl({ token, state, pkg = APP_PACKAGE, storeUrl = APP_STORE_URL } = {}) {
    if (typeof token !== 'string' || !token || typeof state !== 'string' || !STATE_RE.test(state)) return '';
    if (typeof pkg !== 'string' || !PACKAGE_RE.test(pkg) || typeof storeUrl !== 'string' || !storeUrl) return '';
    // Every value is encoded: a ';' or '=' inside one would otherwise end the intent's parameter early.
    return `intent://maralyrics.com/account/app-signin#Intent;scheme=https;package=${pkg};S.token=${encodeURIComponent(token)};S.state=${encodeURIComponent(state)};S.browser_fallback_url=${encodeURIComponent(storeUrl)};end`;
  }

  return { parse, cleanSearch, intentUrl, APP_PACKAGE, APP_STORE_URL };
})();
