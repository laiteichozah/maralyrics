#!/usr/bin/env node
// Checks for /app-auth, the stand-alone page the Android app opens to sign a reader in.   npm run test:appauth
//
//   • AccountAppMode (public/app-mode.js): reading ?state=, cleaning the address, building the intent URL
//   • the page (public/app-auth.html): no site header or menu, noindex, three cards, ONE button on the success card, no form on the
//     invalid card, and nothing it loads that would bring the site's chrome (app.js, theme.js, consent.js ...)
//   • the page's logic (public/app-auth.js), run against stand-ins for the document, the address and the sign-in code: a valid state
//     shows the sign-in card, a missing or invalid one the invalid card and no form, a session shows the success card, the tap builds
//     the intent URL as it should and puts the address back; nothing is stored, logged or put in an https:// address
//   • the service worker, the headers and the sitemap leave the page alone; /account is a normal page again
// The real browser run of the whole flow (Google, email + password, challenges, a phone screen) is in scripts/e2e-account.mjs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passes = 0;
let failures = 0;
const check = (cond, msg) => { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } };

const Mode = vm.runInNewContext(`${read('public/app-mode.js')}; AccountAppMode`, { URLSearchParams, encodeURIComponent });
const Page = vm.runInNewContext(`${read('public/app-auth.js')}; AppAuthPage`, {});   // no `document` here: the file only defines the page
const html = read('public/app-auth.html');

// ─── The address and the intent URL ──────────────────────────────────────────
console.log('App mode helpers');
const STATE = 'Ab3-_xYz9Qw0LmNp';          // 16 characters, the shortest allowed
const LONG_STATE = 'a'.repeat(128);
check(Mode.parse(`?state=${STATE}`)?.state === STATE, 'a well-formed state is read from the address');
check(Mode.parse(`?x=1&state=${LONG_STATE}&y=2`)?.state === LONG_STATE && Mode.parse(`?app=android&state=${STATE}`)?.state === STATE, '…with other parameters around it, up to 128 characters (an app= parameter is ignored)');
for (const [why, search] of [
  ['no parameters', ''], ['nothing at all', undefined], ['no state', '?app=android'], ['an empty state', '?state='],
  ['a state of 15 characters', `?state=${STATE.slice(1)}`], ['a state of 129 characters', `?state=${'a'.repeat(129)}`],
  ['a state with a dot', `?state=${STATE}.`], ['a state with a plus sign', `?state=${STATE.slice(1)}%2B`], ['a state with a space', `?state=${STATE.slice(1)}%20`],
  ['a state with a slash', `?state=${STATE.slice(1)}%2F`], ['a state with an equals sign', `?state=${STATE.slice(1)}%3D`],
  ['a repeated state', `?state=${STATE}&state=${STATE}`], ['a script in the state', '?state=%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
]) check(Mode.parse(search) === null, `it finds no state in ${why}`);
check(Mode.cleanSearch(`?state=${STATE}`) === '' && Mode.cleanSearch(`?verify=abc&state=${STATE}`) === '?verify=abc' && Mode.cleanSearch(`?state=${STATE}&x=1&app=android&y=two`) === '?x=1&y=two', 'cleaning the address takes out state (and app) and keeps every other parameter');

const appJs = read('public/app.js');
check(Mode.APP_PACKAGE === (/APP_PACKAGE: '([^']+)'/.exec(appJs) || [])[1] && Mode.APP_STORE_URL === (/APP_STORE_URL: '([^']+)'/.exec(appJs) || [])[1], 'the package name and Play address are the same two values as Utils.APP_PACKAGE / APP_STORE_URL (the song page\'s button)');
check(Mode.APP_PACKAGE === 'com.maralyrics.laitei' && Mode.APP_STORE_URL === 'https://play.google.com/store/apps/details?id=com.maralyrics.laitei', '…and they are the app\'s');
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.sig+/=;#?&é x';   // a token with every character that could break a URL
const expected = `intent://maralyrics.com/account/app-signin#Intent;scheme=https;package=com.maralyrics.laitei;S.token=${encodeURIComponent(TOKEN)};S.state=${STATE};S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.maralyrics.laitei;end`;
const intent = Mode.intentUrl({ token: TOKEN, state: STATE });
check(intent === expected, 'the intent URL is built exactly: package, token, state and the Play fallback, each encoded');
const extras = intent.split('#Intent;')[1].split(';');
check(extras.length === 6 && extras[5] === 'end' && extras[0] === 'scheme=https' && extras[1] === 'package=com.maralyrics.laitei', 'it has exactly the parts it should (nothing in the token can end a parameter early)');
check(decodeURIComponent(extras[2].slice('S.token='.length)) === TOKEN && decodeURIComponent(extras[3].slice('S.state='.length)) === STATE && decodeURIComponent(extras[4].slice('S.browser_fallback_url='.length)) === Mode.APP_STORE_URL, 'the app gets the token, the state and the fallback back exactly');
check(!/https?:\/\//i.test(intent) && intent.startsWith('intent://maralyrics.com/account/app-signin#Intent;'), 'the token and state are in no https:// address: the only URL is intent:// (the Play address is encoded)');
check(Mode.intentUrl({ token: 'abc.def.ghi', state: LONG_STATE }).includes(`S.state=${LONG_STATE};`), 'an ordinary token and the longest state go in as they are');
for (const [why, args] of [
  ['no token', { token: '' }], ['a token that is not text', { token: 12345 }], ['no state', { state: '' }], ['a state that is too short', { state: 'short' }],
  ['a state with a ;', { state: `${STATE};S.x=1` }], ['a package that could add parameters', { pkg: 'com.evil;S.token=x' }], ['no Play address', { storeUrl: '' }],
]) check(Mode.intentUrl({ token: 'abc.def.ghi', state: STATE, ...args }) === '', `no intent URL is made with ${why}`);

// ─── The page's HTML ─────────────────────────────────────────────────────────
console.log('The page');
const cardOf = (id) => { const m = new RegExp(`<section[^>]*id="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html); return m ? m[1] : ''; };
const invalid = cardOf('invalidCard'), signin = cardOf('signinCard'), success = cardOf('successCard');
check(/<meta name="robots" content="[^"]*noindex/.test(html), 'the page is marked noindex');
check((html.match(/<h1\b/g) || []).length === 1 && /<h1 class="aa-sr"/.test(html), 'the page has one heading for screen readers (each card has its own visible title)');
check(!/<(header|nav|footer|aside)\b/i.test(html) && !/class="[^"]*(header|footer|drawer|lang-switcher|menu|nav)[^"]*"/i.test(html), 'it has no site header, menu, footer or language bar');
check(['i18n.js', 'app-mode.js', 'account-auth.js', 'app-auth.js'].every((f) => html.includes(`/${f}`)), 'it loads the translations, the app hand-back, the shared sign-in code and its own script');
check(!['app.js', 'theme.js', 'consent.js', 'toast.js', 'photo-cropper.js', 'account-page.js', 'adsbygoogle'].some((f) => html.includes(f)), '…and none of the site\'s own scripts (so none of its calendar, promo or cookie dialogs, and no ads)');
check(/<link rel="stylesheet" href="\/app-auth\.css/.test(html) && !html.includes('/style.css') && !html.includes('/account.css'), 'its look is its own stylesheet, not the site\'s');
check(['invalidCard', 'signinCard', 'successCard'].every((id) => new RegExp(`<section[^>]*id="${id}"[^>]*\\bhidden\\b`).test(html)), 'all three cards start hidden (the script shows one)');
check(!/<(form|input|button|a|select|textarea)\b/i.test(invalid) && /isn't valid\. Open the Mara Lyrics app and tap Continue with Google to start again\./.test(invalid), 'the invalid card is only the sentence: no form, no field, no button, no link');
check((success.match(/<(a|button)\b/gi) || []).length === 1 && /<a [^>]*id="returnBtn"/.test(success) && !/<(form|input|button)\b/i.test(success), 'the success card has exactly one button: the "Return to the app" link');
check(/<a [^>]*id="returnBtn" href="#"/.test(success), 'which holds no address until it is tapped');
check(/<form[^>]*id="signinForm"/.test(signin) && !/<form/i.test(invalid + success) && (html.match(/<form\b/g) || []).length === 1, 'the only form on the page is the sign-in form, inside the sign-in card');
check(['signinForm', 'signinUser', 'signinPass', 'signinTurnstile', 'signinMsg', 'signinBtn', 'googleBlock', 'googleBtn', 'googleChallenge', 'googleTurnstile'].every((id) => signin.includes(`id="${id}"`)), 'the sign-in card has the elements the shared sign-in code works on');
check(/<a href="\/account"[^>]*>Create an account<\/a>/.test(signin), 'and a small "New here? Create an account" link to /account');
check(/<svg[^>]*class="aa-check"[\s\S]*#00bfa5/.test(success) && /<h2[^>]*>Login successful<\/h2>/.test(success) && /You're signed in\. Return to the Mara Lyrics app to finish signing in there\./.test(success) && />Return to the app</.test(success), 'the success card has the teal check, "Login successful", the sentence and "Return to the app"');
check(/id="returnHint"[^>]*\bhidden\b[^>]*>Nothing happened\? Make sure the Mara Lyrics app is installed and up to date\./.test(success), '"Nothing happened?" waits, hidden, until the button has been tapped');
const css = read('public/app-auth.css');
for (const [what, re] of [
  ['the page background #0c143d', /background: #0c143d/], ['the card #222c59, 14px radius, 40px padding', /\.aa-card \{[^}]*padding: 40px;[^}]*background: #222c59;[^}]*border-radius: 14px/s],
  ['the card width min(576px, 100% - 32px)', /width: min\(576px, calc\(100% - 32px\)\)/], ['the 112px logo circle on #151e47', /\.aa-logo \{[^}]*width: 112px;[^}]*background: #151e47/s],
  ['the logo 44px from the top and the card 28px below it', /padding: 44px 0 48px/], ['…and', /\.aa-card \{[^}]*margin-top: 28px/s],
  ['the text colour #e1e2e8, 17px / 32px', /\.aa-text \{[^}]*font-size: 17px;[^}]*line-height: 32px; color: #e1e2e8/], ['the title: uppercase, bold, 26px, letter-spacing .5px', /font-size: 26px;[^}]*letter-spacing: 0\.5px;[^}]*text-transform: uppercase/s],
  ['the 240 × 48 button on #0c143d with white 13px uppercase text', /\.aa-btn \{[^}]*width: 240px;[^}]*height: 48px;[^}]*border-radius: 4px;[^}]*background: #0c143d;[^}]*color: #ffffff;[^}]*font-size: 13px;[^}]*text-transform: uppercase/s],
  ['32px between the text and the button', /\.aa-btn \{[^}]*margin-top: 32px/s], ['a full-width button on narrow phones', /@media \(max-width: 480px\)[\s\S]*\.aa-btn \{ width: 100%; \}/],
  ['the teal #00bfa5 check', /#00bfa5/], ['dark only', /color-scheme: dark/], ['the site\'s font stack', /font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif/],
]) check(re.test(css), `the stylesheet has ${what}`);
check(read('public/style.css').includes("--font-sans: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;"), '(that font stack is the site\'s --font-sans)');

// ─── The page's logic, against stand-ins ─────────────────────────────────────
console.log('The page\'s logic');
const hiddenAtStart = new Set([...html.matchAll(/<[a-z0-9]+\b[^>]*\bid="([^"]+)"[^>]*>/gi)].filter((m) => /\bhidden\b/.test(m[0])).map((m) => m[1]));
function world({ search, token = '', meStatus = 200, config = { google_client_id: 'gid' }, failSet = false }) {
  const els = {};
  const el = (id) => els[id] || (els[id] = {
    id, hidden: hiddenAtStart.has(id), attrs: { href: id === 'returnBtn' ? '#' : undefined }, handlers: {},
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    click() { const ev = { currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; for (const fn of this.handlers.click || []) fn(ev); return ev; },
  });
  const w = { storage: new Map(token ? [['ml_account_token', token]] : []), replaced: [], timers: [], calls: [], logs: [], googleStart: null, bound: 0 };
  const auth = {
    getToken: () => w.storage.get('ml_account_token') || '',
    async api(method, p, body, tok) {
      w.calls.push(`${method} ${p}`);
      if (p === '/me') { if (meStatus === 200) return { account: {} }; const e = new Error('Unauthorized'); e.status = meStatus; throw e; }
      if (p === '/config') { if (!config) throw new Error('down'); return config; }
      throw new Error(`unexpected ${p}`);
    },
    bindSignin() { w.bound++; },
    google: { start(id, opts) { w.googleStart = { id, opts }; } },
    googleSignIn() {},
  };
  const env = {
    $: el, mode: Mode, auth,
    storage: { getItem: (k) => w.storage.get(k) ?? null, setItem: (k, v) => { if (failSet) throw new Error('private mode'); w.storage.set(k, v); }, removeItem: (k) => w.storage.delete(k) },
    location: { pathname: '/app-auth', search, hash: '' },
    history: { replaceState: (a, b, url) => w.replaced.push(url) },
    later: (fn, ms) => w.timers.push({ fn, ms }),
    ready: async () => {},
  };
  const page = Page.create(env);
  const visible = () => ['invalidCard', 'signinCard', 'successCard'].filter((id) => !el(id).hidden);
  return { w, el, page, visible };
}

let T = world({ search: `?state=${STATE}` });
await T.page.start();
check(T.visible().join() === 'signinCard', 'a valid state and no session: the sign-in card shows, and only that');
check(T.w.replaced.join() === '/app-auth' && T.w.bound === 1, 'the state is taken out of the address bar at once, and the sign-in form is wired');
check(T.w.googleStart && T.w.googleStart.id === 'gid' && T.el('googleBlock').hidden === false && T.w.googleStart.opts.buttons[0][0] === 'googleBtn', 'the Google button is started with the server\'s client id (and its block shown)');
check(!T.w.calls.includes('GET /me'), '(no session was checked: there was none)');

T = world({ search: `?state=${STATE}`, config: null });
await T.page.start();
check(T.visible().join() === 'signinCard' && T.el('googleBlock').hidden === true, 'if the server\'s settings cannot be read the sign-in card still works, without Google');

T = world({ search: `?x=1&state=${STATE}` });
await T.page.start();
check(T.w.replaced.join() === '/app-auth?x=1', 'other parameters stay in the address bar');

for (const [why, search] of [['no state', ''], ['no parameters but app=android', '?app=android'], ['a state that is too short', '?state=short'], ['a repeated state', `?state=${STATE}&state=${STATE}`], ['a state with forbidden characters', `?state=${STATE}.x`]]) {
  T = world({ search, token: 'a.b.c' });
  await T.page.start();
  check(T.visible().join() === 'invalidCard' && T.el('signinCard').hidden && T.el('successCard').hidden, `${why}: only the invalid card shows (the form is hidden)`);
  check(T.w.bound === 0 && !T.w.googleStart && T.w.calls.length === 0 && T.w.replaced.length === 0, `${why}: no form is wired, no Google, no call to the server, the address is left alone`);
}

T = world({ search: `?state=${STATE}`, token: 'abc.def.ghi' });
await T.page.start();
check(T.visible().join() === 'successCard' && T.w.calls.join() === 'GET /me' && T.w.bound === 0, 'a valid state with a session the browser already holds: the success card shows straight away (after one check of the session)');
check(T.el('returnBtn').getAttribute('href') === '#' && T.el('returnHint').hidden === true, 'before the tap the button holds no address and the hint is hidden');
let ev = T.el('returnBtn').click();
check(!ev.defaultPrevented && T.el('returnBtn').getAttribute('href') === Mode.intentUrl({ token: 'abc.def.ghi', state: STATE }) && T.el('returnBtn').getAttribute('href').startsWith('intent://maralyrics.com/account/app-signin#Intent;scheme=https;package=com.maralyrics.laitei;S.token=abc.def.ghi;S.state='), 'the tap puts the intent URL on the link (token = the session, state = the page\'s) and lets the browser follow it');
check(T.el('returnHint').hidden === false, '"Nothing happened?" shows after the tap');
check(T.w.timers.length === 1 && T.w.timers[0].ms >= 1000 && T.w.timers[0].ms <= 3000, 'a timer is set to take the address off the link again');
T.w.timers[0].fn();
check(T.el('returnBtn').getAttribute('href') === '#', '…and it does: the token is not left in the page');
T.w.storage.set('ml_account_token', 'new.session.token');
ev = T.el('returnBtn').click();
check(T.el('returnBtn').getAttribute('href') === Mode.intentUrl({ token: 'new.session.token', state: STATE }), 'a second tap uses the session as it is by then');
T.w.storage.delete('ml_account_token');
T.el('returnBtn').attrs.href = '#';
ev = T.el('returnBtn').click();
check(ev.defaultPrevented && T.el('returnBtn').getAttribute('href') === '#', 'with no session left the tap does nothing (it is cancelled, not sent to a bad address)');

T = world({ search: `?state=${STATE}`, token: 'old.expired.token', meStatus: 401 });
await T.page.start();
check(T.visible().join() === 'signinCard' && !T.w.storage.has('ml_account_token') && T.w.bound === 1, 'a session the server no longer accepts is dropped, and the sign-in card shows');

T = world({ search: `?state=${STATE}`, token: 'abc.def.ghi', meStatus: 503 });
await T.page.start();
check(T.visible().join() === 'signinCard' && T.w.storage.has('ml_account_token'), 'if the server cannot be reached the sign-in card shows and the saved session is kept');

T = world({ search: `?state=${STATE}` });
await T.page.start();
await T.page.signedIn({ token: 'fresh.token.value', account: {} });
check(T.visible().join() === 'successCard' && T.w.storage.get('ml_account_token') === 'fresh.token.value', 'after a sign-in (password or Google) the success card replaces the form and the session is kept by the browser');
T.el('returnBtn').click();
check(T.el('returnBtn').getAttribute('href') === Mode.intentUrl({ token: 'fresh.token.value', state: STATE }), '…and the tap hands back that session');
const keepNothing = world({ search: `?state=${STATE}`, failSet: true });
await keepNothing.page.start();
await keepNothing.page.signedIn({ token: 'kept.in.memory', account: {} });
keepNothing.el('returnBtn').click();
check(keepNothing.visible().join() === 'successCard' && keepNothing.el('returnBtn').getAttribute('href') === Mode.intentUrl({ token: 'kept.in.memory', state: STATE }), 'a browser that will not keep the session still shows the success card and hands the session back (the page holds it for the tap)');
check(Page.viewFor({ parsed: null, hasSession: true }) === 'invalid' && Page.viewFor({ parsed: { state: STATE }, hasSession: false }) === 'signin' && Page.viewFor({ parsed: { state: STATE }, hasSession: true }) === 'success', 'viewFor: invalid beats everything, then a session means success');

// ─── The code never stores, sends or logs the token or the state ─────────────
console.log('Where the token and the state go');
const codeLines = (src) => src.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
const files = { 'app-auth.js': read('public/app-auth.js'), 'app-mode.js': read('public/app-mode.js'), 'account-auth.js': read('public/account-auth.js') };
check(Object.values(files).every((src) => !codeLines(src).some((l) => /console\./.test(l))), 'no file logs anything');
check(Object.values(files).every((src) => !codeLines(src).filter((l) => /https?:\/\//.test(l)).some((l) => /token|state/i.test(l.replace(/\bapiBase\b/g, '')))), 'no line that builds an https:// address mentions the token or the state');
check(!codeLines(files['app-auth.js']).filter((l) => /\bstate\b/.test(l)).some((l) => /localStorage|sessionStorage|storage\.|fetch\(|api\(|document\.cookie|location\.(href|assign|replace)|postMessage|navigator\./i.test(l)), 'the state is kept in the one variable: never stored, sent or put in an address');
check(!codeLines(files['app-auth.js']).some((l) => /location\.(href|assign|replace)\s*[=(]|window\.open|\.click\(\)/.test(l)), 'nothing navigates by itself: the page only sets the address of a link that the person taps');
check(!/package=/.test(files['app-auth.js']) && /APP_PACKAGE = 'com\.maralyrics\.laitei'/.test(files['app-mode.js']), 'the package name is hard-coded in app-mode.js and never read from the address');
check(/AccountAppMode\.parse|mode\.parse/.test(files['app-auth.js']) && /mode\.intentUrl/.test(files['app-auth.js']), 'the page reads the address with AccountAppMode.parse and builds the link with AccountAppMode.intentUrl');
check(!/appMode|appState|AccountAppMode|app-mode/.test(read('public/account-page.js')) && !/appReturn|app-mode/.test(read('public/account.html')) && !/app-return/.test(read('public/account.css')), '/account is a normal page again: no app mode panel, code or style');
const en = JSON.parse(read('public/locales/en.json'));
check(!Object.keys(en.account).some((k) => /^app_/.test(k)), '…and none of its texts');
check(['title_signin', 'invalid', 'success_title', 'success_text', 'return_btn', 'return_hint', 'create_account', 'or_email', 'email_or_username', 'password', 'signin_btn', 'new_here', 'google_challenge'].every((k) => typeof en.app_auth[k] === 'string'), 'the page\'s texts are under app_auth.* in en.json (my and mrh use the English until they are translated)');
const keysUsed = [...html.matchAll(/data-i18n="app_auth\.([a-z_]+)"/g)].map((m) => m[1]);
check(keysUsed.length >= 12 && keysUsed.every((k) => en.app_auth[k]), `every text on the page has its key (${keysUsed.length} used)`);

// ─── The service worker, headers and sitemap leave the page alone ────────────
console.log('Not cached, not indexed');
const listeners = {};
const sandbox = {
  self: { addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim() {} } },
  caches: { open: async () => ({ put: async () => {}, match: async () => undefined, addAll: async () => {} }), match: async () => undefined, keys: async () => [], delete: async () => true },
  fetch: async () => new Response('ok', { status: 200 }), Response, URL, console,
};
vm.runInNewContext(read('public/sw.js'), sandbox);
const intercepts = async (url, headers = {}) => {
  let answered = null;
  const request = { method: 'GET', url, headers: { has: (n) => Object.keys(headers).some((k) => k.toLowerCase() === n.toLowerCase()), get: (n) => headers[n] || null }, mode: 'navigate' };
  listeners.fetch({ request, respondWith: (p) => { answered = p; } });
  if (answered) await answered;
  return !!answered;
};
check(await intercepts('https://maralyrics.com/about') === true, '(the service worker still serves the other pages)');
check(await intercepts('https://maralyrics.com/app-auth') === false && await intercepts('https://maralyrics.com/app-auth.html') === false, 'the service worker does not touch the page (so it never keeps a copy)');
check(await intercepts('https://api.maralyrics.com/api/v1/account/config') === false && await intercepts('https://api.maralyrics.com/api/v1/account/me', { Authorization: 'Bearer t' }) === false, '…nor the account answers the page asks for');
const swSrc = read('public/sw.js');
check(Number(/ml-v(\d+)/.exec(swSrc)[1]) >= 47, 'the cache version was bumped, so the old worker\'s copies of the scripts are replaced');
check(!/app-auth/.test(read('functions/sitemap.xml.js')), 'the page is not in the sitemap');
const headers = read('public/_headers');
check(/\/app-auth\n\s+Cache-Control: no-store\n\s+X-Robots-Tag: noindex, nofollow\n\s+Referrer-Policy: no-referrer/.test(headers), 'the page is served no-store, noindex and without a referrer');

console.log(failures ? `\n✗ ${failures} failed, ${passes} passed` : `\n✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
