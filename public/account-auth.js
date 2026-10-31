// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — sign-in parts shared by pages     │
// └───────────────────────────────────────────────┘
// The pieces of signing in that the account page (/account, public/account-page.js) and the stand-alone page the Android app
// opens (/app-auth, public/app-auth.js) both need, so neither copies them:
//   • the account API call, with the plain error messages the server gives
//   • Cloudflare Turnstile widgets (rendered explicitly, one per box, removed and reset by id)
//   • small helpers for a form's message line and its busy button
//   • Google sign-in (Google Identity Services): load the script, draw the buttons, send the credential
//   • the email + password sign-in form and the Google sign-in with its Cloudflare challenge for a NEW account
// It needs nothing from app.js (the /app-auth page does not load it): the page passes in the API address, the key the session
// is kept under, the translate function and what to do once somebody is signed in.
//
//   const auth = AccountAuth.create({ apiBase, tokenKey, t, onSignedIn(data, { via }) });
//   auth.bindSignin();                                   // wires #signinForm (the elements it uses are listed there)
//   auth.google.start(clientId, { buttons, onCredential }); auth.google.render();
const AccountAuth = (() => {
  'use strict';
  const TURNSTILE_SITEKEY = '0x4AAAAAABjildkegfR6T0sd'; // same public site key as the feedback forms

  function create({ apiBase, tokenKey, t, onSignedIn }) {
    const $ = (id) => document.getElementById(id);
    const getToken = () => { try { return localStorage.getItem(tokenKey) || ''; } catch { return ''; } };

    async function api(method, path, body, token = getToken()) {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const err = new Error(data.error || t('common.err_generic')); err.status = res.status; err.code = data.code; throw err; }
      return data;
    }

    // ── Cloudflare Turnstile (rendered explicitly, once per form) ──
    const widgets = {};
    function renderTurnstile(boxId, tries = 0, extra = {}) {
      if (widgets[boxId] !== undefined) return;
      if (!window.turnstile) { if (tries < 40) setTimeout(() => renderTurnstile(boxId, tries + 1, extra), 250); return; }
      widgets[boxId] = window.turnstile.render(`#${boxId}`, { sitekey: TURNSTILE_SITEKEY, theme: 'auto', ...extra });
    }
    function removeTurnstile(boxId) {
      if (widgets[boxId] !== undefined && window.turnstile) { try { window.turnstile.remove(widgets[boxId]); } catch { /* already gone */ } }
      delete widgets[boxId];
    }
    const turnstileToken = (boxId) => (widgets[boxId] !== undefined && window.turnstile ? window.turnstile.getResponse(widgets[boxId]) : '') || '';
    const turnstileReset = (boxId) => { if (widgets[boxId] !== undefined && window.turnstile) window.turnstile.reset(widgets[boxId]); };

    function say(id, text, ok = false) {
      const el = $(id);
      el.textContent = text || '';
      el.hidden = !text;
      el.className = `acct-message${ok ? ' acct-message--ok' : ''}`;
    }
    async function busy(btn, fn) {
      btn.disabled = true;
      try { return await fn(); } finally { btn.disabled = false; }
    }

    // ── Google (Google Identity Services; only loaded when the server has a client id) ──
    // One callback serves every Google button on the page. `buttons` lists the boxes to draw them in: [[boxId, text], ...].
    const google = (() => {
      let started = false;
      let setup = null;
      function load(tries = 0) {
        if (!window.google || !window.google.accounts) {
          if (tries === 0) {
            const tag = document.createElement('script');
            tag.src = 'https://accounts.google.com/gsi/client';
            tag.async = true;
            document.head.appendChild(tag);
          }
          if (tries < 40) setTimeout(() => load(tries + 1), 250);
          return;
        }
        window.google.accounts.id.initialize({ client_id: setup.clientId, callback: setup.onCredential, use_fedcm_for_prompt: true });
        render();
      }
      function render() {
        if (!setup || !window.google || !window.google.accounts) return;
        const draw = (id, text) => {
          const box = $(id);
          if (!box || box.dataset.drawn || !box.offsetParent) return; // draw once, and only when it can be seen (so its width is known)
          box.dataset.drawn = '1';
          window.google.accounts.id.renderButton(box, { type: 'standard', theme: 'outline', size: 'large', shape: 'rectangular', text, logo_alignment: 'left', width: Math.min(320, box.parentElement.clientWidth || 300) });
        };
        for (const [id, text] of setup.buttons) draw(id, text);
      }
      function start(clientId, options) {
        if (started || !clientId) return;
        started = true;
        setup = { clientId, buttons: options.buttons, onCredential: options.onCredential };
        load();
      }
      return { start, render };
    })();

    /** Signs in with a Google credential. A NEW account needs the Cloudflare challenge first; solving it sends the same sign-in again. */
    async function googleSignIn(response, challengeToken = '') {
      say('signinMsg', '');
      if ($('regMsg')) say('regMsg', '');
      try {
        const data = await api('POST', '/google', { credential: response.credential, turnstile_token: challengeToken }, '');
        $('googleChallenge').hidden = true;
        removeTurnstile('googleTurnstile');
        await onSignedIn(data, { via: 'google' });
      } catch (err) {
        if (err.code === 'challenge_required') {
          $('googleChallenge').hidden = false;
          removeTurnstile('googleTurnstile');
          renderTurnstile('googleTurnstile', 0, { callback: (tok) => googleSignIn(response, tok) });
          return;
        }
        const registering = $('registerForm') && !$('registerForm').hidden;
        say(registering ? 'regMsg' : 'signinMsg', err.message);
      }
    }

    /** Email + password. Uses #signinForm, #signinUser, #signinPass, #signinTurnstile, #signinMsg and #signinBtn. */
    function bindSignin() {
      $('signinForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        say('signinMsg', '');
        await busy($('signinBtn'), async () => {
          try {
            await onSignedIn(await api('POST', '/login', { identifier: $('signinUser').value, password: $('signinPass').value, turnstile_token: turnstileToken('signinTurnstile') }, ''), { via: 'password' });
            $('signinPass').value = '';
            removeTurnstile('signinTurnstile');
          } catch (err) {
            say('signinMsg', err.message);
            // After a couple of wrong passwords the server wants a Cloudflare challenge too: show it, and use a fresh one each time.
            if (err.code === 'challenge_required') { renderTurnstile('signinTurnstile'); turnstileReset('signinTurnstile'); }
          }
        });
      });
    }

    return { api, getToken, say, busy, renderTurnstile, removeTurnstile, turnstileToken, turnstileReset, google, googleSignIn, bindSignin };
  }

  return { create, TURNSTILE_SITEKEY };
})();
