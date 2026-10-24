// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — Account page (/account)          │
// └───────────────────────────────────────────────┘
// Sign in / create an account (Google, or email + password) to keep favorites, pins, downloads and preferences in step
// on every device. Signed in, five tabs: Overview (sync status), Profile (name, photo, username, contact details),
// Preferences, Security (password, Google, sign out everywhere) and Your data (download, delete). Talks to
// /api/v1/account (worker/routes/account.js); the syncing itself is the Sync module in app.js. It is the same account
// the "For Artists" page uses. Loaded after app.js.
(() => {
  'use strict';
  if (!document.getElementById('syncPage')) return;

  const API = `${CONFIG.API_BASE}/account`;
  const TURNSTILE_SITEKEY = '0x4AAAAAABjildkegfR6T0sd'; // same public site key as the feedback forms
  const TABS = ['overview', 'profile', 'preferences', 'security', 'data'];
  const PHOTO_SIZE = 256;                                // a chosen photo is centre-cropped to a square this size (JPEG)
  const MAX_PHOTO_FILE_BYTES = 15 * 1024 * 1024;
  const $ = (id) => document.getElementById(id);
  const t = (key, vars) => I18n.t(key, vars);

  let account = null;
  let tab = 'overview';
  let cfg = { google_client_id: null, email_enabled: false };

  async function api(method, path, body, token = Sync.token()) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const notice = (text, ok = true) => say('pageNotice', text, ok);
  async function busy(btn, fn) {
    btn.disabled = true;
    try { return await fn(); } finally { btn.disabled = false; }
  }
  const toast = (text, type = 'success') => { if (typeof Toast !== 'undefined') Toast.show(text, { type, duration: 2400 }); };

  // ── Signed out ──────────────────────────────────
  let googleStarted = false;
  function showAuth(view = 'tabs') {
    $('syncAuth').hidden = false;
    $('syncHome').hidden = true;
    $('forgotLink').hidden = !cfg.email_enabled;
    showAuthView(view);
    startGoogle();
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
        await enter(await api('POST', '/login', { identifier: $('signinUser').value, password: $('signinPass').value, turnstile_token: turnstileToken('signinTurnstile') }, ''));
        $('signinPass').value = '';
        removeTurnstile('signinTurnstile');
      } catch (err) {
        say('signinMsg', err.message);
        // After a couple of wrong passwords the server wants a Cloudflare challenge too: show it, and use a fresh one each time.
        if (err.code === 'challenge_required') { renderTurnstile('signinTurnstile'); turnstileReset('signinTurnstile'); }
      }
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

  // ── Google (Google Identity Services; only loaded when the server has a client id) ──
  // One callback serves three buttons: sign in (signed out), connect Google (Security tab), confirm a deletion (Your data tab).
  function startGoogle() {
    if (googleStarted || !cfg.google_client_id) return;
    googleStarted = true;
    loadGoogle();
  }
  function loadGoogle(tries = 0) {
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
    renderGoogleButtons();
  }
  function renderGoogleButtons() {
    if (!window.google || !window.google.accounts || !cfg.google_client_id) return;
    const draw = (id, text) => {
      const box = $(id);
      if (!box || box.dataset.drawn || !box.offsetParent) return; // draw once, and only when it can be seen (so its width is known)
      box.dataset.drawn = '1';
      window.google.accounts.id.renderButton(box, { type: 'standard', theme: 'outline', size: 'large', shape: 'rectangular', text, logo_alignment: 'left', width: Math.min(320, box.parentElement.clientWidth || 300) });
    };
    draw('googleBtn', 'continue_with');
    draw('googleLinkBtn', 'continue_with');
    draw('googleConfirmBtn', 'continue_with');
  }

  async function onGoogle(response, challengeToken = '') {
    if (!Sync.active()) return googleSignIn(response, challengeToken);
    if (tab === 'data') return googleConfirmDelete(response);
    return googleLink(response);
  }

  async function googleSignIn(response, challengeToken) {
    say('signinMsg', '');
    say('regMsg', '');
    try {
      const data = await api('POST', '/google', { credential: response.credential, turnstile_token: challengeToken }, '');
      $('googleChallenge').hidden = true;
      removeTurnstile('googleTurnstile');
      await enter(data);
      if (data.password_removed) notice(t('account.google_password_removed'), true);
    } catch (err) {
      if (err.code === 'challenge_required') {
        // A NEW account needs the Cloudflare challenge first; solving it sends the same Google sign-in again.
        $('googleChallenge').hidden = false;
        removeTurnstile('googleTurnstile');
        renderTurnstile('googleTurnstile', 0, { callback: (tok) => googleSignIn(response, tok) });
        return;
      }
      say($('registerForm').hidden ? 'signinMsg' : 'regMsg', err.message);
    }
  }

  // ── Signed in ───────────────────────────────────
  const initial = (name) => (name || '?').trim().charAt(0).toUpperCase() || '?';
  function drawAvatar(el, url, name) {
    el.textContent = '';
    if (url) { const img = document.createElement('img'); img.alt = ''; img.src = url; el.appendChild(img); } else el.textContent = initial(name);
  }

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
    $('syncAuto').checked = Sync.info().auto;
    renderAccount();
    fillForms();
    const wanted = (location.hash || '').slice(1);
    selectTab(TABS.includes(wanted) ? wanted : 'overview', { updateHash: false });
    renderStatus(Sync.info());
    await Sync.signedIn(account); // remembers the account on this device and runs the first sync
    renderStatus(Sync.info());
  }

  /** Puts the saved values into the form fields (on load and after saving — never while someone is typing). */
  function fillForms() {
    $('profName').value = account.display_name || '';
    $('profUser').value = account.username || '';
    $('contactEmail').value = account.contact_email || '';
    $('contactPhone').value = account.contact_phone || '';
  }

  /** Everything that comes from the account record, except what is typed into the forms. */
  function renderAccount() {
    const shown = account.display_name || account.contact_email || account.username || '';
    $('syncName').textContent = shown;
    $('syncMeta').textContent = account.display_name ? (account.contact_email || '') : t('account_sync.signed_in_as');
    drawAvatar($('syncAvatar'), account.avatar, shown);
    drawAvatar($('profAvatar'), photoDraft === undefined ? account.avatar : photoDraft, shown);
    $('photoRemove').hidden = !(photoDraft === undefined ? account.avatar : photoDraft);
    const mailOn = cfg.email_enabled;
    $('verifyBar').hidden = !(mailOn && !account.email_verified);
    $('contactEmailState').textContent = account.email_verified ? t('account_sec.email_confirmed') : (mailOn ? t('account_sec.email_unconfirmed') : '');
    // Security
    $('pwCurrentField').hidden = !account.has_password;
    $('pwCurrent').required = account.has_password;
    $('pwNote').textContent = t(account.has_password ? 'account_sec.password_note' : 'account_sec.password_none');
    $('pwSave').textContent = t(account.has_password ? 'account.save_password' : 'account_sec.password_set');
    $('googleNote').textContent = t(account.google ? (account.has_password ? 'account_sec.google_on' : 'account_sec.google_only') : 'account_sec.google_off');
    $('googleLinkBlock').hidden = account.google || !cfg.google_client_id;
    $('unlinkForm').hidden = !(account.google && account.has_password);
    $('googleTitle').parentElement.hidden = !cfg.google_client_id && !account.google;
    // Your data
    $('deletePassField').hidden = !account.has_password;
    $('deletePass').required = account.has_password;
    $('deleteGoogleBlock').hidden = account.has_password || !cfg.google_client_id;
    renderGoogleButtons();
  }

  // ── Tabs ────────────────────────────────────────
  function selectTab(which, { updateHash = true } = {}) {
    tab = which;
    document.querySelectorAll('.acct-tab').forEach((b) => {
      const on = b.dataset.tab === which;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    TABS.forEach((name) => { $(`panel${name.charAt(0).toUpperCase()}${name.slice(1)}`).hidden = name !== which; });
    if (updateHash) history.replaceState(null, '', which === 'overview' ? location.pathname : `#${which}`);
    if (which === 'preferences') renderPrefs();
    renderGoogleButtons();
  }
  document.querySelectorAll('.acct-tab').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  // ── Profile ─────────────────────────────────────
  let photoDraft; // undefined = unchanged, '' = removed, data URL = chosen

  $('photoPick').addEventListener('click', () => $('photoFile').click());
  $('photoRemove').addEventListener('click', () => { photoDraft = ''; renderAccount(); });
  $('photoFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { say('profMsg', t('account.err_image')); return; }
    if (file.size > MAX_PHOTO_FILE_BYTES) { say('profMsg', t('account.err_image_big')); return; }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
      const side = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = PHOTO_SIZE;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // JPEG has no alpha
      ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
      photoDraft = canvas.toDataURL('image/jpeg', 0.85);
      say('profMsg', '');
      renderAccount();
    } catch { say('profMsg', t('account.err_image')); } finally { URL.revokeObjectURL(url); }
  });

  $('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('profMsg', '');
    const body = {};
    if ($('profName').value.trim() !== (account.display_name || '')) body.display_name = $('profName').value;
    if ($('profUser').value.trim().toLowerCase() !== account.username.toLowerCase()) body.username = $('profUser').value;
    if (photoDraft !== undefined) body.avatar = photoDraft;
    if (!Object.keys(body).length) { say('profMsg', t('account_sec.nothing_changed')); return; }
    await busy($('profSave'), async () => {
      try {
        const res = await api('PUT', '/profile', body);
        if (res.token) localStorage.setItem(Sync.TOKEN_KEY, res.token); // the username is inside the session token
        account = { ...account, ...res.account };
        photoDraft = undefined;
        Sync.setProfile({ name: account.display_name, avatar: account.avatar });
        renderAccount();
        fillForms();
        say('profMsg', t('account.saved'), true);
      } catch (err) { say('profMsg', err.message); }
    });
  });

  $('contactForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('contactMsg', '');
    await busy($('contactSave'), async () => {
      try {
        const res = await api('PUT', '/contact', { contact_email: $('contactEmail').value, contact_phone: $('contactPhone').value, phone_optional: true });
        account = { ...account, ...res.account };
        renderAccount();
        fillForms();
        say('contactMsg', res.verification === 'sent' ? t('account.verify_sent', { email: account.contact_email }) : t('account.saved'), true);
      } catch (err) { say('contactMsg', err.message); }
    });
  });

  $('verifySend').addEventListener('click', async () => {
    await busy($('verifySend'), async () => {
      try { await api('POST', '/verify-email/send', {}); notice(t('account.verify_sent', { email: account.contact_email })); } catch (err) { notice(err.message, false); }
    });
  });

  // ── Preferences (the same stores the Settings panel uses, so they sync like everything else) ──
  function renderPrefs() {
    const mark = (boxId, attr, value) => $(boxId).querySelectorAll('.acct-chip').forEach((b) => {
      const on = b.dataset[attr] === value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    mark('prefLang', 'lang', I18n.getLang());
    mark('prefTheme', 'theme', Theme.getMode());
    mark('prefView', 'view', DisplayMode.current);
  }
  $('prefLang').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (!b || b.dataset.lang === I18n.getLang()) return;
    I18n.setLanguage(b.dataset.lang);
    Sync.record('pref', 'lang', true, b.dataset.lang);
    renderPrefs();
  });
  $('prefTheme').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]');
    if (!b || b.dataset.theme === Theme.getMode()) return;
    Theme.setMode(b.dataset.theme);
    Sync.record('pref', 'theme', true, b.dataset.theme);
    renderPrefs();
  });
  $('prefView').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    DisplayMode.set(b.dataset.view); // records itself
    renderPrefs();
  });
  $('syncAuto').addEventListener('change', (e) => Sync.setAuto(e.target.checked));
  // The Settings panel (gear) changes the same things: keep the buttons in step with it.
  document.addEventListener('click', () => { if (tab === 'preferences' && !$('syncHome').hidden) setTimeout(renderPrefs, 60); });

  // ── Security ────────────────────────────────────
  $('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('pwMsg', '');
    await busy($('pwSave'), async () => {
      try {
        const res = await api('POST', '/change-password', { current_password: $('pwCurrent').value, new_password: $('pwNew').value });
        if (res.token) localStorage.setItem(Sync.TOKEN_KEY, res.token); // other devices are signed out; this one gets a fresh session
        $('pwCurrent').value = '';
        $('pwNew').value = '';
        account = { ...account, has_password: true };
        renderAccount();
        say('pwMsg', t('account_sec.password_saved'), true);
      } catch (err) { say('pwMsg', err.message); }
    });
  });

  async function googleLink(response) {
    say('googleMsg', '');
    try {
      const res = await api('POST', '/google/link', { credential: response.credential });
      account = { ...account, ...res.account };
      renderAccount();
      say('googleMsg', t('account_sec.google_connected'), true);
    } catch (err) { say('googleMsg', err.message); }
  }
  $('unlinkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('googleMsg', '');
    await busy($('unlinkBtn'), async () => {
      try {
        const res = await api('POST', '/google/unlink', { password: $('unlinkPass').value });
        $('unlinkPass').value = '';
        account = { ...account, ...res.account };
        renderAccount();
        say('googleMsg', t('account_sec.google_disconnected'), true);
      } catch (err) { say('googleMsg', err.message); }
    });
  });

  $('logoutAll').addEventListener('click', async () => {
    if (!window.confirm(t('account_sec.logout_all_confirm'))) return;
    say('sessionsMsg', '');
    await busy($('logoutAll'), async () => {
      try {
        const res = await api('POST', '/logout-all', {});
        localStorage.setItem(Sync.TOKEN_KEY, res.token);
        say('sessionsMsg', t('account_sec.logout_all_done'), true);
      } catch (err) { say('sessionsMsg', err.message); }
    });
  });

  // ── Your data ───────────────────────────────────
  $('exportBtn').addEventListener('click', async () => {
    say('exportMsg', '');
    await busy($('exportBtn'), async () => {
      try {
        const res = await fetch(`${API}/export`, { headers: { Authorization: `Bearer ${Sync.token()}` } });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('common.err_generic'));
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url;
        a.download = 'maralyrics-account.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (err) { say('exportMsg', err.message); }
    });
  });

  async function deleteAccount(body) {
    say('deleteMsg', '');
    if (!window.confirm(t('account_sec.delete_confirm'))) return;
    try {
      await api('POST', '/delete-account', body);
      // The account is gone: sign out and clear what was synced from it off this device too.
      if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
      await Sync.signedOut({ wipe: true });
      account = null;
      showAuth();
      notice(t('account_sec.deleted'));
    } catch (err) { say('deleteMsg', err.message); }
  }
  $('deleteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!account.has_password) return; // an account with only Google confirms with the Google button
    await busy($('deleteBtn'), () => deleteAccount({ password: $('deletePass').value }));
  });
  async function googleConfirmDelete(response) { await deleteAccount({ credential: response.credential }); }
  $('deleteBtn').addEventListener('click', () => {
    if (account && !account.has_password) say('deleteMsg', t('account_sec.delete_use_google'));
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
  document.addEventListener('sync-applied', () => { renderStatus(Sync.info()); if (tab === 'preferences') renderPrefs(); });
  document.addEventListener('downloads-changed', () => renderStatus(Sync.info()));
  setInterval(() => renderStatus(Sync.info()), 15 * 1000);

  $('syncNow').addEventListener('click', () => Sync.run({ force: true }));

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
    if (account && !$('syncHome').hidden) { renderAccount(); renderPrefs(); }
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
