// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — Account page (/account)          │
// └───────────────────────────────────────────────┘
// Sign in / create an account (Google, or email + password) to keep favorites, pins, downloads and preferences in step
// on every device, and see how the sync is doing. Talks to /api/v1/account (worker/routes/account.js); the syncing itself
// is the Sync module in app.js. It is the same account the "For Artists" page uses. Loaded after app.js.
(() => {
  'use strict';
  if (!document.getElementById('syncPage')) return;

  const API = `${CONFIG.API_BASE}/account`;
  const TURNSTILE_SITEKEY = '0x4AAAAAABjildkegfR6T0sd'; // same public site key as the feedback forms
  const $ = (id) => document.getElementById(id);
  const t = (key, vars) => I18n.t(key, vars);

  let account = null;
  let cfg = { google_client_id: null, email_enabled: false };

  async function api(method, path, body, token = Sync.token()) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || t('common.err_generic')); err.status = res.status; throw err; }
    return data;
  }

  // ── Cloudflare Turnstile (rendered explicitly, once per form) ──
  const widgets = {};
  function renderTurnstile(boxId, tries = 0) {
    if (widgets[boxId] !== undefined) return;
    if (!window.turnstile) { if (tries < 40) setTimeout(() => renderTurnstile(boxId, tries + 1), 250); return; }
    widgets[boxId] = window.turnstile.render(`#${boxId}`, { sitekey: TURNSTILE_SITEKEY, theme: 'dark' });
  }
  const turnstileToken = (boxId) => (widgets[boxId] !== undefined && window.turnstile ? window.turnstile.getResponse(widgets[boxId]) : '') || '';
  const turnstileReset = (boxId) => { if (widgets[boxId] !== undefined && window.turnstile) window.turnstile.reset(widgets[boxId]); };

  function say(id, text, ok = false) {
    const el = $(id);
    el.textContent = text || '';
    el.hidden = !text;
    el.className = `acct-message${ok ? ' acct-message--ok' : ''}`;
  }
  const notice = (text, ok = true) => say('pageNotice', text, ok);
  async function busy(btn, fn) {
    btn.disabled = true;
    try { return await fn(); } finally { btn.disabled = false; }
  }

  // ── Signed out ──────────────────────────────────
  let googleStarted = false;
  function showAuth(view = 'tabs') {
    $('syncAuth').hidden = false;
    $('syncHome').hidden = true;
    $('forgotLink').hidden = !cfg.email_enabled;
    showAuthView(view);
    if (!googleStarted && cfg.google_client_id) { googleStarted = true; loadGoogle(); }
  }

  function selectAuthTab(which) {
    const reg = which === 'register';
    $('signinForm').hidden = reg;
    $('registerForm').hidden = !reg;
    $('switchToRegister').hidden = reg;
    $('switchToSignin').hidden = !reg;
    $('authTitle').textContent = t(reg ? 'account.auth_register_title' : 'account_sync.signin_title');
    if (reg) renderTurnstile('regTurnstile');
  }

  /** 'tabs' = sign in / create account, 'forgot' = ask for a reset link, 'reset' = arrived from the emailed link. */
  function showAuthView(view) {
    $('authTabsBox').hidden = view !== 'tabs';
    $('forgotForm').hidden = view !== 'forgot';
    $('resetForm').hidden = view !== 'reset';
    $('googleBlock').hidden = view !== 'tabs' || !cfg.google_client_id;
    $('syncAbout').hidden = view !== 'tabs';
    if (view === 'forgot') renderTurnstile('forgotTurnstile');
  }

  async function enter(data) {
    localStorage.setItem(Sync.TOKEN_KEY, data.token);
    await showHome();
  }

  $('tabSignin').addEventListener('click', () => selectAuthTab('signin'));
  $('tabRegister').addEventListener('click', () => selectAuthTab('register'));

  $('signinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('signinMsg', '');
    await busy($('signinBtn'), async () => {
      try {
        await enter(await api('POST', '/login', { identifier: $('signinUser').value, password: $('signinPass').value }, ''));
        $('signinPass').value = '';
      } catch (err) { say('signinMsg', err.message); }
    });
  });

  $('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('regMsg', '');
    const ts = turnstileToken('regTurnstile');
    if (!ts) { say('regMsg', t('feedback.err_turnstile')); return; }
    await busy($('regBtn'), async () => {
      try {
        const data = await api('POST', '/register', { email: $('regEmail').value, password: $('regPass').value, reader: true, page: 'account', turnstile_token: ts }, '');
        $('regPass').value = '';
        await enter(data);
        if (data.verification === 'sent') notice(t('account.verify_sent', { email: data.account.contact_email }));
        else if (data.verification === 'failed') notice(t('account.verify_failed'), false);
      } catch (err) { say('regMsg', err.message); turnstileReset('regTurnstile'); }
    });
  });

  // ── Forgot / reset password (the emailed link brings people back with ?reset=…) ──
  $('forgotLink').addEventListener('click', () => { say('forgotMsg', ''); $('forgotEmail').value = $('signinUser').value.includes('@') ? $('signinUser').value : ''; showAuthView('forgot'); });
  $('forgotBack').addEventListener('click', () => showAuthView('tabs'));
  $('forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('forgotMsg', '');
    const ts = turnstileToken('forgotTurnstile');
    if (!ts) { say('forgotMsg', t('feedback.err_turnstile')); return; }
    await busy($('forgotBtn'), async () => {
      try {
        await api('POST', '/forgot-password', { email: $('forgotEmail').value, page: 'account', turnstile_token: ts }, '');
        say('forgotMsg', t('account.forgot_done'), true);
      } catch (err) { say('forgotMsg', err.message); }
      turnstileReset('forgotTurnstile');
    });
  });
  let resetToken = '';
  $('resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('resetMsg', '');
    await busy($('resetBtn'), async () => {
      try {
        await api('POST', '/reset-password', { token: resetToken, new_password: $('resetPass').value }, '');
        $('resetPass').value = '';
        resetToken = '';
        showAuthView('tabs');
        selectAuthTab('signin');
        notice(t('account.reset_done'));
      } catch (err) { say('resetMsg', err.message); }
    });
  });

  // ── Sign in with Google (Google Identity Services; only loaded when the server has a client id) ──
  function loadGoogle(tries = 0) {
    if (!cfg.google_client_id) return;
    if (!window.google || !window.google.accounts) {
      if (tries === 0) {
        const tag = document.createElement('script');
        tag.src = 'https://accounts.google.com/gsi/client';
        tag.async = true;
        document.head.appendChild(tag);
      }
      if (tries < 40) setTimeout(() => loadGoogle(tries + 1), 250);
      return;
    }
    window.google.accounts.id.initialize({ client_id: cfg.google_client_id, callback: onGoogle, use_fedcm_for_prompt: true });
    window.google.accounts.id.renderButton($('googleBtn'), { type: 'standard', theme: 'outline', size: 'large', shape: 'rectangular', text: 'continue_with', logo_alignment: 'left', width: Math.min(400, $('googleBtn').parentElement.clientWidth || 320) });
  }
  async function onGoogle(response) {
    say('signinMsg', '');
    say('regMsg', '');
    try {
      const data = await api('POST', '/google', { credential: response.credential }, '');
      await enter(data);
      if (data.password_removed) notice(t('account.google_password_removed'), true);
    } catch (err) {
      say($('registerForm').hidden ? 'signinMsg' : 'regMsg', err.message);
    }
  }

  // ── Signed in ───────────────────────────────────
  async function showHome() {
    let me;
    try { me = await api('GET', '/me'); } catch (err) {
      if (err.status === 401) { await Sync.signedOut(); showAuth(); return; }
      say('signinMsg', err.message);
      return;
    }
    account = me.account;
    $('syncAuth').hidden = true;
    $('syncHome').hidden = false;
    const name = account.contact_email || account.username || '';
    $('syncName').textContent = name;
    $('syncAvatar').textContent = (name.charAt(0) || '?').toUpperCase();
    $('verifyBar').hidden = !(cfg.email_enabled && !account.email_verified);
    $('syncAuto').checked = Sync.info().auto;
    renderStatus(Sync.info());
    await Sync.signedIn(account); // remembers the account on this device and runs the first sync
    renderStatus(Sync.info());
  }

  $('verifySend').addEventListener('click', async () => {
    await busy($('verifySend'), async () => {
      try { await api('POST', '/verify-email/send', {}); notice(t('account.verify_sent', { email: account.contact_email })); } catch (err) { notice(err.message, false); }
    });
  });

  // ── Sync status ─────────────────────────────────
  function ago(ms) {
    const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 10) return t('account_sync.just_now');
    if (sec < 60) return t('account_sync.seconds_ago', { n: sec });
    const min = Math.round(sec / 60);
    if (min < 60) return t('account_sync.minutes_ago', { n: min });
    return t('account_sync.hours_ago', { n: Math.round(min / 60) });
  }

  function renderStatus(info) {
    if (!info.active || $('syncHome').hidden) return;
    const line = $('syncLine');
    line.classList.remove('acct-status-line--ok');
    if (info.status === 'syncing') line.textContent = t('account_sync.status_syncing');
    else if (info.status === 'offline') line.textContent = t('account_sync.status_offline');
    else if (info.status === 'error') line.textContent = t('account_sync.status_error');
    else if (info.at) { line.textContent = `${t('account_sync.status_ok')} · ${ago(info.at)}${info.pending ? ` · ${t('account_sync.status_pending', { n: info.pending })}` : ''}`; line.classList.add('acct-status-line--ok'); }
    else line.textContent = t('account_sync.status_syncing');
    $('statFav').textContent = info.counts.favorite;
    $('statDl').textContent = info.counts.download;
    $('statPin').textContent = info.counts.pin;
    $('syncNow').disabled = info.status === 'syncing';
  }

  document.addEventListener('sync-status', (e) => renderStatus(e.detail));
  document.addEventListener('sync-applied', () => renderStatus(Sync.info()));
  document.addEventListener('downloads-changed', () => renderStatus(Sync.info()));
  setInterval(() => renderStatus(Sync.info()), 15 * 1000);

  $('syncNow').addEventListener('click', () => Sync.run({ force: true }));
  $('syncAuto').addEventListener('change', (e) => Sync.setAuto(e.target.checked));

  async function signOut(wipe) {
    if (wipe && !window.confirm(t('account_sync.signout_wipe_confirm'))) return;
    if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
    await Sync.signedOut({ wipe });
    account = null;
    showAuth();
  }
  $('syncSignout').addEventListener('click', () => signOut(false));
  $('signoutKeep').addEventListener('click', () => signOut(false));
  $('signoutWipe').addEventListener('click', () => signOut(true));

  // Re-label what JavaScript wrote when the language changes.
  document.addEventListener('i18n-applied', () => {
    if (!$('registerForm').hidden) $('authTitle').textContent = t('account.auth_register_title');
    else if (!$('syncAuth').hidden) $('authTitle').textContent = t('account_sync.signin_title');
    renderStatus(Sync.info());
  });

  // ── Start ───────────────────────────────────────
  // app.js loads the translations asynchronously and gives no "ready" signal, so wait for ours before drawing text.
  const i18nReady = () => new Promise((resolve) => {
    let tries = 0;
    const tick = () => (I18n.t('account_sync.signin_title') !== 'account_sync.signin_title' || tries++ > 40 ? resolve() : setTimeout(tick, 100));
    tick();
  });
  async function init() {
    await i18nReady();
    try { cfg = await api('GET', '/config', undefined, ''); } catch { /* the page still works without Google / email */ }

    // Links from our emails: /account?verify=… (confirm the address) and /account?reset=… (choose a new password).
    const params = new URLSearchParams(location.search);
    const verifyTok = params.get('verify');
    const resetTok = params.get('reset');
    if (verifyTok || resetTok) {
      params.delete('verify');
      params.delete('reset');
      history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`); // keep the token out of the address bar
    }
    if (verifyTok) {
      try { const r = await api('POST', '/verify-email', { token: verifyTok }, ''); notice(t('account.verify_done', { email: r.email })); } catch (err) { notice(err.message, false); }
    }
    if (resetTok) { resetToken = resetTok; showAuth('reset'); return; }
    if (Sync.active()) await showHome(); else showAuth();
  }
  init();
})();
