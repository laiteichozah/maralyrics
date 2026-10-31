// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — /app-auth, the Android app's sign-in │
// └───────────────────────────────────────────────┘
// The page the Android app opens in the phone's browser when the reader taps "Continue with Google":
//   https://maralyrics.com/app-auth?state=<state>
// One card at a time: "invalid" (no usable state), "signin" (Google or email + password) or "success" (a button that hands the
// session back to the app). It does not load app.js, so none of the site's header, menu, calendar or promo dialogs come with it.
// The sign-in parts are the ones /account uses (account-auth.js); reading the address and building the intent URL are in
// app-mode.js. The state is kept in a variable only (and taken out of the address bar at once); the session token and the state
// go only into the intent URL, built at the moment of the tap: never into an https address, a hash, a log or analytics.
//
// AppAuthPage.create(env).start() does the work; env holds everything it touches (document, address, storage, the shared sign-in
// object), so scripts/check-app-auth.mjs can run it against stand-ins. In a browser the last lines start it.
const AppAuthPage = (() => {
  'use strict';
  const API_BASE = 'https://api.maralyrics.com/api/v1/account'; // the same Worker as WORKER_ORIGIN in app.js
  const TOKEN_KEY = 'ml_account_token';                         // the session, shared with the site (Sync.TOKEN_KEY in app.js)
  const HREF_RESET_MS = 1500;

  /** Which card to show. */
  function viewFor({ parsed, hasSession }) {
    if (!parsed) return 'invalid';
    return hasSession ? 'success' : 'signin';
  }

  function create(env) {
    const { $, mode, auth, storage } = env;
    let state = '';         // the app's state: in this variable only
    let session = '';       // the token of a sign-in made here (a fallback when the browser will not keep it)

    function show(view) {
      for (const name of ['invalid', 'signin', 'success']) $(`${name}Card`).hidden = name !== view;
    }

    // A real link, and a real tap follows it (Chrome ignores intent: links that were not tapped). The address is made now, from the
    // session as it is now, and put back to '#' a moment later so the token is not left sitting in the page.
    function tap(e) {
      const link = e.currentTarget;
      const url = mode.intentUrl({ token: auth.getToken() || session, state });
      if (!url) { e.preventDefault(); return; }
      link.setAttribute('href', url);
      $('returnHint').hidden = false;
      env.later(() => link.setAttribute('href', '#'), HREF_RESET_MS);
    }

    /** Called by the shared sign-in code after any successful sign-in (password or Google). */
    async function signedIn(data) {
      session = data.token;
      try { storage.setItem(TOKEN_KEY, data.token); } catch { /* the browser will not keep it: the tap uses the copy above */ }
      show('success');
    }

    async function start() {
      await env.ready();
      const parsed = mode.parse(env.location.search);
      if (!parsed) { show(viewFor({ parsed: null })); return; }
      state = parsed.state;
      env.history.replaceState(null, '', `${env.location.pathname}${mode.cleanSearch(env.location.search)}${env.location.hash}`);
      $('returnBtn').addEventListener('click', tap);

      // A session the browser already holds (the reader is signed in on the site): check it, then go straight to the success card.
      let hasSession = false;
      if (auth.getToken()) {
        try { await auth.api('GET', '/me'); hasSession = true; } catch (err) { if (err.status === 401) storage.removeItem(TOKEN_KEY); }
      }
      show(viewFor({ parsed, hasSession }));
      if (hasSession) return;

      auth.bindSignin();
      try {
        const cfg = await auth.api('GET', '/config', undefined, '');
        if (cfg.google_client_id) {
          $('googleBlock').hidden = false;
          auth.google.start(cfg.google_client_id, { buttons: [['googleBtn', 'continue_with']], onCredential: (response) => auth.googleSignIn(response) });
        }
      } catch { /* the page still works with email + password */ }
    }

    return { start, signedIn };
  }

  return { create, viewFor, API_BASE, TOKEN_KEY };
})();

// In the browser: start. (The first line stops this file from doing anything when it is loaded by the tests.)
if (typeof document !== 'undefined' && document.getElementById('appAuthPage')) {
  let page;
  const auth = AccountAuth.create({
    apiBase: AppAuthPage.API_BASE,
    tokenKey: AppAuthPage.TOKEN_KEY,
    t: (key, vars) => I18n.t(key, vars),
    onSignedIn: (data) => page.signedIn(data),
  });
  let storage;
  try { storage = window.localStorage; storage.getItem(AppAuthPage.TOKEN_KEY); } catch { storage = { getItem: () => null, setItem() {}, removeItem() {} }; }
  page = AppAuthPage.create({
    $: (id) => document.getElementById(id),
    mode: AccountAppMode,
    auth,
    storage,
    location,
    history,
    later: (fn, ms) => setTimeout(fn, ms),
    ready: () => I18n.init().catch(() => {}),
  });
  page.start();
}
