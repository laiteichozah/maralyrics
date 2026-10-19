// ┌───────────────────────────────────────────────┐
// │        MaraLyrics — Admin Dashboard Logic     │
// └───────────────────────────────────────────────┘

'use strict';

const WORKER_ORIGIN = 'https://api.maralyrics.com';
const SITE_ORIGIN = 'https://maralyrics.com';
const API_BASE = `${WORKER_ORIGIN}/api/v1`;
const ADMIN_API = `${API_BASE}/admin`;

// ─── Shared status color maps (feedback/reports, revisions, contacts tables) ──
const REPORT_STATUS_COLORS = { pending: '#f59e0b', reviewed: '#3b82f6', resolved: '#10b981', dismissed: '#6b7280' };
const REVISION_STATUS_COLORS = { pending: '#f59e0b', approved: '#10b981', rejected: '#ef4444' };
const CONTACT_STATUS_COLORS = { unread: '#f59e0b', read: '#3b82f6', archived: '#6b7280' };

// ─── Admin session (JWT, per-account role) ──────────
const TOKEN_KEY = 'ml_admin_jwt';
const INFO_KEY = 'ml_admin_info'; // { id, username, role }

function getAdminToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
function setAdminToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}
function getAdminInfo() {
  try { return JSON.parse(localStorage.getItem(INFO_KEY) || 'null'); } catch { return null; }
}
function setAdminInfo(info) {
  localStorage.setItem(INFO_KEY, JSON.stringify(info));
}
function clearAdminSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(INFO_KEY);
}
function authHeaders(extra = {}) {
  return { ...extra, Authorization: `Bearer ${getAdminToken()}` };
}
function hasRole(...roles) {
  const info = getAdminInfo();
  return !!info && roles.includes(info.role);
}

function showLoginOverlay(message) {
  document.getElementById('loginOverlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  const errEl = document.getElementById('loginError');
  errEl.textContent = message || '';
  errEl.style.display = message ? 'block' : 'none';
}
function hideLoginOverlay() {
  document.getElementById('loginOverlay').style.display = 'none';
  document.body.style.overflow = '';
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginSubmit');
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.textContent = 'Signing in...';

  try {
    const res = await fetch(`${ADMIN_API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Login failed');

    setAdminToken(data.token);
    setAdminInfo({ id: data.id, username: data.username, role: data.role, avatar: data.avatar, photo: data.photo });
    hideLoginOverlay();
    document.getElementById('loginForm').reset();
    AdminUI.success(`Welcome back, ${data.username}!`);
    initDashboard();
  } catch (err) {
    const errEl = document.getElementById('loginError');
    errEl.textContent = err.message;
    errEl.style.display = 'block';
    AdminUI.error(err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.textContent = 'Sign In';
  }
}

function logout() {
  clearAdminSession();
  AdminUI.flash('You have been signed out.', 'info');
  location.reload();
}

// ─── Settings dropdown (My Profile / Change Password / Log Out) ────
function toggleSettingsMenu() {
  const dropdown = document.getElementById('settingsDropdown');
  dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
}
function closeSettingsMenu() {
  document.getElementById('settingsDropdown').style.display = 'none';
}

async function changePassword() {
  const current_password = window.prompt('Current password:');
  if (!current_password) return;
  const new_password = window.prompt('New password (min 8 characters):');
  if (!new_password) return;

  try {
    await apiPost(`${ADMIN_API}/auth/change-password`, { current_password, new_password });
    if (typeof Toast !== 'undefined') Toast.show('Password updated.', { type: 'success' });
    else AdminUI.alertToast('Password updated.');
  } catch (err) {
    AdminUI.alertToast('Failed to change password: ' + err.message);
  }
}

// ─── Role-based UI visibility ───────────────────────
// Keep in sync with worker/lib/permissions.js — index.js is a plain <script>,
// not a module, so it can't import that file directly; the lists are duplicated here.
const ROLES_ALL = ['viewer', 'translator', 'reviewer', 'editor', 'manager', 'super_admin'];

const CAN_CREATE_SONG        = ['translator', 'editor', 'manager', 'super_admin'];
const CAN_EDIT_SONG_DIRECT   = ['editor', 'manager', 'super_admin'];
const CAN_SUBMIT_REVISION    = ['translator', 'editor', 'manager', 'super_admin'];
const CAN_REVIEW_REVISIONS   = ['reviewer', 'manager', 'super_admin'];
const CAN_PUBLISH_UNPUBLISH  = ['reviewer', 'editor', 'manager', 'super_admin'];
const CAN_ARCHIVE_RESTORE    = ['reviewer', 'manager', 'super_admin'];
const CAN_DELETE_SONG        = ['manager', 'super_admin'];
const CAN_MANAGE_REFERENCE_DATA = ['manager', 'super_admin'];
const CAN_MANAGE_BADGES = ['super_admin']; // awarding/removing artist & composer badges
const CAN_MANAGE_ADMIN_USERS = ['manager', 'super_admin'];
const CAN_MANAGE_IDOL = ['editor', 'manager', 'super_admin']; // Mara Idol seasons & idols — create/edit
const CAN_DELETE_IDOL = ['manager', 'super_admin'];
const CAN_MANAGE_GREEN = ['super_admin']; // Green mark: prices, payment review, granting/removing marks (money)
const CAN_REVIEW_CLAIMS = ['manager', 'super_admin']; // approving a claim hands someone edit rights over a public profile
// Kept in sync with worker/lib/permissions.js (this file can't import it — plain <script>, not a module).
const CAN_CREATE_ARTICLE  = ['editor', 'manager', 'super_admin'];
const CAN_EDIT_ARTICLE    = ['editor', 'manager', 'super_admin'];
const CAN_PUBLISH_ARTICLE = ['editor', 'manager', 'super_admin'];
const CAN_DELETE_ARTICLE  = ['manager', 'super_admin'];

function statusChangePermission(fromStatus, toStatus) {
  return fromStatus === 'archived' || toStatus === 'archived' ? CAN_ARCHIVE_RESTORE : CAN_PUBLISH_UNPUBLISH;
}

// Keep in sync with worker/lib/avatars.js — the built-in, no-upload avatar set.
const AVATARS = [
  '🦊', '🐱', '🐶', '🐼', '🐨', '🐵', '🦁', '🐯',
  '🐸', '🐧', '🦉', '🦄', '🐝', '🦋', '🐢', '🐙',
  '🦖', '🐳', '🌵', '🌸', '⭐', '🔥', '🎧', '🎸',
];

// Default avatar: an inline SVG silhouette (the 👤 emoji renders as tofu / inconsistently on some systems).
const DEFAULT_AVATAR_SVG = '<svg class="profile-avatar__default" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8" r="4.2"/><path d="M3.5 21c0-4.7 3.8-7.8 8.5-7.8s8.5 3.1 8.5 7.8z"/></svg>';

// One small icon per role, drawn in a 24x24 box and filled white inside the colored role mark.
const ROLE_MARK_ICON = {
  viewer: '<path d="M12 5C7 5 2.7 8.1 1 12c1.7 3.9 6 7 11 7s9.3-3.1 11-7c-1.7-3.9-6-7-11-7zm0 11a4 4 0 110-8 4 4 0 010 8zm0-6a2 2 0 100 4 2 2 0 000-4z"/>',
  translator: '<path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/>',
  reviewer: '<path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" stroke="currentColor" stroke-width="1.5"/>',
  editor: '<path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75z"/>',
  manager: '<path d="M12 2l3 6.5 7 .9-5.2 4.8 1.4 7L12 17.8l-6.2 3.4 1.4-7L2 9.4l7-.9z"/>',
  super_admin: '<path d="M6.5 3h11L22 9l-10 13L2 9z"/>',
};

function roleMarkHtml(role) {
  const icon = ROLE_MARK_ICON[role];
  if (!icon) return '';
  return `<span class="role-mark role-mark--${role}" title="${escapeHtml(roleLabel(role))}" aria-label="${escapeHtml(roleLabel(role))}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span>`;
}

// photo (uploaded) > emoji avatar > default icon, with the role's mark on the corner.
// `size` is '' (header/list, 32px) or 'lg' (profile card).
function avatarMarkupFor({ photo, avatar, role } = {}, size = '') {
  const inner = photo
    ? `<img class="profile-avatar__img" src="${escapeHtml(photo)}" alt="" />`
    : (avatar ? escapeHtml(avatar) : DEFAULT_AVATAR_SVG);
  const sizeClass = size === 'lg' ? 'profile-avatar--lg' : 'profile-avatar--sm';
  return `<span class="avatar-wrap${size === 'lg' ? ' avatar-wrap--lg' : ''}"><span class="profile-avatar ${sizeClass}">${inner}</span>${roleMarkHtml(role)}</span>`;
}

const ROLE_TABS = {
  songs: ROLES_ALL,
  artists: ROLES_ALL,
  composers: ROLES_ALL,
  'copyright-owners': ROLES_ALL,
  articles: ROLES_ALL,
  'mara-idol': ROLES_ALL,
  claims: CAN_REVIEW_CLAIMS,
  green: CAN_MANAGE_GREEN,
  supporters: CAN_MANAGE_REFERENCE_DATA,
  reports: ['translator', 'reviewer', 'editor', 'manager', 'super_admin'],
  revisions: ['reviewer', 'manager', 'super_admin'],
  auditlog: ['reviewer', 'manager', 'super_admin'],
  contacts: ['super_admin'],
  admins: ['manager', 'super_admin'],
};

function applyRoleVisibility() {
  const info = getAdminInfo();
  const avatarEl = document.getElementById('headerUserAvatar');
  const nameEl = document.getElementById('headerUserName');
  if (avatarEl && nameEl) {
    avatarEl.innerHTML = avatarMarkupFor(info || {});
    nameEl.textContent = info ? info.username : 'Admin';
  }

  let firstVisibleTab = null;
  document.querySelectorAll('.admin__tab').forEach((tab) => {
    const allowed = ROLE_TABS[tab.dataset.tab] || [];
    const visible = !!info && allowed.includes(info.role);
    tab.style.display = visible ? '' : 'none';
    if (visible && !firstVisibleTab) firstVisibleTab = tab.dataset.tab;
  });

  const activeTab = document.querySelector('.admin__tab.active');
  if (firstVisibleTab && (!activeTab || activeTab.style.display === 'none')) {
    switchTab(firstVisibleTab);
  }

  // Per-button gating within a visible tab — a role can see a tab but not every action in it.
  toggleEl('btnNewSong', hasRole(...CAN_CREATE_SONG));
  toggleEl('btnNewArtist', hasRole(...CAN_MANAGE_REFERENCE_DATA));
  toggleEl('btnNewComposer', hasRole(...CAN_MANAGE_REFERENCE_DATA));
  toggleEl('btnNewCopyrightOwner', hasRole(...CAN_MANAGE_REFERENCE_DATA));
  toggleEl('btnNewSupporter', hasRole(...CAN_MANAGE_REFERENCE_DATA));
  toggleEl('btnNewIdolSeason', hasRole(...CAN_MANAGE_IDOL));
  toggleEl('btnNewIdol', hasRole(...CAN_MANAGE_IDOL));
  toggleEl('btnNewArticle', hasRole(...CAN_CREATE_ARTICLE));
  toggleEl('btnNewAdminUser', hasRole(...CAN_MANAGE_ADMIN_USERS));
  wireQuickAdd();

  const superAdminOption = document.querySelector('#auFormRole option[value="super_admin"]');
  if (superAdminOption) superAdminOption.style.display = hasRole('super_admin') ? '' : 'none';
}

function toggleEl(id, visible) {
  const el = document.getElementById(id);
  if (el) el.style.display = visible ? '' : 'none';
}

function roleLabel(role) {
  return {
    viewer: 'Viewer',
    translator: 'Translator',
    reviewer: 'Reviewer',
    editor: 'Editor',
    manager: 'Manager',
    super_admin: 'Super Admin',
  }[role] || role;
}

// Per-role badge color, escalating from neutral (viewer) to the gradient reserved
// for super_admin — keeps "who can do what" scannable at a glance anywhere a role
// is shown (header, admins table, profile card, profile directory).
const ROLE_BADGE_CLASS = {
  viewer: 'role-badge--viewer',
  translator: 'role-badge--translator',
  reviewer: 'role-badge--reviewer',
  editor: 'role-badge--editor',
  manager: 'role-badge--manager',
  super_admin: 'role-badge--super_admin',
};
function roleBadgeClass(role) {
  return 'role-badge ' + (ROLE_BADGE_CLASS[role] || '');
}
function roleBadgeHtml(role, extraClass = '') {
  return `<span class="${roleBadgeClass(role)}${extraClass ? ' ' + extraClass : ''}">${escapeHtml(roleLabel(role))}</span>`;
}

// State
let currentPage = 1;
let totalPages = 1;
let allSongs = [];
let allArtists = [];
let allComposers = [];
let deleteTargetId = null;
let deleteTargetType = 'song'; // 'song' | 'artist' | 'composer' | 'report' | 'admin-user' | 'contact'
let allReports = [];
let allCopyrightOwners = [];
let allSupporters = [];
let allIdolSeasons = [];
let allIdols = [];
let allArticles = [];
let allAdminUsers = [];
let allRevisions = [];
let allAuditLog = [];
let allContacts = [];
let currentRevisionId = null;
let currentProfileId = null;
let currentProfileIsFollowing = false;
let selectedAvatar = null;
let allAdminDirectory = [];

// ═══════════════════════════════════════════════════
// ═══ DRAFT MANAGEMENT (localStorage auto-save) ════
// ═══════════════════════════════════════════════════

const DRAFT_PREFIX = 'ml_admin_draft_';

function draftKey(type, id) {
  return DRAFT_PREFIX + type + '_' + (id || 'new');
}
function saveDraft(type, id, data) {
  try { localStorage.setItem(draftKey(type, id), JSON.stringify({ data, savedAt: Date.now() })); } catch {}
}
function loadDraft(type, id) {
  try {
    const raw = localStorage.getItem(draftKey(type, id));
    if (!raw) return null;
    return JSON.parse(raw).data || null;
  } catch { return null; }
}
function clearDraft(type, id) {
  try { localStorage.removeItem(draftKey(type, id)); } catch {}
}
function showDraftBanner(bannerId) {
  const banner = document.getElementById(bannerId);
  if (banner) banner.style.display = 'flex';
}
function hideDraftBanner(bannerId, indicatorId) {
  const banner = document.getElementById(bannerId);
  if (banner) banner.style.display = 'none';
  if (indicatorId) {
    const ind = document.getElementById(indicatorId);
    if (ind) ind.style.display = 'none';
  }
}
function updateDraftIndicator(indicatorId) {
  const ind = document.getElementById(indicatorId);
  if (!ind) return;
  const now = new Date();
  ind.textContent = 'Draft saved at ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  ind.style.display = 'block';
}

// Checkbox-list helpers (Artist/Composer fields allow picking more than one, up to 20).
// A checkbox list is used instead of a native <select multiple> because a plain click on
// an option in <select multiple> — without holding Ctrl/Cmd — silently deselects every
// other option, which previously caused real data loss (a song's existing artist/composer
// credits got wiped just by clicking to add one more without the modifier key held).
const MAX_CREDITED_PEOPLE_CLIENT = 20;

// "Unknown" is a UI-only sentinel — a song can genuinely have no known artist/composer
// (traditional/folk songs). It isn't a real artist/composer row: checking it just means
// "confirmed unknown", mutually exclusive with picking real people, and saves as an empty
// artist_ids/composer_ids array exactly like leaving the list untouched would.
const UNKNOWN_CHECKBOX_SELECTOR = 'input[data-unknown="1"]';

function getSelectedIds(containerEl) {
  if (!containerEl) return [];
  return Array.from(containerEl.querySelectorAll(`input[type="checkbox"]:checked:not(${UNKNOWN_CHECKBOX_SELECTOR})`))
    .map(cb => Number(cb.value));
}
function setSelectedIds(containerEl, ids) {
  if (!containerEl) return;
  const set = new Set((ids || []).map(Number));
  containerEl.querySelectorAll(`input[type="checkbox"]:not(${UNKNOWN_CHECKBOX_SELECTOR})`).forEach(cb => {
    cb.checked = set.has(Number(cb.value));
  });
  const unknownCb = containerEl.querySelector(UNKNOWN_CHECKBOX_SELECTOR);
  if (unknownCb) unknownCb.checked = false;
  updateCheckboxListState(containerEl);
}

function updateCheckboxListState(containerEl) {
  if (!containerEl) return;
  const unknownCb = containerEl.querySelector(UNKNOWN_CHECKBOX_SELECTOR);
  const realBoxes = Array.from(containerEl.querySelectorAll(`input[type="checkbox"]:not(${UNKNOWN_CHECKBOX_SELECTOR})`));
  const selectedCount = realBoxes.filter(cb => cb.checked).length;

  // Mutually exclusive: picking "Unknown" disables real options, and vice versa.
  if (unknownCb) {
    realBoxes.forEach(cb => { cb.disabled = unknownCb.checked; });
    unknownCb.disabled = selectedCount > 0;
  }

  const countEl = containerEl.parentElement?.querySelector('.checkbox-list__count');
  if (countEl) {
    countEl.textContent = `${selectedCount} / ${MAX_CREDITED_PEOPLE_CLIENT} selected`;
    countEl.classList.toggle('checkbox-list__count--full', selectedCount >= MAX_CREDITED_PEOPLE_CLIENT);
  }
}

function buildCheckboxList(containerEl, items) {
  if (!containerEl) return;
  const unknownRow = `
    <label class="checkbox-list__item checkbox-list__item--unknown">
      <input type="checkbox" data-unknown="1" />
      <span>Unknown</span>
    </label>
    <div class="checkbox-list__divider"></div>
  `;
  const itemRows = items.map(item => `
    <label class="checkbox-list__item" data-name="${escapeHtml(normalizeForSearch(item.name))}">
      <input type="checkbox" value="${item.id}" />
      ${entityAvatarHtml(item.image_url, 'xs')}
      <span>${escapeHtml(item.name)}</span>
    </label>
  `).join('') || '<div class="checkbox-list__empty">None yet.</div>';

  containerEl.innerHTML = unknownRow + itemRows;

  containerEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (getSelectedIds(containerEl).length > MAX_CREDITED_PEOPLE_CLIENT) {
        cb.checked = false;
        if (typeof Toast !== 'undefined') Toast.show(`You can select up to ${MAX_CREDITED_PEOPLE_CLIENT}.`, { type: 'error' });
        else AdminUI.alertToast(`You can select up to ${MAX_CREDITED_PEOPLE_CLIENT}.`);
      }
      updateCheckboxListState(containerEl);
    });
  });
  updateCheckboxListState(containerEl);
}
function wireCheckboxListFilter(filterEl, containerEl) {
  if (!filterEl || !containerEl) return;
  filterEl.addEventListener('input', () => {
    const q = normalizeForSearch(filterEl.value).trim();
    // "Unknown" is pinned at the top and always stays visible regardless of the filter —
    // it has no `data-name` since it isn't a real, filterable artist/composer.
    containerEl.querySelectorAll('.checkbox-list__item:not(.checkbox-list__item--unknown)').forEach((row) => {
      row.classList.toggle('checkbox-list__item--hidden', !!q && !row.dataset.name.includes(q));
    });
  });
}

// ─── Song Draft ─────────────────────────────────
let _songDraftTimer = null;
function autoSaveSongDraft() {
  clearTimeout(_songDraftTimer);
  _songDraftTimer = setTimeout(() => {
    const id = document.getElementById('formSongId')?.value || null;
    const data = {
      title: document.getElementById('formTitle')?.value || '',
      artist_ids: getSelectedIds(document.getElementById('formArtist')),
      composer_ids: getSelectedIds(document.getElementById('formComposer')),
      category: document.getElementById('formCategory')?.value || '',
      copyright_owner_id: document.getElementById('formCopyrightOwner')?.value || '',
      slug: document.getElementById('formSlug')?.value || '',
      lyrics: document.getElementById('formLyrics')?.value || '',
    };
    if (data.title || data.lyrics) {
      saveDraft('song', id, data);
      updateDraftIndicator('songDraftIndicator');
    }
  }, 1500);
}
function restoreSongDraftData(draft) {
  if (!draft) return;
  if (draft.title !== undefined) document.getElementById('formTitle').value = draft.title;
  if (draft.artist_ids?.length) setSelectedIds(document.getElementById('formArtist'), draft.artist_ids);
  if (draft.composer_ids?.length) setSelectedIds(document.getElementById('formComposer'), draft.composer_ids);
  if (draft.category) document.getElementById('formCategory').value = draft.category;
  if (draft.copyright_owner_id) document.getElementById('formCopyrightOwner').value = draft.copyright_owner_id;
  if (draft.slug !== undefined) {
    document.getElementById('formSlug').value = draft.slug;
    if (draft.slug) document.getElementById('formSlug').dataset.manual = '1';
  }
  if (draft.lyrics !== undefined) document.getElementById('formLyrics').value = draft.lyrics;
}

// ─── Person Draft ────────────────────────────────
let _personDraftTimer = null;
function autoSavePersonDraft() {
  clearTimeout(_personDraftTimer);
  _personDraftTimer = setTimeout(() => {
    const type = document.getElementById('personFormType')?.value || 'artist';
    const id = document.getElementById('personFormId')?.value || null;
    const data = {
      name: document.getElementById('personFormName')?.value || '',
      slug: document.getElementById('personFormSlug')?.value || '',
      bio: personBioRte ? personBioRte.getHtml() : '',
    };
    if (data.name || data.bio) {
      saveDraft(type, id, data);
      updateDraftIndicator('personDraftIndicator');
    }
  }, 1500);
}
function restorePersonDraftData(draft) {
  if (!draft) return;
  if (draft.name !== undefined) document.getElementById('personFormName').value = draft.name;
  if (draft.slug !== undefined) {
    document.getElementById('personFormSlug').value = draft.slug;
    if (draft.slug) document.getElementById('personFormSlug').dataset.manual = '1';
  }
  if (draft.bio !== undefined && personBioRte) personBioRte.setHtml(draft.bio);
}

// ─── Copyright Owner Draft ───────────────────────
let _coDraftTimer = null;
function autoSaveCoDraft() {
  clearTimeout(_coDraftTimer);
  _coDraftTimer = setTimeout(() => {
    const id = document.getElementById('coFormId')?.value || null;
    const data = {
      name: document.getElementById('coFormName')?.value || '',
      slug: document.getElementById('coFormSlug')?.value || '',
      full_legal_name: document.getElementById('coFormFullLegalName')?.value || '',
      organization: document.getElementById('coFormOrganization')?.value || '',
      territory: document.getElementById('coFormTerritory')?.value || '',
    };
    if (data.name) {
      saveDraft('copyright-owner', id, data);
      updateDraftIndicator('coDraftIndicator');
    }
  }, 1500);
}
function restoreCoDraftData(draft) {
  if (!draft) return;
  if (draft.name !== undefined) document.getElementById('coFormName').value = draft.name;
  if (draft.slug !== undefined) {
    document.getElementById('coFormSlug').value = draft.slug;
    if (draft.slug) document.getElementById('coFormSlug').dataset.manual = '1';
  }
  if (draft.full_legal_name !== undefined) document.getElementById('coFormFullLegalName').value = draft.full_legal_name;
  if (draft.organization !== undefined) document.getElementById('coFormOrganization').value = draft.organization;
  if (draft.territory !== undefined) document.getElementById('coFormTerritory').value = draft.territory;
}

// Helpers
// Escapes all 5 HTML-significant characters, not just &/</> — this value gets embedded both
// in text content AND inside double-quoted HTML attributes (title="...", value="...", data-*)
// throughout this file. A DOM textContent round-trip only escapes &/</>, which left a real
// stored-XSS hole: a double quote in a song title, username, or report body could break out
// of an attribute and inject a new one (e.g. onmouseover=) — exploitable by anyone who could
// set that field, including anonymous public report/contact submissions.
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatViews(n) {
  if (!n || n < 1000) return String(n || 0);
  if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

// Diacritic- and case-insensitive text match, so "rama" also finds "Ramâ" — same
// normalization approach as the slug generator, applied here to search filtering.
function normalizeForSearch(str) {
  return String(str || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

// Client-side filter for tabs that load their full dataset up front (Artists, Composers,
// Copyright Owners, Reports, Revisions, Contacts, Admins, Audit Log) — checks each of
// `fields` on every item for a substring match against the query.
function filterBySearch(items, query, fields) {
  const q = normalizeForSearch(query).trim();
  if (!q) return items;
  return items.filter(item => fields.some(f => normalizeForSearch(item[f]).includes(q)));
}

function generateSlug(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // strip combining diacritics (â→a, ô→o, ...) instead of deleting the letter
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── API Calls ──────────────────────────────────
async function handleAuthFailure(res) {
  if (res.status === 401) {
    clearAdminSession();
    showLoginOverlay('Session expired. Please sign in again.');
    AdminUI.notify('Your session expired. Please sign in again.', 'warning');
  }
}

// Carries the HTTP status + parsed body onto the thrown Error (not just its message) so
// callers can tell a 409 conflict apart from any other failure and read the server's
// current version back out of err.body.current — used by the offline sync queue and by
// direct online saves alike, since a conflicting concurrent edit can happen either way.
function apiError(status, data) {
  const err = new Error((data && data.error) || `Error ${status}`);
  err.status = status;
  err.body = data;
  return err;
}

// Every helper feeds the top progress bar. Writes (POST/PUT/DELETE) also put a spinner on
// the button the admin just pressed and, when `opts.success` is given, toast on success.
// opts.silent skips the button spinner (used for background work like the offline sync).
async function apiRequest(method, url, body, opts = {}) {
  const isWrite = method !== 'GET';
  const btn = isWrite && !opts.silent ? AdminUI.activeButton() : null;
  const dialog = isWrite && !opts.silent;
  if (dialog) AdminUI.showLoading(opts.loading || (method === 'DELETE' ? 'Deleting…' : 'Saving…'));
  AdminUI.setBusy(btn, true);
  try {
    const res = await AdminUI.track(fetch(url, {
      method,
      headers: authHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }));
    if (!res.ok) {
      await handleAuthFailure(res);
      throw apiError(res.status, await res.json().catch(() => ({})));
    }
    // Writes may legitimately return an empty body; reads must be valid JSON (as before).
    const data = isWrite ? await res.json().catch(() => ({})) : await res.json();
    if (opts.success) AdminUI.success(opts.success);
    return data;
  } finally {
    AdminUI.setBusy(btn, false);
    if (dialog) AdminUI.hideLoading();
  }
}

// Declared as functions (not const) so they stay reachable as window.apiPost etc. — offline-sync.js relies on that.
function apiGet(url) { return apiRequest('GET', url); }
function apiPost(url, body, opts) { return apiRequest('POST', url, body, opts); }
function apiPut(url, body, opts) { return apiRequest('PUT', url, body, opts); }
function apiDelete(url, opts) { return apiRequest('DELETE', url, undefined, opts); }

// ─── Tab Switching ──────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.admin__tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.admin__panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById('panel' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (panel) panel.style.display = 'block';
  try { sessionStorage.setItem('admin_tab', tab); } catch {}

  if (tab === 'artists') loadArtists();
  if (tab === 'composers') loadComposers();
  if (tab === 'reports') loadReports();
  if (tab === 'copyright-owners') loadCopyrightOwners();
  if (tab === 'articles') loadArticles();
  if (tab === 'supporters') loadSupporters();
  if (tab === 'mara-idol') loadIdol();
  if (tab === 'claims') loadClaims();
  if (tab === 'green') loadGreenAdmin();
  if (tab === 'admins') loadAdminUsers();
  if (tab === 'revisions') loadRevisions();
  if (tab === 'auditlog') loadAuditLog();
  if (tab === 'contacts') loadContacts();
}

// ─── Populate Artist/Composer Dropdowns ─────────
// Deduped: called both at startup and every time the song modal opens. Without this,
// two concurrent calls could each rebuild the checkbox lists' innerHTML — if the
// startup call's rebuild lands AFTER a form's selections were just set, it silently
// wipes them back to unchecked.
let dropdownsLoadPromise = null;

async function populateDropdowns() {
  if (dropdownsLoadPromise) return dropdownsLoadPromise;
  dropdownsLoadPromise = (async () => {
    try {
      const [aData, cData, coData] = await Promise.all([
        apiGet(`${ADMIN_API}/artists`),
        apiGet(`${ADMIN_API}/composers`),
        apiGet(`${ADMIN_API}/copyright-owners`),
      ]);
      allArtists = aData.artists || [];
      allComposers = cData.composers || [];
      allCopyrightOwners = coData.copyright_owners || [];
      OfflineSync.cacheReferenceData({
        artists: allArtists, composers: allComposers, copyright_owners: allCopyrightOwners,
      }).catch(() => {});
    } catch (err) {
      console.warn('Failed to load dropdowns:', err);
      if (OfflineSync.isNetworkError(err)) {
        const cached = await OfflineSync.getCachedReferenceData();
        allArtists = cached.artists || [];
        allComposers = cached.composers || [];
        allCopyrightOwners = cached.copyright_owners || [];
      }
    }

    buildCheckboxList(document.getElementById('formArtist'), allArtists);
    buildCheckboxList(document.getElementById('formComposer'), allComposers);

    const coSel = document.getElementById('formCopyrightOwner');
    if (coSel) {
      coSel.innerHTML = '<option value="">— None —</option>' +
        allCopyrightOwners.map(co => `<option value="${co.id}">${escapeHtml(co.name)}</option>`).join('');
    }
  })();
  try {
    await dropdownsLoadPromise;
  } finally {
    dropdownsLoadPromise = null;
  }
}

// ─── Inline "create new" in the song form ───────
// Creates just the name (the server derives the slug); the full record can be filled in later
// from the Artists / Composers / Copyright Owners tabs. The new entry is added to the list and
// auto-selected so the song being written needs no round trip. Same permission as those tabs.
const QUICK_ADD = {
  artist: { path: 'artists', label: 'artist' },
  composer: { path: 'composers', label: 'composer' },
  'copyright-owner': { path: 'copyright-owners', label: 'copyright holder' },
};

function wireQuickAdd() {
  const allowed = hasRole(...CAN_MANAGE_REFERENCE_DATA);
  document.querySelectorAll('.quick-add').forEach((box) => {
    box.style.display = allowed ? '' : 'none';
    if (box.dataset.wired) return;
    box.dataset.wired = '1';
    const toggle = box.querySelector('.quick-add__toggle');
    const form = box.querySelector('.quick-add__form');
    const input = box.querySelector('.quick-add__input');
    const save = box.querySelector('.quick-add__save');
    const close = () => { form.style.display = 'none'; toggle.style.display = ''; input.value = ''; };
    toggle.addEventListener('click', () => { toggle.style.display = 'none'; form.style.display = 'flex'; input.focus(); });
    box.querySelector('.quick-add__cancel').addEventListener('click', close);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save.click(); }
      else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
    save.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      const { path, label } = QUICK_ADD[box.dataset.kind];
      save.disabled = true;
      try {
        const created = await apiPost(`${ADMIN_API}/${path}`, { name });
        addQuickCreated(box.dataset.kind, created);
        if (typeof Toast !== 'undefined') Toast.show(`Created ${label} "${created.name}".`, { type: 'success' });
        close();
      } catch (err) {
        if (typeof Toast !== 'undefined') Toast.show(err.message || `Could not create ${label}.`, { type: 'error' });
        else AdminUI.alertToast(err.message || `Could not create ${label}.`);
      } finally {
        save.disabled = false;
      }
    });
  });
}

function addQuickCreated(kind, created) {
  if (kind === 'copyright-owner') {
    allCopyrightOwners.push(created);
    const sel = document.getElementById('formCopyrightOwner');
    sel.insertAdjacentHTML('beforeend', `<option value="${created.id}">${escapeHtml(created.name)}</option>`);
    sel.value = String(created.id);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    const list = kind === 'artist' ? allArtists : allComposers;
    const el = document.getElementById(kind === 'artist' ? 'formArtist' : 'formComposer');
    const selected = getSelectedIds(el);
    list.push(created);
    buildCheckboxList(el, list);
    // Rebuilding resets every checkbox — restore the prior picks, then tick the new one.
    setSelectedIds(el, [...selected, created.id].slice(0, MAX_CREDITED_PEOPLE_CLIENT));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// ═══════════════════════════════════════════════════
// ═══ SONGS ════════════════════════════════════════
// ═══════════════════════════════════════════════════

let currentSearchQuery = '';

async function loadSongs(page = 1, query = currentSearchQuery) {
  const tbody = document.getElementById('songsTableBody');
  tbody.innerHTML = AdminUI.loadingRows(8);
  currentSearchQuery = query || '';

  try {
    // Search runs server-side across the whole table, not just the currently loaded
    // page — filtering only `allSongs` client-side would silently miss matches on
    // any page other than the one currently displayed.
    const qParam = currentSearchQuery ? `&q=${encodeURIComponent(currentSearchQuery)}` : '';
    const data = await apiGet(`${ADMIN_API}/songs?page=${page}&limit=50${qParam}`);
    allSongs = data.songs || [];
    currentPage = data.page;
    totalPages = data.totalPages;

    OfflineSync.cacheList('song', allSongs).catch(() => {});
    renderSongsTable(allSongs);
    renderPagination();
  } catch (err) {
    if (!OfflineSync.isNetworkError(err)) {
      tbody.innerHTML = `<tr><td colspan="8" class="admin-table__empty" style="color:var(--danger);">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
      return;
    }
    // Offline (or the API is unreachable) — fall back to whatever was last cached,
    // filtered client-side since the server-side search can't run.
    try {
      const cached = await OfflineSync.getCachedList('song');
      allSongs = filterBySearch(cached, currentSearchQuery, ['title', 'artist_name', 'composer_name', 'category'])
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      currentPage = 1;
      totalPages = 1;
      renderSongsTable(allSongs);
      document.getElementById('adminPagination').innerHTML = '';
      if (typeof Toast !== 'undefined') Toast.show('Offline — showing cached songs.', { type: 'info' });
    } catch {
      tbody.innerHTML = '<tr><td colspan="8" class="admin-table__empty" style="color:var(--danger);">Offline and no cached songs available.</td></tr>';
    }
  }
}

function statusBadgeHtml(status) {
  const labels = { pending: 'Pending', published: 'Published', archived: 'Archived' };
  return `<span class="status-badge status-badge--${status}">${labels[status] || status}</span>`;
}

// Inline Publish/Set-Pending/Archive/Restore icons for the songs table row — same
// permission split as the backend's PUT /songs/:id/status (Editor gets publish/unpublish
// but never archive/restore).
function songStatusActionsHtml(song) {
  const info = getAdminInfo();
  if (!info) return '';
  const allowed = (target) => statusChangePermission(song.status, target).includes(info.role);
  const buttons = [];

  if (song.status !== 'published' && allowed('published')) {
    buttons.push(`<button class="btn btn--sm btn--ghost" onclick="changeSongStatus(${song.id}, 'published')" title="Publish">📢</button>`);
  }
  if (song.status === 'published' && allowed('pending')) {
    buttons.push(`<button class="btn btn--sm btn--ghost" onclick="changeSongStatus(${song.id}, 'pending')" title="Set Pending">⏸️</button>`);
  }
  if (song.status !== 'archived' && allowed('archived')) {
    buttons.push(`<button class="btn btn--sm btn--ghost" onclick="changeSongStatus(${song.id}, 'archived')" title="Archive">🗄️</button>`);
  }
  if (song.status === 'archived' && allowed('pending')) {
    buttons.push(`<button class="btn btn--sm btn--ghost" onclick="changeSongStatus(${song.id}, 'pending')" title="Restore">♻️</button>`);
  }
  return buttons.join('');
}

async function changeSongStatus(id, status) {
  try {
    const updated = await apiPut(`${ADMIN_API}/songs/${id}/status`, { status }, { success: `Song marked ${status}.` });
    const song = allSongs.find(s => s.id === id);
    if (song) song.status = updated.status;
    renderSongsTable(allSongs);
    if (document.getElementById('formSongId')?.value == id) {
      renderSongStatusRow(updated);
    }
  } catch (err) {
    if (typeof Toast !== 'undefined') Toast.show('Failed to update status: ' + err.message, { type: 'error' });
    else AdminUI.alertToast('Failed to update status: ' + err.message);
  }
}

function renderSongsTable(songs) {
  const tbody = document.getElementById('songsTableBody');

  if (!songs.length) {
    tbody.innerHTML = currentSearchQuery
      ? '<tr><td colspan="8" class="admin-table__empty">No songs match your search.</td></tr>'
      : '<tr><td colspan="8" class="admin-table__empty">No songs found. Click "+ New Song" to add one.</td></tr>';
    return;
  }

  const canDelete = hasRole(...CAN_DELETE_SONG);
  // Viewer/Reviewer get every field disabled by applySongModalPermissions() once the
  // modal opens (neither can edit-direct nor submit-revision) — reflect that up front
  // instead of labeling it "Edit" for a form they can't actually change anything in.
  const canEditOrReview = hasRole(...CAN_CREATE_SONG);

  tbody.innerHTML = songs.map((song) => {
    // Not-yet-synced records (created offline, or an offline edit queued against a real
    // song) never get status-change/delete/view-live actions — there's nothing live to
    // act on until the sync queue lands them on the server.
    const isUnsynced = song._offlineLocal || song._offlinePending || OfflineSync.isPending('song', song.id);
    const hasConflict = OfflineSync.hasConflict('song', song.id);
    const idArg = JSON.stringify(song.id);
    const syncBadge = hasConflict
      ? '<span class="sync-badge sync-badge--conflict" title="A newer version exists on the server">⚠️ Conflict</span>'
      : isUnsynced ? '<span class="sync-badge sync-badge--pending" title="Queued, waiting to sync">🔄 Pending sync</span>' : '';

    return `
    <tr data-id="${song.id}">
      <td>
        <div class="admin-table__title">${escapeHtml(song.title)}</div>
        <div class="admin-table__slug">/song/${escapeHtml(song.slug)}</div>
      </td>
      <td>${escapeHtml(song.artist_name || song.artist || '—')}</td>
      <td>${escapeHtml(song.composer_name || song.composer || '—')}</td>
      <td>${song.category ? `<span class="song-card__category">${escapeHtml(song.category)}</span>` : '—'}</td>
      <td>${statusBadgeHtml(song.status || 'published')}${syncBadge}</td>
      <td>${formatViews(song.views)}</td>
      <td>${formatDate(song.created_at)}</td>
      <td>
        <div class="admin-table__actions">
          ${canEditOrReview
            ? `<button class="btn btn--sm btn--ghost" onclick="editSong(${idArg})" title="Edit">✏️</button>`
            : `<button class="btn btn--sm btn--ghost" onclick="editSong(${idArg})" title="View">👁️</button>`}
          ${isUnsynced ? '' : songStatusActionsHtml(song)}
          ${canDelete && !isUnsynced ? `<button class="btn btn--sm btn--ghost btn--danger-text" onclick="confirmDelete(${idArg}, 'song')" title="Delete">🗑️</button>` : ''}
          ${isUnsynced ? '' : `<a href="${SITE_ORIGIN}/song/${escapeHtml(song.slug)}" target="_blank" class="btn btn--sm btn--ghost" title="View">👁️</a>`}
        </div>
      </td>
    </tr>
  `;
  }).join('');
}

function renderPagination() {
  const el = document.getElementById('adminPagination');
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  let html = `<button class="pagination__btn" ${currentPage <= 1 ? 'disabled' : ''} onclick="loadSongs(${currentPage - 1})">← Prev</button>`;
  html += `<span class="pagination__info">Page ${currentPage} of ${totalPages}</span>`;
  html += `<button class="pagination__btn" ${currentPage >= totalPages ? 'disabled' : ''} onclick="loadSongs(${currentPage + 1})">Next →</button>`;
  el.innerHTML = html;
}

// Site-wide totals (NOT affected by pagination or search) — sourced from the public
// /stats endpoint, which aggregates across the whole table, unlike the paginated song list.
async function refreshStats() {
  try {
    const stats = await apiGet(`${API_BASE}/stats`);
    document.getElementById('statTotal').textContent = stats.songs ?? 0;
    document.getElementById('statCategories').textContent = stats.categories ?? 0;
    document.getElementById('statViews').textContent = formatViews(stats.total_views ?? 0);
  } catch { /* ignore — stat cards just keep showing the previous values */ }
}

// Song Modal
function openSongModal() {
  document.getElementById('songModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function closeSongModal() {
  document.getElementById('songModal').style.display = 'none';
  document.body.style.overflow = '';
  clearSongForm();
}
function clearSongForm() {
  document.getElementById('songForm').reset();
  document.getElementById('formSongId').value = '';
  document.getElementById('formMessage').style.display = 'none';
  // .reset() reverts field values but never touches dataset — without this the
  // "manual" flag can survive from a slug edited in a previous session and
  // silently block auto-slug generation for every song created/edited after.
  document.getElementById('formSlug').dataset.manual = '';
  currentSongLoadedUpdatedAt = null;
  hideDraftBanner('songDraftBanner', 'songDraftIndicator');
}
function showFormMessage(text, isError = false) {
  const el = document.getElementById('formMessage');
  el.textContent = text;
  el.className = 'form-message ' + (isError ? 'form-message--error' : 'form-message--success');
  el.style.display = 'block';
}

// Disables/enables the song content fields (everything except the status row) — used by
// applySongModalPermissions so a role that can only view or only change status never gets
// a form it can silently edit and lose.
function setSongFieldsDisabled(disabled) {
  ['formTitle', 'formCopyrightOwner', 'formCategory', 'formSlug', 'formLyrics'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  ['formArtist', 'formComposer'].forEach((id) => {
    const container = document.getElementById(id);
    if (!container) return;
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.disabled = disabled; });
    if (!disabled) updateCheckboxListState(container); // reconcile Unknown/real mutual exclusivity
  });
}

// Populates the status badge + Publish/Set-Pending/Archive/Restore buttons, each shown only
// if the current role has that specific permission for the song's current status — mirrors
// the backend's statusChangePermission() split (Editor: publish/unpublish, not archive/restore).
function renderSongStatusRow(song) {
  const row = document.getElementById('songStatusRow');
  const badge = document.getElementById('songStatusBadge');
  const actions = document.getElementById('songStatusActions');
  if (!row || !badge || !actions) return;
  if (!song || !song.status) { row.style.display = 'none'; return; }

  row.style.display = 'flex';
  badge.className = 'status-badge status-badge--' + song.status;
  badge.textContent = { pending: 'Pending', published: 'Published', archived: 'Archived' }[song.status] || song.status;

  const info = getAdminInfo();
  const allowed = (target) => !!info && statusChangePermission(song.status, target).includes(info.role);
  const buttons = [];
  if (song.status !== 'published' && allowed('published')) {
    buttons.push(`<button type="button" class="btn btn--sm btn--ghost" onclick="changeSongStatus(${song.id}, 'published')">Publish</button>`);
  }
  if (song.status === 'published' && allowed('pending')) {
    buttons.push(`<button type="button" class="btn btn--sm btn--ghost" onclick="changeSongStatus(${song.id}, 'pending')">Set Pending</button>`);
  }
  if (song.status !== 'archived' && allowed('archived')) {
    buttons.push(`<button type="button" class="btn btn--sm btn--ghost" onclick="changeSongStatus(${song.id}, 'archived')">Archive</button>`);
  }
  if (song.status === 'archived' && allowed('pending')) {
    buttons.push(`<button type="button" class="btn btn--sm btn--ghost" onclick="changeSongStatus(${song.id}, 'pending')">Restore</button>`);
  }
  actions.innerHTML = buttons.join('');
}

// Drives every role-conditional part of the song modal (field editability, status row,
// which of Update Song / Submit for Revision are offered) from two facts: are we creating
// or editing, and what can this role do. See migrations/0004 + worker/lib/permissions.js.
function applySongModalPermissions(mode, role, song) {
  const btnSubmit = document.getElementById('btnSubmit');
  const btnSubmitRevision = document.getElementById('btnSubmitRevision');
  const statusRow = document.getElementById('songStatusRow');

  if (mode === 'create') {
    setSongFieldsDisabled(false);
    statusRow.style.display = 'none';
    btnSubmit.style.display = '';
    btnSubmit.textContent = 'Create Song';
    btnSubmitRevision.style.display = 'none';
    return;
  }

  renderSongStatusRow(song);

  const canEditDirect = CAN_EDIT_SONG_DIRECT.includes(role);
  const canSubmitRevision = CAN_SUBMIT_REVISION.includes(role);

  setSongFieldsDisabled(!canEditDirect && !canSubmitRevision);

  btnSubmit.style.display = canEditDirect ? '' : 'none';
  btnSubmit.textContent = 'Update Song';

  btnSubmitRevision.style.display = canSubmitRevision ? '' : 'none';
  btnSubmitRevision.textContent = 'Submit for Revision';
}

async function openNewSong() {
  return AdminUI.withLoading('Opening form…', () => _openNewSong());
}
async function _openNewSong() {
  if (!hasRole(...CAN_CREATE_SONG)) return;
  clearSongForm();
  document.getElementById('modalTitle').textContent = 'New Song';
  await populateDropdowns();
  openSongModal();
  applySongModalPermissions('create', getAdminInfo()?.role, null);
  document.getElementById('formTitle').focus();
  // Check for unsaved draft
  const draft = loadDraft('song', null);
  if (draft && (draft.title || draft.lyrics)) {
    showDraftBanner('songDraftBanner');
  }
}

// Set whenever a song is loaded into the edit form — sent back as expected_updated_at
// on save so the server can detect a concurrent edit (see admin.js songsApp.put).
let currentSongLoadedUpdatedAt = null;

function populateSongForm(song) {
  document.getElementById('formSongId').value = song.id;
  document.getElementById('formTitle').value = song.title || '';
  setSelectedIds(document.getElementById('formArtist'), (song.artists || []).map(a => a.id));
  setSelectedIds(document.getElementById('formComposer'), (song.composers || []).map(c => c.id));
  document.getElementById('formCategory').value = song.category || '';
  document.getElementById('formCopyrightOwner').value = song.copyright_owner_id || '';
  document.getElementById('formSlug').value = song.slug || '';
  document.getElementById('formLyrics').value = song.lyrics || '';
  currentSongLoadedUpdatedAt = song.updated_at || null;
  applySongModalPermissions('edit', getAdminInfo()?.role, song);
}

async function editSong(id) {
  return AdminUI.withLoading('Loading song…', () => _editSong(id));
}
async function _editSong(id) {
  clearSongForm();
  document.getElementById('modalTitle').textContent = 'Edit Song';
  await populateDropdowns();
  openSongModal();

  // A still-unsynced offline record only exists in the local cache — there's no
  // server copy to fetch yet.
  const isLocalOnly = typeof id === 'string' && id.startsWith('local-song-');
  if (isLocalOnly) {
    const song = await OfflineSync.getCachedOne('song', id);
    if (!song) { showFormMessage('This queued song is no longer available.', true); return; }
    populateSongForm(song);
    return;
  }

  try {
    const song = await apiGet(`${ADMIN_API}/songs/${id}`);
    OfflineSync.cacheDetail('song', song).catch(() => {});
    populateSongForm(song);
    const draft = loadDraft('song', song.id);
    if (draft && (draft.title || draft.lyrics)) {
      showDraftBanner('songDraftBanner');
    }
  } catch (err) {
    if (!OfflineSync.isNetworkError(err)) {
      showFormMessage('Failed to load song: ' + err.message, true);
      return;
    }
    const cached = await OfflineSync.getCachedOne('song', id);
    if (cached && cached.artists) {
      populateSongForm(cached);
      if (typeof Toast !== 'undefined') Toast.show('Offline — editing the cached copy of this song.', { type: 'info' });
    } else if (cached) {
      showFormMessage('Offline: only summary data is cached for this song — open it once while online to enable offline editing.', true);
    } else {
      showFormMessage('Offline and this song isn’t cached yet.', true);
    }
  }
}

function gatherSongFormData() {
  return {
    title: document.getElementById('formTitle').value.trim(),
    artist_ids: getSelectedIds(document.getElementById('formArtist')),
    composer_ids: getSelectedIds(document.getElementById('formComposer')),
    copyright_owner_id: document.getElementById('formCopyrightOwner').value || null,
    category: document.getElementById('formCategory').value.trim(),
    slug: document.getElementById('formSlug').value.trim(),
    lyrics: document.getElementById('formLyrics').value.trim(),
  };
}

function validateSongFormData(body) {
  if (!body.title) return 'Title is required.';
  if (!body.lyrics) return 'Lyrics are required.';
  if (body.artist_ids.length > 20) return 'A song can have at most 20 artists.';
  if (body.composer_ids.length > 20) return 'A song can have at most 20 composers.';
  return null;
}

// Direct save — creates a new song, or applies an edit immediately for roles allowed to
// bypass the revision queue (Editor/Manager/Admin). Never touches status.
async function saveSongDirect(e) {
  e.preventDefault();

  const id = document.getElementById('formSongId').value;
  const body = gatherSongFormData();
  const error = validateSongFormData(body);
  if (error) { showFormMessage(error, true); return; }

  const isLocalOnly = !!id && id.startsWith('local-song-');
  const btn = document.getElementById('btnSubmit');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  const refData = { artists: allArtists, composers: allComposers };

  // Offline, or this is a still-unsynced offline record being edited further: write
  // straight to the offline queue — see offline-sync.js.
  if (!OfflineSync.isOnline() || isLocalOnly) {
    try {
      if (id) await OfflineSync.queueUpdate('song', isLocalOnly ? id : Number(id), body, currentSongLoadedUpdatedAt, refData);
      else await OfflineSync.queueCreate('song', body, refData);
      showFormMessage(OfflineSync.isOnline() ? 'Saved — syncing…' : 'Saved offline — will sync when back online.');
      clearDraft('song', id || null);
      hideDraftBanner('songDraftBanner', 'songDraftIndicator');
      setTimeout(() => { closeSongModal(); loadSongs(currentPage); refreshStats(); }, 800);
      if (OfflineSync.isOnline()) OfflineSync.processQueue();
    } catch (err) {
      showFormMessage(err.message, true);
      if (err.staleLocalId) {
        // The record this modal was editing finished syncing to a real id in the
        // background — there's nothing left to save under the old local id. Bail out to
        // the table instead of silently losing the edit (see offline-sync.js queueUpdate).
        setTimeout(() => { closeSongModal(); loadSongs(currentPage); }, 1200);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = id ? 'Update Song' : 'Create Song';
    }
    return;
  }

  try {
    if (id) {
      await apiPut(`${ADMIN_API}/songs/${id}`, { ...body, expected_updated_at: currentSongLoadedUpdatedAt }, { success: 'Song updated.' });
      showFormMessage('Song updated successfully!');
      // A successful edit supersedes any conflict left over from an earlier, abandoned
      // attempt on this same song (see offline-sync.js recordDirectConflict).
      OfflineSync.clearConflict('song', Number(id)).catch(() => {});
    } else {
      await apiPost(`${ADMIN_API}/songs`, body, { success: 'Song created.' });
      showFormMessage('Song created successfully!');
    }
    // Clear draft on successful save
    clearDraft('song', id || null);
    hideDraftBanner('songDraftBanner', 'songDraftIndicator');

    setTimeout(() => {
      closeSongModal();
      loadSongs(currentPage);
      refreshStats();
    }, 800);
  } catch (err) {
    if (err.status === 409 && err.body && err.body.current) {
      // Same "someone else changed this" conflict the offline sync queue handles —
      // routed through the one conflict-resolution modal instead of a plain error.
      await OfflineSync.recordDirectConflict('song', Number(id), body, currentSongLoadedUpdatedAt, err.body.current);
      showFormMessage('This song was changed by someone else since you loaded it.', true);
      closeSongModal();
      loadSongs(currentPage);
      OfflineSync.openConflictModal();
    } else if (OfflineSync.isNetworkError(err)) {
      // Connectivity dropped between the isOnline() check above and this request —
      // fall back to queueing instead of losing the edit.
      try {
        if (id) await OfflineSync.queueUpdate('song', Number(id), body, currentSongLoadedUpdatedAt, refData);
        else await OfflineSync.queueCreate('song', body, refData);
        showFormMessage('Connection lost — saved offline, will sync when back online.');
        clearDraft('song', id || null);
        setTimeout(() => { closeSongModal(); loadSongs(currentPage); }, 800);
      } catch (queueErr) {
        showFormMessage(queueErr.message, true);
      }
    } else {
      showFormMessage(err.message, true);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = id ? 'Update Song' : 'Create Song';
  }
}

// Proposes an edit to an EXISTING song for Reviewer approval instead of applying it
// directly — used by Translator always, and optionally by Editor/Manager/Admin.
async function submitSongRevision() {
  const id = document.getElementById('formSongId').value;
  if (!id) return;

  const body = gatherSongFormData();
  const error = validateSongFormData(body);
  if (error) { showFormMessage(error, true); return; }

  const btn = document.getElementById('btnSubmitRevision');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    await apiPost(`${ADMIN_API}/songs/${id}/revisions`, body, { success: 'Revision submitted for review.' });
    showFormMessage('Revision submitted for review!');
    clearDraft('song', id);
    hideDraftBanner('songDraftBanner', 'songDraftIndicator');
    setTimeout(() => closeSongModal(), 800);
  } catch (err) {
    showFormMessage(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit for Revision';
  }
}

// Auto-slug for songs
function autoSongSlug() {
  const slugField = document.getElementById('formSlug');
  const titleField = document.getElementById('formTitle');
  if (!slugField.dataset.manual) {
    slugField.value = generateSlug(titleField.value);
  }
}

// ═══════════════════════════════════════════════════
// ═══ ARTISTS / COMPOSERS ══════════════════════════
// ═══════════════════════════════════════════════════

async function loadArtists() {
  const tbody = document.getElementById('artistsTableBody');
  tbody.innerHTML = AdminUI.loadingRows(4);
  try {
    const data = await apiGet(`${ADMIN_API}/artists`);
    allArtists = data.artists || [];
    renderArtistsTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-table__empty" style="color:var(--danger);">Failed: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadComposers() {
  const tbody = document.getElementById('composersTableBody');
  tbody.innerHTML = AdminUI.loadingRows(4);
  try {
    const data = await apiGet(`${ADMIN_API}/composers`);
    allComposers = data.composers || [];
    renderComposersTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-table__empty" style="color:var(--danger);">Failed: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderArtistsTable() {
  const tbody = document.getElementById('artistsTableBody');
  const query = document.getElementById('artistSearch')?.value || '';
  renderPersonTable('artist', filterBySearch(allArtists, query, ['name', 'slug']), tbody, !!query.trim());
}

function renderComposersTable() {
  const tbody = document.getElementById('composersTableBody');
  const query = document.getElementById('composerSearch')?.value || '';
  renderPersonTable('composer', filterBySearch(allComposers, query, ['name', 'slug']), tbody, !!query.trim());
}

function renderPersonTable(type, items, tbody, isFiltered = false) {
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-table__empty">${isFiltered ? `No ${type}s match your search.` : `No ${type}s found.`}</td></tr>`;
    return;
  }
  const canManage = hasRole(...CAN_MANAGE_REFERENCE_DATA);
  const canBadge = hasRole(...CAN_MANAGE_BADGES);
  tbody.innerHTML = items.map(item => `
    <tr data-id="${item.id}">
      <td><div class="admin-table__person">${entityAvatarHtml(item.image_url)}<div class="admin-table__person-text"><div class="admin-table__title">${escapeHtml(item.name)}</div>${badgeChipsHtml(type, item.badges)}</div></div></td>
      <td><div class="admin-table__slug">/${type}/${escapeHtml(item.slug)}</div></td>
      <td>${escapeHtml((item.bio || '').substring(0, 60))}${item.bio && item.bio.length > 60 ? '...' : ''}</td>
      <td>
        <div class="admin-table__actions">
          ${canBadge ? `<button class="btn btn--sm btn--ghost" onclick="openBadgeModal('${type}', ${item.id})" title="Badges" aria-label="Manage badges for ${escapeHtml(item.name)}">🏅</button>` : ''}
          ${canManage ? `<button class="btn btn--sm btn--ghost" onclick="editPerson('${type}', ${item.id})" title="Edit">✏️</button>` : ''}
          ${canManage ? `<button class="btn btn--sm btn--ghost btn--danger-text" onclick="confirmDelete(${item.id}, '${type}')" title="Delete">🗑️</button>` : ''}
          <a href="${SITE_ORIGIN}/${type}/${escapeHtml(item.slug)}" target="_blank" class="btn btn--sm btn--ghost" title="View">👁️</a>
        </div>
      </td>
    </tr>
  `).join('');
}

// ═══ ARTIST / COMPOSER BADGES (Super Admin) ═══════
// A badge recognises one artist or composer for a month ('YYYY-MM'), a year ('YYYY') or a
// lifetime. Anyone in the dashboard sees them; only a Super Admin can award or remove them
// (enforced by the API — hiding the button here is just a convenience).
const BADGE_ICONS = { lifetime: '👑', year: '🏆', month: '🏅' };

function badgeWhen(b) {
  if (b.period === 'lifetime') return '';
  if (b.period === 'year') return b.period_value;
  const [y, m] = String(b.period_value).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleDateString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Standard label unless a custom title was given, e.g. "Artist of the Month · Oct 2026". */
function badgeText(type, b) {
  const role = type === 'artist' ? 'Artist' : 'Composer';
  const base = b.title || (b.period === 'lifetime' ? 'Lifetime Achievement' : `${role} of the ${b.period === 'year' ? 'Year' : 'Month'}`);
  const when = badgeWhen(b);
  return when ? `${base} · ${when}` : base;
}

function badgeChipsHtml(type, badges) {
  if (!Array.isArray(badges) || !badges.length) return '';
  return `<div class="admin-badges">${badges.map((b) =>
    `<span class="badge-chip badge-chip--${b.period}" title="${escapeHtml(badgeText(type, b))}">${BADGE_ICONS[b.period] || '🏅'} ${escapeHtml(badgeText(type, b))}</span>`).join('')}</div>`;
}

let badgeTarget = null; // { type: 'artist' | 'composer', id }

const badgeList = () => (badgeTarget.type === 'artist' ? allArtists : allComposers);
const badgePerson = () => badgeList().find((p) => p.id === badgeTarget.id);

function showBadgeMessage(text, isError = false) {
  const el = document.getElementById('badgeFormMessage');
  el.textContent = text;
  el.className = 'form-message ' + (isError ? 'form-message--error' : 'form-message--success');
  el.style.display = text ? 'block' : 'none';
}

function syncBadgeFormFields() {
  const period = document.getElementById('badgePeriod').value;
  document.getElementById('badgeMonthGroup').style.display = period === 'month' ? '' : 'none';
  document.getElementById('badgeYearGroup').style.display = period === 'year' ? '' : 'none';
}

function renderBadgeModal() {
  const person = badgePerson();
  if (!person) return;
  document.getElementById('badgeModalTitle').textContent = `Badges — ${person.name}`;
  const list = document.getElementById('badgeList');
  const badges = person.badges || [];
  list.innerHTML = badges.length
    ? badges.map((b) => `
        <div class="badge-admin-row">
          <span class="badge-chip badge-chip--${b.period}">${BADGE_ICONS[b.period] || '🏅'} ${escapeHtml(badgeText(badgeTarget.type, b))}</span>
          <button type="button" class="btn btn--sm btn--ghost btn--danger-text" data-remove-badge="${b.id}" title="Remove this badge" aria-label="Remove ${escapeHtml(badgeText(badgeTarget.type, b))}">✕</button>
        </div>`).join('')
    : '<p class="admin-table__empty" style="padding:var(--space-sm) 0;">No badges yet.</p>';
}

function openBadgeModal(type, id) {
  if (!hasRole(...CAN_MANAGE_BADGES)) return;
  badgeTarget = { type, id };
  document.getElementById('badgeForm').reset();
  document.getElementById('badgePeriod').value = 'month';
  // Default the pickers to "now" — the common case is recognising the current month/year.
  const now = new Date();
  document.getElementById('badgeMonth').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  document.getElementById('badgeYear').value = String(now.getFullYear());
  syncBadgeFormFields();
  showBadgeMessage('');
  renderBadgeModal();
  document.getElementById('badgeModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  document.getElementById('badgePeriod').focus();
}

function closeBadgeModal() {
  document.getElementById('badgeModal').style.display = 'none';
  document.body.style.overflow = '';
  badgeTarget = null;
}

/** Re-read one person (with badge ids) from the API and refresh the table + modal in place. */
async function refreshBadgePerson() {
  const { type, id } = badgeTarget;
  const fresh = await apiGet(`${ADMIN_API}/${type}s/${id}`);
  const list = badgeList();
  const idx = list.findIndex((p) => p.id === id);
  if (idx >= 0) list[idx] = fresh;
  if (type === 'artist') renderArtistsTable(); else renderComposersTable();
  renderBadgeModal();
}

async function submitBadge(e) {
  e.preventDefault();
  if (!badgeTarget || !hasRole(...CAN_MANAGE_BADGES)) return;
  const period = document.getElementById('badgePeriod').value;
  const body = { period };
  if (period === 'month') {
    body.period_value = document.getElementById('badgeMonth').value;
    if (!/^\d{4}-\d{2}$/.test(body.period_value)) { showBadgeMessage('Pick a month.', true); return; }
  } else if (period === 'year') {
    body.period_value = String(document.getElementById('badgeYear').value || '').trim();
    if (!/^\d{4}$/.test(body.period_value)) { showBadgeMessage('Enter a 4-digit year.', true); return; }
  }
  const title = document.getElementById('badgeTitle').value.trim();
  if (title) body.title = title;

  const person = badgePerson();
  try {
    await apiPost(`${ADMIN_API}/${badgeTarget.type}s/${badgeTarget.id}/badges`, body,
      { success: `Badge awarded${person ? ` to ${person.name}` : ''}.` });
    document.getElementById('badgeTitle').value = '';
    showBadgeMessage('');
    await refreshBadgePerson();
  } catch (err) {
    showBadgeMessage(err.status === 403 ? 'Only a Super Admin can award badges.' : err.message, true);
  }
}

async function removeBadge(badgeId) {
  if (!badgeTarget || !hasRole(...CAN_MANAGE_BADGES)) return;
  try {
    await apiDelete(`${ADMIN_API}/${badgeTarget.type}s/${badgeTarget.id}/badges/${badgeId}`, { success: 'Badge removed.' });
    await refreshBadgePerson();
  } catch (err) {
    showBadgeMessage(err.status === 403 ? 'Only a Super Admin can remove badges.' : err.message, true);
  }
}

function initBadgeModal() {
  document.getElementById('badgeModalClose').addEventListener('click', closeBadgeModal);
  document.getElementById('badgeBtnClose').addEventListener('click', closeBadgeModal);
  document.getElementById('badgeBackdrop').addEventListener('click', closeBadgeModal);
  document.getElementById('badgePeriod').addEventListener('change', syncBadgeFormFields);
  document.getElementById('badgeForm').addEventListener('submit', submitBadge);
  document.getElementById('badgeList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-badge]');
    if (btn) removeBadge(Number(btn.dataset.removeBadge));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('badgeModal').style.display === 'flex') closeBadgeModal();
  });
}

// ─── Social Link Helpers ────────────────────────
// Platform detection + icons live in /social-icons.js (shared with the public profile pages).
function detectSocialPlatform(url) {
  if (!url) return null;
  return SocialIcons.detect(url, { size: 18 });
}

function addSocialLinkRow(url = '') {
  const container = document.getElementById('socialLinksContainer');
  const row = document.createElement('div');
  row.className = 'social-link-row';
  const platform = detectSocialPlatform(url);
  row.innerHTML = `
    <span class="social-link__icon">${platform ? platform.icon : '🔗'}</span>
    <input type="url" class="form-input social-link__url" value="${escapeHtml(url)}" placeholder="https://facebook.com/username" />
    <button type="button" class="btn--remove-social" title="Remove">&times;</button>
  `;
  // Update icon on URL change
  const input = row.querySelector('.social-link__url');
  const iconSpan = row.querySelector('.social-link__icon');
  input.addEventListener('input', () => {
    const p = detectSocialPlatform(input.value);
    iconSpan.innerHTML = p ? p.icon : '🔗';
  });
  row.querySelector('.btn--remove-social').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function getSocialLinksJSON() {
  const rows = document.querySelectorAll('#socialLinksContainer .social-link__url');
  const links = [];
  rows.forEach(input => {
    const url = input.value.trim();
    if (url) links.push(url);
  });
  return links.length ? JSON.stringify(links) : null;
}

function loadSocialLinks(socialLinksStr) {
  const container = document.getElementById('socialLinksContainer');
  container.innerHTML = '';
  if (!socialLinksStr) return;
  try {
    const links = JSON.parse(socialLinksStr);
    if (Array.isArray(links)) {
      links.forEach(url => addSocialLinkRow(url));
    }
  } catch { /* ignore bad JSON */ }
}

// ─── Photo field (Artist / Composer / Copyright Owner) ────────
// Same drag-to-position + zoom circular crop as the admin's own profile photo. The hidden
// input (`data-target`) holds the value that gets saved: '' (no photo), an http(s) URL, or a
// cropped data:image URL.
const ENTITY_PHOTO_SIZE = 400;
const WIDE_PHOTO_SIZE = 1000; // output width of a 2:1 cover banner (1000 × 500)

function entityAvatarHtml(imageUrl, size = 'sm', shape = 'circle') {
  const inner = imageUrl
    ? `<img class="profile-avatar__img" src="${escapeHtml(imageUrl)}" alt="" loading="lazy" />`
    : DEFAULT_AVATAR_SVG;
  return `<span class="profile-avatar profile-avatar--${size}${shape === 'square' || shape === 'wide' ? ' profile-avatar--square' : ''}${shape === 'wide' ? ' profile-avatar--wide' : ''}${imageUrl ? '' : ' profile-avatar--empty'}" title="${imageUrl ? 'Has a photo' : 'No photo'}">${inner}</span>`;
}

function setImageField(targetId, url) {
  const hidden = document.getElementById(targetId);
  if (!hidden) return;
  hidden.value = url || '';
  const field = document.querySelector(`.image-field[data-target="${targetId}"]`);
  if (!field) return;
  field.querySelector('.image-field__preview').innerHTML = entityAvatarHtml(url, 'lg', field.dataset.shape);
  field.querySelector('.image-field__remove').style.display = url ? '' : 'none';
  const urlInput = field.querySelector('.image-field__url');
  urlInput.value = '';
  urlInput.style.display = 'none';
}

function initImageFields() {
  document.querySelectorAll('.image-field').forEach((field) => {
    const target = field.dataset.target;
    const fileInput = field.querySelector('.image-field__file');
    const urlInput = field.querySelector('.image-field__url');
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      openPhotoCrop(file, {
        size: field.dataset.shape === 'wide' ? WIDE_PHOTO_SIZE : ENTITY_PHOTO_SIZE,
        title: field.dataset.shape === 'wide' ? 'Crop Cover Photo' : 'Crop Photo',
        shape: field.dataset.shape || 'circle',
        onError: (msg) => AdminUI.alertToast(msg),
        onSave: (dataUrl) => setImageField(target, dataUrl),
      });
    });
    field.querySelector('.image-field__url-btn').addEventListener('click', () => {
      urlInput.style.display = urlInput.style.display === 'none' ? 'block' : 'none';
      if (urlInput.style.display === 'block') urlInput.focus();
    });
    const applyUrl = () => {
      const url = urlInput.value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) { AdminUI.alertToast('Enter an http(s) image URL.'); return; }
      setImageField(target, url);
    };
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyUrl(); } });
    urlInput.addEventListener('blur', applyUrl);
    field.querySelector('.image-field__remove').addEventListener('click', () => setImageField(target, ''));
    setImageField(target, '');
  });
}

// Person Modal (shared for Artist / Composer)
function openPersonModal() {
  document.getElementById('personModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function closePersonModal() {
  document.getElementById('personModal').style.display = 'none';
  document.body.style.overflow = '';
  clearPersonForm();
}
// The artist / composer bio is rich text (bold, italic, links, lists, line breaks) — see /rich-text.js.
let personBioRte = null;
const BIO_TEXT_MAX = 5000;
function mountPersonBioRte() {
  const box = document.getElementById('personFormBio');
  if (!box || personBioRte || !window.RichText) return;
  personBioRte = RichText.mount(box, {
    placeholder: 'Brief biography…',
    editorClass: 'form-input form-textarea rte-editor--compact',
    onChange: ({ length, user }) => {
      const count = document.getElementById('personFormBioCount');
      if (count) { count.textContent = `${length} / ${BIO_TEXT_MAX}`; count.style.color = length > BIO_TEXT_MAX ? 'var(--danger, #ef4444)' : ''; }
      if (user) autoSavePersonDraft();
    },
  });
}

function clearPersonForm() {
  document.getElementById('personForm').reset();
  if (personBioRte) personBioRte.setHtml('');
  document.getElementById('personFormId').value = '';
  document.getElementById('personFormMessage').style.display = 'none';
  // See clearSongForm() — .reset() never clears dataset, so the "manual" flag
  // must be cleared explicitly or it leaks into the next new/edit session.
  document.getElementById('personFormSlug').dataset.manual = '';
  hideDraftBanner('personDraftBanner', 'personDraftIndicator');
  setImageField('personFormImage', '');
  loadSocialLinks(null);
}
function showPersonMessage(text, isError = false) {
  const el = document.getElementById('personFormMessage');
  el.textContent = text;
  el.className = 'form-message ' + (isError ? 'form-message--error' : 'form-message--success');
  el.style.display = 'block';
}

function openNewPerson(type) {
  if (!hasRole(...CAN_MANAGE_REFERENCE_DATA)) return;
  clearPersonForm();
  const label = type === 'artist' ? 'Artist' : 'Composer';
  document.getElementById('personModalTitle').textContent = 'New ' + label;
  document.getElementById('personBtnSubmit').textContent = 'Create ' + label;
  document.getElementById('personFormType').value = type;
  openPersonModal();
  document.getElementById('personFormName').focus();
  // Check for unsaved draft
  const draft = loadDraft(type, null);
  if (draft && draft.name) {
    showDraftBanner('personDraftBanner');
  }
}

async function editPerson(type, id) {
  return AdminUI.withLoading('Loading…', () => _editPerson(type, id));
}
async function _editPerson(type, id) {
  clearPersonForm();
  const label = type === 'artist' ? 'Artist' : 'Composer';
  document.getElementById('personModalTitle').textContent = 'Edit ' + label;
  document.getElementById('personBtnSubmit').textContent = 'Update ' + label;
  document.getElementById('personFormType').value = type;
  openPersonModal();

  try {
    const item = await apiGet(`${ADMIN_API}/${type}s/${id}`);
    document.getElementById('personFormId').value = item.id;
    document.getElementById('personFormName').value = item.name || '';
    document.getElementById('personFormSlug').value = item.slug || '';
    if (personBioRte) personBioRte.setHtml(item.bio || '');
    setImageField('personFormImage', item.image_url || '');
    // Load social links
    loadSocialLinks(item.social_links || null);
    // Check for unsaved draft for this person
    const personDraft = loadDraft(type, item.id);
    if (personDraft && personDraft.name) {
      showDraftBanner('personDraftBanner');
    }
  } catch (err) {
    showPersonMessage('Failed to load: ' + err.message, true);
  }
}

async function savePerson(e) {
  e.preventDefault();

  const type = document.getElementById('personFormType').value;
  const id = document.getElementById('personFormId').value;
  const name = document.getElementById('personFormName').value.trim();
  const slug = document.getElementById('personFormSlug').value.trim();
  const bio = personBioRte ? personBioRte.getHtml() : '';
  if (personBioRte && personBioRte.getText().length > BIO_TEXT_MAX) { showPersonMessage(`Bio is too long (max ${BIO_TEXT_MAX} characters).`, true); return; }
  const image_url = document.getElementById('personFormImage').value.trim();
  const label = type === 'artist' ? 'Artist' : 'Composer';

  if (!name) { showPersonMessage('Name is required.', true); return; }

  const btn = document.getElementById('personBtnSubmit');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const social_links = getSocialLinksJSON();
    const body = { name, slug, bio, image_url, social_links };
    const plural = type + 's';

    if (id) {
      await apiPut(`${ADMIN_API}/${type}s/${id}`, body, { success: `${label} updated.` });
      showPersonMessage(label + ' updated successfully!');
    } else {
      await apiPost(`${ADMIN_API}/${plural}`, body, { success: `${label} created.` });
      showPersonMessage(label + ' created successfully!');
    }
    // Clear draft on successful save
    clearDraft(type, id || null);
    hideDraftBanner('personDraftBanner', 'personDraftIndicator');

    setTimeout(() => {
      closePersonModal();
      if (type === 'artist') loadArtists(); else loadComposers();
    }, 800);
  } catch (err) {
    showPersonMessage(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = id ? 'Update ' + label : 'Create ' + label;
  }
}

function autoPersonSlug() {
  const slugField = document.getElementById('personFormSlug');
  const nameField = document.getElementById('personFormName');
  if (!slugField.dataset.manual) {
    slugField.value = generateSlug(nameField.value);
  }
}

// ═══════════════════════════════════════════════════
// ═══ DELETE (shared) ══════════════════════════════
// ═══════════════════════════════════════════════════

// Looks up the display name from already-loaded state by id, rather than trusting a name
// string passed in through an inline onclick="" attribute — free-text fields (song titles,
// usernames, etc.) can contain a literal double-quote, which breaks out of a double-quoted
// HTML attribute and lets stored content inject new attributes (e.g. onmouseover=) on the
// element. Only numeric ids and fixed type literals ever reach an onclick string now.
const DELETE_NAME_LOOKUP = {
  song: (id) => allSongs.find(s => s.id === id)?.title,
  artist: (id) => allArtists.find(a => a.id === id)?.name,
  composer: (id) => allComposers.find(c => c.id === id)?.name,
  'copyright-owner': (id) => allCopyrightOwners.find(c => c.id === id)?.name,
  article: (id) => allArticles.find(a => a.id === id)?.title,
  supporter: (id) => allSupporters.find(x => x.id === id)?.name,
  'idol-season': (id) => allIdolSeasons.find(x => x.id === id)?.title,
  'idol-contestant': (id) => allIdols.find(x => x.id === id)?.name,
  'admin-user': (id) => allAdminUsers.find(u => u.id === id)?.username,
  report: (id) => `Report #${id}`,
  contact: (id) => `Message #${id}`,
};

const DELETE_TYPE_LABEL = { 'idol-season': 'Season', 'idol-contestant': 'Idol' };

function confirmDelete(id, type) {
  deleteTargetId = id;
  deleteTargetType = type;
  const name = DELETE_NAME_LOOKUP[type]?.(id) || `#${id}`;
  document.getElementById('deleteModalTitle').textContent = 'Delete ' + (DELETE_TYPE_LABEL[type] || type.charAt(0).toUpperCase() + type.slice(1));
  document.getElementById('deleteName').textContent = name; // .textContent — safe regardless of what `name` contains
  document.getElementById('deleteModal').style.display = 'flex';
}

function closeDeleteModal() {
  deleteTargetId = null;
  document.getElementById('deleteModal').style.display = 'none';
}

async function deleteItem() {
  if (!deleteTargetId) return;
  const id = deleteTargetId;
  const type = deleteTargetType;

  // 1. Close modal immediately for snappy UX
  closeDeleteModal();

  // 2. Remove row from DOM immediately (optimistic)
  const row = document.querySelector(`tr[data-id="${id}"]`);
  if (row) row.remove();

  // 3. Update in-memory arrays immediately
  if (type === 'song') allSongs = allSongs.filter(s => s.id !== id);
  else if (type === 'artist') allArtists = allArtists.filter(a => a.id !== id);
  else if (type === 'composer') allComposers = allComposers.filter(c => c.id !== id);
  else if (type === 'copyright-owner') allCopyrightOwners = allCopyrightOwners.filter(co => co.id !== id);
  else if (type === 'article') allArticles = allArticles.filter(a => a.id !== id);
  else if (type === 'supporter') allSupporters = allSupporters.filter(x => x.id !== id);
  else if (type === 'idol-season') allIdolSeasons = allIdolSeasons.filter(x => x.id !== id);
  else if (type === 'idol-contestant') allIdols = allIdols.filter(x => x.id !== id);
  else if (type === 'report') allReports = allReports.filter(r => r.id !== id);
  else if (type === 'admin-user') allAdminUsers = allAdminUsers.filter(u => u.id !== id);
  else if (type === 'contact') allContacts = allContacts.filter(c => c.id !== id);

  try {
    await apiDelete(`${ADMIN_API}/${type}s/${id}`, { success: `${(DELETE_TYPE_LABEL[type] || type.replace('-', ' ').replace(/^./, (c) => c.toUpperCase()))} deleted.` });
    // Reload for accurate counts/pagination
    if (type === 'song') { loadSongs(currentPage); refreshStats(); }
    else if (type === 'artist') loadArtists();
    else if (type === 'composer') loadComposers();
    else if (type === 'report') loadReports();
    else if (type === 'copyright-owner') loadCopyrightOwners();
    else if (type === 'article') loadArticles(currentArticlePage);
    else if (type === 'supporter') loadSupporters();
    else if (type === 'idol-season' || type === 'idol-contestant') loadIdol();
    else if (type === 'admin-user') loadAdminUsers();
    else if (type === 'contact') loadContacts();
  } catch (err) {
    // Show error and restore list by reloading
    if (typeof Toast !== 'undefined') {
      Toast.show('Delete failed: ' + err.message, { type: 'error', duration: 4000 });
    } else {
      AdminUI.alertToast('Delete failed: ' + err.message);
    }
    if (type === 'song') loadSongs(currentPage);
    else if (type === 'artist') loadArtists();
    else if (type === 'composer') loadComposers();
    else if (type === 'report') loadReports();
    else if (type === 'copyright-owner') loadCopyrightOwners();
    else if (type === 'article') loadArticles(currentArticlePage);
    else if (type === 'supporter') loadSupporters();
    else if (type === 'idol-season' || type === 'idol-contestant') loadIdol();
    else if (type === 'admin-user') loadAdminUsers();
    else if (type === 'contact') loadContacts();
  }
}

// ═══════════════════════════════════════════════════
// ═══ SPONSORS & PARTNERS (manager + super admin) ══
// ═══════════════════════════════════════════════════

const SUPPORTER_KIND_LABEL = { sponsor: 'Sponsor', partner: 'Partner' };

async function loadSupporters() {
  const tbody = document.getElementById('supportersTableBody');
  tbody.innerHTML = AdminUI.loadingRows(5);
  try {
    const data = await apiGet(`${ADMIN_API}/supporters`);
    allSupporters = data.supporters || [];
    renderSupportersTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-table__empty" style="color:var(--danger);">Failed: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderSupportersTable() {
  const tbody = document.getElementById('supportersTableBody');
  if (!allSupporters.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="admin-table__empty">None yet. The Sponsors and Partners sections stay hidden on the Project page until you add one.</td></tr>';
    return;
  }
  tbody.innerHTML = allSupporters.map(item => `
    <tr data-id="${item.id}">
      <td><div class="admin-table__person">${entityAvatarHtml(item.logo_url, 'sm', 'square')}<div class="admin-table__title">${escapeHtml(item.name)}</div></div></td>
      <td>${escapeHtml(SUPPORTER_KIND_LABEL[item.kind] || item.kind)}</td>
      <td>${item.website_url ? `<a href="${escapeHtml(item.website_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">${escapeHtml(item.website_url.replace(/^https?:\/\//i, ''))}</a>` : '—'}</td>
      <td>${item.sort_order}</td>
      <td>
        <div class="admin-table__actions">
          <button class="btn btn--sm btn--ghost" onclick="editSupporter(${item.id})" title="Edit">✏️</button>
          <button class="btn btn--sm btn--ghost btn--danger-text" onclick="confirmDelete(${item.id}, 'supporter')" title="Delete">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function openSupporterModal() {
  document.getElementById('supporterModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function closeSupporterModal() {
  const modal = document.getElementById('supporterModal');
  if (!modal || modal.style.display === 'none') return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
  clearSupporterForm();
}
function clearSupporterForm() {
  document.getElementById('supporterForm').reset();
  document.getElementById('supFormId').value = '';
  document.getElementById('supFormMessage').style.display = 'none';
  setImageField('supFormLogo', '');
}
function showSupporterMessage(text, isError = false) {
  const el = document.getElementById('supFormMessage');
  el.textContent = text;
  el.className = 'form-message ' + (isError ? 'form-message--error' : 'form-message--success');
  el.style.display = 'block';
}

function openNewSupporter() {
  if (!hasRole(...CAN_MANAGE_REFERENCE_DATA)) return;
  clearSupporterForm();
  document.getElementById('supModalTitle').textContent = 'New Sponsor / Partner';
  document.getElementById('supBtnSubmit').textContent = 'Create';
  openSupporterModal();
  document.getElementById('supFormName').focus();
}

function editSupporter(id) {
  const item = allSupporters.find(x => x.id === id);
  if (!item) return;
  clearSupporterForm();
  document.getElementById('supModalTitle').textContent = 'Edit Sponsor / Partner';
  document.getElementById('supBtnSubmit').textContent = 'Update';
  document.getElementById('supFormId').value = item.id;
  document.getElementById('supFormKind').value = item.kind;
  document.getElementById('supFormOrder').value = item.sort_order;
  document.getElementById('supFormName').value = item.name || '';
  document.getElementById('supFormDescription').value = item.description || '';
  document.getElementById('supFormWebsite').value = item.website_url || '';
  setImageField('supFormLogo', item.logo_url || '');
  openSupporterModal();
}

async function saveSupporter(e) {
  e.preventDefault();
  const id = document.getElementById('supFormId').value;
  const name = document.getElementById('supFormName').value.trim();
  if (!name) { showSupporterMessage('Name is required.', true); return; }

  const body = {
    kind: document.getElementById('supFormKind').value,
    name,
    description: document.getElementById('supFormDescription').value.trim(),
    website_url: document.getElementById('supFormWebsite').value.trim(),
    logo_url: document.getElementById('supFormLogo').value.trim(),
    sort_order: document.getElementById('supFormOrder').value,
  };

  const btn = document.getElementById('supBtnSubmit');
  btn.disabled = true;
  try {
    if (id) await apiPut(`${ADMIN_API}/supporters/${id}`, body, { success: 'Supporter updated.' });
    else await apiPost(`${ADMIN_API}/supporters`, body, { success: 'Supporter added.' });
    closeSupporterModal();
    loadSupporters();
  } catch (err) {
    showSupporterMessage(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════
// ═══ MARA IDOL (editor + manager + super admin) ═══
// ═══════════════════════════════════════════════════

const IDOL_RESULT_LABEL = {
  winner: '🏆 Winner', runner_up: '🥈 Runner-up', second_runner_up: '🥉 Second runner-up',
  finalist: 'Finalist', semi_finalist: 'Semi-finalist', contestant: 'Contestant',
};

async function loadIdol() {
  const seasonsBody = document.getElementById('idolSeasonsTableBody');
  const idolsBody = document.getElementById('idolsTableBody');
  seasonsBody.innerHTML = AdminUI.loadingRows(5);
  idolsBody.innerHTML = AdminUI.loadingRows(6);
  try {
    const [sData, cData] = await Promise.all([
      apiGet(`${ADMIN_API}/idol-seasons`),
      apiGet(`${ADMIN_API}/idol-contestants`),
    ]);
    allIdolSeasons = sData.seasons || [];
    allIdols = cData.contestants || [];
    renderIdolSeasonsTable();
    renderIdolSeasonOptions();
    renderIdolsTable();
  } catch (err) {
    const msg = `<tr><td colspan="6" class="admin-table__empty" style="color:var(--danger);">Failed: ${escapeHtml(err.message)}</td></tr>`;
    seasonsBody.innerHTML = msg;
    idolsBody.innerHTML = msg;
  }
}

function idolStatusBadge(status) {
  return `<span class="status-badge status-badge--${status === 'published' ? 'published' : 'pending'}">${status === 'published' ? 'Published' : 'Draft'}</span>`;
}

function renderIdolSeasonsTable() {
  const tbody = document.getElementById('idolSeasonsTableBody');
  if (!allIdolSeasons.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="admin-table__empty">No seasons yet. Add a season first, then add its idols.</td></tr>';
    return;
  }
  const canManage = hasRole(...CAN_MANAGE_IDOL);
  const canDelete = hasRole(...CAN_DELETE_IDOL);
  tbody.innerHTML = allIdolSeasons.map(item => `
    <tr data-id="${item.id}">
      <td><div class="admin-table__person">${entityAvatarHtml(item.photo_url || item.cover_url, 'sm', 'square')}<div class="admin-table__title">${escapeHtml(item.title)}</div></div></td>
      <td>${item.year}</td>
      <td>${item.contestant_count || 0}</td>
      <td>${idolStatusBadge(item.status)}</td>
      <td>
        <div class="admin-table__actions">
          ${item.status === 'published' ? `<a class="btn btn--sm btn--ghost" href="/mara-idol/${encodeURIComponent(item.slug)}" target="_blank" rel="noopener" title="View on site">↗</a>` : ''}
          ${canManage ? `<button class="btn btn--sm btn--ghost" onclick="editIdolSeason(${item.id})" title="Edit">✏️</button>` : ''}
          ${canDelete ? `<button class="btn btn--sm btn--ghost btn--danger-text" onclick="confirmDelete(${item.id}, 'idol-season')" title="Delete">🗑️</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

/** Fills the season filter (keeping the current choice) and the idol modal's season select. */
function renderIdolSeasonOptions() {
  const label = (s) => `${s.title} (${s.year})${s.status === 'published' ? '' : ' — draft'}`;
  const filter = document.getElementById('idolFilterSeason');
  const keep = filter.value;
  filter.innerHTML = '<option value="">All Seasons</option>' +
    allIdolSeasons.map(s => `<option value="${s.id}">${escapeHtml(label(s))}</option>`).join('');
  if (allIdolSeasons.some(s => String(s.id) === keep)) filter.value = keep;

  const select = document.getElementById('idFormSeason');
  const current = select.value;
  select.innerHTML = '<option value="">Select a season…</option>' +
    allIdolSeasons.map(s => `<option value="${s.id}">${escapeHtml(label(s))}</option>`).join('');
  select.value = current;
}

function renderIdolsTable() {
  const tbody = document.getElementById('idolsTableBody');
  const season = document.getElementById('idolFilterSeason').value;
  const query = document.getElementById('idolSearch').value.trim().toLowerCase();
  const rows = allIdols.filter(i =>
    (!season || String(i.season_id) === season) &&
    (!query || i.name.toLowerCase().includes(query) || (i.artist_name || '').toLowerCase().includes(query)));
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-table__empty">${allIdols.length ? 'No idols match your filter.' : 'No idols yet.'}</td></tr>`;
    return;
  }
  const canManage = hasRole(...CAN_MANAGE_IDOL);
  const canDelete = hasRole(...CAN_DELETE_IDOL);
  tbody.innerHTML = rows.map(item => `
    <tr data-id="${item.id}">
      <td><div class="admin-table__person">${entityAvatarHtml(item.photo_url, 'sm')}<div class="admin-table__title">${escapeHtml(item.name)}</div></div></td>
      <td>${escapeHtml(item.season_title)} (${item.season_year})</td>
      <td>${escapeHtml(IDOL_RESULT_LABEL[item.result] || item.result)}${item.placement ? ` · #${item.placement}` : ''}</td>
      <td>${item.artist_name ? escapeHtml(item.artist_name) : '—'}</td>
      <td>${item.sort_order}</td>
      <td>
        <div class="admin-table__actions">
          ${canManage ? `<button class="btn btn--sm btn--ghost" onclick="editIdol(${item.id})" title="Edit">✏️</button>` : ''}
          ${canDelete ? `<button class="btn btn--sm btn--ghost btn--danger-text" onclick="confirmDelete(${item.id}, 'idol-contestant')" title="Delete">🗑️</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

// ── Video list editor ────────────────────────────
// One row per video: link, optional title, and a thumbnail that is either uploaded here (16:9 crop, stored on the
// video) or — when nothing is uploaded — loaded from the video platform (YouTube) by the public page.
// The server stores [{ title?, url, thumb? }].
const MAX_VIDEO_ROWS = 10; // mirrors worker/lib/idol.js
const VIDEO_THUMB_WIDTH = 480; // output px of an uploaded thumbnail (480 × 270)

function adminYoutubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, '');
    let id = '';
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v') || (u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/) || [])[1] || '';
    }
    return /^[\w-]{11}$/.test(id) ? id : '';
  } catch { return ''; }
}

function refreshVideoRow(row) {
  const thumb = row.videoThumb || '';
  const id = adminYoutubeId(row.querySelector('.video-row__url').value.trim());
  const src = thumb || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '');
  row.querySelector('.video-row__preview').innerHTML = src
    ? `<img src="${escapeHtml(src)}" alt="" referrerpolicy="no-referrer" />`
    : '<span aria-hidden="true">▶</span>';
  row.querySelector('.video-row__source').textContent = thumb
    ? 'Uploaded thumbnail'
    : id ? 'Automatic: YouTube thumbnail' : 'No thumbnail — upload one (other platforms have no automatic thumbnail)';
  row.querySelector('.video-row__clear').style.display = thumb ? '' : 'none';
}

function addVideoRow(editorId, video = {}) {
  const box = document.getElementById(editorId);
  if (box.children.length >= MAX_VIDEO_ROWS) { AdminUI.alertToast(`At most ${MAX_VIDEO_ROWS} videos.`); return null; }
  const row = document.createElement('div');
  row.className = 'video-row';
  row.innerHTML = `
    <span class="video-row__preview"></span>
    <div class="video-row__fields">
      <input type="url" class="form-input form-input--sm video-row__url" placeholder="https://www.youtube.com/watch?v=…" maxlength="500" value="${escapeHtml(video.url || '')}" />
      <input type="text" class="form-input form-input--sm video-row__title" placeholder="Title (optional)" maxlength="100" value="${escapeHtml(video.title || '')}" />
      <div class="video-row__actions">
        <label class="btn btn--sm btn--primary">Upload thumbnail<input type="file" class="video-row__file" accept="image/*" hidden /></label>
        <button type="button" class="btn btn--sm btn--ghost btn--danger-text video-row__clear">Remove uploaded</button>
        <span class="form-hint video-row__source"></span>
      </div>
    </div>
    <button type="button" class="btn btn--sm btn--ghost btn--danger-text video-row__remove" title="Remove video" aria-label="Remove video">✕</button>`;
  row.videoThumb = video.thumb || '';
  box.appendChild(row);
  refreshVideoRow(row);
  return row;
}

function setVideoEditor(editorId, videos) {
  document.getElementById(editorId).innerHTML = '';
  (Array.isArray(videos) ? videos : []).forEach((v) => addVideoRow(editorId, v));
}

/** Rows with a link → [{ title?, url, thumb? }] (the thumbnail is omitted when none was uploaded). */
function getVideoEditor(editorId) {
  return [...document.getElementById(editorId).children].map((row) => {
    const url = row.querySelector('.video-row__url').value.trim();
    const title = row.querySelector('.video-row__title').value.trim();
    return { url, ...(title ? { title } : {}), ...(row.videoThumb ? { thumb: row.videoThumb } : {}) };
  }).filter((v) => v.url);
}

function initVideoEditors() {
  document.querySelectorAll('.video-editor').forEach((box) => {
    box.addEventListener('input', (e) => { if (e.target.classList.contains('video-row__url')) refreshVideoRow(e.target.closest('.video-row')); });
    box.addEventListener('click', (e) => {
      const row = e.target.closest('.video-row');
      if (!row) return;
      if (e.target.closest('.video-row__remove')) row.remove();
      else if (e.target.closest('.video-row__clear')) { row.videoThumb = ''; refreshVideoRow(row); }
    });
    box.addEventListener('change', (e) => {
      if (!e.target.classList.contains('video-row__file')) return;
      const row = e.target.closest('.video-row');
      const file = e.target.files[0];
      e.target.value = '';
      openPhotoCrop(file, {
        size: VIDEO_THUMB_WIDTH,
        shape: 'video',
        title: 'Crop Video Thumbnail',
        onError: (msg) => AdminUI.alertToast(msg),
        onSave: (dataUrl) => { row.videoThumb = dataUrl; refreshVideoRow(row); },
      });
    });
  });
  document.querySelectorAll('[data-video-add]').forEach((btn) => {
    btn.addEventListener('click', () => addVideoRow(btn.dataset.videoAdd)?.querySelector('.video-row__url').focus());
  });
}

// ── Season modal ─────────────────────────────────
function openIdolSeasonModal() {
  document.getElementById('idolSeasonModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function closeIdolSeasonModal() {
  const modal = document.getElementById('idolSeasonModal');
  if (!modal || modal.style.display === 'none') return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
  clearIdolSeasonForm();
}
function clearIdolSeasonForm() {
  document.getElementById('idolSeasonForm').reset();
  document.getElementById('isFormId').value = '';
  document.getElementById('isFormMessage').style.display = 'none';
  setImageField('isFormCover', '');
  setImageField('isFormPhoto', '');
  setVideoEditor('isVideos', []);
}
function showIdolSeasonMessage(text, isError = false) {
  const el = document.getElementById('isFormMessage');
  el.textContent = text;
  el.className = 'form-message ' + (isError ? 'form-message--error' : 'form-message--success');
  el.style.display = 'block';
}

function openNewIdolSeason() {
  if (!hasRole(...CAN_MANAGE_IDOL)) return;
  clearIdolSeasonForm();
  document.getElementById('isModalTitle').textContent = 'New Season';
  document.getElementById('isBtnSubmit').textContent = 'Create';
  document.getElementById('isFormYear').value = new Date().getFullYear();
  openIdolSeasonModal();
  document.getElementById('isFormTitle').focus();
}

function editIdolSeason(id) {
  const item = allIdolSeasons.find(x => x.id === id);
  if (!item || !hasRole(...CAN_MANAGE_IDOL)) return;
  clearIdolSeasonForm();
  document.getElementById('isModalTitle').textContent = 'Edit Season';
  document.getElementById('isBtnSubmit').textContent = 'Update';
  document.getElementById('isFormId').value = item.id;
  document.getElementById('isFormTitle').value = item.title || '';
  document.getElementById('isFormYear').value = item.year;
  document.getElementById('isFormSlug').value = item.slug || '';
  document.getElementById('isFormStatus').value = item.status;
  document.getElementById('isFormVenue').value = item.venue || '';
  document.getElementById('isFormStart').value = item.start_date || '';
  document.getElementById('isFormEnd').value = item.end_date || '';
  document.getElementById('isFormDescription').value = item.description || '';
  setVideoEditor('isVideos', item.videos);
  setImageField('isFormCover', item.cover_url || '');
  setImageField('isFormPhoto', item.photo_url || '');
  openIdolSeasonModal();
}

async function saveIdolSeason(e) {
  e.preventDefault();
  const id = document.getElementById('isFormId').value;
  const title = document.getElementById('isFormTitle').value.trim();
  if (!title) { showIdolSeasonMessage('Title is required.', true); return; }

  // PUT replaces the whole record, so every field is always sent.
  const body = {
    title,
    year: document.getElementById('isFormYear').value,
    slug: document.getElementById('isFormSlug').value.trim(),
    status: document.getElementById('isFormStatus').value,
    venue: document.getElementById('isFormVenue').value.trim(),
    start_date: document.getElementById('isFormStart').value,
    end_date: document.getElementById('isFormEnd').value,
    description: document.getElementById('isFormDescription').value.trim(),
    cover_url: document.getElementById('isFormCover').value.trim(),
    photo_url: document.getElementById('isFormPhoto').value.trim(),
    videos: getVideoEditor('isVideos'),
  };

  const btn = document.getElementById('isBtnSubmit');
  btn.disabled = true;
  try {
    if (id) await apiPut(`${ADMIN_API}/idol-seasons/${id}`, body, { success: 'Season updated.' });
    else await apiPost(`${ADMIN_API}/idol-seasons`, body, { success: 'Season added.' });
    closeIdolSeasonModal();
    loadIdol();
  } catch (err) {
    showIdolSeasonMessage(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Idol modal ───────────────────────────────────
function openIdolModal() {
  document.getElementById('idolModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function closeIdolModal() {
  const modal = document.getElementById('idolModal');
  if (!modal || modal.style.display === 'none') return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
  clearIdolForm();
}
function clearIdolForm() {
  document.getElementById('idolForm').reset();
  document.getElementById('idFormId').value = '';
  document.getElementById('idFormMessage').style.display = 'none';
  setImageField('idFormPhoto', '');
  setVideoEditor('idVideos', []);
}
function showIdolMessage(text, isError = false) {
  const el = document.getElementById('idFormMessage');
  el.textContent = text;
  el.className = 'form-message ' + (isError ? 'form-message--error' : 'form-message--success');
  el.style.display = 'block';
}

/** Artist select for the idol modal — built from the artists already loaded for the song form. */
function renderIdolArtistOptions() {
  const select = document.getElementById('idFormArtist');
  select.innerHTML = '<option value="">None</option>' +
    [...allArtists].sort((a, b) => a.name.localeCompare(b.name))
      .map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
}

function openNewIdol() {
  if (!hasRole(...CAN_MANAGE_IDOL)) return;
  if (!allIdolSeasons.length) { AdminUI.alertToast('Add a season first.'); return; }
  clearIdolForm();
  renderIdolSeasonOptions();
  renderIdolArtistOptions();
  document.getElementById('idModalTitle').textContent = 'New Idol';
  document.getElementById('idBtnSubmit').textContent = 'Create';
  // Pre-select the season currently being browsed.
  document.getElementById('idFormSeason').value = document.getElementById('idolFilterSeason').value;
  openIdolModal();
  document.getElementById('idFormName').focus();
}

function editIdol(id) {
  const item = allIdols.find(x => x.id === id);
  if (!item || !hasRole(...CAN_MANAGE_IDOL)) return;
  clearIdolForm();
  renderIdolSeasonOptions();
  renderIdolArtistOptions();
  document.getElementById('idModalTitle').textContent = 'Edit Idol';
  document.getElementById('idBtnSubmit').textContent = 'Update';
  document.getElementById('idFormId').value = item.id;
  document.getElementById('idFormName').value = item.name || '';
  document.getElementById('idFormSeason').value = item.season_id;
  document.getElementById('idFormResult').value = item.result;
  document.getElementById('idFormPlacement').value = item.placement || '';
  document.getElementById('idFormOrder').value = item.sort_order;
  document.getElementById('idFormSlug').value = item.slug || '';
  document.getElementById('idFormBio').value = item.bio || '';
  setVideoEditor('idVideos', item.videos);
  setImageField('idFormPhoto', item.photo_url || '');
  const artistSelect = document.getElementById('idFormArtist');
  // An artist added after the dropdowns loaded would otherwise be silently unlinked on save.
  if (item.artist_id && !allArtists.some(a => a.id === item.artist_id)) {
    artistSelect.insertAdjacentHTML('beforeend', `<option value="${item.artist_id}">${escapeHtml(item.artist_name || '#' + item.artist_id)}</option>`);
  }
  artistSelect.value = item.artist_id || '';
  openIdolModal();
}

async function saveIdol(e) {
  e.preventDefault();
  const id = document.getElementById('idFormId').value;
  const name = document.getElementById('idFormName').value.trim();
  if (!name) { showIdolMessage('Name is required.', true); return; }
  const season = document.getElementById('idFormSeason').value;
  if (!season) { showIdolMessage('Choose a season.', true); return; }

  const body = {
    name,
    season_id: season,
    result: document.getElementById('idFormResult').value,
    placement: document.getElementById('idFormPlacement').value,
    sort_order: document.getElementById('idFormOrder').value,
    slug: document.getElementById('idFormSlug').value.trim(),
    artist_id: document.getElementById('idFormArtist').value || null,
    bio: document.getElementById('idFormBio').value.trim(),
    photo_url: document.getElementById('idFormPhoto').value.trim(),
    videos: getVideoEditor('idVideos'),
  };

  const btn = document.getElementById('idBtnSubmit');
  btn.disabled = true;
  try {
    if (id) await apiPut(`${ADMIN_API}/idol-contestants/${id}`, body, { success: 'Idol updated.' });
    else await apiPost(`${ADMIN_API}/idol-contestants`, body, { success: 'Idol added.' });
    closeIdolModal();
    loadIdol();
  } catch (err) {
    showIdolMessage(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════
// ═══ PROFILE CLAIMS (manager + super admin) ═══════
// ═══════════════════════════════════════════════════

let allClaims = [];
const CLAIM_STATUS_LABEL = { pending: 'Waiting for review', approved: 'Approved', rejected: 'Not approved', revoked: 'Access removed' };
const CLAIM_STATUS_CLASS = { pending: 'pending', approved: 'published', rejected: 'archived', revoked: 'archived' };

/** Escapes, then turns http(s) links in free text into safe anchors (the evidence is written by a stranger). */
function linkifyEvidence(text) {
  return escapeHtml(text).replace(/https?:\/\/[^\s<]+/g, (url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow" style="color:var(--accent);">${url}</a>`);
}

async function loadClaims() {
  const tbody = document.getElementById('claimsTableBody');
  tbody.innerHTML = AdminUI.loadingRows(5);
  try {
    const status = document.getElementById('claimFilterStatus').value;
    const data = await apiGet(`${ADMIN_API}/claims${status ? `?status=${status}` : ''}`);
    allClaims = data.claims || [];
    renderClaimsTable();
    if (status === 'pending') setClaimsTabCount(allClaims.length);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-table__empty" style="color:var(--danger);">Failed: ${escapeHtml(err.message)}</td></tr>`;
  }
}

/** "Claims (3)" on the tab so the review team sees there is something waiting. */
function setClaimsTabCount(n) {
  const tab = document.querySelector('.admin__tab[data-tab="claims"]');
  if (tab) tab.textContent = n > 0 ? `Claims (${n})` : 'Claims';
}
async function refreshClaimsTabCount() {
  if (!hasRole(...CAN_REVIEW_CLAIMS)) return;
  try { setClaimsTabCount(((await apiGet(`${ADMIN_API}/claims?status=pending`)).claims || []).length); } catch { /* the badge is optional */ }
}

function renderClaimsTable() {
  const tbody = document.getElementById('claimsTableBody');
  if (!allClaims.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="admin-table__empty">No claims here.</td></tr>';
    return;
  }
  tbody.innerHTML = allClaims.map((c) => `
    <tr data-id="${c.id}">
      <td>
        <div class="admin-table__title">${escapeHtml(c.name)}</div>
        <div class="admin-table__slug"><a href="${SITE_ORIGIN}/${c.type}/${encodeURIComponent(c.slug)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">/${c.type}/${escapeHtml(c.slug)}</a></div>
      </td>
      <td>
        <div class="admin-table__title">${escapeHtml(c.claimant)}</div>
        <div class="admin-table__slug">${c.claimant_email ? escapeHtml(c.claimant_email) : 'no email'}${c.claimant_email ? (c.claimant_email_verified ? ' <span title="The claimant confirmed this address" style="color:var(--success,#22c55e);">✔ confirmed</span>' : ' <span title="Not confirmed by the claimant yet" style="color:var(--text-muted);">· unconfirmed</span>') : ''}</div>
        <div class="admin-table__slug">${c.claimant_phone ? escapeHtml(c.claimant_phone) : 'no phone'}</div>
        <div class="admin-table__slug">${escapeHtml(formatDate(c.created_at))}</div>
      </td>
      <td><div class="claim-evidence">${linkifyEvidence(c.evidence)}</div>${c.review_note ? `<div class="admin-table__slug">Note: ${escapeHtml(c.review_note)}</div>` : ''}</td>
      <td>
        <span class="status-badge status-badge--${CLAIM_STATUS_CLASS[c.status] || 'archived'}">${escapeHtml(CLAIM_STATUS_LABEL[c.status] || c.status)}</span>
        ${c.status === 'pending' && c.has_owner ? '<div class="admin-table__slug" style="color:var(--danger);">Already has an owner</div>' : ''}
        ${c.reviewed_by_username ? `<div class="admin-table__slug">by ${escapeHtml(c.reviewed_by_username)}</div>` : ''}
      </td>
      <td>
        <div class="admin-table__actions">
          ${c.status === 'pending' && !c.has_owner ? `<button class="btn btn--sm btn--primary" onclick="openClaimReview(${c.id}, 'approve')">Approve</button>` : ''}
          ${c.status === 'pending' ? `<button class="btn btn--sm btn--ghost btn--danger-text" onclick="openClaimReview(${c.id}, 'reject')">Reject</button>` : ''}
          ${c.status === 'approved' ? `<button class="btn btn--sm btn--ghost btn--danger-text" onclick="openClaimReview(${c.id}, 'revoke')">Revoke</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

const CLAIM_ACTION = {
  approve: { title: 'Approve claim', button: 'Approve', noteRequired: false, text: (c) => `${c.claimant} will be able to edit the bio, photo and social links of ${c.name}.` },
  reject:  { title: 'Reject claim',  button: 'Reject',  noteRequired: true,  text: (c) => `${c.claimant} will see your note. They can claim again later.` },
  revoke:  { title: 'Revoke access', button: 'Revoke',  noteRequired: true,  text: (c) => `${c.claimant} will no longer be able to edit ${c.name}. The profile keeps its current content.` },
};

function openClaimReview(id, action) {
  const claim = allClaims.find((c) => c.id === id);
  const cfg = CLAIM_ACTION[action];
  if (!claim || !cfg || !hasRole(...CAN_REVIEW_CLAIMS)) return;
  document.getElementById('claimReviewId').value = id;
  document.getElementById('claimReviewAction').value = action;
  document.getElementById('claimModalTitle').textContent = cfg.title;
  document.getElementById('claimReviewSummary').textContent = cfg.text(claim);
  document.getElementById('claimReviewSubmit').textContent = cfg.button;
  document.getElementById('claimReviewRequired').style.display = cfg.noteRequired ? '' : 'none';
  document.getElementById('claimReviewNote').value = '';
  document.getElementById('claimReviewMessage').style.display = 'none';
  document.getElementById('claimModal').style.display = 'flex';
  document.getElementById('claimReviewNote').focus();
}
function closeClaimModal() {
  const modal = document.getElementById('claimModal');
  if (modal) modal.style.display = 'none';
}

async function submitClaimReview(e) {
  e.preventDefault();
  const id = document.getElementById('claimReviewId').value;
  const action = document.getElementById('claimReviewAction').value;
  const cfg = CLAIM_ACTION[action];
  const note = document.getElementById('claimReviewNote').value.trim();
  const msg = document.getElementById('claimReviewMessage');
  if (cfg.noteRequired && !note) {
    msg.textContent = 'A note is required — the claimant will see it.';
    msg.className = 'form-message form-message--error';
    msg.style.display = 'block';
    return;
  }
  const btn = document.getElementById('claimReviewSubmit');
  btn.disabled = true;
  try {
    await apiPut(`${ADMIN_API}/claims/${id}/${action}`, { note }, { success: { approve: 'Claim approved.', reject: 'Claim rejected.', revoke: 'Access revoked.' }[action] });
    closeClaimModal();
    loadClaims();
    refreshClaimsTabCount();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-message form-message--error';
    msg.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
}
window.openClaimReview = openClaimReview;

// ═══════════════════════════════════════════════════
// ═══ GREEN MARK (super admin only — money) ════════
// ═══════════════════════════════════════════════════

let greenSettings = null;
let greenOrders = [];
let greenMarks = [];
const GREEN_PLAN_LABEL = { 1: '1 month', 3: '3 months', 6: '6 months', 12: '1 year', 36: '3 years' };
const GREEN_STATUS_LABEL = { pending: 'Waiting for review', approved: 'Approved', rejected: 'Not approved', cancelled: 'Cancelled' };
const GREEN_STATUS_CLASS = { pending: 'pending', approved: 'published', rejected: 'archived', cancelled: 'archived' };

function greenMoney(cents, currency) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
}

async function loadGreenAdmin() {
  const status = document.getElementById('greenOrderFilter').value;
  document.getElementById('greenOrdersBody').innerHTML = AdminUI.loadingRows(6);
  document.getElementById('greenMarksBody').innerHTML = AdminUI.loadingRows(4);
  try {
    const [settings, orders, marks] = await Promise.all([
      apiGet(`${ADMIN_API}/green/settings`),
      apiGet(`${ADMIN_API}/green/orders${status ? `?status=${status}` : ''}`),
      apiGet(`${ADMIN_API}/green/marks`),
    ]);
    greenSettings = settings;
    greenOrders = orders.orders || [];
    greenMarks = marks.marks || [];
    renderGreenSettings();
    renderGreenOrders();
    renderGreenMarks();
    renderGreenGrantProfiles();
    if (!status || status === 'pending') setGreenTabCount(greenOrders.filter((o) => o.status === 'pending').length);
  } catch (err) {
    const msg = `<tr><td colspan="6" class="admin-table__empty" style="color:var(--danger);">Failed: ${escapeHtml(err.message)}</td></tr>`;
    document.getElementById('greenOrdersBody').innerHTML = msg;
    document.getElementById('greenMarksBody').innerHTML = msg;
  }
}

function setGreenTabCount(n) {
  const tab = document.querySelector('.admin__tab[data-tab="green"]');
  if (tab) tab.textContent = n > 0 ? `Green Mark (${n})` : 'Green Mark';
}
async function refreshGreenTabCount() {
  if (!hasRole(...CAN_MANAGE_GREEN)) return;
  try { setGreenTabCount(((await apiGet(`${ADMIN_API}/green/orders?status=pending`)).orders || []).length); } catch { /* the badge is optional */ }
}

function renderGreenSettings() {
  document.getElementById('greenCurrency').value = greenSettings.currency;
  document.getElementById('greenInstructions').value = greenSettings.payment_instructions;
  document.getElementById('greenPlansBody').innerHTML = greenSettings.plans.map((p) => `
    <tr data-months="${p.months}">
      <td>${GREEN_PLAN_LABEL[p.months]}</td>
      <td><input type="text" inputmode="decimal" class="form-input form-input--sm green-plan-price" value="${escapeHtml(p.price)}" placeholder="not set" style="width:120px;" aria-label="Price for ${GREEN_PLAN_LABEL[p.months]}" /></td>
      <td><label><input type="checkbox" class="green-plan-enabled"${p.enabled ? ' checked' : ''} /> Offered to artists</label></td>
    </tr>`).join('');
}

async function saveGreenSettings(e) {
  e.preventDefault();
  const msg = document.getElementById('greenSettingsMessage');
  msg.style.display = 'none';
  const body = {
    currency: document.getElementById('greenCurrency').value,
    payment_instructions: document.getElementById('greenInstructions').value,
    plans: [...document.querySelectorAll('#greenPlansBody tr')].map((tr) => ({
      months: Number(tr.dataset.months),
      price: tr.querySelector('.green-plan-price').value.trim(),
      enabled: tr.querySelector('.green-plan-enabled').checked,
    })),
  };
  const btn = document.getElementById('greenSettingsSave');
  btn.disabled = true;
  try {
    greenSettings = await apiPut(`${ADMIN_API}/green/settings`, body, { success: 'Plans saved.' });
    renderGreenSettings();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-message form-message--error';
    msg.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
}

function renderGreenOrders() {
  const tbody = document.getElementById('greenOrdersBody');
  if (!greenOrders.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="admin-table__empty">No orders here.</td></tr>';
    return;
  }
  tbody.innerHTML = greenOrders.map((o) => `
    <tr data-id="${o.id}">
      <td><div class="admin-table__title">${escapeHtml(o.name)}</div><div class="admin-table__slug">${escapeHtml(o.type)}</div></td>
      <td><div class="admin-table__title">${escapeHtml(o.buyer)}</div><div class="admin-table__slug">${o.buyer_email ? escapeHtml(o.buyer_email) : 'no email'}${o.buyer_email ? (o.buyer_email_verified ? ' <span title="The buyer confirmed this address" style="color:var(--success,#22c55e);">✔ confirmed</span>' : ' <span style="color:var(--text-muted);">· unconfirmed</span>') : ''}</div><div class="admin-table__slug">${o.buyer_phone ? escapeHtml(o.buyer_phone) : 'no phone'}</div><div class="admin-table__slug">${escapeHtml(formatDate(o.created_at))}</div></td>
      <td><div class="admin-table__title">${GREEN_PLAN_LABEL[o.months] || o.months + ' months'}</div><div class="admin-table__slug">${escapeHtml(greenMoney(o.amount_cents, o.currency))}</div></td>
      <td><div class="claim-evidence">${escapeHtml(o.reference)}</div>${o.note ? `<div class="admin-table__slug">${escapeHtml(o.note)}</div>` : ''}${o.has_receipt ? '<div class="admin-table__slug">📎 receipt attached</div>' : ''}</td>
      <td><span class="status-badge status-badge--${GREEN_STATUS_CLASS[o.status] || 'archived'}">${escapeHtml(GREEN_STATUS_LABEL[o.status] || o.status)}</span>${o.reviewed_by_username ? `<div class="admin-table__slug">by ${escapeHtml(o.reviewed_by_username)}</div>` : ''}${o.review_note ? `<div class="admin-table__slug">Note: ${escapeHtml(o.review_note)}</div>` : ''}</td>
      <td><div class="admin-table__actions"><button class="btn btn--sm ${o.status === 'pending' ? 'btn--primary' : 'btn--ghost'}" onclick="openGreenOrder(${o.id})">${o.status === 'pending' ? 'Review' : 'View'}</button></div></td>
    </tr>`).join('');
}

async function openGreenOrder(id) {
  const o = greenOrders.find((x) => x.id === id);
  if (!o) return;
  document.getElementById('greenOrderId').value = id;
  document.getElementById('greenOrderModalTitle').textContent = `Order #${id} — ${o.name}`;
  document.getElementById('greenOrderDetails').innerHTML = `
    <dt>Buyer</dt><dd>${escapeHtml(o.buyer)}${o.buyer_email ? ` · ${escapeHtml(o.buyer_email)}` : ''}${o.buyer_phone ? ` · ${escapeHtml(o.buyer_phone)}` : ''}</dd>
    <dt>Plan</dt><dd>${GREEN_PLAN_LABEL[o.months] || o.months + ' months'} · <strong>${escapeHtml(greenMoney(o.amount_cents, o.currency))}</strong></dd>
    <dt>Reference</dt><dd>${escapeHtml(o.reference)}</dd>
    ${o.note ? `<dt>Note</dt><dd>${escapeHtml(o.note)}</dd>` : ''}
    <dt>Current mark</dt><dd>${o.mark_expires_at ? `until ${escapeHtml(formatDate(o.mark_expires_at))}` : 'none'}</dd>
    <dt>Status</dt><dd>${escapeHtml(GREEN_STATUS_LABEL[o.status] || o.status)}</dd>`;
  const pending = o.status === 'pending';
  document.getElementById('greenOrderApprove').style.display = pending ? '' : 'none';
  document.getElementById('greenOrderReject').style.display = pending ? '' : 'none';
  document.getElementById('greenOrderNote').parentElement.style.display = pending ? '' : 'none';
  document.getElementById('greenOrderNote').value = '';
  document.getElementById('greenOrderMessage').style.display = 'none';
  document.getElementById('greenOrderReceiptBox').style.display = 'none';
  document.getElementById('greenOrderModal').style.display = 'flex';
  if (o.has_receipt) {
    try {
      const full = await apiGet(`${ADMIN_API}/green/orders/${id}`);
      if (full.receipt && /^data:image\//i.test(full.receipt)) {
        document.getElementById('greenOrderReceipt').src = full.receipt;
        document.getElementById('greenOrderReceiptBox').style.display = '';
      }
    } catch { /* the receipt is optional context */ }
  }
}
function closeGreenOrderModal() {
  const m = document.getElementById('greenOrderModal');
  if (m) m.style.display = 'none';
  const img = document.getElementById('greenOrderReceipt');
  if (img) img.removeAttribute('src');
}

async function reviewGreenOrder(action) {
  const id = document.getElementById('greenOrderId').value;
  const note = document.getElementById('greenOrderNote').value.trim();
  const msg = document.getElementById('greenOrderMessage');
  if (action === 'reject' && !note) {
    msg.textContent = 'A note is required to reject — the buyer will see it.';
    msg.className = 'form-message form-message--error';
    msg.style.display = 'block';
    return;
  }
  const buttons = ['greenOrderApprove', 'greenOrderReject'].map((b) => document.getElementById(b));
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await apiPut(`${ADMIN_API}/green/orders/${id}/${action}`, { note }, { success: action === 'approve' ? 'Order approved — Green mark is on.' : 'Order rejected.' });
    closeGreenOrderModal();
    loadGreenAdmin();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-message form-message--error';
    msg.style.display = 'block';
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

function renderGreenMarks() {
  const tbody = document.getElementById('greenMarksBody');
  if (!greenMarks.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="admin-table__empty">No Green marks yet.</td></tr>';
    return;
  }
  tbody.innerHTML = greenMarks.map((m) => `
    <tr data-id="${m.id}">
      <td><div class="admin-table__title">${escapeHtml(m.name)}</div><div class="admin-table__slug">${escapeHtml(m.type)}</div></td>
      <td><span class="status-badge status-badge--${m.active ? 'published' : 'archived'}">${m.active ? 'Active' : 'Expired'}</span></td>
      <td>${escapeHtml(formatDate(m.expires_at))}</td>
      <td><div class="admin-table__actions"><button class="btn btn--sm btn--ghost btn--danger-text" onclick="removeGreenMark(${m.id})">Remove</button></div></td>
    </tr>`).join('');
}

function renderGreenGrantProfiles() {
  const type = document.getElementById('greenGrantType').value;
  const list = type === 'artist' ? allArtists : allComposers;
  document.getElementById('greenGrantProfile').innerHTML = list.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

async function grantGreenMark(e) {
  e.preventDefault();
  const id = Number(document.getElementById('greenGrantProfile').value);
  if (!id) { AdminUI.alertToast('Choose a profile.'); return; }
  try {
    await apiPost(`${ADMIN_API}/green/marks`, { type: document.getElementById('greenGrantType').value, id, months: Number(document.getElementById('greenGrantMonths').value) }, { success: 'Green mark granted.' });
    loadGreenAdmin();
  } catch (err) { AdminUI.alertToast(err.message); }
}

async function removeGreenMark(id) {
  const m = greenMarks.find((x) => x.id === id);
  if (!m || !window.confirm(`Remove the Green mark from ${m.name}?`)) return;
  try {
    await apiDelete(`${ADMIN_API}/green/marks/${id}`, { success: 'Green mark removed.' });
    loadGreenAdmin();
  } catch (err) { AdminUI.alertToast(err.message); }
}
window.openGreenOrder = openGreenOrder;
window.removeGreenMark = removeGreenMark;

// ═══════════════════════════════════════════════════
// ═══ ADMIN USERS (super_admin only) ═══════════════
// ═══════════════════════════════════════════════════

async function loadAdminUsers() {
  const tbody = document.getElementById('adminUsersTableBody');
  tbody.innerHTML = AdminUI.loadingRows(4);
  try {
    const data = await apiGet(`${ADMIN_API}/admin-users`);
    allAdminUsers = data.admin_users || [];
    renderAdminUsersTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-table__empty" style="color:var(--danger);">Failed: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderAdminUsersTable() {
  const tbody = document.getElementById('adminUsersTableBody');
  const query = document.getElementById('adminUserSearch')?.value || '';
  // Search by the role label actually shown in the table (e.g. "Super Admin"),
  // not just the raw role slug (e.g. "super_admin"), so what the user sees is what matches.
  const q = normalizeForSearch(query).trim();
  const filtered = !q ? allAdminUsers : allAdminUsers.filter(u =>
    normalizeForSearch(u.username).includes(q) || normalizeForSearch(roleLabel(u.role)).includes(q));
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="admin-table__empty">${query.trim() ? 'No admin accounts match your search.' : 'No admin accounts found.'}</td></tr>`;
    return;
  }
  const me = getAdminInfo();
  // A Manager may not touch an existing Super Admin account at all — same rule the
  // backend enforces on PUT/DELETE /admin-users/:id — so hide those rows' actions client-side too.
  const canGrantSuperAdmin = hasRole('super_admin');
  tbody.innerHTML = filtered.map(u => {
    // Also lock your own row here — the backend rejects self-delete outright, so offering
    // Delete just to have it bounce back with an error is worse than not showing it at all.
    const locked = (u.role === 'super_admin' && !canGrantSuperAdmin) || (me && me.id === u.id);
    return `
    <tr data-id="${u.id}">
      <td><div class="admin-table__title">${escapeHtml(u.username)}${me && me.id === u.id ? ' <span class="role-badge role-badge--you">You</span>' : ''}</div></td>
      <td>${roleBadgeHtml(u.role)}</td>
      <td>${formatDate(u.created_at)}</td>
      <td>
        <div class="admin-table__actions">
          <button class="btn btn--sm btn--ghost" onclick="openProfileModal(${u.id})" title="View Profile">👁️</button>
          ${locked ? '' : `
          <button class="btn btn--sm btn--ghost" onclick="editAdminUser(${u.id})" title="Edit">✏️</button>
          <button class="btn btn--sm btn--ghost btn--danger-text" onclick="confirmDelete(${u.id}, 'admin-user')" title="Delete">🗑️</button>
          `}
        </div>
      </td>
    </tr>
  `;
  }).join('');
}

function openAdminUserModal() {
  document.getElementById('adminUserModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function closeAdminUserModal() {
  document.getElementById('adminUserModal').style.display = 'none';
  document.body.style.overflow = '';
  document.getElementById('adminUserForm').reset();
  document.getElementById('auFormId').value = '';
  document.getElementById('auFormMessage').style.display = 'none';
}
function showAdminUserMessage(text, isError = false) {
  const el = document.getElementById('auFormMessage');
  el.textContent = text;
  el.className = 'form-message ' + (isError ? 'form-message--error' : 'form-message--success');
  el.style.display = 'block';
}

function openNewAdminUser() {
  if (!hasRole(...CAN_MANAGE_ADMIN_USERS)) return;
  closeAdminUserModal();
  document.getElementById('adminUserModalTitle').textContent = 'New Admin';
  document.getElementById('auBtnSubmit').textContent = 'Create Admin';
  document.getElementById('auFormPassword').required = true;
  document.getElementById('auPasswordRequired').style.display = 'inline';
  document.getElementById('auFormPassword').placeholder = '';
  openAdminUserModal();
  document.getElementById('auFormUsername').focus();
}

function editAdminUser(id) {
  const u = allAdminUsers.find(a => a.id === id);
  if (!u) return;
  closeAdminUserModal();
  document.getElementById('adminUserModalTitle').textContent = 'Edit Admin';
  document.getElementById('auBtnSubmit').textContent = 'Update Admin';
  document.getElementById('auFormId').value = u.id;
  document.getElementById('auFormUsername').value = u.username;
  document.getElementById('auFormRole').value = u.role;
  document.getElementById('auFormPassword').required = false;
  document.getElementById('auPasswordRequired').style.display = 'none';
  document.getElementById('auFormPassword').placeholder = 'Leave blank to keep current password';
  openAdminUserModal();
}

async function saveAdminUser(e) {
  e.preventDefault();
  const id = document.getElementById('auFormId').value;
  const username = document.getElementById('auFormUsername').value.trim();
  const password = document.getElementById('auFormPassword').value;
  const role = document.getElementById('auFormRole').value;

  if (!username) { showAdminUserMessage('Username is required.', true); return; }
  if (!id && !password) { showAdminUserMessage('Password is required.', true); return; }
  if (password && password.length < 8) { showAdminUserMessage('Password must be at least 8 characters.', true); return; }

  const btn = document.getElementById('auBtnSubmit');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const body = { username, role };
    if (password) body.password = password;

    if (id) await apiPut(`${ADMIN_API}/admin-users/${id}`, body, { success: 'Admin updated.' });
    else await apiPost(`${ADMIN_API}/admin-users`, body, { success: 'Admin created.' });

    closeAdminUserModal();
    loadAdminUsers();
  } catch (err) {
    showAdminUserMessage(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = id ? 'Update Admin' : 'Create Admin';
  }
}

// ═══════════════════════════════════════════════════
// ═══ INIT ═════════════════════════════════════════
// ═══════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  AdminUI.showFlash();

  if (!getAdminToken()) {
    AdminUI.hideSplash();
    showLoginOverlay();
    return;
  }

  // Verify the stored session is still valid (also refreshes cached role info). A
  // network failure here (offline, or the API unreachable) is NOT a session failure —
  // falling into the same "session expired" branch would wipe a perfectly good token
  // just because there's no connectivity yet, locking the admin out of the offline app
  // they came here for. Only an actual auth rejection (401 from apiGet) clears the session.
  try {
    const me = await apiGet(`${ADMIN_API}/auth/me`);
    setAdminInfo(me);
  } catch (err) {
    if (OfflineSync.isNetworkError(err) && getAdminInfo()) {
      AdminUI.hideSplash();
      AdminUI.notify('You are offline — showing cached data.', 'info');
      initDashboard();
      return;
    }
    clearAdminSession();
    AdminUI.hideSplash();
    showLoginOverlay('Session expired. Please sign in again.');
    return;
  }

  AdminUI.hideSplash();
  initDashboard();
});

// Refreshes whichever table is on screen after the offline queue syncs or changes —
// bound once at load time (not inside initDashboard, which can re-run on re-login).
window.addEventListener('ml:sync-complete', () => {
  loadSongs(currentPage);
  loadArticles(currentArticlePage);
  refreshStats();
});
window.addEventListener('ml:queue-changed', () => {
  // Skip a table that's still showing its loading skeleton — re-rendering the (still empty)
  // list now would replace the skeleton with a misleading "No songs found".
  const stillLoading = (id) => document.getElementById(id)?.querySelector('.skel-row');
  if (!stillLoading('songsTableBody')) renderSongsTable(allSongs);
  if (!stillLoading('articlesTableBody')) renderArticlesTable(allArticles);
});

let dashboardInitialized = false;
function initDashboard() {
  applyRoleVisibility();
  OfflineSync.init();

  if (dashboardInitialized) {
    // A session-expiry (handleAuthFailure) shows the login overlay without
    // reloading the page, so a re-login reaches this function a second time
    // on the same still-mounted DOM. Re-running all the addEventListener
    // calls below would bind every form/button twice, turning one submit or
    // click into two (e.g. duplicate created rows, double status changes).
    // Just refresh the visible data instead.
    loadSongs(currentPage);
    refreshStats();
    return;
  }
  dashboardInitialized = true;

  // Settings menu (header dropdown: My Profile / Change Password / Log Out)
  document.getElementById('btnSettingsToggle').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSettingsMenu();
  });
  document.getElementById('btnLogout').addEventListener('click', () => { closeSettingsMenu(); logout(); });
  document.getElementById('btnChangePassword').addEventListener('click', () => { closeSettingsMenu(); changePassword(); });
  document.getElementById('btnMyProfile').addEventListener('click', () => {
    closeSettingsMenu();
    const info = getAdminInfo();
    if (info) openProfileModal(info.id);
  });
  document.getElementById('headerUser').addEventListener('click', () => {
    const info = getAdminInfo();
    if (info) openProfileModal(info.id);
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('settingsMenu');
    if (menu && !menu.contains(e.target)) closeSettingsMenu();
  });

  // Profile modal (view/follow any admin; self-management for your own)
  document.getElementById('profileModalClose').addEventListener('click', closeProfileModal);
  document.getElementById('profileBackdrop').addEventListener('click', closeProfileModal);
  document.getElementById('profileBtnClose').addEventListener('click', closeProfileModal);
  document.getElementById('profileBtnFollow').addEventListener('click', toggleProfileFollow);
  document.getElementById('profileBtnSaveChanges').addEventListener('click', saveProfileChanges);
  wirePhotoCrop();
  document.getElementById('profileBtnChangePassword').addEventListener('click', changePassword);
  document.getElementById('profileBtnDeleteAccount').addEventListener('click', showDeleteAccountConfirm);
  document.getElementById('profileBtnCancelDelete').addEventListener('click', cancelDeleteAccountConfirm);
  document.getElementById('profileBtnConfirmDelete').addEventListener('click', confirmDeleteAccount);

  // Admin user management (super_admin only)
  document.getElementById('btnNewAdminUser')?.addEventListener('click', openNewAdminUser);
  document.getElementById('adminUserForm')?.addEventListener('submit', saveAdminUser);
  document.getElementById('adminUserModalClose')?.addEventListener('click', closeAdminUserModal);
  document.getElementById('adminUserBackdrop')?.addEventListener('click', closeAdminUserModal);
  document.getElementById('auBtnCancel')?.addEventListener('click', closeAdminUserModal);

  // Sessions that predate profile photos have none cached — pull it once so the header avatar is right.
  apiGet(`${ADMIN_API}/auth/me`).then((me) => {
    const info = getAdminInfo();
    if (info && (info.photo || null) !== (me.photo || null)) {
      setAdminInfo({ ...info, photo: me.photo });
      applyRoleVisibility();
    }
  }).catch(() => {});

  // Load songs + populate dropdowns
  loadSongs();
  refreshStats();
  populateDropdowns();

  // Restore saved tab (persists across page refresh)
  const savedTab = (() => { try { return sessionStorage.getItem('admin_tab') || 'songs'; } catch { return 'songs'; } })();
  switchTab(savedTab);

  // Tab switching
  document.querySelectorAll('.admin__tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Song buttons
  document.getElementById('btnNewSong').addEventListener('click', openNewSong);
  document.getElementById('songForm').addEventListener('submit', saveSongDirect);
  document.getElementById('btnSubmitRevision').addEventListener('click', submitSongRevision);
  document.getElementById('modalClose').addEventListener('click', closeSongModal);
  document.getElementById('modalBackdrop').addEventListener('click', closeSongModal);
  document.getElementById('btnCancel').addEventListener('click', closeSongModal);

  // Artist/Composer checkbox-list filters
  wireCheckboxListFilter(document.getElementById('formArtistFilter'), document.getElementById('formArtist'));
  wireCheckboxListFilter(document.getElementById('formComposerFilter'), document.getElementById('formComposer'));

  // Image upload & social links
  initImageFields();
  initVideoEditors();
  document.getElementById('btnAddSocial').addEventListener('click', () => addSocialLinkRow());

  // Artist / Composer buttons
  document.getElementById('btnNewArtist').addEventListener('click', () => openNewPerson('artist'));
  document.getElementById('btnNewComposer').addEventListener('click', () => openNewPerson('composer'));
  document.getElementById('personForm').addEventListener('submit', savePerson);
  initBadgeModal();
  document.getElementById('personModalClose').addEventListener('click', closePersonModal);
  document.getElementById('personBackdrop').addEventListener('click', closePersonModal);
  document.getElementById('personBtnCancel').addEventListener('click', closePersonModal);

  // Copyright Owner buttons
  document.getElementById('btnNewSupporter').addEventListener('click', openNewSupporter);
  document.getElementById('supporterForm').addEventListener('submit', saveSupporter);
  ['supModalClose', 'supBackdrop', 'supBtnCancel'].forEach(id => document.getElementById(id).addEventListener('click', closeSupporterModal));
  document.getElementById('greenSettingsForm').addEventListener('submit', saveGreenSettings);
  document.getElementById('greenOrderFilter').addEventListener('change', loadGreenAdmin);
  document.getElementById('greenGrantForm').addEventListener('submit', grantGreenMark);
  document.getElementById('greenGrantType').addEventListener('change', renderGreenGrantProfiles);
  document.getElementById('greenOrderApprove').addEventListener('click', () => reviewGreenOrder('approve'));
  document.getElementById('greenOrderReject').addEventListener('click', () => reviewGreenOrder('reject'));
  ['greenOrderClose', 'greenOrderBackdrop', 'greenOrderCancel'].forEach(id => document.getElementById(id).addEventListener('click', closeGreenOrderModal));
  refreshGreenTabCount();
  document.getElementById('claimFilterStatus').addEventListener('change', loadClaims);
  document.getElementById('claimReviewForm').addEventListener('submit', submitClaimReview);
  ['claimModalClose', 'claimBackdrop', 'claimReviewCancel'].forEach(id => document.getElementById(id).addEventListener('click', closeClaimModal));
  refreshClaimsTabCount();
  document.getElementById('btnNewIdolSeason').addEventListener('click', openNewIdolSeason);
  document.getElementById('idolSeasonForm').addEventListener('submit', saveIdolSeason);
  ['isModalClose', 'isBackdrop', 'isBtnCancel'].forEach(id => document.getElementById(id).addEventListener('click', closeIdolSeasonModal));
  document.getElementById('btnNewIdol').addEventListener('click', openNewIdol);
  document.getElementById('idolForm').addEventListener('submit', saveIdol);
  ['idModalClose', 'idBackdrop', 'idBtnCancel'].forEach(id => document.getElementById(id).addEventListener('click', closeIdolModal));
  document.getElementById('idolFilterSeason').addEventListener('change', renderIdolsTable);
  document.getElementById('idolSearch').addEventListener('input', renderIdolsTable);
  document.getElementById('btnNewCopyrightOwner').addEventListener('click', openNewCopyrightOwner);
  document.getElementById('copyrightOwnerForm').addEventListener('submit', saveCopyrightOwner);
  document.getElementById('coModalClose').addEventListener('click', closeCopyrightOwnerModal);
  document.getElementById('coBackdrop').addEventListener('click', closeCopyrightOwnerModal);
  document.getElementById('coBtnCancel').addEventListener('click', closeCopyrightOwnerModal);

  // Article buttons
  document.getElementById('btnNewArticle').addEventListener('click', openNewArticle);
  document.getElementById('articleForm').addEventListener('submit', saveArticle);
  document.getElementById('articleModalClose').addEventListener('click', closeArticleModal);
  document.getElementById('articleBackdrop').addEventListener('click', closeArticleModal);
  document.getElementById('articleBtnCancel').addEventListener('click', closeArticleModal);
  document.getElementById('articleFormTitle').addEventListener('input', autoArticleSlug);
  document.getElementById('articleFormSlug').addEventListener('input', function () {
    this.dataset.manual = this.value ? '1' : '';
  });
  wireArticleRte();
  mountPersonBioRte();
  document.getElementById('articleFilterStatus').addEventListener('change', () => loadArticles(1));
  let articleSearchTimer;
  document.getElementById('articleSearch').addEventListener('input', (e) => {
    clearTimeout(articleSearchTimer);
    articleSearchTimer = setTimeout(() => loadArticles(1, e.target.value), 200);
  });

  // Delete modal
  document.getElementById('deleteModalClose').addEventListener('click', closeDeleteModal);
  document.getElementById('deleteBackdrop').addEventListener('click', closeDeleteModal);
  document.getElementById('btnDeleteCancel').addEventListener('click', closeDeleteModal);
  document.getElementById('btnDeleteConfirm').addEventListener('click', deleteItem);

  // Search filter (server-side, across all songs — not just the current page)
  let searchTimer;
  document.getElementById('adminSearch').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadSongs(1, e.target.value), 200);
  });

  // Search filters (client-side — these tabs load their full dataset up front)
  document.getElementById('artistSearch')?.addEventListener('input', () => renderArtistsTable());
  document.getElementById('composerSearch')?.addEventListener('input', () => renderComposersTable());
  document.getElementById('coSearch')?.addEventListener('input', () => renderCopyrightOwnersTable());
  document.getElementById('reportSearch')?.addEventListener('input', () => renderReportsTable());
  document.getElementById('revisionSearch')?.addEventListener('input', () => renderRevisionsTable());
  document.getElementById('auditSearch')?.addEventListener('input', () => renderAuditLogTable());
  document.getElementById('contactSearch')?.addEventListener('input', () => renderContactsTable());
  document.getElementById('adminUserSearch')?.addEventListener('input', () => renderAdminUsersTable());

  // Reports filter
  document.getElementById('reportFilterStatus').addEventListener('change', () => renderReportsTable());

  // Feedback detail modal
  document.getElementById('feedbackModalClose').addEventListener('click', closeFeedbackModal);
  document.getElementById('feedbackBackdrop').addEventListener('click', closeFeedbackModal);
  document.getElementById('feedbackBtnClose').addEventListener('click', closeFeedbackModal);

  // Revisions tab + review modal
  document.getElementById('revisionFilterStatus')?.addEventListener('change', () => renderRevisionsTable());
  document.getElementById('revisionModalClose')?.addEventListener('click', closeRevisionModal);
  document.getElementById('revisionBackdrop')?.addEventListener('click', closeRevisionModal);
  document.getElementById('revisionBtnClose')?.addEventListener('click', closeRevisionModal);
  document.getElementById('revisionBtnApprove')?.addEventListener('click', approveRevision);
  document.getElementById('revisionBtnReject')?.addEventListener('click', rejectRevision);

  // Audit log filter
  document.getElementById('auditFilterTarget')?.addEventListener('change', () => loadAuditLog());

  // Feedback Inbox (contacts) filter + detail modal
  document.getElementById('contactFilterStatus')?.addEventListener('change', () => renderContactsTable());
  document.getElementById('contactModalClose')?.addEventListener('click', closeContactModal);
  document.getElementById('contactBackdrop')?.addEventListener('click', closeContactModal);
  document.getElementById('contactBtnClose')?.addEventListener('click', closeContactModal);

  // Auto-slug on title/name typing
  document.getElementById('formTitle').addEventListener('input', autoSongSlug);
  document.getElementById('formSlug').addEventListener('input', function () {
    this.dataset.manual = this.value ? '1' : '';
  });
  document.getElementById('personFormName').addEventListener('input', autoPersonSlug);
  document.getElementById('personFormSlug').addEventListener('input', function () {
    this.dataset.manual = this.value ? '1' : '';
  });
  document.getElementById('coFormName').addEventListener('input', autoCOSlug);
  document.getElementById('coFormSlug').addEventListener('input', function () {
    this.dataset.manual = this.value ? '1' : '';
  });

  // ── Auto-save drafts while typing ─────────────────
  ['formTitle', 'formLyrics', 'formCategory', 'formSlug'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', autoSaveSongDraft);
  });
  ['formArtist', 'formComposer', 'formCopyrightOwner'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', autoSaveSongDraft);
  });
  ['personFormName', 'personFormSlug'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', autoSavePersonDraft);
  });
  ['coFormName', 'coFormSlug', 'coFormFullLegalName', 'coFormOrganization', 'coFormTerritory', 'coFormNotes'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', autoSaveCoDraft);
  });

  // ── Draft banner: Restore / Discard buttons ────────
  document.getElementById('btnRestoreSongDraft')?.addEventListener('click', () => {
    const id = document.getElementById('formSongId').value || null;
    const draft = loadDraft('song', id);
    if (draft) restoreSongDraftData(draft);
    hideDraftBanner('songDraftBanner', 'songDraftIndicator');
  });
  document.getElementById('btnDiscardSongDraft')?.addEventListener('click', () => {
    const id = document.getElementById('formSongId').value || null;
    clearDraft('song', id);
    hideDraftBanner('songDraftBanner', 'songDraftIndicator');
  });
  document.getElementById('btnRestorePersonDraft')?.addEventListener('click', () => {
    const type = document.getElementById('personFormType').value || 'artist';
    const id = document.getElementById('personFormId').value || null;
    const draft = loadDraft(type, id);
    if (draft) restorePersonDraftData(draft);
    hideDraftBanner('personDraftBanner', 'personDraftIndicator');
  });
  document.getElementById('btnDiscardPersonDraft')?.addEventListener('click', () => {
    const type = document.getElementById('personFormType').value || 'artist';
    const id = document.getElementById('personFormId').value || null;
    clearDraft(type, id);
    hideDraftBanner('personDraftBanner', 'personDraftIndicator');
  });
  document.getElementById('btnRestoreCoDraft')?.addEventListener('click', () => {
    const id = document.getElementById('coFormId').value || null;
    const draft = loadDraft('copyright-owner', id);
    if (draft) restoreCoDraftData(draft);
    hideDraftBanner('coDraftBanner', 'coDraftIndicator');
  });
  document.getElementById('btnDiscardCoDraft')?.addEventListener('click', () => {
    const id = document.getElementById('coFormId').value || null;
    clearDraft('copyright-owner', id);
    hideDraftBanner('coDraftBanner', 'coDraftIndicator');
  });

  // Keyboard: Escape to close modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSongModal();
      closePersonModal();
      closeCopyrightOwnerModal();
      closeSupporterModal();
      closeIdolSeasonModal();
      closeIdolModal();
      closeClaimModal();
      closeGreenOrderModal();
      closeDeleteModal();
      closeFeedbackModal();
      closeRevisionModal();
      closeContactModal();
      closeProfileModal();
      closeAdminUserModal();
      closeSettingsMenu();
    }
  });
}

// Expose to inline onclick handlers
window.editSong = editSong;
window.editPerson = editPerson;
window.editAdminUser = editAdminUser;
window.editCopyrightOwner = editCopyrightOwner;
window.confirmDelete = confirmDelete;
window.loadSongs = loadSongs;
window.updateReportStatus = updateReportStatus;
window.viewFeedback = viewFeedback;
window.changeSongStatus = changeSongStatus;
window.openRevisionModal = openRevisionModal;
window.updateContactStatus = updateContactStatus;
window.viewContact = viewContact;
window.openProfileModal = openProfileModal;
window.selectAvatar = selectAvatar;

// ═══════════════════════════════════════════════════
// ═══ COPYRIGHT OWNERS ═════════════════════════════
// ═══════════════════════════════════════════════════

async function loadCopyrightOwners() {
  const tbody = document.getElementById('copyrightOwnersTableBody');
  tbody.innerHTML = AdminUI.loadingRows(5);
  try {
    const data = await apiGet(`${ADMIN_API}/copyright-owners`);
    allCopyrightOwners = data.copyright_owners || [];
    renderCopyrightOwnersTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-table__empty" style="color:var(--danger);">Failed: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderCopyrightOwnersTable() {
  const tbody = document.getElementById('copyrightOwnersTableBody');
  const query = document.getElementById('coSearch')?.value || '';
  const items = filterBySearch(allCopyrightOwners, query, ['name', 'slug', 'organization', 'territory']);
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-table__empty">${query.trim() ? 'No copyright owners match your search.' : 'No copyright owners found.'}</td></tr>`;
    return;
  }
  const canManage = hasRole(...CAN_MANAGE_REFERENCE_DATA);
  tbody.innerHTML = items.map(item => `
    <tr data-id="${item.id}">
      <td><div class="admin-table__person">${entityAvatarHtml(item.image_url)}<div class="admin-table__title">${escapeHtml(item.name)}</div></div></td>
      <td><div class="admin-table__slug">/copyright-owner/${escapeHtml(item.slug)}</div></td>
      <td>${escapeHtml(item.organization || '—')}</td>
      <td>${escapeHtml(item.territory || '—')}</td>
      <td>
        <div class="admin-table__actions">
          ${canManage ? `<button class="btn btn--sm btn--ghost" onclick="editCopyrightOwner(${item.id})" title="Edit">✏️</button>` : ''}
          ${canManage ? `<button class="btn btn--sm btn--ghost btn--danger-text" onclick="confirmDelete(${item.id}, 'copyright-owner')" title="Delete">🗑️</button>` : ''}
          <a href="${SITE_ORIGIN}/copyright-owner/${escapeHtml(item.slug)}" target="_blank" class="btn btn--sm btn--ghost" title="View">👁️</a>
        </div>
      </td>
    </tr>
  `).join('');
}

// Copyright Owner Modal
function openCopyrightOwnerModal() {
  document.getElementById('copyrightOwnerModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function closeCopyrightOwnerModal() {
  document.getElementById('copyrightOwnerModal').style.display = 'none';
  document.body.style.overflow = '';
  clearCopyrightOwnerForm();
}
function clearCopyrightOwnerForm() {
  document.getElementById('copyrightOwnerForm').reset();
  document.getElementById('coFormId').value = '';
  document.getElementById('coFormMessage').style.display = 'none';
  // See clearSongForm() — .reset() never clears dataset, so the "manual" flag
  // must be cleared explicitly or it leaks into the next new/edit session.
  document.getElementById('coFormSlug').dataset.manual = '';
  hideDraftBanner('coDraftBanner', 'coDraftIndicator');
  setImageField('coFormImage', '');
}
function showCOMessage(text, isError = false) {
  const el = document.getElementById('coFormMessage');
  el.textContent = text;
  el.className = 'form-message ' + (isError ? 'form-message--error' : 'form-message--success');
  el.style.display = 'block';
}

function openNewCopyrightOwner() {
  if (!hasRole(...CAN_MANAGE_REFERENCE_DATA)) return;
  clearCopyrightOwnerForm();
  document.getElementById('coModalTitle').textContent = 'New Copyright Owner';
  document.getElementById('coBtnSubmit').textContent = 'Create Copyright Owner';
  openCopyrightOwnerModal();
  document.getElementById('coFormName').focus();
  // Check for unsaved draft
  const draft = loadDraft('copyright-owner', null);
  if (draft && draft.name) {
    showDraftBanner('coDraftBanner');
  }
}

async function editCopyrightOwner(id) {
  return AdminUI.withLoading('Loading…', () => _editCopyrightOwner(id));
}
async function _editCopyrightOwner(id) {
  clearCopyrightOwnerForm();
  document.getElementById('coModalTitle').textContent = 'Edit Copyright Owner';
  document.getElementById('coBtnSubmit').textContent = 'Update Copyright Owner';
  openCopyrightOwnerModal();

  try {
    const item = await apiGet(`${ADMIN_API}/copyright-owners/${id}`);
    document.getElementById('coFormId').value = item.id;
    document.getElementById('coFormName').value = item.name || '';
    document.getElementById('coFormSlug').value = item.slug || '';
    document.getElementById('coFormFullLegalName').value = item.full_legal_name || '';
    document.getElementById('coFormOrganization').value = item.organization || '';
    document.getElementById('coFormTerritory').value = item.territory || '';
    document.getElementById('coFormEmail').value = item.email || '';
    document.getElementById('coFormWebsite').value = item.website || '';
    document.getElementById('coFormAddress').value = item.address || '';
    document.getElementById('coFormIPI').value = item.ipi_number || '';
    document.getElementById('coFormISRC').value = item.isrc_prefix || '';
    document.getElementById('coFormPRO').value = item.pro_affiliation || '';
    document.getElementById('coFormNotes').value = item.notes || '';
    setImageField('coFormImage', item.image_url || '');
    // Check for unsaved draft for this copyright owner
    const coDraft = loadDraft('copyright-owner', item.id);
    if (coDraft && coDraft.name) {
      showDraftBanner('coDraftBanner');
    }
  } catch (err) {
    showCOMessage('Failed to load: ' + err.message, true);
  }
}

async function saveCopyrightOwner(e) {
  e.preventDefault();

  const id = document.getElementById('coFormId').value;
  const name = document.getElementById('coFormName').value.trim();
  const slug = document.getElementById('coFormSlug').value.trim();
  const full_legal_name = document.getElementById('coFormFullLegalName').value.trim();
  const organization = document.getElementById('coFormOrganization').value.trim();
  const territory = document.getElementById('coFormTerritory').value.trim();
  const email = document.getElementById('coFormEmail').value.trim();
  const website = document.getElementById('coFormWebsite').value.trim();
  const address = document.getElementById('coFormAddress').value.trim();
  const ipi_number = document.getElementById('coFormIPI').value.trim();
  const isrc_prefix = document.getElementById('coFormISRC').value.trim();
  const pro_affiliation = document.getElementById('coFormPRO').value.trim();
  const notes = document.getElementById('coFormNotes').value.trim();
  const image_url = document.getElementById('coFormImage').value.trim();

  if (!name) { showCOMessage('Name is required.', true); return; }

  const btn = document.getElementById('coBtnSubmit');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const body = { name, slug, full_legal_name, organization, territory, email, website, address, ipi_number, isrc_prefix, pro_affiliation, notes, image_url };

    if (id) {
      await apiPut(`${ADMIN_API}/copyright-owners/${id}`, body, { success: 'Copyright owner updated.' });
      showCOMessage('Copyright owner updated successfully!');
    } else {
      await apiPost(`${ADMIN_API}/copyright-owners`, body, { success: 'Copyright owner created.' });
      showCOMessage('Copyright owner created successfully!');
    }
    // Clear draft on successful save
    clearDraft('copyright-owner', id || null);
    hideDraftBanner('coDraftBanner', 'coDraftIndicator');

    setTimeout(() => {
      closeCopyrightOwnerModal();
      loadCopyrightOwners();
    }, 800);
  } catch (err) {
    showCOMessage(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = id ? 'Update Copyright Owner' : 'Create Copyright Owner';
  }
}

function autoCOSlug() {
  const slugField = document.getElementById('coFormSlug');
  const nameField = document.getElementById('coFormName');
  if (!slugField.dataset.manual) {
    slugField.value = generateSlug(nameField.value);
  }
}

// ═══════════════════════════════════════════════════
// ═══ ARTICLES ═════════════════════════════════════
// ═══════════════════════════════════════════════════
// No revision workflow (unlike songs) — direct create/edit, gated by role.
// Publishing (draft -> published) IS the "send notification" action: it's what
// makes an article show up on the public /articles page and in the site's
// in-app notification poller (title + author). There's no separate send step.

let currentArticlePage = 1;
let totalArticlePages = 1;
let currentArticleSearchQuery = '';

async function loadArticles(page = 1, query = currentArticleSearchQuery) {
  const tbody = document.getElementById('articlesTableBody');
  tbody.innerHTML = AdminUI.loadingRows(5);
  currentArticleSearchQuery = query || '';

  try {
    const qParam = currentArticleSearchQuery ? `&q=${encodeURIComponent(currentArticleSearchQuery)}` : '';
    const statusFilter = document.getElementById('articleFilterStatus')?.value || '';
    const statusParam = statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : '';
    const data = await apiGet(`${ADMIN_API}/articles?page=${page}&limit=50${qParam}${statusParam}`);
    allArticles = data.articles || [];
    currentArticlePage = data.page;
    totalArticlePages = data.totalPages;

    OfflineSync.cacheList('article', allArticles).catch(() => {});
    renderArticlesTable(allArticles);
    renderArticlesPagination();
  } catch (err) {
    if (!OfflineSync.isNetworkError(err)) {
      tbody.innerHTML = `<tr><td colspan="5" class="admin-table__empty" style="color:var(--danger);">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
      return;
    }
    try {
      const cached = await OfflineSync.getCachedList('article');
      allArticles = filterBySearch(cached, currentArticleSearchQuery, ['title', 'author_name'])
        .filter((a) => !statusFilterValue() || a.status === statusFilterValue())
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      currentArticlePage = 1;
      totalArticlePages = 1;
      renderArticlesTable(allArticles);
      document.getElementById('articlesPagination').innerHTML = '';
      if (typeof Toast !== 'undefined') Toast.show('Offline — showing cached articles.', { type: 'info' });
    } catch {
      tbody.innerHTML = '<tr><td colspan="5" class="admin-table__empty" style="color:var(--danger);">Offline and no cached articles available.</td></tr>';
    }
  }
}
function statusFilterValue() {
  return document.getElementById('articleFilterStatus')?.value || '';
}

function articleStatusBadgeHtml(status) {
  return `<span class="status-badge status-badge--${status === 'published' ? 'published' : 'pending'}">${status === 'published' ? 'Published' : 'Draft'}</span>`;
}

// Inline Publish/Unpublish for the articles table row.
function articleStatusActionsHtml(article) {
  if (!hasRole(...CAN_PUBLISH_ARTICLE)) return '';
  return article.status === 'published'
    ? `<button class="btn btn--sm btn--ghost" onclick="changeArticleStatus(${article.id}, 'draft')" title="Unpublish">⏸️</button>`
    : `<button class="btn btn--sm btn--ghost" onclick="changeArticleStatus(${article.id}, 'published')" title="Publish (sends the notification)">📢</button>`;
}

async function changeArticleStatus(id, status) {
  try {
    const updated = await apiPut(`${ADMIN_API}/articles/${id}/status`, { status }, { success: `Article marked ${status}.` });
    const article = allArticles.find(a => a.id === id);
    if (article) { article.status = updated.status; article.published_at = updated.published_at; }
    renderArticlesTable(allArticles);
    if (document.getElementById('articleFormId')?.value == id) {
      renderArticleStatusRow(updated);
    }
    if (typeof Toast !== 'undefined' && status === 'published') {
      Toast.show('Article published — it now appears on the public site and in visitors’ notifications.', { type: 'success', duration: 4000 });
    }
  } catch (err) {
    if (typeof Toast !== 'undefined') Toast.show('Failed to update status: ' + err.message, { type: 'error' });
    else AdminUI.alertToast('Failed to update status: ' + err.message);
  }
}

function renderArticlesTable(articles) {
  const tbody = document.getElementById('articlesTableBody');

  if (!articles.length) {
    tbody.innerHTML = currentArticleSearchQuery
      ? '<tr><td colspan="5" class="admin-table__empty">No articles match your search.</td></tr>'
      : '<tr><td colspan="5" class="admin-table__empty">No articles found. Click "+ New Article" to add one.</td></tr>';
    return;
  }

  const canDelete = hasRole(...CAN_DELETE_ARTICLE);
  const canEdit = hasRole(...CAN_EDIT_ARTICLE);

  tbody.innerHTML = articles.map((article) => {
    const isUnsynced = article._offlineLocal || article._offlinePending || OfflineSync.isPending('article', article.id);
    const hasConflict = OfflineSync.hasConflict('article', article.id);
    const idArg = JSON.stringify(article.id);
    const syncBadge = hasConflict
      ? '<span class="sync-badge sync-badge--conflict" title="A newer version exists on the server">⚠️ Conflict</span>'
      : isUnsynced ? '<span class="sync-badge sync-badge--pending" title="Queued, waiting to sync">🔄 Pending sync</span>' : '';

    return `
    <tr data-id="${article.id}">
      <td>
        <div class="admin-table__title">${escapeHtml(article.title)}</div>
        <div class="admin-table__slug">/article/${escapeHtml(article.slug)}</div>
      </td>
      <td>${escapeHtml(article.author_name)}</td>
      <td>${articleStatusBadgeHtml(article.status)}${syncBadge}</td>
      <td>${formatDate(article.created_at)}</td>
      <td>
        <div class="admin-table__actions">
          ${canEdit
            ? `<button class="btn btn--sm btn--ghost" onclick="editArticle(${idArg})" title="Edit">✏️</button>`
            : `<button class="btn btn--sm btn--ghost" onclick="editArticle(${idArg})" title="View">👁️</button>`}
          ${isUnsynced ? '' : articleStatusActionsHtml(article)}
          ${canDelete && !isUnsynced ? `<button class="btn btn--sm btn--ghost btn--danger-text" onclick="confirmDelete(${idArg}, 'article')" title="Delete">🗑️</button>` : ''}
          ${!isUnsynced && article.status === 'published' ? `<a href="${SITE_ORIGIN}/article/${escapeHtml(article.slug)}" target="_blank" class="btn btn--sm btn--ghost" title="View">👁️</a>` : ''}
        </div>
      </td>
    </tr>
  `;
  }).join('');
}

function renderArticlesPagination() {
  const el = document.getElementById('articlesPagination');
  if (!el) return;
  if (totalArticlePages <= 1) { el.innerHTML = ''; return; }

  let html = `<button class="pagination__btn" ${currentArticlePage <= 1 ? 'disabled' : ''} onclick="loadArticles(${currentArticlePage - 1})">← Prev</button>`;
  html += `<span class="pagination__info">Page ${currentArticlePage} of ${totalArticlePages}</span>`;
  html += `<button class="pagination__btn" ${currentArticlePage >= totalArticlePages ? 'disabled' : ''} onclick="loadArticles(${currentArticlePage + 1})">Next →</button>`;
  el.innerHTML = html;
}

// Article Modal
function openArticleModal() {
  document.getElementById('articleModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function closeArticleModal() {
  document.getElementById('articleModal').style.display = 'none';
  document.body.style.overflow = '';
  clearArticleForm();
}
// Set whenever an article is loaded into the edit form — sent back as
// expected_updated_at on save (see currentSongLoadedUpdatedAt for the song equivalent).
let currentArticleLoadedUpdatedAt = null;

function clearArticleForm() {
  document.getElementById('articleForm').reset();
  document.getElementById('articleFormId').value = '';
  document.getElementById('articleFormContent').innerHTML = '';
  document.getElementById('articleFormMessage').style.display = 'none';
  document.getElementById('articleFormSlug').dataset.manual = '';
  document.getElementById('articleStatusRow').style.display = 'none';
  document.getElementById('articleBtnSubmit').style.display = '';
  currentArticleLoadedUpdatedAt = null;
  setArticleFieldsDisabled(false);
}

// Wires the toolbar above the Article "Content" field — a contenteditable div
// driven by document.execCommand, the only rich-text field in this dashboard.
function wireArticleRte() {
  const toolbar = document.querySelector('.rte-toolbar[data-for="articleFormContent"]');
  const editor = document.getElementById('articleFormContent');
  if (!toolbar || !editor) return;

  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.rte-toolbar__btn');
    if (!btn) return;
    e.preventDefault();
    editor.focus();
    const cmd = btn.dataset.cmd;
    if (cmd === 'createLink') {
      const url = prompt('Link URL:', 'https://');
      if (!url) return;
      document.execCommand('createLink', false, url);
    } else if (cmd === 'formatBlock') {
      document.execCommand('formatBlock', false, btn.dataset.value);
    } else {
      document.execCommand(cmd, false, null);
    }
  });

  // Reflect active formatting (bold/italic/underline/lists) on the toolbar as
  // the caret moves, same as a normal word processor toolbar.
  const updateActiveStates = () => {
    toolbar.querySelectorAll('.rte-toolbar__btn[data-cmd]').forEach((btn) => {
      const cmd = btn.dataset.cmd;
      if (cmd === 'createLink' || cmd === 'removeFormat' || cmd === 'formatBlock') return;
      let active = false;
      try { active = document.queryCommandState(cmd); } catch { /* unsupported in this browser */ }
      btn.classList.toggle('active', active);
    });
  };
  editor.addEventListener('keyup', updateActiveStates);
  editor.addEventListener('mouseup', updateActiveStates);
  editor.addEventListener('focus', updateActiveStates);
}
function showArticleMessage(text, isError = false) {
  const el = document.getElementById('articleFormMessage');
  el.textContent = text;
  el.className = 'form-message ' + (isError ? 'form-message--error' : 'form-message--success');
  el.style.display = 'block';
}

function setArticleFieldsDisabled(disabled) {
  ['articleFormTitle', 'articleFormAuthor', 'articleFormSlug', 'articleFormSummary'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  const editor = document.getElementById('articleFormContent');
  if (editor) editor.contentEditable = disabled ? 'false' : 'true';
}

// Populates the status badge + Publish/Unpublish button — mirrors renderSongStatusRow.
function renderArticleStatusRow(article) {
  const row = document.getElementById('articleStatusRow');
  const badge = document.getElementById('articleStatusBadge');
  const actions = document.getElementById('articleStatusActions');
  if (!row || !badge || !actions) return;
  if (!article || !article.status) { row.style.display = 'none'; return; }

  row.style.display = 'flex';
  badge.className = 'status-badge status-badge--' + (article.status === 'published' ? 'published' : 'pending');
  badge.textContent = article.status === 'published' ? 'Published' : 'Draft';

  actions.innerHTML = hasRole(...CAN_PUBLISH_ARTICLE)
    ? (article.status === 'published'
        ? `<button type="button" class="btn btn--sm btn--ghost" onclick="changeArticleStatus(${article.id}, 'draft')">Unpublish</button>`
        : `<button type="button" class="btn btn--sm btn--ghost" onclick="changeArticleStatus(${article.id}, 'published')">Publish</button>`)
    : '';
}

function openNewArticle() {
  if (!hasRole(...CAN_CREATE_ARTICLE)) return;
  clearArticleForm();
  document.getElementById('articleModalTitle').textContent = 'New Article';
  document.getElementById('articleBtnSubmit').textContent = 'Create Article';
  openArticleModal();
  document.getElementById('articleFormTitle').focus();
}

function populateArticleForm(item) {
  document.getElementById('articleFormId').value = item.id;
  document.getElementById('articleFormTitle').value = item.title || '';
  document.getElementById('articleFormAuthor').value = item.author_name || '';
  document.getElementById('articleFormSlug').value = item.slug || '';
  document.getElementById('articleFormSummary').value = item.summary || '';
  document.getElementById('articleFormContent').innerHTML = item.content || '';
  currentArticleLoadedUpdatedAt = item.updated_at || null;
  renderArticleStatusRow(item);
}

async function editArticle(id) {
  return AdminUI.withLoading('Loading article…', () => _editArticle(id));
}
async function _editArticle(id) {
  clearArticleForm();
  document.getElementById('articleModalTitle').textContent = 'Edit Article';
  document.getElementById('articleBtnSubmit').textContent = 'Update Article';
  const canEdit = hasRole(...CAN_EDIT_ARTICLE);
  setArticleFieldsDisabled(!canEdit);
  document.getElementById('articleBtnSubmit').style.display = canEdit ? '' : 'none';
  openArticleModal();

  const isLocalOnly = typeof id === 'string' && id.startsWith('local-article-');
  if (isLocalOnly) {
    const item = await OfflineSync.getCachedOne('article', id);
    if (!item) { showArticleMessage('This queued article is no longer available.', true); return; }
    populateArticleForm(item);
    return;
  }

  try {
    const item = await apiGet(`${ADMIN_API}/articles/${id}`);
    OfflineSync.cacheDetail('article', item).catch(() => {});
    populateArticleForm(item);
  } catch (err) {
    if (!OfflineSync.isNetworkError(err)) {
      showArticleMessage('Failed to load: ' + err.message, true);
      return;
    }
    const cached = await OfflineSync.getCachedOne('article', id);
    if (cached) {
      populateArticleForm(cached);
      if (typeof Toast !== 'undefined') Toast.show('Offline — editing the cached copy of this article.', { type: 'info' });
    } else {
      showArticleMessage('Offline and this article isn’t cached yet.', true);
    }
  }
}

async function saveArticle(e) {
  e.preventDefault();

  const id = document.getElementById('articleFormId').value;
  const title = document.getElementById('articleFormTitle').value.trim();
  const author_name = document.getElementById('articleFormAuthor').value.trim();
  const slug = document.getElementById('articleFormSlug').value.trim();
  const summary = document.getElementById('articleFormSummary').value.trim();
  const contentEl = document.getElementById('articleFormContent');
  const content = contentEl.innerHTML.trim();
  // A "visually empty" contenteditable div can still contain markup like
  // <p><br></p> — textContent is the reliable empty check.
  const contentIsEmpty = !contentEl.textContent.trim();

  if (!title || !author_name || contentIsEmpty) {
    showArticleMessage('Title, author name, and content are required.', true);
    return;
  }

  const btn = document.getElementById('articleBtnSubmit');
  btn.disabled = true;
  btn.textContent = 'Saving...';
  const body = { title, author_name, slug, summary, content };
  const isLocalOnly = !!id && id.startsWith('local-article-');

  if (!OfflineSync.isOnline() || isLocalOnly) {
    try {
      if (id) await OfflineSync.queueUpdate('article', isLocalOnly ? id : Number(id), body, currentArticleLoadedUpdatedAt);
      else await OfflineSync.queueCreate('article', body);
      showArticleMessage(OfflineSync.isOnline() ? 'Saved — syncing…' : 'Saved offline — will sync when back online.');
      setTimeout(() => { closeArticleModal(); loadArticles(currentArticlePage); }, 900);
      if (OfflineSync.isOnline()) OfflineSync.processQueue();
    } catch (err) {
      showArticleMessage(err.message, true);
      if (err.staleLocalId) {
        setTimeout(() => { closeArticleModal(); loadArticles(currentArticlePage); }, 1200);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = id ? 'Update Article' : 'Create Article';
    }
    return;
  }

  try {
    if (id) {
      await apiPut(`${ADMIN_API}/articles/${id}`, { ...body, expected_updated_at: currentArticleLoadedUpdatedAt }, { success: 'Article updated.' });
      showArticleMessage('Article updated successfully!');
      OfflineSync.clearConflict('article', Number(id)).catch(() => {});
    } else {
      await apiPost(`${ADMIN_API}/articles`, body, { success: 'Article saved as a draft.' });
      showArticleMessage('Article created as a draft. Publish it from the table to make it public and notify visitors.');
    }

    setTimeout(() => {
      closeArticleModal();
      loadArticles(currentArticlePage);
    }, 900);
  } catch (err) {
    if (err.status === 409 && err.body && err.body.current) {
      await OfflineSync.recordDirectConflict('article', Number(id), body, currentArticleLoadedUpdatedAt, err.body.current);
      showArticleMessage('This article was changed by someone else since you loaded it.', true);
      closeArticleModal();
      loadArticles(currentArticlePage);
      OfflineSync.openConflictModal();
    } else if (OfflineSync.isNetworkError(err)) {
      try {
        if (id) await OfflineSync.queueUpdate('article', Number(id), body, currentArticleLoadedUpdatedAt);
        else await OfflineSync.queueCreate('article', body);
        showArticleMessage('Connection lost — saved offline, will sync when back online.');
        setTimeout(() => { closeArticleModal(); loadArticles(currentArticlePage); }, 900);
      } catch (queueErr) {
        showArticleMessage(queueErr.message, true);
      }
    } else {
      showArticleMessage(err.message, true);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = id ? 'Update Article' : 'Create Article';
  }
}

function autoArticleSlug() {
  const slugField = document.getElementById('articleFormSlug');
  const titleField = document.getElementById('articleFormTitle');
  if (!slugField.dataset.manual) {
    slugField.value = generateSlug(titleField.value);
  }
}

// ═══════════════════════════════════════════════════
// ═══ REPORTS ══════════════════════════════════════
// ═══════════════════════════════════════════════════

async function loadReports() {
  const tbody = document.getElementById('reportsTableBody');
  tbody.innerHTML = AdminUI.loadingRows(6);

  try {
    const data = await apiGet(`${ADMIN_API}/reports`);
    allReports = data.reports || [];
    renderReportsTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-table__empty" style="color:var(--danger);">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderReportsTable() {
  const tbody = document.getElementById('reportsTableBody');
  const filterEl = document.getElementById('reportFilterStatus');
  const statusFilter = filterEl ? filterEl.value : '';
  const query = document.getElementById('reportSearch')?.value || '';

  let filtered = allReports;
  if (statusFilter) {
    filtered = filtered.filter(r => r.status === statusFilter);
  }
  filtered = filterBySearch(filtered, query, ['song_title', 'song_slug', 'song_artist', 'reporter_name', 'reporter_email', 'body']);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-table__empty">${query.trim() ? 'No reports match your search.' : statusFilter ? 'No ' + statusFilter + ' reports.' : 'No reports yet.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const statusColor = REPORT_STATUS_COLORS[r.status] || '#6b7280';
    const bodyPreview = (r.body || '').length > 80 ? r.body.substring(0, 80) + '...' : (r.body || '');

    return `
      <tr data-id="${r.id}">
        <td>
          <div class="admin-table__title">${escapeHtml(r.song_title || r.song_slug || '—')}</div>
          <div class="admin-table__slug">${escapeHtml(r.song_artist || '')}</div>
        </td>
        <td>
          <div>${escapeHtml(r.reporter_name || '—')}</div>
          <div class="admin-table__slug">${escapeHtml(r.reporter_email || '')}</div>
        </td>
        <td><div class="admin-table__desc" title="${escapeHtml(r.body || '')}">${escapeHtml(bodyPreview)}</div></td>
        <td>
          <select class="report-status-select" onchange="updateReportStatus(${r.id}, this.value)" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;border-radius:var(--radius-md);padding:2px 8px;font-size:var(--text-xs);font-weight:600;cursor:pointer;">
            <option value="pending" ${r.status === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="reviewed" ${r.status === 'reviewed' ? 'selected' : ''}>Reviewed</option>
            <option value="resolved" ${r.status === 'resolved' ? 'selected' : ''}>Resolved</option>
            <option value="dismissed" ${r.status === 'dismissed' ? 'selected' : ''}>Dismissed</option>
          </select>
        </td>
        <td>${formatDate(r.created_at)}</td>
        <td>
          <div class="admin-table__actions">
            <button class="btn btn--sm btn--ghost" onclick="viewFeedback(${r.id})" title="View Detail">📝</button>
            ${r.song_slug ? `<a href="${SITE_ORIGIN}/song/${escapeHtml(r.song_slug)}" target="_blank" class="btn btn--sm btn--ghost" title="View Song">👁️</a>` : ''}
            <button class="btn btn--sm btn--ghost btn--danger-text" onclick="confirmDelete(${r.id}, 'report')" title="Delete">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function updateReportStatus(id, status) {
  try {
    await apiPut(`${ADMIN_API}/reports/${id}`, { status }, { success: `Report marked ${status}.` });
    // Update local state
    const report = allReports.find(r => r.id === id);
    if (report) report.status = status;
    renderReportsTable();
  } catch (err) {
    AdminUI.alertToast('Failed to update status: ' + err.message);
    loadReports();
  }
}

// ─── Feedback Detail Modal ─────────────────────────
function viewFeedback(id) {
  const r = allReports.find(rep => rep.id === id);
  if (!r) return;

  const statusLabels = { pending: 'Pending', reviewed: 'Reviewed', resolved: 'Resolved', dismissed: 'Dismissed' };
  const color = REPORT_STATUS_COLORS[r.status] || '#6b7280';

  document.getElementById('feedbackModalTitle').textContent = `Feedback #${r.id}`;
  document.getElementById('fdSong').textContent = r.song_title || r.song_slug || '—';
  document.getElementById('fdArtist').textContent = r.song_artist || '—';
  document.getElementById('fdReporter').textContent = r.reporter_name || '—';
  document.getElementById('fdEmail').innerHTML = r.reporter_email
    ? `<a href="mailto:${escapeHtml(r.reporter_email)}" style="color:var(--accent);">${escapeHtml(r.reporter_email)}</a>`
    : '—';
  document.getElementById('fdStatus').innerHTML = `<span style="color:${color};font-weight:600;">${statusLabels[r.status] || r.status}</span>`;
  document.getElementById('fdDate').textContent = formatDate(r.created_at);
  document.getElementById('fdBody').textContent = r.body || '—';

  const viewSongBtn = document.getElementById('feedbackBtnViewSong');
  if (r.song_slug) {
    viewSongBtn.href = SITE_ORIGIN + '/song/' + r.song_slug;
    viewSongBtn.style.display = 'inline-flex';
  } else {
    viewSongBtn.style.display = 'none';
  }

  document.getElementById('feedbackModal').style.display = 'flex';
}

function closeFeedbackModal() {
  document.getElementById('feedbackModal').style.display = 'none';
}

// ═══════════════════════════════════════════════════
// ═══ REVISIONS ════════════════════════════════════
// ═══════════════════════════════════════════════════

async function loadRevisions() {
  const tbody = document.getElementById('revisionsTableBody');
  tbody.innerHTML = AdminUI.loadingRows(5);
  try {
    const data = await apiGet(`${ADMIN_API}/revisions`);
    allRevisions = data.revisions || [];
    renderRevisionsTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-table__empty" style="color:var(--danger);">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderRevisionsTable() {
  const tbody = document.getElementById('revisionsTableBody');
  const filterEl = document.getElementById('revisionFilterStatus');
  const statusFilter = filterEl ? filterEl.value : '';
  const query = document.getElementById('revisionSearch')?.value || '';

  let filtered = allRevisions;
  if (statusFilter) filtered = filtered.filter(r => r.status === statusFilter);
  filtered = filterBySearch(filtered, query, ['song_title', 'song_slug', 'submitted_by_username']);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-table__empty">${query.trim() ? 'No revisions match your search.' : statusFilter ? 'No ' + statusFilter + ' revisions.' : 'No revisions yet.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((r) => {
    const color = REVISION_STATUS_COLORS[r.status] || '#6b7280';
    return `
      <tr data-id="${r.id}">
        <td>
          <div class="admin-table__title">${escapeHtml(r.song_title || '—')}</div>
          <div class="admin-table__slug">/song/${escapeHtml(r.song_slug || '')}</div>
        </td>
        <td>${escapeHtml(r.submitted_by_username || '—')}</td>
        <td>${formatDate(r.created_at)}</td>
        <td><span class="status-badge" style="background:${color}22;color:${color};border-color:${color}44;">${escapeHtml(r.status)}</span></td>
        <td>
          <div class="admin-table__actions">
            <button class="btn btn--sm btn--ghost" onclick="openRevisionModal(${r.id})" title="Review">👁️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Plain-text before/after summary of a song's editable fields — used for both the "Current"
// and "Proposed" sides of the revision diff modal.
function describeSongFields(song) {
  if (!song) return '—';
  const artists = (song.artists || []).map(a => a.name).join(', ') || '—';
  const composers = (song.composers || []).map(c => c.name).join(', ') || '—';
  const co = song.copyright_owner_id
    ? (allCopyrightOwners.find(c => c.id === song.copyright_owner_id)?.name || `#${song.copyright_owner_id}`)
    : '—';
  return `Title: ${song.title || '—'}\nSlug: ${song.slug || '—'}\nCategory: ${song.category || '—'}\nCopyright Owner: ${co}\nArtists: ${artists}\nComposers: ${composers}\n\nLyrics:\n${song.lyrics || '—'}`;
}

async function openRevisionModal(id) {
  return AdminUI.withLoading('Loading revision…', () => _openRevisionModal(id));
}
async function _openRevisionModal(id) {
  currentRevisionId = id;
  document.getElementById('revisionModal').style.display = 'flex';
  document.getElementById('rdSong').textContent = 'Loading...';
  document.getElementById('rdCurrent').textContent = '';
  document.getElementById('rdProposed').textContent = '';
  document.getElementById('rdNoteInput').value = '';

  try {
    const { revision, current } = await apiGet(`${ADMIN_API}/revisions/${id}`);
    document.getElementById('revisionModalTitle').textContent = `Revision #${revision.id}`;
    document.getElementById('rdSong').textContent = current ? current.title : `Song #${revision.song_id}`;
    document.getElementById('rdSubmittedBy').textContent = revision.submitted_by_username || '—';
    document.getElementById('rdSubmittedAt').textContent = formatDate(revision.created_at);
    document.getElementById('rdStatus').textContent = revision.status.charAt(0).toUpperCase() + revision.status.slice(1);

    document.getElementById('rdCurrent').textContent = describeSongFields(current);
    const proposedArtistIds = JSON.parse(revision.artist_ids || '[]');
    const proposedComposerIds = JSON.parse(revision.composer_ids || '[]');
    document.getElementById('rdProposed').textContent = describeSongFields({
      title: revision.title,
      slug: revision.slug,
      category: revision.category,
      lyrics: revision.lyrics,
      copyright_owner_id: revision.copyright_owner_id,
      artists: proposedArtistIds.map(aid => ({ name: allArtists.find(a => a.id === aid)?.name || `#${aid}` })),
      composers: proposedComposerIds.map(cid => ({ name: allComposers.find(c => c.id === cid)?.name || `#${cid}` })),
    });

    const isPending = revision.status === 'pending';
    document.getElementById('rdNoteInputRow').style.display = isPending ? 'block' : 'none';
    document.getElementById('rdNoteRow').style.display = isPending ? 'none' : 'block';
    if (!isPending) document.getElementById('rdReviewerNote').textContent = revision.reviewer_note || '—';
    document.getElementById('revisionBtnApprove').style.display = isPending ? '' : 'none';
    document.getElementById('revisionBtnReject').style.display = isPending ? '' : 'none';
  } catch (err) {
    document.getElementById('rdSong').textContent = 'Failed to load: ' + err.message;
  }
}

function closeRevisionModal() {
  document.getElementById('revisionModal').style.display = 'none';
  currentRevisionId = null;
}

async function approveRevision() {
  if (!currentRevisionId) return;
  const reviewer_note = document.getElementById('rdNoteInput').value.trim();
  try {
    await apiPut(`${ADMIN_API}/revisions/${currentRevisionId}/approve`, reviewer_note ? { reviewer_note } : {});
    if (typeof Toast !== 'undefined') Toast.show('Revision approved.', { type: 'success' });
    closeRevisionModal();
    loadRevisions();
    loadSongs(currentPage);
  } catch (err) {
    AdminUI.alertToast('Failed to approve: ' + err.message);
  }
}

async function rejectRevision() {
  if (!currentRevisionId) return;
  const reviewer_note = document.getElementById('rdNoteInput').value.trim();
  if (!reviewer_note) { AdminUI.alertToast('A reviewer note is required to reject a revision.'); return; }
  try {
    await apiPut(`${ADMIN_API}/revisions/${currentRevisionId}/reject`, { reviewer_note });
    if (typeof Toast !== 'undefined') Toast.show('Revision rejected.', { type: 'success' });
    closeRevisionModal();
    loadRevisions();
  } catch (err) {
    AdminUI.alertToast('Failed to reject: ' + err.message);
  }
}

// ═══════════════════════════════════════════════════
// ═══ AUDIT LOG ════════════════════════════════════
// ═══════════════════════════════════════════════════

async function loadAuditLog() {
  const tbody = document.getElementById('auditLogTableBody');
  tbody.innerHTML = AdminUI.loadingRows(5);
  try {
    const targetType = document.getElementById('auditFilterTarget')?.value || '';
    const params = new URLSearchParams({ limit: '100' });
    if (targetType) params.set('target_type', targetType);
    const data = await apiGet(`${ADMIN_API}/audit-log?${params.toString()}`);
    allAuditLog = data.audit_log || [];
    renderAuditLogTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-table__empty" style="color:var(--danger);">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderAuditLogTable() {
  const tbody = document.getElementById('auditLogTableBody');
  const query = document.getElementById('auditSearch')?.value || '';
  const filtered = filterBySearch(allAuditLog, query, ['admin_username', 'action', 'target_type', 'detail']);
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="admin-table__empty">${query.trim() ? 'No audit entries match your search.' : 'No audit entries yet.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map((entry) => `
    <tr>
      <td>${formatDate(entry.created_at)}</td>
      <td>${escapeHtml(entry.admin_username || '—')}</td>
      <td>${escapeHtml(entry.action)}</td>
      <td>${escapeHtml(entry.target_type)}${entry.target_id ? ' #' + entry.target_id : ''}</td>
      <td>${escapeHtml(entry.detail || '—')}</td>
    </tr>
  `).join('');
}

// ═══════════════════════════════════════════════════
// ═══ FEEDBACK INBOX (contacts — Admin only) ═══════
// ═══════════════════════════════════════════════════

async function loadContacts() {
  const tbody = document.getElementById('contactsTableBody');
  tbody.innerHTML = AdminUI.loadingRows(6);
  try {
    const data = await apiGet(`${ADMIN_API}/contacts`);
    allContacts = data.contacts || [];
    renderContactsTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-table__empty" style="color:var(--danger);">Failed to load: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderContactsTable() {
  const tbody = document.getElementById('contactsTableBody');
  const filterEl = document.getElementById('contactFilterStatus');
  const statusFilter = filterEl ? filterEl.value : '';
  const query = document.getElementById('contactSearch')?.value || '';

  let filtered = allContacts;
  if (statusFilter) filtered = filtered.filter(c => c.status === statusFilter);
  filtered = filterBySearch(filtered, query, ['name', 'email', 'subject', 'message']);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="admin-table__empty">${query.trim() ? 'No messages match your search.' : statusFilter ? 'No ' + statusFilter + ' messages.' : 'No messages yet.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((c) => {
    const color = CONTACT_STATUS_COLORS[c.status] || '#6b7280';
    const preview = (c.message || '').length > 80 ? c.message.substring(0, 80) + '...' : (c.message || '');
    return `
      <tr data-id="${c.id}">
        <td>
          <div class="admin-table__title">${escapeHtml(c.name || '—')}</div>
          <div class="admin-table__slug">${escapeHtml(c.email || '')}</div>
        </td>
        <td>${escapeHtml(c.subject || 'General')}</td>
        <td><div class="admin-table__desc" title="${escapeHtml(c.message || '')}">${escapeHtml(preview)}</div></td>
        <td>
          <select class="report-status-select" onchange="updateContactStatus(${c.id}, this.value)" style="background:${color}22;color:${color};border:1px solid ${color}44;border-radius:var(--radius-md);padding:2px 8px;font-size:var(--text-xs);font-weight:600;cursor:pointer;">
            <option value="unread" ${c.status === 'unread' ? 'selected' : ''}>Unread</option>
            <option value="read" ${c.status === 'read' ? 'selected' : ''}>Read</option>
            <option value="archived" ${c.status === 'archived' ? 'selected' : ''}>Archived</option>
          </select>
        </td>
        <td>${formatDate(c.created_at)}</td>
        <td>
          <div class="admin-table__actions">
            <button class="btn btn--sm btn--ghost" onclick="viewContact(${c.id})" title="View Detail">📝</button>
            <button class="btn btn--sm btn--ghost btn--danger-text" onclick="confirmDelete(${c.id}, 'contact')" title="Delete">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function updateContactStatus(id, status) {
  try {
    await apiPut(`${ADMIN_API}/contacts/${id}`, { status }, { success: `Message marked ${status}.` });
    const contact = allContacts.find(c => c.id === id);
    if (contact) contact.status = status;
    renderContactsTable();
  } catch (err) {
    AdminUI.alertToast('Failed to update status: ' + err.message);
    loadContacts();
  }
}

function viewContact(id) {
  const c = allContacts.find(x => x.id === id);
  if (!c) return;

  const statusLabels = { unread: 'Unread', read: 'Read', archived: 'Archived' };
  const color = CONTACT_STATUS_COLORS[c.status] || '#6b7280';

  document.getElementById('contactModalTitle').textContent = `Message #${c.id}`;
  document.getElementById('cdName').textContent = c.name || '—';
  document.getElementById('cdEmail').innerHTML = c.email
    ? `<a href="mailto:${escapeHtml(c.email)}" style="color:var(--accent);">${escapeHtml(c.email)}</a>`
    : '—';
  document.getElementById('cdSubject').textContent = c.subject || 'General';
  document.getElementById('cdStatus').innerHTML = `<span style="color:${color};font-weight:600;">${statusLabels[c.status] || c.status}</span>`;
  document.getElementById('cdDate').textContent = formatDate(c.created_at);
  document.getElementById('cdMessage').textContent = c.message || '—';

  document.getElementById('contactModal').style.display = 'flex';
}

function closeContactModal() {
  document.getElementById('contactModal').style.display = 'none';
}

// ═══════════════════════════════════════════════════
// ═══ PROFILES (any admin can view/follow any profile;
// ═══ the owner manages avatar/username/password/deletion) ═══
// ═══════════════════════════════════════════════════

async function openProfileModal(id) {
  return AdminUI.withLoading('Loading profile…', () => _openProfileModal(id));
}
async function _openProfileModal(id) {
  currentProfileId = id;
  document.getElementById('profileModal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  document.getElementById('profileUsername').textContent = 'Loading...';
  document.getElementById('profileFormMessage').style.display = 'none';
  cancelDeleteAccountConfirm();

  try {
    const profile = await apiGet(`${ADMIN_API}/admin-users/${id}/profile`);
    document.getElementById('profileAvatar').innerHTML = avatarMarkupFor(profile, 'lg');
    document.getElementById('profileUsername').textContent = profile.username;
    document.getElementById('profileJoined').textContent = 'Joined ' + formatDate(profile.created_at);
    document.getElementById('profileFollowers').textContent = profile.follower_count;
    document.getElementById('profileFollowing').textContent = profile.following_count;

    currentProfileIsFollowing = !!profile.is_following;
    const followBtn = document.getElementById('profileBtnFollow');
    if (profile.is_self) {
      followBtn.style.display = 'none';
    } else {
      followBtn.style.display = '';
      followBtn.textContent = currentProfileIsFollowing ? 'Unfollow' : 'Follow';
      followBtn.className = 'btn ' + (currentProfileIsFollowing ? 'btn--ghost' : 'btn--primary');
      followBtn.style.width = '100%';
    }

    const selfSection = document.getElementById('profileSelfSection');
    selfSection.style.display = profile.is_self ? 'block' : 'none';
    if (profile.is_self) {
      document.getElementById('profileFormUsername').value = profile.username;
      selectedAvatar = profile.avatar || null;
      renderAvatarPicker();
    }
  } catch (err) {
    document.getElementById('profileUsername').textContent = 'Failed to load: ' + err.message;
  }

  loadProfileDirectory();
}

function closeProfileModal() {
  document.getElementById('profileModal').style.display = 'none';
  document.body.style.overflow = '';
  currentProfileId = null;
}

function renderAvatarPicker() {
  const picker = document.getElementById('avatarPicker');
  picker.innerHTML = AVATARS.map(a => `
    <button type="button" class="avatar-picker__option${a === selectedAvatar ? ' avatar-picker__option--selected' : ''}" onclick="selectAvatar('${a}')">${a}</button>
  `).join('');
}

function selectAvatar(avatar) {
  selectedAvatar = avatar;
  renderAvatarPicker();
}

// Every role can browse this list, even roles without access to the Admins management tab —
// it's how a Viewer/Translator/Reviewer/Editor discovers other admins to view/follow at all.
async function loadProfileDirectory() {
  const listEl = document.getElementById('profileDirectoryList');
  listEl.innerHTML = '<div class="admin-table__empty"><span class="inline-spinner" aria-hidden="true"></span> Loading…</div>';
  try {
    const data = await apiGet(`${ADMIN_API}/admin-users/directory`);
    allAdminDirectory = data.admin_users || [];
    renderProfileDirectory();
  } catch (err) {
    listEl.innerHTML = `<div class="admin-table__empty" style="color:var(--danger);">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderProfileDirectory() {
  const listEl = document.getElementById('profileDirectoryList');
  if (!allAdminDirectory.length) {
    listEl.innerHTML = '<div class="admin-table__empty">No admins found.</div>';
    return;
  }
  listEl.innerHTML = allAdminDirectory.map(u => `
    <button type="button" class="profile-directory__item${u.id === currentProfileId ? ' profile-directory__item--active' : ''}" onclick="openProfileModal(${u.id})">
      ${avatarMarkupFor(u)}
      <span class="profile-directory__name">${escapeHtml(u.username)}</span>
    </button>
  `).join('');
}

// ─── Profile photo upload + square crop ─────────
// Drag to position, slider/wheel to zoom; the visible 300px square is exported as a 256px JPEG
// (small enough to store in the row) and saved straight away via PUT /profile.
// `size` is the canvas width and `h` its height (equal for circle/square crops; 'wide' is a 2:1 banner, 'video' a 16:9 thumbnail).
const CROP_CANVAS = { wide: [360, 180], video: [384, 216] };
const photoCrop = { img: null, minScale: 1, zoom: 1, x: 0, y: 0, size: 300, h: 300, dragging: null, outSize: 256, onSave: null, onError: null, shape: 'circle' };
const MAX_PHOTO_FILE_BYTES = 15 * 1024 * 1024;

function photoCropClamp() {
  const s = photoCrop.minScale * photoCrop.zoom;
  const w = photoCrop.img.width * s, h = photoCrop.img.height * s;
  photoCrop.x = Math.min(0, Math.max(photoCrop.size - w, photoCrop.x));
  photoCrop.y = Math.min(0, Math.max(photoCrop.h - h, photoCrop.y));
}

function photoCropDraw() {
  if (!photoCrop.img) return;
  const canvas = document.getElementById('photoCropCanvas');
  const ctx = canvas.getContext('2d');
  const size = photoCrop.size, height = photoCrop.h;
  const s = photoCrop.minScale * photoCrop.zoom;
  ctx.clearRect(0, 0, size, height);
  ctx.drawImage(photoCrop.img, photoCrop.x, photoCrop.y, photoCrop.img.width * s, photoCrop.img.height * s);
  // Dim everything outside the shape the result will actually be shown in.
  const square = photoCrop.shape !== 'circle';
  const inset = 2, r = size / 2 - inset, rad = Math.min(size, height) * 0.12;
  const guide = () => {
    ctx.beginPath();
    if (square) ctx.roundRect(inset, inset, size - inset * 2, height - inset * 2, rad);
    else ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
  };
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.rect(0, 0, size, height);
  if (square) ctx.roundRect(inset, inset, size - inset * 2, height - inset * 2, rad);
  else ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2, true);
  ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 2;
  guide();
  ctx.stroke();
  ctx.restore();
}

function photoCropSetZoom(zoom) {
  const halfX = photoCrop.size / 2, halfY = photoCrop.h / 2;
  const oldS = photoCrop.minScale * photoCrop.zoom;
  const cx = (halfX - photoCrop.x) / oldS, cy = (halfY - photoCrop.y) / oldS;
  photoCrop.zoom = Math.min(4, Math.max(1, zoom));
  const newS = photoCrop.minScale * photoCrop.zoom;
  photoCrop.x = halfX - cx * newS;
  photoCrop.y = halfY - cy * newS;
  photoCropClamp();
  document.getElementById('photoCropZoom').value = photoCrop.zoom;
  photoCropDraw();
}

function showPhotoCropMessage(text) {
  const el = document.getElementById('photoCropMessage');
  el.textContent = text;
  el.className = 'form-message form-message--error';
  el.style.display = text ? 'block' : 'none';
}

// Shared by the admin profile photo and the Artist / Composer / Copyright Owner photos.
// opts: { size (output px), title, onSave(dataUrl) (may throw/reject to show an error), onError(msg) }
function openPhotoCrop(file, opts = {}) {
  if (!file) return;
  const fail = (msg) => (opts.onError || ((m) => showProfileMessage(m, true)))(msg);
  if (!/^image\//.test(file.type)) { fail('Please choose an image file.'); return; }
  if (file.size > MAX_PHOTO_FILE_BYTES) { fail('That image is too large (max 15 MB).'); return; }
  photoCrop.outSize = opts.size || 256;
  photoCrop.shape = opts.shape || 'circle';
  [photoCrop.size, photoCrop.h] = CROP_CANVAS[photoCrop.shape] || [300, 300];
  const canvas = document.getElementById('photoCropCanvas');
  canvas.width = photoCrop.size;
  canvas.height = photoCrop.h;
  canvas.style.width = `${photoCrop.size}px`;
  canvas.style.aspectRatio = `${photoCrop.size} / ${photoCrop.h}`;
  photoCrop.onSave = opts.onSave;
  document.getElementById('photoCropTitle').textContent = opts.title || 'Crop Profile Photo';
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    photoCrop.img = img;
    photoCrop.minScale = Math.max(photoCrop.size / img.width, photoCrop.h / img.height);
    photoCrop.zoom = 1;
    photoCrop.x = (photoCrop.size - img.width * photoCrop.minScale) / 2;
    photoCrop.y = (photoCrop.h - img.height * photoCrop.minScale) / 2;
    document.getElementById('photoCropZoom').value = 1;
    showPhotoCropMessage('');
    document.getElementById('photoCropModal').style.display = 'flex';
    photoCropDraw();
  };
  img.onerror = () => { URL.revokeObjectURL(url); fail('Could not read that image.'); };
  img.src = url;
}

function closePhotoCrop() {
  document.getElementById('photoCropModal').style.display = 'none';
  photoCrop.img = null;
}

async function savePhoto(photo) {
  const updated = await apiPut(`${ADMIN_API}/profile`, { photo }, { success: 'Profile photo updated.' });
  const info = getAdminInfo();
  if (info) setAdminInfo({ ...info, photo: updated.photo });
  applyRoleVisibility();
  document.getElementById('profileAvatar').innerHTML = avatarMarkupFor(updated, 'lg');
  loadProfileDirectory();
}

async function applyPhotoCrop() {
  if (!photoCrop.img) return;
  const outSize = photoCrop.outSize;
  const out = document.createElement('canvas');
  const ratio = outSize / photoCrop.size;
  out.width = outSize;
  out.height = Math.round(photoCrop.h * ratio);
  const s = photoCrop.minScale * photoCrop.zoom * ratio;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no alpha — transparent PNGs would turn black otherwise
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(photoCrop.img, photoCrop.x * ratio, photoCrop.y * ratio, photoCrop.img.width * s, photoCrop.img.height * s);
  const btn = document.getElementById('photoCropSave');
  btn.disabled = true;
  try {
    await photoCrop.onSave(out.toDataURL('image/jpeg', 0.88));
    closePhotoCrop();
  } catch (err) {
    showPhotoCropMessage(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function removePhoto() {
  try {
    await savePhoto(null);
    showProfileMessage('Photo removed.');
  } catch (err) {
    showProfileMessage(err.message, true);
  }
}

function wirePhotoCrop() {
  const canvas = document.getElementById('photoCropCanvas');
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    photoCrop.dragging = { px: e.clientX, py: e.clientY, x: photoCrop.x, y: photoCrop.y };
  });
  canvas.addEventListener('pointermove', (e) => {
    const d = photoCrop.dragging;
    if (!d || !photoCrop.img) return;
    const k = photoCrop.size / canvas.getBoundingClientRect().width; // canvas may be CSS-scaled down (same factor on both axes)
    photoCrop.x = d.x + (e.clientX - d.px) * k;
    photoCrop.y = d.y + (e.clientY - d.py) * k;
    photoCropClamp();
    photoCropDraw();
  });
  ['pointerup', 'pointercancel'].forEach(t => canvas.addEventListener(t, () => { photoCrop.dragging = null; }));
  canvas.addEventListener('wheel', (e) => {
    if (!photoCrop.img) return;
    e.preventDefault();
    photoCropSetZoom(photoCrop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  }, { passive: false });
  document.getElementById('photoCropZoom').addEventListener('input', (e) => photoCropSetZoom(Number(e.target.value)));
  document.getElementById('photoCropSave').addEventListener('click', applyPhotoCrop);
  ['photoCropCancel', 'photoCropClose', 'photoCropBackdrop'].forEach(id => document.getElementById(id).addEventListener('click', closePhotoCrop));
  const fileInput = document.getElementById('profilePhotoFile');
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    openPhotoCrop(file, { size: 256, title: 'Crop Profile Photo', onSave: async (dataUrl) => { await savePhoto(dataUrl); showProfileMessage('Photo updated!'); } });
  });
  document.getElementById('profileBtnRemovePhoto').addEventListener('click', removePhoto);
}

async function toggleProfileFollow() {
  if (!currentProfileId) return;
  const btn = document.getElementById('profileBtnFollow');
  btn.disabled = true;
  try {
    if (currentProfileIsFollowing) {
      await apiDelete(`${ADMIN_API}/admin-users/${currentProfileId}/follow`, { success: 'Unfollowed.' });
    } else {
      await apiPost(`${ADMIN_API}/admin-users/${currentProfileId}/follow`, {}, { success: 'Following.' });
    }
    await openProfileModal(currentProfileId);
  } catch (err) {
    if (typeof Toast !== 'undefined') Toast.show('Failed: ' + err.message, { type: 'error' });
    else AdminUI.alertToast('Failed: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

function showProfileMessage(text, isError = false) {
  const el = document.getElementById('profileFormMessage');
  el.textContent = text;
  el.className = 'form-message ' + (isError ? 'form-message--error' : 'form-message--success');
  el.style.display = 'block';
}

async function saveProfileChanges() {
  const username = document.getElementById('profileFormUsername').value.trim();
  if (!username) { showProfileMessage('Username is required.', true); return; }

  const btn = document.getElementById('profileBtnSaveChanges');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const updated = await apiPut(`${ADMIN_API}/profile`, { username, avatar: selectedAvatar }, { success: 'Profile updated.' });
    showProfileMessage('Profile updated successfully!');
    // Keep the cached session info (header chip, role checks) in sync with the new username/avatar.
    const info = getAdminInfo();
    if (info) setAdminInfo({ ...info, username: updated.username, avatar: updated.avatar, photo: updated.photo });
    applyRoleVisibility();
    document.getElementById('profileUsername').textContent = updated.username;
    document.getElementById('profileAvatar').innerHTML = avatarMarkupFor(updated, 'lg');
    loadProfileDirectory();
  } catch (err) {
    showProfileMessage(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  }
}

function showDeleteAccountConfirm() {
  document.getElementById('profileBtnDeleteAccount').style.display = 'none';
  document.getElementById('profileDeleteConfirm').style.display = 'block';
  document.getElementById('profileDeletePassword').focus();
}

function cancelDeleteAccountConfirm() {
  document.getElementById('profileBtnDeleteAccount').style.display = '';
  document.getElementById('profileDeleteConfirm').style.display = 'none';
  document.getElementById('profileDeletePassword').value = '';
}

async function confirmDeleteAccount() {
  const password = document.getElementById('profileDeletePassword').value;
  if (!password) { AdminUI.alertToast('Enter your password to confirm.'); return; }

  const btn = document.getElementById('profileBtnConfirmDelete');
  btn.disabled = true;
  btn.textContent = 'Deleting...';

  try {
    await apiPost(`${ADMIN_API}/profile/delete`, { password });
    clearAdminSession();
    alert('Your account has been deleted.');
    location.reload();
  } catch (err) {
    AdminUI.alertToast('Failed to delete account: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Permanently Delete My Account';
  }
}
