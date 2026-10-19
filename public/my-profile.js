// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — Artist Court (artist & composer accounts)  │
// └───────────────────────────────────────────────┘
// Sign in / create an account, ask to claim an artist or composer profile, and — once a claim is approved —
// edit that profile's bio, photo and social links and apply for the Green mark. Four tabs: Profile, Green Mark,
// Claims, Account. Talks to /api/v1/account (see worker/routes/account.js). Loaded after app.js (uses CONFIG,
// I18n, Utils, Toast, GreenMark, SocialIcons).
(() => {
  'use strict';
  if (!document.getElementById('accountPage')) return;

  const API = `${CONFIG.API_BASE}/account`;
  const TOKEN_KEY = 'ml_account_token';
  const TURNSTILE_SITEKEY = '0x4AAAAAABjildkegfR6T0sd'; // same public site key as the feedback forms
  const PHOTO_SIZE = 400; // uploaded photos are centre-cropped to a square this size (JPEG)
  const MAX_PHOTO_FILE_BYTES = 15 * 1024 * 1024;
  const MAX_LINKS = 10;
  const TABS = ['profile', 'green', 'claims', 'account'];

  const $ = (id) => document.getElementById(id);
  const t = (key, vars) => I18n.t(key, vars);
  const esc = (s) => Utils.escapeHtml(s);

  const store = {
    get() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
    set(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
  };

  let token = store.get();
  let account = null;
  let claims = [];
  let tab = 'claims';
  let selectedId = null;  // claim id of the profile shown in the Profile tab / banner
  let editing = null;     // { claimId, type, slug, name, role }
  let photo = '';         // current photo (data: URL or https URL), '' = none
  let links = [];         // current social links
  let target = null;      // { type, slug, name } when arriving from a profile's "Claim" link
  let cfg = { google_client_id: null, email_enabled: false }; // what the server has switched on (Google sign-in, email)

  const approved = () => claims.filter((c) => c.status === 'approved');
  const selectedClaim = () => approved().find((c) => c.id === selectedId) || approved()[0] || null;

  // ── API ─────────────────────────────────────────
  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || t('common.err_generic'));
      err.status = res.status;
      throw err;
    }
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

  // ── Small UI helpers ────────────────────────────
  function say(id, text, ok = false) {
    const el = $(id);
    el.textContent = text || '';
    el.hidden = !text;
    el.className = `royal-message${ok ? ' royal-message--ok' : ''}`;
  }
  async function busy(btn, fn) {
    btn.disabled = true;
    try { return await fn(); } finally { btn.disabled = false; }
  }
  const publicUrl = (c) => `/${c.type}/${encodeURIComponent(c.slug)}`;
  const initial = (name) => esc((name || '?').charAt(0).toUpperCase());
  const avatarHtml = (url, name) => (url ? `<img src="${esc(url)}" alt="" />` : `<span aria-hidden="true">${initial(name)}</span>`);
  const typeLabel = (type) => t(type === 'artist' ? 'account.type_artist' : 'account.type_composer');

  // ── Signed out ──────────────────────────────────
  let googleStarted = false;
  function showAuth(view = 'tabs') {
    $('accountAuth').hidden = false;
    $('accountHome').hidden = true;
    $('forgotLink').hidden = !cfg.email_enabled;
    showAuthView(view);
    if (!googleStarted && cfg.google_client_id) { googleStarted = true; loadGoogle(); }
    if (target && view === 'tabs') {
      const note = $('authClaimNote');
      note.textContent = t('account.claim_prompt', { name: target.name });
      note.hidden = false;
      selectAuthTab('register');
    }
  }

  function selectAuthTab(which) {
    const reg = which === 'register';
    $('tabSignin').classList.toggle('active', !reg);
    $('tabRegister').classList.toggle('active', reg);
    $('signinForm').hidden = reg;
    $('registerForm').hidden = !reg;
    if (reg) renderTurnstile('regTurnstile');
  }

  /** The signed-out box shows one of: sign in / create account ('tabs'), 'forgot' password, or 'reset' (arrived from the emailed link). */
  function showAuthView(view) {
    $('authTabsBox').hidden = view !== 'tabs';
    $('forgotForm').hidden = view !== 'forgot';
    $('resetForm').hidden = view !== 'reset';
    $('googleBlock').hidden = view !== 'tabs' || !cfg.google_client_id;
    if (view === 'forgot') renderTurnstile('forgotTurnstile');
  }

  /** Shown above everything, for results of things done in an email link and for sign-up news. */
  const notice = (text, ok = true) => say('pageNotice', text, ok);

  async function enter(data) {
    token = data.token;
    store.set(token);
    await showHome();
  }

  $('tabSignin').addEventListener('click', () => selectAuthTab('signin'));
  $('tabRegister').addEventListener('click', () => selectAuthTab('register'));

  $('signinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('signinMsg', '');
    await busy($('signinBtn'), async () => {
      try {
        await enter(await api('POST', '/login', { identifier: $('signinUser').value, password: $('signinPass').value }));
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
        const data = await api('POST', '/register', { email: $('regEmail').value, password: $('regPass').value, contact_phone: $('regPhone').value, turnstile_token: ts });
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
        await api('POST', '/forgot-password', { email: $('forgotEmail').value, turnstile_token: ts });
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
        await api('POST', '/reset-password', { token: resetToken, new_password: $('resetPass').value });
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
    window.google.accounts.id.renderButton($('googleBtn'), { type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'left', width: 300 });
  }
  async function onGoogle(response) {
    say('signinMsg', '');
    say('regMsg', '');
    try {
      const data = await api('POST', '/google', { credential: response.credential });
      await enter(data);
      if (data.password_removed) notice(t('account.google_password_removed'), true);
    } catch (err) {
      const box = $('registerForm').hidden ? 'signinMsg' : 'regMsg';
      say(box, err.message);
    }
  }

  // ── Signed in ───────────────────────────────────
  function signOut() {
    token = '';
    account = null;
    claims = [];
    editing = null;
    selectedId = null;
    greenState.offer = null;
    store.set('');
    if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
    showAuth();
  }

  async function showHome() {
    let me;
    try { me = await api('GET', '/me'); } catch (err) {
      if (err.status === 401) { signOut(); return; }
      say('signinMsg', err.message);
      return;
    }
    account = me.account;
    claims = me.claims;
    $('accountAuth').hidden = true;
    $('accountHome').hidden = false;
    fillContact();
    renderTurnstile('claimTurnstile');
    renderClaimTarget();
    await refreshAll();
    const wanted = (location.hash || '').slice(1);
    // An older account with no phone number yet is sent to the Account tab to add it.
    const land = !account.contact_complete ? 'account' : approved().length ? 'profile' : 'claims';
    selectTab(TABS.includes(wanted) ? wanted : land, { updateHash: false });
  }

  /** Re-draws everything that depends on the account / claims, and (re)loads the selected profile for editing. */
  async function refreshAll() {
    if (!selectedClaim()) selectedId = null;
    else if (!approved().some((c) => c.id === selectedId)) selectedId = approved()[0].id;
    renderClaims();
    renderLocks();
    renderSwitch();
    await loadGreen();
    renderBanner();
    if (selectedClaim() && (!editing || editing.claimId !== selectedClaim().id)) await openEditor(selectedClaim());
    if (!selectedClaim()) editing = null;
    renderPreview();
    renderContactNeeds();
  }

  async function refreshClaims() {
    const me = await api('GET', '/me');
    account = me.account;
    claims = me.claims;
    await refreshAll();
  }

  $('btnSignout').addEventListener('click', signOut);

  // ── Banner ──────────────────────────────────────
  function renderBanner() {
    if (!account) return;
    const claim = selectedClaim();
    const name = claim ? claim.name : (account.contact_email || account.username);
    const active = !!(greenState.offer && claim && (greenState.offer.profiles.find((p) => p.claim_id === claim.id) || {}).active);
    $('bannerName').innerHTML = `${esc(name)}${active ? GreenMark.html() : ''}`;
    $('bannerAvatar').innerHTML = avatarHtml(claim && editing && editing.claimId === claim.id ? photo : '', name);
    const who = account.contact_email || account.username;
    $('bannerMeta').textContent = claim ? `${typeLabel(claim.type)} · ${t('account.signed_in_as', { name: who })}` : t('account.signed_in_as', { name: who });
    const view = $('bannerView');
    view.hidden = !claim;
    if (claim) view.href = publicUrl(claim);
  }

  // ── Tabs ────────────────────────────────────────
  function selectTab(which, { updateHash = true } = {}) {
    if (!TABS.includes(which)) which = 'claims';
    tab = which;
    for (const b of $('courtTabs').querySelectorAll('[data-tab]')) {
      const on = b.dataset.tab === which;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const name of TABS) $(`panel${name[0].toUpperCase()}${name.slice(1)}`).hidden = name !== which;
    if (updateHash) history.replaceState(null, '', `${location.pathname}${location.search}#${which}`);
  }
  $('courtTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) selectTab(b.dataset.tab);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b) selectTab(b.dataset.goto);
  });
  window.addEventListener('hashchange', () => {
    const wanted = (location.hash || '').slice(1);
    if (account && TABS.includes(wanted) && wanted !== tab) selectTab(wanted, { updateHash: false });
  });

  /** The Profile and Green Mark tabs are locked until a claim is approved. */
  function renderLocks() {
    const has = approved().length > 0;
    for (const id of ['panelProfile', 'panelGreen']) {
      $(id).querySelector('[data-locked]').hidden = has;
      $(id).querySelector('[data-body]').hidden = !has;
    }
  }

  /** Profile switcher chips — only when the owner has more than one approved profile. */
  function renderSwitch() {
    const list = approved();
    const box = $('profileSwitch');
    box.hidden = list.length < 2;
    box.setAttribute('aria-label', t('account.switch_profile'));
    box.innerHTML = list.map((c) => `<button type="button" class="royal-chip${c.id === (selectedClaim() || {}).id ? ' active' : ''}" data-claim="${Number(c.id)}">${esc(c.name)}</button>`).join('');
  }
  $('profileSwitch').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-claim]');
    if (!b) return;
    selectedId = Number(b.dataset.claim);
    renderSwitch();
    const claim = selectedClaim();
    if (claim) await openEditor(claim);
    renderBanner();
    renderPreview();
  });

  // ── Contact details (email + phone are compulsory) ──
  function fillContact() {
    if (!account) return;
    if (account.contact_email && !$('claimEmail').value) $('claimEmail').value = account.contact_email;
    if (account.contact_phone && !$('claimPhone').value) $('claimPhone').value = account.contact_phone;
    $('contactEmail').value = account.contact_email || '';
    $('contactPhone').value = account.contact_phone || '';
  }

  // Once the server can send email, an address has to be confirmed before claiming or ordering a Green mark.
  const needsConfirm = () => !!account && cfg.email_enabled && !account.email_verified;

  function renderVerify() {
    if (!account) return;
    const need = needsConfirm();
    $('verifyBar').hidden = !need;
    if (need) $('verifyText').textContent = t('account.verify_bar', { email: account.contact_email || '' });
    $('claimNeedVerify').hidden = !need;
    $('claimNeedVerify').textContent = need ? t('account.verify_needed') : '';
    $('claimBtn').disabled = need;
    $('claimEmail').readOnly = !!account.contact_email; // the account's own address; changed in the Account tab
    const line = $('contactVerified');
    line.hidden = !account.contact_email;
    line.textContent = account.email_verified ? `✔ ${t('account.email_confirmed')}` : t('account.email_unconfirmed');
    line.classList.toggle('royal-status-line--ok', !!account.email_verified);
    $('pwCurrentRow').hidden = !account.has_password;
    $('pwCurrent').required = !!account.has_password;
    $('pwGoogleNote').hidden = !!account.has_password;
    $('pwTitle').textContent = t(account.has_password ? 'account.change_password' : 'account.set_password');
  }

  /** Nudges an account that has no phone yet (older accounts, Google sign-ups) to add one before claiming or ordering. */
  function renderContactNeeds() {
    renderVerify();
    const missing = !!account && !account.contact_complete;
    const confirm = needsConfirm();
    const need = $('greenNeedContact');
    need.textContent = missing ? t('account.contact_needed') : confirm ? t('account.verify_needed') : '';
    need.hidden = !(missing || confirm);
    $('greenForm').hidden = missing || confirm || !greenCanOrder();
    if (missing) say('contactMsg', t('account.contact_needed'));
  }

  $('verifySend').addEventListener('click', async () => {
    await busy($('verifySend'), async () => {
      try {
        const res = await api('POST', '/verify-email/send');
        if (res.already) { await refreshClaims(); return; }
        notice(t('account.verify_sent', { email: account.contact_email }));
      } catch (err) { notice(err.message, false); }
    });
  });

  $('contactForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('contactMsg', '');
    await busy($('contactForm').querySelector('button[type="submit"]'), async () => {
      try {
        const res = await api('PUT', '/contact', { contact_email: $('contactEmail').value, contact_phone: $('contactPhone').value });
        account = res.account || { ...account, contact_email: res.contact_email, contact_phone: res.contact_phone, contact_complete: true };
        fillContact();
        $('claimEmail').value = account.contact_email || '';
        $('claimPhone').value = account.contact_phone || '';
        renderContactNeeds();
        say('contactMsg', res.verification === 'sent' ? t('account.contact_saved_verify', { email: account.contact_email }) : t('account.contact_saved'), true);
      } catch (err) { say('contactMsg', err.message); }
    });
  });

  $('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('pwMsg', '');
    try {
      const res = await api('POST', '/change-password', { current_password: $('pwCurrent').value, new_password: $('pwNew').value });
      // Other sessions were signed out; this one carries on with a fresh token.
      if (res.token) { token = res.token; store.set(token); }
      account = { ...account, has_password: true };
      $('pwCurrent').value = '';
      $('pwNew').value = '';
      renderVerify();
      say('pwMsg', t('account.password_changed'), true);
    } catch (err) { say('pwMsg', err.message); }
  });

  // ── Claims list ─────────────────────────────────
  const STATUS_KEY = { pending: 'account.status_pending', approved: 'account.status_approved', rejected: 'account.status_rejected', revoked: 'account.status_revoked' };
  const pillClass = (s) => (s === 'approved' ? 'approved' : s === 'pending' ? 'pending' : 'rejected');

  function renderClaims() {
    $('claimEmpty').hidden = claims.length > 0;
    $('claimList').innerHTML = claims.map((c) => `
      <article class="royal-status${c.status === 'approved' ? ' royal-status--active' : ''}" data-id="${Number(c.id)}">
        <div class="royal-status__main">
          <a class="royal-status__name" href="${publicUrl(c)}">${esc(c.name)}</a>
          <span class="royal-status__type">${esc(typeLabel(c.type))}</span>
          <span class="royal-pill royal-pill--${pillClass(c.status)}">${esc(t(STATUS_KEY[c.status] || c.status))}</span>
        </div>
        ${c.review_note ? `<p class="royal-status__note">${esc(t('account.note_from_team', { note: c.review_note }))}</p>` : ''}
        <div class="royal-status__actions">
          ${c.status === 'approved' ? `<button type="button" class="royal-btn royal-btn--sm" data-action="edit">${esc(t('account.edit_profile'))}</button>` : ''}
          ${c.status === 'pending' ? `<button type="button" class="royal-btn royal-btn--ghost royal-btn--sm" data-action="withdraw">${esc(t('account.withdraw'))}</button>` : ''}
        </div>
      </article>`).join('');
  }

  $('claimList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = Number(btn.closest('[data-id]').dataset.id);
    const claim = claims.find((c) => c.id === id);
    if (!claim) return;
    if (btn.dataset.action === 'edit') {
      selectedId = claim.id;
      renderSwitch();
      await openEditor(claim);
      renderBanner();
      renderPreview();
      selectTab('profile');
    }
    if (btn.dataset.action === 'withdraw' && window.confirm(t('account.withdraw_confirm'))) {
      try { await api('DELETE', `/claims/${id}`); await refreshClaims(); } catch (err) { Toast.show(err.message, { type: 'error' }); }
    }
  });

  // ── Claim form ──────────────────────────────────
  const names = {}; // type → [{ name, slug }]
  async function loadNames(type) {
    if (names[type]) return names[type];
    const res = await fetch(`${CONFIG.API_BASE}/${type}s`);
    const data = res.ok ? await res.json() : {};
    names[type] = (data[`${type}s`] || []).map((p) => ({ name: p.name, slug: p.slug }));
    return names[type];
  }
  async function fillNames() {
    const list = await loadNames($('claimType').value).catch(() => []);
    $('claimNames').innerHTML = list.map((p) => `<option value="${esc(p.name)}"></option>`).join('');
  }
  $('claimType').addEventListener('change', () => { $('claimSearch').value = ''; fillNames(); });
  $('claimSearch').addEventListener('focus', fillNames, { once: true });

  function renderClaimTarget() {
    const el = $('claimTarget');
    if (target) {
      el.textContent = t('account.claiming', { name: target.name });
      el.hidden = false;
      $('claimPicker').hidden = true;
    } else {
      el.hidden = true;
      $('claimPicker').hidden = false;
    }
  }

  $('claimForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('claimMsg', '');
    let pick = target;
    if (!pick) {
      const typed = $('claimSearch').value.trim().toLowerCase();
      const type = $('claimType').value;
      const matches = typed ? (await loadNames(type).catch(() => [])).filter((p) => p.name.toLowerCase() === typed) : [];
      if (!matches.length) { say('claimMsg', t('account.claim_pick')); return; }
      if (matches.length > 1) { say('claimMsg', t('account.claim_ambiguous')); return; }
      pick = { type, slug: matches[0].slug, name: matches[0].name };
    }
    const ts = turnstileToken('claimTurnstile');
    if (!ts) { say('claimMsg', t('feedback.err_turnstile')); return; }
    await busy($('claimBtn'), async () => {
      try {
        await api('POST', '/claims', {
          type: pick.type, slug: pick.slug, evidence: $('claimEvidence').value, contact_email: $('claimEmail').value, contact_phone: $('claimPhone').value, turnstile_token: ts,
        });
        $('claimEvidence').value = '';
        $('claimSearch').value = '';
        target = null;
        renderClaimTarget();
        history.replaceState(null, '', `${location.pathname}#claims`);
        say('claimMsg', t('account.claim_sent'), true);
        await refreshClaims();
      } catch (err) { say('claimMsg', err.message); }
      turnstileReset('claimTurnstile');
    });
  });

  // ── Green mark ──────────────────────────────────
  // Plans and prices are set by the Super Admin; an order is paid outside the site and checked by hand.
  const greenState = { offer: null, receipt: '' };
  const PLAN_KEY = { 1: 'green.plan_1', 3: 'green.plan_3', 6: 'green.plan_6', 12: 'green.plan_12', 36: 'green.plan_36' };
  const planName = (months) => t(PLAN_KEY[months] || 'green.plan_1');
  const money = (cents, currency) => {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
  };
  const fmtDate = (sqlDate) => new Date(`${String(sqlDate).replace(' ', 'T')}Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  // The how-to-pay text is written by the site owner, but is still escaped; only http(s) links are made clickable.
  const linkify = (text) => esc(text).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`);
  const ORDER_STATUS_KEY = { pending: 'green.status_pending', approved: 'green.status_approved', rejected: 'green.status_rejected', cancelled: 'green.status_cancelled' };
  const greenCanOrder = () => !!greenState.offer && greenState.offer.plans.length > 0 && greenState.offer.profiles.length > 0;

  async function loadGreen() {
    if (!approved().length) { greenState.offer = null; return; }
    try { greenState.offer = await api('GET', '/green'); } catch { greenState.offer = null; $('panelGreen').querySelector('[data-body]').hidden = true; return; } // not available yet (e.g. before the migration)
    renderGreen();
  }

  function renderGreen() {
    const offer = greenState.offer;
    if (!offer) return;
    $('greenProfiles').innerHTML = offer.profiles.map((p) => `
      <div class="royal-status${p.active ? ' royal-status--active' : ''}">
        <div class="royal-status__main">
          <span class="royal-status__name">${esc(p.name)}${p.active ? GreenMark.html() : ''}</span>
          <span class="royal-status__state">${esc(p.has_pending ? t('green.pending_order') : p.active ? t('green.active_until', { date: fmtDate(p.expires_at) }) : t('green.not_active'))}</span>
        </div>
      </div>`).join('');

    $('greenNoPlans').hidden = offer.plans.length > 0;
    if (greenCanOrder()) {
      const chosenProfile = $('greenProfile').value;
      $('greenProfile').innerHTML = offer.profiles.map((p) => `<option value="${Number(p.claim_id)}"${p.has_pending ? ' disabled' : ''}>${esc(p.name)}${p.has_pending ? ` — ${esc(t('green.pending_order'))}` : ''}</option>`).join('');
      if (chosenProfile && [...$('greenProfile').options].some((o) => o.value === chosenProfile && !o.disabled)) $('greenProfile').value = chosenProfile;
      else $('greenProfile').value = (offer.profiles.find((p) => !p.has_pending) || {}).claim_id ?? '';
      $('greenProfileRow').hidden = offer.profiles.length < 2;
      const chosenPlan = (document.querySelector('input[name="greenPlan"]:checked') || {}).value;
      $('greenPlans').innerHTML = offer.plans.map((p, i) => `
        <label class="royal-plan">
          <input type="radio" name="greenPlan" value="${Number(p.months)}"${(chosenPlan ? String(p.months) === chosenPlan : i === 0) ? ' checked' : ''} />
          <span class="royal-plan__name">${esc(planName(p.months))}</span>
          <span class="royal-plan__price">${esc(money(p.price_cents, offer.currency))}</span>
        </label>`).join('');
      $('greenHowTo').innerHTML = offer.payment_instructions ? linkify(offer.payment_instructions) : esc(t('green.no_instructions'));
    }
    $('greenForm').hidden = !greenCanOrder() || (!!account && !account.contact_complete);

    $('greenNoOrders').hidden = offer.orders.length > 0;
    $('greenOrders').innerHTML = offer.orders.map((o) => `
      <article class="royal-status${o.status === 'approved' ? ' royal-status--active' : ''}" data-order="${Number(o.id)}">
        <div class="royal-status__main">
          <span class="royal-status__name">${esc(o.name)}</span>
          <span class="royal-status__type">${esc(t('green.order_line', { plan: planName(o.months), amount: money(o.amount_cents, o.currency) }))}</span>
          <span class="royal-pill royal-pill--${pillClass(o.status)}">${esc(t(ORDER_STATUS_KEY[o.status] || o.status))}</span>
        </div>
        ${o.review_note ? `<p class="royal-status__note">${esc(t('account.note_from_team', { note: o.review_note }))}</p>` : ''}
        ${o.status === 'pending' ? `<div class="royal-status__actions"><button type="button" class="royal-btn royal-btn--ghost royal-btn--sm" data-cancel-order="${Number(o.id)}">${esc(t('green.cancel_order'))}</button></div>` : ''}
      </article>`).join('');
  }

  $('greenOrders').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cancel-order]');
    if (!btn || !window.confirm(t('green.cancel_confirm'))) return;
    try { await api('DELETE', `/green/orders/${btn.dataset.cancelOrder}`); await loadGreen(); renderBanner(); } catch (err) { Toast.show(err.message, { type: 'error' }); }
  });

  // A receipt photo is shrunk (max 1000 px, JPEG) so it stays small enough to send and store.
  function setReceipt(dataUrl) {
    greenState.receipt = dataUrl || '';
    const box = $('greenReceiptPreview');
    box.innerHTML = dataUrl ? `<img src="${esc(dataUrl)}" alt="" />` : '';
    box.hidden = !dataUrl;
    $('greenReceiptRemove').hidden = !dataUrl;
  }
  $('greenReceiptRemove').addEventListener('click', () => setReceipt(''));
  $('greenReceiptFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type) || file.size > MAX_PHOTO_FILE_BYTES) { say('greenMsg', t('green.err_receipt')); return; }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
      const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      let out = '';
      for (const q of [0.8, 0.65, 0.5, 0.35]) { out = canvas.toDataURL('image/jpeg', q); if (out.length < 250000) break; }
      say('greenMsg', '');
      setReceipt(out);
    } catch { say('greenMsg', t('green.err_receipt')); } finally { URL.revokeObjectURL(url); }
  });

  $('greenForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('greenMsg', '');
    const months = Number((document.querySelector('input[name="greenPlan"]:checked') || {}).value);
    await busy($('greenSubmit'), async () => {
      try {
        await api('POST', '/green/orders', {
          claim_id: Number($('greenProfile').value), months, reference: $('greenReference').value, note: $('greenNote').value, receipt: greenState.receipt,
        });
        $('greenReference').value = '';
        $('greenNote').value = '';
        setReceipt('');
        say('greenMsg', t('green.sent'), true);
        await loadGreen();
      } catch (err) { say('greenMsg', err.message); }
    });
  });

  // ── Profile editor ──────────────────────────────
  function renderPhoto() {
    $('editorPhoto').innerHTML = avatarHtml(photo, editing && editing.name);
    $('editorPhotoRemove').hidden = !photo;
  }

  function renderLinks() {
    $('editorLinks').innerHTML = links.map((url, i) => `
      <div class="royal-link-row">
        <span class="royal-link-icon" title="${esc(SocialIcons.detect(url, { websiteLabel: t('common.website') }).name)}">${SocialIcons.detect(url).icon}</span>
        <input type="url" value="${esc(url)}" data-i="${i}" placeholder="${esc(t('account.social_ph'))}" maxlength="500" />
        <button type="button" class="royal-btn royal-btn--ghost royal-btn--sm" data-remove="${i}" aria-label="${esc(t('account.social_remove'))}">✕</button>
      </div>`).join('');
    $('editorAddLink').hidden = links.length >= MAX_LINKS;
  }

  // The bio is rich text (bold, italic, links, lists, new lines) — see /rich-text.js.
  const BIO_MAX = 5000;
  const rteLabels = () => ({
    bold: t('account.rte_bold'), italic: t('account.rte_italic'), underline: t('account.rte_underline'), link: t('account.rte_link'),
    unlink: t('account.rte_unlink'), ul: t('account.rte_ul'), ol: t('account.rte_ol'), quote: t('account.rte_quote'), clear: t('account.rte_clear'),
    toolbar: t('account.rte_toolbar'), link_prompt: t('account.rte_link_prompt'), link_invalid: t('account.rte_link_invalid'), hint: t('account.rte_hint'),
  });
  let bioRte = null;
  function mountBio() {
    if (bioRte) return;
    bioRte = RichText.mount($('editorBio'), {
      labels: rteLabels(),
      placeholder: t('account.bio_ph'),
      onChange: ({ length }) => { countBio(length); renderPreview(); },
    });
  }
  const countBio = (length = bioRte ? bioRte.getText().length : 0) => {
    const el = $('editorBioCount');
    el.textContent = `${length} / ${BIO_MAX}`;
    el.style.color = length > BIO_MAX ? 'var(--r-danger)' : '';
  };

  /** The "this is how your page will look" card, redrawn on every keystroke. */
  function renderPreview() {
    const box = $('previewCard');
    if (!editing) { box.innerHTML = ''; return; }
    const active = !!(greenState.offer && (greenState.offer.profiles.find((p) => p.claim_id === editing.claimId) || {}).active);
    const icons = links.map((u) => u.trim()).filter(Boolean).slice(0, MAX_LINKS)
      .map((u) => `<span title="${esc(SocialIcons.detect(u, { websiteLabel: t('common.website') }).name)}">${SocialIcons.detect(u).icon}</span>`).join('');
    box.innerHTML = `
      <span class="royal-avatar royal-avatar--lg">${avatarHtml(photo, editing.name)}</span>
      <h3 class="royal-preview__name">${esc(editing.name)}${active ? GreenMark.html() : ''}</h3>
      <p class="royal-preview__role">${esc(typeLabel(editing.type))}</p>
      ${bioRte && !bioRte.isEmpty() ? `<div class="royal-preview__bio">${RichText.clean(bioRte.getHtml())}</div>` : ''}
      ${icons ? `<div class="royal-preview__links">${icons}</div>` : ''}`;
    $('bannerAvatar').innerHTML = avatarHtml(photo, editing.name);
  }

  async function openEditor(claim) {
    say('editorMsg', '');
    try {
      const p = await api('GET', `/claims/${claim.id}/profile`);
      editing = { claimId: claim.id, type: p.type, slug: p.slug, name: p.name };
      photo = p.image_url || '';
      links = p.social_links.slice();
      mountBio();
      bioRte.setHtml(p.bio_html || p.bio);
      renderPhoto();
      renderLinks();
      countBio();
      renderPreview();
    } catch (err) {
      Toast.show(err.message, { type: 'error' });
      if (err.status === 404) await refreshClaims(); // the claim was revoked meanwhile
    }
  }

  $('editorAddLink').addEventListener('click', () => { links.push(''); renderLinks(); $('editorLinks').lastElementChild?.querySelector('input').focus(); });
  $('editorLinks').addEventListener('input', (e) => {
    if (e.target.dataset.i === undefined) return;
    links[Number(e.target.dataset.i)] = e.target.value;
    // Update just this row's icon (re-rendering the list would steal focus from the input).
    const found = SocialIcons.detect(e.target.value, { websiteLabel: t('common.website') });
    const icon = e.target.previousElementSibling;
    icon.innerHTML = found.icon;
    icon.title = found.name;
    renderPreview();
  });
  $('editorLinks').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (b) { links.splice(Number(b.dataset.remove), 1); renderLinks(); renderPreview(); }
  });
  $('editorPhotoRemove').addEventListener('click', () => { photo = ''; renderPhoto(); renderPreview(); });

  // Centre-crop to a square and shrink, so a phone photo becomes a ~40 KB JPEG.
  $('editorPhotoFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { say('editorMsg', t('account.err_image')); return; }
    if (file.size > MAX_PHOTO_FILE_BYTES) { say('editorMsg', t('account.err_image_big')); return; }
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
      photo = canvas.toDataURL('image/jpeg', 0.85);
      say('editorMsg', '');
      renderPhoto();
      renderPreview();
    } catch { say('editorMsg', t('account.err_image')); } finally { URL.revokeObjectURL(url); }
  });

  $('editorForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editing) return;
    say('editorMsg', '');
    await busy($('editorSave'), async () => {
      try {
        const saved = await api('PUT', `/claims/${editing.claimId}/profile`, {
          bio: bioRte ? bioRte.getHtml() : '', image_url: photo, social_links: links.map((u) => u.trim()).filter(Boolean),
        });
        links = saved.social_links.slice();
        renderLinks();
        renderPreview();
        say('editorMsg', t('account.saved'), true);
      } catch (err) {
        say('editorMsg', err.message);
        if (err.status === 404) { editing = null; await refreshClaims(); }
      }
    });
  });

  // ── Language ────────────────────────────────────
  // app.js loads the translations asynchronously and gives no "ready" signal, so wait for ours to appear before
  // drawing anything that calls t(); and redraw the script-built parts when the visitor switches language.
  const i18nReady = () => new Promise((resolve) => {
    let tries = 0;
    const tick = () => (I18n.t('account.court_title') !== 'account.court_title' || tries++ > 40 ? resolve() : setTimeout(tick, 100));
    tick();
  });
  function redraw() {
    if (bioRte) { const html = bioRte.getHtml(); bioRte = null; mountBio(); bioRte.setHtml(html); } // new toolbar tooltips in the chosen language
    if (account) {
      renderBanner();
      renderClaims();
      renderClaimTarget();
      renderSwitch();
      renderGreen();
      renderLinks();
      renderPreview();
      renderContactNeeds();
    } else if (target) {
      $('authClaimNote').textContent = t('account.claim_prompt', { name: target.name });
    }
  }
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  // ── Start ───────────────────────────────────────
  async function init() {
    await i18nReady();
    try { cfg = await api('GET', '/config'); } catch { /* the page still works without Google / email */ }

    // Links from our emails: /my-profile?verify=… (confirm the address) and /my-profile?reset=… (choose a new password).
    const params = new URLSearchParams(location.search);
    const verifyTok = params.get('verify');
    const resetTok = params.get('reset');
    if (verifyTok || resetTok) {
      params.delete('verify');
      params.delete('reset');
      history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`); // keep the token out of the address bar
    }
    if (verifyTok) {
      try { const r = await api('POST', '/verify-email', { token: verifyTok }); notice(t('account.verify_done', { email: r.email })); } catch (err) { notice(err.message, false); }
    }

    // Arrived from a profile's "Claim this profile" link: /my-profile?claim=artist:ann-artist
    const m = /^(artist|composer):([\w-]+)$/.exec(params.get('claim') || '');
    if (m) {
      try {
        const res = await fetch(`${CONFIG.API_BASE}/${m[1]}s/${encodeURIComponent(m[2])}`);
        if (res.ok) { const p = await res.json(); if (!p.claimed) target = { type: m[1], slug: m[2], name: p.name }; }
      } catch { /* the picker still works */ }
    }
    if (resetTok) { token = ''; store.set(''); resetToken = resetTok; showAuth('reset'); return; }
    if (token) await showHome(); else showAuth();
  }
  init();
})();
