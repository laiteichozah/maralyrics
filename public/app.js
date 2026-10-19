// ╔══════════════════════════════════════════════════════════════╗
// ║        MaraLyrics — Client-Side Application                 ║
// ║        Vanilla JS · Modular · Offline-Ready                 ║
// ╚══════════════════════════════════════════════════════════════╝

'use strict';

// ─── Configuration ─────────────────────────────────────────────
const WORKER_ORIGIN = 'https://api.maralyrics.com';
const CONFIG = {
  API_BASE: `${WORKER_ORIGIN}/api/v1`,
  CACHE_PREFIX: 'ml_',
  CACHE_TTL: 24 * 60 * 60 * 1000, // 24 hours
  SEARCH_DEBOUNCE: 300,
  ITEMS_PER_PAGE: 20,
  POPULAR_LIMIT: 6,
  VIEW_COOLDOWN: 60 * 60 * 1000, // 1 hour
};

// ─── Utility Module ────────────────────────────────────────────
const Utils = {
  /** Escape all 5 HTML-significant characters — safe in both text content and quoted
   *  attributes (href=, data-*=). A DOM textContent round-trip only escapes &/</>, which
   *  leaves a double quote free to break out of an attribute value. */
  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  /** Strip HTML tags for contexts that need plain text — meta descriptions,
   *  JSON-LD, share text — from a field that may contain the article editor's
   *  sanitized rich-text HTML. Collapses whitespace left behind by removed
   *  block tags so paragraphs don't run together without a space. */
  stripHtml(html) {
    if (!html) return '';
    return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  },

  /** Debounce function calls. */
  debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  },

  /** Format view count (e.g., 1234 → "1.2K"). */
  formatViews(n) {
    if (!n || n < 1000) return String(n || 0);
    if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  },

  /** BCP 47 tag for Intl/toLocale* formatting, following the site language rather than the
   *  browser's. Mara (mrh) has no Intl locale data, so it formats dates like English. */
  locale() {
    const lang = typeof I18n !== 'undefined' && I18n.getLang ? I18n.getLang() : 'en';
    return lang === 'my' ? 'my' : 'en';
  },

  /** Format a date string as e.g. "Sep 17, 2026" for article cards/pages. D1's
   *  DATETIME columns come back as 'YYYY-MM-DD HH:MM:SS' (UTC, no timezone marker). */
  formatDateShort(dateStr) {
    if (!dateStr) return '';
    let iso = dateStr;
    if (iso.includes(' ') && !iso.includes('T')) iso = iso.replace(' ', 'T');
    if (!/[Zz]|[+-]\d{2}:\d{2}$/.test(iso)) iso += 'Z';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(Utils.locale(), { month: 'short', day: 'numeric', year: 'numeric' });
  },

  /** Check if device is online. */
  isOnline() {
    return navigator.onLine;
  },

  /** Today's date as YYYY-MM-DD in the visitor's local timezone (not UTC —
   *  matters for matching all-day calendar events to "today"). */
  todayLocalISODate() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  },

  /** Get slug from current URL path. */
  getSlugFromUrl() {
    const path = window.location.pathname;
    const match = path.match(/\/(song|artist|composer|copyright-owner|article)\/([^/]+)/);
    return match ? match[2] : null;
  },

  /** Get page type from current URL path. */
  getPageType() {
    const path = window.location.pathname;
    if (path.startsWith('/song/')) return 'song';
    if (path.startsWith('/artist/')) return 'artist';
    if (path.startsWith('/composer/')) return 'composer';
    if (path.startsWith('/copyright-owner/')) return 'copyright-owner';
    if (path.startsWith('/article/')) return 'article';
    if (path === '/mara-idol' || path === '/mara-idol.html') return 'idol-index';
    if (path.startsWith('/mara-idol/')) {
      const depth = path.split('/').filter(Boolean).length; // mara-idol / season [/ idol]
      return depth >= 3 ? 'idol' : 'idol-season';
    }
    if (path === '/articles' || path === '/articles.html') return 'articles';
    if (path === '/artists-composers' || path === '/artists-composers.html') return 'people';
    if (path === '/downloads' || path === '/downloads.html') return 'downloads';
    return 'home';
  },

  /** Create a clickable name link or a disabled span for unknown. */
  renderNameLink(name, slug, type) {
    if (name && slug) {
      const href = `/${type}/${this.escapeHtml(slug)}`;
      return `<a href="${href}" class="meta-link">${this.escapeHtml(name)}</a>`;
    }
    return `<span class="meta-link meta-link--disabled">${this.escapeHtml(name || I18n.t('common.unknown'))}</span>`;
  },

  /**
   * Render credited people (artists/composers). A single person renders as a plain link;
   * two or more collapse into a "Various Artists/Composers" trigger that opens a small
   * popover listing each person as its own link (see the delegated click handler below).
   */
  renderCreditedPeople(list, type, variousLabel) {
    if (!list || !list.length) {
      return `<span class="meta-link meta-link--disabled">${this.escapeHtml(I18n.t('common.unknown'))}</span>`;
    }
    if (list.length === 1) {
      return this.renderNameLink(list[0].name, list[0].slug, type);
    }
    const links = list
      .map((item) => `<a href="/${type}/${this.escapeHtml(item.slug)}" class="credits-popover__link">${this.escapeHtml(item.name)}</a>`)
      .join('');
    return `
      <span class="credits-wrap">
        <button type="button" class="meta-link credits-trigger" aria-haspopup="true" aria-expanded="false">${this.escapeHtml(variousLabel)}</button>
        <span class="credits-popover" role="menu">${links}</span>
      </span>
    `;
  },

  /** Plain-text comma-separated names, for titles/meta/search (no markup). */
  joinNames(list, fallback) {
    if (list && list.length) return list.map((item) => item.name).join(', ');
    return fallback || I18n.t('common.unknown');
  },

  /** Prefix a bare domain (e.g. "example.com") with https:// so it resolves as an absolute URL. */
  normalizeUrl(url) {
    if (!url) return url;
    return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  },

  /** Only http(s)/mailto is safe to put in an href — anything else (javascript:, data:,
   *  vbscript:, ...) executes on click instead of navigating. Mirrors the server-side
   *  SAFE_HREF allowlist (worker/lib/sanitizeHtml.js) that already gates article links;
   *  applied here too as defense in depth for admin-supplied social/website links, which
   *  should already be rejected at write time but shouldn't be trusted blindly at render time. */
  isSafeUrl(url) {
    return /^(https?:|mailto:)/i.test(String(url || '').trim());
  },

  /** Client-side sort matching the /songs API's `sort` values — used for lists (like
   *  favorites) that aren't fetched through that paginated endpoint. */
  sortSongs(songs, sortKey) {
    const comparators = {
      name_asc: (a, b) => (a.title || '').localeCompare(b.title || ''),
      name_desc: (a, b) => (b.title || '').localeCompare(a.title || ''),
      views_asc: (a, b) => (a.views || 0) - (b.views || 0),
      views_desc: (a, b) => (b.views || 0) - (a.views || 0),
      created_asc: (a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0),
      created_desc: (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
    };
    return [...songs].sort(comparators[sortKey] || comparators.name_asc);
  },

  /** Detect social platform from URL and return name + SVG icon (see social-icons.js). */
  detectSocialPlatform(url) {
    return SocialIcons.detect(url, { size: 20, websiteLabel: I18n.t('common.website') });
  },
};

// ─── Cache Module (localStorage + cookies) ─────────────────────
const Cache = {
  /** Save data to localStorage with timestamp. */
  set(key, data) {
    try {
      const entry = {
        data,
        timestamp: Date.now(),
      };
      localStorage.setItem(CONFIG.CACHE_PREFIX + key, JSON.stringify(entry));
    } catch (e) {
      // Storage full — clear oldest entries
      this._cleanup();
    }
  },

  /** Retrieve from localStorage if not expired. */
  get(key) {
    try {
      const raw = localStorage.getItem(CONFIG.CACHE_PREFIX + key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (Date.now() - entry.timestamp > CONFIG.CACHE_TTL) {
        localStorage.removeItem(CONFIG.CACHE_PREFIX + key);
        return null;
      }
      return entry.data;
    } catch {
      return null;
    }
  },

  /** Save minimal metadata to cookies (for quick offline detection). */
  setCookie(name, value, hours = 24) {
    const expires = new Date(Date.now() + hours * 60 * 60 * 1000).toUTCString();
    document.cookie = `${CONFIG.CACHE_PREFIX}${name}=${encodeURIComponent(value)};expires=${expires};path=/;SameSite=Lax`;
  },

  /** Read a cookie value. */
  getCookie(name) {
    const match = document.cookie.match(
      new RegExp('(?:^|; )' + CONFIG.CACHE_PREFIX + name + '=([^;]*)')
    );
    return match ? decodeURIComponent(match[1]) : null;
  },

  /** Cache song list. */
  cacheSongList(page, category, sort, data) {
    const key = `list_${page}_${category || 'all'}_${sort || 'default'}`;
    this.set(key, data);
  },

  /** Get cached song list. */
  getCachedSongList(page, category, sort) {
    const key = `list_${page}_${category || 'all'}_${sort || 'default'}`;
    return this.get(key);
  },

  /** Check view cooldown. */
  canCountView(slug) {
    const lastView = this.getCookie('view_' + slug);
    if (lastView && Date.now() - parseInt(lastView, 10) < CONFIG.VIEW_COOLDOWN) {
      return false;
    }
    return true;
  },

  /** Mark view as counted. */
  markViewCounted(slug) {
    this.setCookie('view_' + slug, String(Date.now()), 1);
  },

  /** Remove old entries when storage is full. */
  _cleanup() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(CONFIG.CACHE_PREFIX)) {
        try {
          const entry = JSON.parse(localStorage.getItem(k));
          keys.push({ key: k, ts: entry.timestamp || 0 });
        } catch {
          localStorage.removeItem(k);
        }
      }
    }
    // Remove oldest half
    keys.sort((a, b) => a.ts - b.ts);
    const toRemove = keys.slice(0, Math.ceil(keys.length / 2));
    toRemove.forEach((k) => localStorage.removeItem(k.key));
  },
};

// ─── Downloads Module (songs the visitor chose to keep offline) ──
// "Downloading" a song stores a full copy of it in the browser's IndexedDB — nothing is
// saved to the computer as a file. Songs are only ever stored when the visitor asks (there is
// no automatic caching of songs they merely opened), they never expire, and the browser is
// asked to treat this storage as persistent so it isn't cleared under storage pressure.
const Downloads = {
  DB_NAME: 'maralyrics-downloads',
  STORE: 'songs',
  // A small mirror of the downloaded slugs so cards can render their state synchronously.
  // (Deliberately not prefixed `ml_` — Cache._cleanup() prunes those when storage is full.)
  MIRROR_KEY: 'maralyrics.downloads',
  slugs: new Set(),
  supported: typeof indexedDB !== 'undefined',
  _db: null,
  _ready: null,

  _loadMirror() {
    try {
      const list = JSON.parse(localStorage.getItem(this.MIRROR_KEY) || '[]');
      if (Array.isArray(list)) list.forEach((slug) => this.slugs.add(slug));
    } catch { /* ignore */ }
  },

  _saveMirror() {
    try { localStorage.setItem(this.MIRROR_KEY, JSON.stringify([...this.slugs])); } catch { /* ignore */ }
  },

  _open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.STORE, { keyPath: 'slug' });
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },

  async _tx(mode, fn) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, mode);
      const result = fn(tx.objectStore(this.STORE));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  /** Idempotent. Loads the stored list (the source of truth) and tidies up the old auto-cache. */
  init() {
    if (this._ready) return this._ready;
    this._loadMirror();
    // One-time cleanup of songs the site used to cache automatically as they were opened.
    try {
      if (!localStorage.getItem('maralyrics.autocache_purged')) {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && key.startsWith(CONFIG.CACHE_PREFIX + 'song_')) localStorage.removeItem(key);
        }
        localStorage.setItem('maralyrics.autocache_purged', '1');
      }
    } catch { /* ignore */ }
    this._ready = (async () => {
      if (!this.supported) return;
      try {
        const all = await this.getAll();
        this.slugs = new Set(all.map((entry) => entry.slug));
        this._saveMirror();
        document.dispatchEvent(new CustomEvent('downloads-changed'));
      } catch (err) {
        console.warn('[downloads] storage unavailable:', err);
        this.supported = false;
      }
    })();
    return this._ready;
  },

  has(slug) { return this.slugs.has(slug); },
  get count() { return this.slugs.size; },

  /** Every downloaded song (the song object plus `savedAt`), newest download first. */
  async getAll() {
    if (!this.supported) return [];
    const rows = await this._tx('readonly', (store) => store.getAll());
    return (rows || []).map((row) => ({ ...row.song, slug: row.slug, savedAt: row.savedAt }))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  },

  async get(slug) {
    if (!this.supported || !slug) return null;
    try {
      const row = await this._tx('readonly', (store) => store.get(slug));
      return row ? { ...row.song, slug: row.slug, savedAt: row.savedAt } : null;
    } catch {
      return null;
    }
  },

  async add(song) {
    if (!this.supported || !song?.slug) throw new Error(I18n.t('downloads.unsupported'));
    const existing = await this.get(song.slug);
    await this._tx('readwrite', (store) => store.put({ slug: song.slug, song, savedAt: existing?.savedAt || Date.now() }));
    this.slugs.add(song.slug);
    this._saveMirror();
    // Ask the browser not to evict this data when it is short on space.
    try { navigator.storage?.persist?.(); } catch { /* ignore */ }
    document.dispatchEvent(new CustomEvent('downloads-changed', { detail: { slug: song.slug } }));
  },

  async remove(slug) {
    await this._tx('readwrite', (store) => store.delete(slug));
    this.slugs.delete(slug);
    this._saveMirror();
    document.dispatchEvent(new CustomEvent('downloads-changed', { detail: { slug } }));
  },

  async clear() {
    await this._tx('readwrite', (store) => store.clear());
    this.slugs.clear();
    this._saveMirror();
    document.dispatchEvent(new CustomEvent('downloads-changed'));
  },

  /** Asks the service worker to keep the song page and My Downloads page available offline. */
  prepareOffline() {
    try {
      navigator.serviceWorker?.ready.then((reg) => reg.active?.postMessage({ type: 'CACHE_OFFLINE_SHELLS' }));
    } catch { /* ignore */ }
  },
};
Downloads._loadMirror();

// ─── Favorites Module (cookie-backed) ───────────────────────────
const Favorites = {
  COOKIE_NAME: 'favorites',
  MAX_AGE_HOURS: 24 * 365 * 5, // 5 years — a deliberately "saved" list, not a transient cache

  /** Check if preference storage is allowed (same consent gate as SearchHistory). */
  _canStore() {
    return typeof CookieConsent === 'undefined' || CookieConsent.hasConsent();
  },

  /** Get the list of favorited song slugs. */
  getAll() {
    try {
      const raw = Cache.getCookie(this.COOKIE_NAME);
      const slugs = raw ? JSON.parse(raw) : [];
      return Array.isArray(slugs) ? slugs : [];
    } catch {
      return [];
    }
  },

  has(slug) {
    return this.getAll().includes(slug);
  },

  _save(slugs) {
    try {
      Cache.setCookie(this.COOKIE_NAME, JSON.stringify(slugs), this.MAX_AGE_HOURS);
    } catch { /* ignore */ }
  },

  /** Toggle a song's favorite status. Returns the new state (true = now favorited),
   *  or null if storage isn't allowed under the current cookie-consent choice. */
  toggle(slug) {
    if (!this._canStore()) return null;
    const slugs = this.getAll();
    const idx = slugs.indexOf(slug);
    const nowFavorited = idx === -1;
    if (nowFavorited) slugs.push(slug);
    else slugs.splice(idx, 1);
    this._save(slugs);
    return nowFavorited;
  },

  clear() {
    this._save([]);
  },
};

// ─── Pins Module (cookie-backed) ────────────────────────────────
// Up to MAX favorited songs can be pinned to the top of the home page. Pins live in a cookie
// (same consent gate and lifetime as favorites) and only favorited songs can be pinned —
// un-favoriting a song un-pins it.
const Pins = {
  COOKIE_NAME: 'pinned',
  MAX: 7,
  MAX_AGE_HOURS: 24 * 365 * 5,

  getAll() {
    try {
      const raw = Cache.getCookie(this.COOKIE_NAME);
      const slugs = raw ? JSON.parse(raw) : [];
      return Array.isArray(slugs) ? slugs.filter((x) => typeof x === 'string').slice(0, this.MAX) : [];
    } catch {
      return [];
    }
  },

  has(slug) {
    return this.getAll().includes(slug);
  },

  _save(slugs) {
    try {
      Cache.setCookie(this.COOKIE_NAME, JSON.stringify(slugs), this.MAX_AGE_HOURS);
    } catch { /* ignore */ }
  },

  /** Pin/unpin a song. Returns 'pinned' | 'unpinned' | 'full' | 'not_favorite' | 'no_consent'. */
  toggle(slug) {
    if (typeof CookieConsent !== 'undefined' && !CookieConsent.hasConsent()) return 'no_consent';
    const slugs = this.getAll();
    const idx = slugs.indexOf(slug);
    if (idx !== -1) {
      slugs.splice(idx, 1);
      this._save(slugs);
      return 'unpinned';
    }
    if (!Favorites.has(slug)) return 'not_favorite';
    if (slugs.length >= this.MAX) return 'full';
    slugs.push(slug);
    this._save(slugs);
    return 'pinned';
  },

  remove(slug) {
    const slugs = this.getAll();
    const idx = slugs.indexOf(slug);
    if (idx === -1) return;
    slugs.splice(idx, 1);
    this._save(slugs);
  },
};

// ─── Display Mode Module (Card / List, shared across all song grids) ───
const DisplayMode = {
  STORAGE_KEY: 'ml_display_mode',
  current: 'card',

  init() {
    try {
      this.current = localStorage.getItem(this.STORAGE_KEY) === 'list' ? 'list' : 'card';
    } catch {
      this.current = 'card';
    }
    this.apply();
    document.querySelectorAll('.view-toggle__btn').forEach((btn) => {
      btn.addEventListener('click', () => this.set(btn.dataset.view));
    });
  },

  /** Reflects `current` onto every song grid + toggle button currently in the DOM. */
  apply() {
    document.querySelectorAll('.song-grid').forEach((grid) => {
      grid.classList.toggle('list', this.current === 'list');
    });
    document.querySelectorAll('.view-toggle__btn').forEach((btn) => {
      const active = btn.dataset.view === this.current;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  },

  set(mode) {
    if (mode !== 'card' && mode !== 'list') return;
    this.current = mode;
    try { localStorage.setItem(this.STORAGE_KEY, mode); } catch { /* ignore */ }
    this.apply();
  },
};

// ─── Search History Module ─────────────────────────────────────
const SearchHistory = {
  MAX_ITEMS: 10,
  STORAGE_KEY: 'ml_search_history',

  /** Check if preference storage is allowed. */
  _canStore() {
    return typeof CookieConsent === 'undefined' || CookieConsent.hasConsent();
  },

  /** Get search history array. */
  getHistory() {
    if (!this._canStore()) return [];
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  },

  /** Add a search term to history. */
  add(term) {
    if (!term?.trim() || !this._canStore()) return;
    const history = this.getHistory();
    const normalized = term.trim();
    const filtered = history.filter(h => h.toLowerCase() !== normalized.toLowerCase());
    filtered.unshift(normalized);
    if (filtered.length > this.MAX_ITEMS) filtered.length = this.MAX_ITEMS;
    try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(filtered)); } catch {}
  },

  /** Remove a specific term. */
  remove(term) {
    const history = this.getHistory();
    const filtered = history.filter(h => h !== term);
    try { localStorage.setItem(this.STORAGE_KEY, JSON.stringify(filtered)); } catch {}
  },

  /** Clear all history. */
  clear() {
    try { localStorage.removeItem(this.STORAGE_KEY); } catch {}
  },

  /** Create and show the dropdown under the input. */
  show(input) {
    const history = this.getHistory();
    if (history.length === 0) { this.hide(); return; }

    let dropdown = document.getElementById('searchHistory');
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.id = 'searchHistory';
      dropdown.className = 'search-history';
      input.parentElement.appendChild(dropdown);
    }

    const clockSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

    dropdown.innerHTML = `
      <div class="search-history__header">
        <span class="search-history__label">${I18n.t('search_history.recent')}</span>
        <button class="search-history__clear-all">${I18n.t('search_history.clear_all')}</button>
      </div>
      <div class="search-history__list">
        ${history.map(term => `
          <button class="search-history__item" data-term="${Utils.escapeHtml(term)}">
            <span class="search-history__item-icon">${clockSvg}</span>
            <span class="search-history__item-text">${Utils.escapeHtml(term)}</span>
            <span class="search-history__item-remove" title="${I18n.t('search_history.remove')}">✕</span>
          </button>
        `).join('')}
      </div>
    `;

    // Bind events
    dropdown.querySelector('.search-history__clear-all').addEventListener('click', (e) => {
      e.stopPropagation();
      this.clear();
      this.hide();
    });

    dropdown.querySelectorAll('.search-history__item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.search-history__item-remove')) {
          e.stopPropagation();
          this.remove(item.dataset.term);
          this.show(input);
          return;
        }
        input.value = item.dataset.term;
        this.hide();
        // Trigger search
        if (typeof HomePage !== 'undefined') {
          HomePage.handleSearch(item.dataset.term);
        }
      });
    });

    dropdown.classList.add('visible');
  },

  /** Hide the dropdown. */
  hide() {
    const dropdown = document.getElementById('searchHistory');
    if (dropdown) dropdown.classList.remove('visible');
  },
};

// ─── API Module ────────────────────────────────────────────────
const API = {
  /** Generic JSON fetch with error handling. */
  async fetchJSON(endpoint) {
    const res = await fetch(CONFIG.API_BASE + endpoint);
    if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
    return res.json();
  },

  /** Get paginated song list. */
  async getSongs(page = 1, category = null, sort = null) {
    let url = `/songs?page=${page}&limit=${CONFIG.ITEMS_PER_PAGE}`;
    if (category) url += `&category=${encodeURIComponent(category)}`;
    if (sort) url += `&sort=${encodeURIComponent(sort)}`;
    return this.fetchJSON(url);
  },

  /** Get single song by slug. */
  async getSong(slug) {
    return this.fetchJSON(`/songs/${encodeURIComponent(slug)}`);
  },

  /** Search songs. */
  async search(query) {
    return this.fetchJSON(`/search?q=${encodeURIComponent(query)}`);
  },

  /** Get categories. */
  async getCategories() {
    return this.fetchJSON('/categories');
  },

  /** Get popular songs. */
  async getPopular() {
    return this.fetchJSON(`/songs/popular?limit=${CONFIG.POPULAR_LIMIT}`);
  },

  /** Get today's featured song (same for every visitor, changes once a day). */
  async getSongOfTheDay() {
    return this.fetchJSON('/songs/of-the-day');
  },

  /** Increment view count. */
  async incrementView(slug) {
    return fetch(`${CONFIG.API_BASE}/songs/${encodeURIComponent(slug)}/view`, {
      method: 'POST',
    });
  },

  /** Get copyright owner by slug. */
  async getCopyrightOwner(slug) {
    return this.fetchJSON(`/copyright-owners/${encodeURIComponent(slug)}`);
  },

  /** Get artist by slug. */
  async getArtist(slug) {
    return this.fetchJSON(`/artists/${encodeURIComponent(slug)}`);
  },

  /** Get composer by slug. */
  async getComposer(slug) {
    return this.fetchJSON(`/composers/${encodeURIComponent(slug)}`);
  },

  /** Mara Idol: every published season + idol (index page). */
  async getIdolIndex() {
    return this.fetchJSON('/mara-idol');
  },
  async getIdolSeason(season) {
    return this.fetchJSON(`/mara-idol/${encodeURIComponent(season)}`);
  },
  async getIdolContestant(season, idol) {
    return this.fetchJSON(`/mara-idol/${encodeURIComponent(season)}/${encodeURIComponent(idol)}`);
  },

  /** Get paginated, published articles. */
  async getArticles(page = 1, sort = null) {
    let url = `/articles?page=${page}&limit=12`;
    if (sort) url += `&sort=${encodeURIComponent(sort)}`;
    return this.fetchJSON(url);
  },

  /** Get single published article by slug. */
  async getArticle(slug) {
    return this.fetchJSON(`/articles/${encodeURIComponent(slug)}`);
  },
};

// The blue "downloaded" mark shown beside a song's view count, and the download button icon.
// The blue "downloaded" mark shown beside a song's view count. Built per render so its
// label follows the site language; data-i18n-* keeps it in step on a later language switch.
function downloadedMarkHtml(slug, downloaded) { // slug: already HTML-escaped
  return `<span class="song-card__dlmark" data-slug="${slug}"${downloaded ? '' : ' hidden'} role="img" aria-label="${Utils.escapeHtml(I18n.t('common.downloaded_btn'))}" title="${Utils.escapeHtml(I18n.t('downloads.saved'))}" data-i18n-aria="common.downloaded_btn" data-i18n-title="downloads.saved"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#2f80ed"/><path d="M12 5v9m0 0l-4-4m4 4l4-4M6.5 18.5h11" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}
// The download button icon.
const DOWNLOAD_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v10m0 0l-4-4m4 4l4-4M5 19h14"/></svg>';

// ─── UI Rendering Module ───────────────────────────────────────
const UI = {
  /** Create a song card HTML string. */
  createSongCard(song, index = 0) {
    const delay = Math.min(index * 60, 600);
    const isDownloaded = Downloads.has(song.slug);
    const isFavorited = Favorites.has(song.slug);
    const isPinned = Pins.has(song.slug);
    const slug = Utils.escapeHtml(song.slug);
    // The favorite <button> is a sibling of the <a>, not nested inside it — <a> may not
    // contain interactive content, and nesting would make click targets unpredictable.
    return `
      <div class="song-card stagger-enter${isPinned ? ' song-card--pinned' : ''}" style="animation-delay:${delay}ms" data-slug="${slug}">
        <a href="/song/${slug}" class="song-card__link">
          <h3 class="song-card__title">${Utils.escapeHtml(song.title)}</h3>
          <p class="song-card__artist">${Utils.escapeHtml(Utils.joinNames(song.artists, song.artist_name || song.artist || I18n.t('common.unknown_artist')))}</p>
          <div class="song-card__meta">
            ${song.category ? `<span class="song-card__category">${Utils.escapeHtml(song.category)}</span>` : '<span></span>'}
            <span class="song-card__views">${downloadedMarkHtml(slug, isDownloaded)}👁 ${Utils.formatViews(song.views)}</span>
          </div>
        </a>
        <button type="button" class="song-card__favorite${isFavorited ? ' active' : ''}" data-slug="${slug}" aria-pressed="${isFavorited}" aria-label="${I18n.t(isFavorited ? 'common.remove_from_favorites' : 'common.add_to_favorites')}" title="${I18n.t(isFavorited ? 'common.remove_from_favorites' : 'common.add_to_favorites')}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
        </button>
        <button type="button" class="song-card__download${isDownloaded ? ' active' : ''}" data-slug="${slug}" aria-pressed="${isDownloaded}" aria-label="${I18n.t(isDownloaded ? 'common.downloaded_remove' : 'common.download')}" title="${I18n.t(isDownloaded ? 'common.downloaded_remove' : 'common.download')}">
          ${DOWNLOAD_ICON_SVG}
        </button>
        <button type="button" class="song-card__pin${isPinned ? ' active' : ''}" data-slug="${slug}" aria-pressed="${isPinned}" aria-label="${I18n.t(isPinned ? 'common.unpin' : 'common.pin')}" title="${I18n.t(isPinned ? 'common.unpin' : 'common.pin')}"${isFavorited ? '' : ' hidden'}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/></svg>
        </button>
      </div>`;
  },

  /** Create the larger featured "Song of the Day" card. Reuses the `.song-card__favorite`
   *  class/markup so the site-wide delegated favorite-toggle handler picks it up for free. */
  createSongOfTheDayCard(song) {
    const isFavorited = Favorites.has(song.slug);
    const slug = Utils.escapeHtml(song.slug);
    const artistDisplay = Utils.joinNames(song.artists, song.artist_name || song.artist || I18n.t('common.unknown_artist'));
    return `
      <div class="song-of-the-day fade-in" data-slug="${slug}">
        <span class="song-of-the-day__badge">${I18n.t('home.song_of_the_day_badge')}</span>
        <a href="/song/${slug}" class="song-of-the-day__link">
          <h3 class="song-of-the-day__title">${Utils.escapeHtml(song.title)}</h3>
          <p class="song-of-the-day__artist">${Utils.escapeHtml(artistDisplay)}</p>
          <div class="song-of-the-day__meta">
            ${song.category ? `<span class="song-card__category">${Utils.escapeHtml(song.category)}</span>` : '<span></span>'}
            <span class="song-card__views">👁 ${Utils.formatViews(song.views)}</span>
          </div>
        </a>
        <button type="button" class="song-card__favorite${isFavorited ? ' active' : ''}" data-slug="${slug}" aria-pressed="${isFavorited}" aria-label="${I18n.t(isFavorited ? 'common.remove_from_favorites' : 'common.add_to_favorites')}" title="${I18n.t(isFavorited ? 'common.remove_from_favorites' : 'common.add_to_favorites')}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>
        </button>
      </div>`;
  },

  /** Create the "Today's Event" card that takes over the Song of the Day
   *  spot when a marareih.org community event falls on today. Reuses the
   *  same glowing-border card shell for a consistent, modern look. */
  createEventOfTheDayCard(ev) {
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(ev.start);
    let when;
    if (isAllDay) {
      when = ev.start === ev.end
        ? new Date(ev.start + 'T00:00:00').toLocaleDateString(Utils.locale(), { weekday: 'long', month: 'long', day: 'numeric' })
        : `${new Date(ev.start + 'T00:00:00').toLocaleDateString(Utils.locale(), { month: 'short', day: 'numeric' })} – ${new Date(ev.end + 'T00:00:00').toLocaleDateString(Utils.locale(), { month: 'short', day: 'numeric', year: 'numeric' })}`;
    } else {
      when = new Date(ev.start).toLocaleString(Utils.locale(), { weekday: 'long', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    return `
      <div class="song-of-the-day song-of-the-day--event fade-in" data-event-open>
        <span class="song-of-the-day__badge song-of-the-day__badge--event">${I18n.t('home.event_of_the_day_badge')}</span>
        <div class="song-of-the-day__event-body">
          <h3 class="song-of-the-day__title">${Utils.escapeHtml(ev.title)}</h3>
          <p class="song-of-the-day__artist">🗓️ ${Utils.escapeHtml(when)}${ev.location ? ` · 📍 ${Utils.escapeHtml(ev.location)}` : ''}</p>
          ${ev.description ? `<p class="song-of-the-day__event-desc">${Utils.escapeHtml(ev.description)}</p>` : ''}
        </div>
        <div class="song-of-the-day__event-actions">
          <button type="button" class="song-of-the-day__event-details" data-event-open>${I18n.t('event_detail.view_details')}</button>
          <button type="button" class="song-of-the-day__event-link" data-calendar-open>${I18n.t('home.event_of_the_day_link')}</button>
        </div>
      </div>`;
  },

  /** Create skeleton loading cards. */
  /** Create an article card for the /articles listing grid. */
  createArticleCard(article, index = 0) {
    const delay = Math.min(index * 60, 600);
    const slug = Utils.escapeHtml(article.slug);
    const dateStr = article.published_at || article.created_at;
    return `
      <a href="/article/${slug}" class="article-card stagger-enter" style="animation-delay:${delay}ms">
        <h3 class="article-card__title">${Utils.escapeHtml(article.title)}</h3>
        <div class="article-card__meta">
          <span class="article-card__author">${Utils.escapeHtml(article.author_name)}</span>
          <span class="article-card__dot"></span>
          <span class="article-card__date">${Utils.formatDateShort(dateStr)}</span>
        </div>
        ${article.summary ? `<p class="article-card__summary">${Utils.escapeHtml(article.summary)}</p>` : ''}
      </a>`;
  },

  /** Create skeleton cards shaped like an article card. */
  createArticleSkeletons(count = 6) {
    return Array(count)
      .fill('')
      .map(
        () => `
      <div class="skeleton">
        <div class="skeleton__line skeleton__line--title"></div>
        <div class="skeleton__line skeleton__line--short"></div>
        <div class="skeleton__line" style="margin-top:var(--space-md)"></div>
        <div class="skeleton__line skeleton__line--medium"></div>
      </div>`
      )
      .join('');
  },

  createSkeletons(count = 6) {
    return Array(count)
      .fill('')
      .map(
        () => `
      <div class="skeleton">
        <div class="skeleton__line skeleton__line--title"></div>
        <div class="skeleton__line skeleton__line--short"></div>
        <div class="skeleton__line skeleton__line--medium" style="margin-top:var(--space-md)"></div>
      </div>`
      )
      .join('');
  },

  /** Render pagination controls. */
  createPagination(page, totalPages) {
    if (totalPages <= 1) return '';

    let html = '';

    // Previous button
    html += `<button class="pagination__btn" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">${I18n.t('common.prev')}</button>`;

    // Page numbers
    const range = 2;
    const start = Math.max(1, page - range);
    const end = Math.min(totalPages, page + range);

    if (start > 1) {
      html += `<button class="pagination__btn" data-page="1">1</button>`;
      if (start > 2) html += `<span class="pagination__info">...</span>`;
    }

    for (let i = start; i <= end; i++) {
      html += `<button class="pagination__btn ${i === page ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }

    if (end < totalPages) {
      if (end < totalPages - 1) html += `<span class="pagination__info">...</span>`;
      html += `<button class="pagination__btn" data-page="${totalPages}">${totalPages}</button>`;
    }

    // Next button
    html += `<button class="pagination__btn" ${page >= totalPages ? 'disabled' : ''} data-page="${page + 1}">${I18n.t('common.next')}</button>`;

    return html;
  },

  /** Show/hide the offline badge (header). */
  setOfflineMode(offline) {
    if (typeof Toast !== 'undefined') {
      Toast.setBadge(offline);
    }
  },

  /** Show empty state. `variant` swaps in different copy (e.g. for an empty favorites list)
   *  without needing a second empty-state element in the markup. */
  showEmptyState(show = true, variant = 'default') {
    const el = document.getElementById('emptyState');
    if (!el) return;
    el.style.display = show ? 'block' : 'none';
    if (!show) return;

    const titleEl = el.querySelector('.empty-state__title');
    const textEl = el.querySelector('.empty-state__text');
    const copy = variant === 'favorites'
      ? { title: I18n.t('home.no_favorites_title'), text: I18n.t('home.no_favorites_text') }
      : { title: I18n.t('home.no_songs_title'), text: I18n.t('home.no_songs_text') };
    if (titleEl) titleEl.textContent = copy.title;
    if (textEl) textEl.textContent = copy.text;
  },
};

// ─── Home Page Controller ──────────────────────────────────────
const HomePage = {
  currentPage: 1,
  currentCategory: null,
  currentSort: 'name_asc',
  favoritesOnly: false,

  async init() {
    FeaturedPeople.init(); // independent of the song list — never blocks it

    this.bindElements();
    this.bindEvents();
    // Restore previous page/category/sort so refresh keeps the user's position
    try {
      const saved = sessionStorage.getItem('ml_home_state');
      if (saved) {
        const s = JSON.parse(saved);
        this.currentPage = s.page || 1;
        this.currentCategory = s.category || null;
        this.favoritesOnly = !!s.favoritesOnly;
      }
      this.currentSort = localStorage.getItem('ml_sort') || 'name_asc';
    } catch {}
    if (this.sortSelect) this.sortSelect.value = this.currentSort;
    this.updateFavoritesFilterButton();

    // Load categories first so active button can be highlighted
    await this.loadCategories();
    if (this.currentCategory) this.updateCategoryButtons();
    await Promise.all([
      this.loadFeaturedSpot(),
      this.loadPopular(),
      this.favoritesOnly ? this.loadFavorites() : this.loadSongs(),
    ]);

    // Deep link: /?q=term runs that search on arrival. This is the URL the home page's
    // WebSite SearchAction (JSON-LD) advertises, so it has to actually work.
    const deepLinkQuery = (new URLSearchParams(location.search).get('q') || '').trim().slice(0, 100);
    if (deepLinkQuery && this.searchInput) {
      this.searchInput.value = deepLinkQuery;
      if (this.searchClear) this.searchClear.classList.add('visible');
      this.handleSearch(deepLinkQuery);
    }
  },

  bindElements() {
    this.searchInput = document.getElementById('searchInput');
    this.searchClear = document.getElementById('searchClear');
    this.categoriesEl = document.getElementById('categories');
    this.songGrid = document.getElementById('songGrid');
    this.popularGrid = document.getElementById('popularGrid');
    this.searchGrid = document.getElementById('searchGrid');
    this.searchResults = document.getElementById('searchResults');
    this.searchCount = document.getElementById('searchCount');
    this.songOfTheDaySection = document.getElementById('songOfTheDaySection');
    this.songOfTheDayCard = document.getElementById('songOfTheDayCard');
    this.songOfTheDaySectionIcon = document.getElementById('songOfTheDaySectionIcon');
    this.songOfTheDaySectionLabel = document.getElementById('songOfTheDaySectionLabel');
    this.popularSection = document.getElementById('popularSection');
    this.allSongsSection = document.getElementById('allSongsSection');
    this.paginationEl = document.getElementById('pagination');
    this.sortSelect = document.getElementById('sortSelect');
    this.favoritesFilterBtn = document.getElementById('favoritesFilterBtn');
  },

  bindEvents() {
    // Search with debounce
    if (this.searchInput) {
      const debouncedSearch = Utils.debounce(
        (e) => this.handleSearch(e.target.value),
        CONFIG.SEARCH_DEBOUNCE
      );
      this.searchInput.addEventListener('input', (e) => {
        this.searchClear.classList.toggle('visible', e.target.value.length > 0);
        if (!e.target.value.trim()) {
          SearchHistory.show(this.searchInput);
        } else {
          SearchHistory.hide();
        }
        debouncedSearch(e);
      });

      // Show search history on focus when input is empty
      this.searchInput.addEventListener('focus', () => {
        if (!this.searchInput.value.trim()) {
          SearchHistory.show(this.searchInput);
        }
      });

      // Hide search history on click outside
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.search') && !e.target.closest('.search-history')) {
          SearchHistory.hide();
        }
      });
    }

    // Clear search
    if (this.searchClear) {
      this.searchClear.addEventListener('click', () => {
        this.searchInput.value = '';
        this.searchClear.classList.remove('visible');
        this.clearSearch();
        this.searchInput.focus();
      });
    }

    // Category filter (event delegation)
    if (this.categoriesEl) {
      this.categoriesEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.category-btn');
        if (!btn) return;
        const cat = btn.dataset.category;
        this.currentCategory = cat === this.currentCategory ? null : cat;
        this.currentPage = 1;
        this.favoritesOnly = false;
        this.updateCategoryButtons();
        this.updateFavoritesFilterButton();
        this.loadSongs();
      });
    }

    // Pagination (event delegation)
    if (this.paginationEl) {
      this.paginationEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.pagination__btn');
        if (!btn || btn.disabled) return;
        this.currentPage = parseInt(btn.dataset.page, 10);
        this.loadSongs();
        window.scrollTo({ top: this.allSongsSection.offsetTop - 80, behavior: 'smooth' });
      });
    }

    // Sort
    if (this.sortSelect) {
      this.sortSelect.addEventListener('change', () => {
        this.currentSort = this.sortSelect.value;
        try { localStorage.setItem('ml_sort', this.currentSort); } catch {}
        this.currentPage = 1;
        this.favoritesOnly ? this.loadFavorites() : this.loadSongs();
      });
    }

    // Favorites filter — shows only favorited songs in place of the paginated list
    if (this.favoritesFilterBtn) {
      this.favoritesFilterBtn.addEventListener('click', () => {
        this.favoritesOnly = !this.favoritesOnly;
        this.currentPage = 1;
        this.updateFavoritesFilterButton();
        if (this.favoritesOnly) {
          this.currentCategory = null;
          this.updateCategoryButtons();
          this.loadFavorites();
        } else {
          this.loadSongs();
        }
      });
    }
  },

  updateFavoritesFilterButton() {
    if (!this.favoritesFilterBtn) return;
    this.favoritesFilterBtn.classList.toggle('active', this.favoritesOnly);
    this.favoritesFilterBtn.setAttribute('aria-pressed', String(this.favoritesOnly));
  },

  // ─── Load Categories ─────────────────────────────────
  async loadCategories() {
    if (!this.categoriesEl) return;
    try {
      let data;
      if (Utils.isOnline()) {
        data = await API.getCategories();
        Cache.set('categories', data.categories);
      } else {
        data = { categories: Cache.get('categories') || [] };
      }

      const allBtn = `<button class="category-btn active" data-category="">${I18n.t('common.all')}</button>`;
      const catBtns = data.categories
        .map((c) => `<button class="category-btn" data-category="${Utils.escapeHtml(c)}">${Utils.escapeHtml(c)}</button>`)
        .join('');

      this.categoriesEl.innerHTML = allBtn + catBtns;
    } catch (err) {
      console.warn('Failed to load categories:', err);
    }
  },

  updateCategoryButtons() {
    if (!this.categoriesEl) return;
    this.categoriesEl.querySelectorAll('.category-btn').forEach((btn) => {
      const cat = btn.dataset.category;
      const isActive =
        (!this.currentCategory && cat === '') ||
        cat === this.currentCategory;
      btn.classList.toggle('active', isActive);
    });
  },

  // ─── Featured spot: today's community event, falling back to Song of the Day ────
  // Shares the Song of the Day slot rather than adding a second section — the two
  // never have anything useful to say at the same time.
  async loadFeaturedSpot() {
    if (!this.songOfTheDaySection || !this.songOfTheDayCard) return;

    const event = await this.getTodaysEvent();
    if (event) {
      this.songOfTheDaySectionIcon.textContent = '📅';
      this.songOfTheDaySectionLabel.setAttribute('data-i18n', 'home.event_of_the_day');
      I18n.applyToDOM();
      this.featuredEvent = event;
      this.songOfTheDayCard.innerHTML = UI.createEventOfTheDayCard(event);
      this.songOfTheDaySection.style.display = 'block';
      return;
    }

    this.songOfTheDaySectionIcon.textContent = '🌟';
    this.songOfTheDaySectionLabel.setAttribute('data-i18n', 'home.song_of_the_day');
    I18n.applyToDOM();
    await this.loadSongOfTheDay();
  },

  /** Looks for a community event on today, via marareih.org's public calendar
   *  API — restricted to the visitor's default calendar (Settings) when one
   *  is set, otherwise any calendar. Cached per-day like Song of the Day. */
  async getTodaysEvent() {
    const todayStr = Utils.todayLocalISODate();
    const defaultCal = CalendarPrefs.get();
    const cacheKey = 'today_event_' + todayStr + (defaultCal ? '_' + defaultCal : '');

    if (!Utils.isOnline()) {
      return Cache.get(cacheKey);
    }

    try {
      const year = new Date().getFullYear();
      const url = new URL('https://calendar-api.marareih.org/api/events');
      url.searchParams.set('year', year);
      if (defaultCal) url.searchParams.set('calendar', defaultCal);
      // The calendar API caches this response for 5 minutes (browser + CDN
      // edge) — fine for browsing other years, but "is there an event
      // today" needs to reflect an event added minutes ago, not up to 5
      // minutes stale. Bust both cache layers with a unique query param.
      url.searchParams.set('_', Date.now());
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const match = (data.events || []).find((ev) => this.isEventOnDate(ev, todayStr)) || null;
      Cache.set(cacheKey, match);
      return match;
    } catch (err) {
      console.warn('Failed to check for a community event today:', err);
      const cached = Cache.get(cacheKey);
      if (cached) UI.setOfflineMode(true);
      return cached;
    }
  },

  isEventOnDate(ev, dateStr) {
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(ev.start);
    // ISO YYYY-MM-DD strings compare lexicographically just like dates.
    return isAllDay ? ev.start <= dateStr && dateStr <= ev.end : ev.start.slice(0, 10) === dateStr;
  },

  // ─── Load Song of the Day ─────────────────────────────
  async loadSongOfTheDay() {
    if (!this.songOfTheDaySection || !this.songOfTheDayCard) return;
    const cacheKey = 'song_of_the_day_' + new Date().toISOString().slice(0, 10);

    try {
      let song;
      if (Utils.isOnline()) {
        song = await API.getSongOfTheDay();
        Cache.set(cacheKey, song);
      } else {
        song = Cache.get(cacheKey);
        if (!song) {
          this.songOfTheDaySection.style.display = 'none';
          return;
        }
        UI.setOfflineMode(true);
      }

      this.songOfTheDayCard.innerHTML = UI.createSongOfTheDayCard(song);
      this.songOfTheDaySection.style.display = 'block';
    } catch (err) {
      console.warn('Failed to load song of the day:', err);
      const cached = Cache.get(cacheKey);
      if (cached) {
        this.songOfTheDayCard.innerHTML = UI.createSongOfTheDayCard(cached);
        this.songOfTheDaySection.style.display = 'block';
        UI.setOfflineMode(true);
      } else {
        this.songOfTheDaySection.style.display = 'none';
      }
    }
  },

  // ─── Load Popular Songs ──────────────────────────────
  async loadPopular() {
    if (!this.popularGrid) return;
    this.popularGrid.innerHTML = UI.createSkeletons(CONFIG.POPULAR_LIMIT);

    try {
      let songs;
      if (Utils.isOnline()) {
        const data = await API.getPopular();
        songs = data.songs;
        Cache.set('popular', songs);
      } else {
        songs = Cache.get('popular') || [];
      }

      if (songs.length === 0) {
        this.popularSection.style.display = 'none';
        return;
      }

      this.popularGrid.innerHTML = songs
        .map((s, i) => UI.createSongCard(s, i))
        .join('');
    } catch (err) {
      console.warn('Failed to load popular songs:', err);
      const cached = Cache.get('popular');
      if (cached?.length) {
        this.popularGrid.innerHTML = cached.map((s, i) => UI.createSongCard(s, i)).join('');
      } else {
        this.popularSection.style.display = 'none';
      }
    }
  },

  // ─── Pinned songs (up to Pins.MAX favorites, kept in a cookie) ────────
  // Pinned songs lead the All Songs list (first page) and the Favorites view, in the order
  // they were pinned. On a category filter only the pinned songs of that category lead.
  async getPinnedSongs() {
    const slugs = Pins.getAll();
    if (!slugs.length) return [];
    const songs = (await Promise.all(slugs.map((slug) => (
      Utils.isOnline()
        ? API.getSong(slug).catch(() => Downloads.get(slug))
        : Downloads.get(slug)
    )))).filter(Boolean);
    return this.currentCategory ? songs.filter((song) => song.category === this.currentCategory) : songs;
  },

  /** One page of songs with the pinned ones moved to the top (page 1) — and removed from later
   *  pages so a pinned song never shows twice. */
  async withPinnedFirst(songs) {
    const pinned = Pins.getAll();
    if (!pinned.length) return songs;
    const rest = songs.filter((song) => !pinned.includes(song.slug));
    if (this.currentPage !== 1) return rest;
    return [...(await this.getPinnedSongs()), ...rest];
  },

  /** Favorites view: pinned songs first (in pin order), then the rest in the chosen sort. */
  pinnedFirst(songs) {
    const pinned = Pins.getAll();
    if (!pinned.length) return songs;
    const lead = pinned.map((slug) => songs.find((song) => song.slug === slug)).filter(Boolean);
    return [...lead, ...songs.filter((song) => !pinned.includes(song.slug))];
  },

  /** Re-render the current list after a pin/unpin (no skeleton flash). */
  refreshList() {
    if (!this.songGrid) return;
    return this.favoritesOnly ? this.loadFavorites(true) : this.loadSongs(true);
  },

  // ─── Load All Songs (Paginated) ──────────────────────
  async loadSongs(quiet = false) {
    if (!this.songGrid) return;
    // Save current state so refresh restores page + category + favorites-filter
    try {
      sessionStorage.setItem('ml_home_state', JSON.stringify({
        page: this.currentPage,
        category: this.currentCategory || '',
        favoritesOnly: this.favoritesOnly,
      }));
    } catch {}
    if (!quiet) {
      this.songGrid.innerHTML = UI.createSkeletons(6);
      this.paginationEl.innerHTML = '';
    }

    try {
      let data;
      if (Utils.isOnline()) {
        data = await API.getSongs(this.currentPage, this.currentCategory, this.currentSort);
        Cache.cacheSongList(this.currentPage, this.currentCategory, this.currentSort, data);
      } else {
        data = Cache.getCachedSongList(this.currentPage, this.currentCategory, this.currentSort);
        if (!data) {
          UI.showEmptyState(true);
          this.songGrid.innerHTML = '';
          return;
        }
        UI.setOfflineMode(true);
      }

      UI.showEmptyState(false);

      if (!data.songs?.length) {
        this.songGrid.innerHTML = '';
        UI.showEmptyState(true);
        return;
      }

      const ordered = await this.withPinnedFirst(data.songs);
      this.songGrid.innerHTML = ordered
        .map((s, i) => UI.createSongCard(s, i))
        .join('');

      this.paginationEl.innerHTML = UI.createPagination(data.page, data.totalPages);
    } catch (err) {
      console.warn('Failed to load songs:', err);
      // Try cache fallback
      const cached = Cache.getCachedSongList(this.currentPage, this.currentCategory, this.currentSort);
      if (cached?.songs?.length) {
        this.songGrid.innerHTML = cached.songs.map((s, i) => UI.createSongCard(s, i)).join('');
        this.paginationEl.innerHTML = UI.createPagination(cached.page, cached.totalPages);
        UI.setOfflineMode(true);
      } else {
        this.songGrid.innerHTML = '';
        UI.showEmptyState(true);
      }
    }
  },

  // ─── Load Favorites (client-side, bypasses server pagination) ────────
  async loadFavorites(quiet = false) {
    if (!this.songGrid) return;
    try {
      sessionStorage.setItem('ml_home_state', JSON.stringify({
        page: this.currentPage,
        category: this.currentCategory || '',
        favoritesOnly: this.favoritesOnly,
      }));
    } catch {}

    const slugs = Favorites.getAll();
    this.paginationEl.innerHTML = '';

    if (!slugs.length) {
      this.songGrid.innerHTML = '';
      UI.showEmptyState(true, 'favorites');
      return;
    }

    if (!quiet) this.songGrid.innerHTML = UI.createSkeletons(Math.min(slugs.length, 6));

    if (!Utils.isOnline()) {
      const cached = (await Promise.all(slugs.map((s) => Downloads.get(s)))).filter(Boolean);
      const sorted = this.pinnedFirst(Utils.sortSongs(cached, this.currentSort));
      UI.setOfflineMode(true);
      if (!sorted.length) {
        this.songGrid.innerHTML = '';
        UI.showEmptyState(true, 'favorites');
        return;
      }
      UI.showEmptyState(false);
      this.songGrid.innerHTML = sorted.map((s, i) => UI.createSongCard(s, i)).join('');
      return;
    }

    try {
      const songs = (await Promise.all(slugs.map((s) => API.getSong(s).catch(() => null)))).filter(Boolean);
      const sorted = this.pinnedFirst(Utils.sortSongs(songs, this.currentSort));

      if (!sorted.length) {
        this.songGrid.innerHTML = '';
        UI.showEmptyState(true, 'favorites');
        return;
      }

      UI.showEmptyState(false);
      this.songGrid.innerHTML = sorted.map((s, i) => UI.createSongCard(s, i)).join('');
    } catch (err) {
      console.warn('Failed to load favorites:', err);
      this.songGrid.innerHTML = '';
      UI.showEmptyState(true, 'favorites');
    }
  },

  // ─── Search Handler ──────────────────────────────────
  async handleSearch(query) {
    const q = query.trim();

    if (!q) {
      this.clearSearch();
      return;
    }

    // Show search section, hide others
    this.searchResults.style.display = 'block';
    this.popularSection.style.display = 'none';
    this.allSongsSection.style.display = 'none';
    UI.showEmptyState(false);
    SearchHistory.hide();

    this.searchGrid.innerHTML = UI.createSkeletons(3);

    try {
      let results, suggestions = [];
      if (Utils.isOnline()) {
        const data = await API.search(q);
        results = data.results;
        suggestions = data.suggestions || [];
        Cache.set('search_' + q.toLowerCase(), results);
      } else {
        // Offline: search from cached data
        results = await this._offlineSearch(q);
        UI.setOfflineMode(true);
      }

      // Search history is saved when a result card is clicked (see below)

      this.searchCount.textContent = I18n.t('common.found', { count: results.length });
      const sugBox = document.getElementById('searchSuggestions');

      if (results.length === 0) {
        this.searchGrid.innerHTML = '';
        if (suggestions.length > 0 && sugBox) {
          sugBox.innerHTML =
            `<p class="suggestions-title">${I18n.t('search.did_you_mean')}</p>` +
            suggestions.map(s => `
              <a href="/song/${Utils.escapeHtml(s.slug)}" class="suggestion-chip">
                <span class="suggestion-chip__title">${Utils.escapeHtml(s.title)}</span>
                ${Number.isFinite(s.match_percent) ? `<span class="suggestion-chip__percent">${s.match_percent}% ${I18n.t('search.match_label')}</span>` : ''}
              </a>
            `).join('');
          sugBox.style.display = 'block';
        } else if (sugBox) {
          sugBox.style.display = 'none';
        }
        UI.showEmptyState(true);
        return;
      }

      if (sugBox) sugBox.style.display = 'none';
      this.searchGrid.innerHTML = results
        .map((s, i) => UI.createSongCard(s, i))
        .join('');

      // Save search term to history when a result card's link is clicked (not the
      // favorite button — favoriting from search results shouldn't count as a visit)
      if (this.searchGrid) {
        this.searchGrid.querySelectorAll('.song-card__link').forEach(link => {
          link.addEventListener('click', () => {
            SearchHistory.add(q);
          });
        });
      }
    } catch (err) {
      console.warn('Search failed:', err);
      const cached = Cache.get('search_' + q.toLowerCase());
      if (cached?.length) {
        this.searchGrid.innerHTML = cached.map((s, i) => UI.createSongCard(s, i)).join('');
        this.searchCount.textContent = I18n.t('common.cached', { count: cached.length });
        UI.setOfflineMode(true);
      } else {
        const offline = await this._offlineSearch(q);
        if (offline.length) {
          this.searchGrid.innerHTML = offline.map((s, i) => UI.createSongCard(s, i)).join('');
          this.searchCount.textContent = I18n.t('common.cached', { count: offline.length });
        } else {
          this.searchGrid.innerHTML = '';
          UI.showEmptyState(true);
        }
      }
    }
  },

  /** Search the songs the visitor has downloaded (the only songs available offline). */
  async _offlineSearch(query) {
    const q = query.toLowerCase();
    const songs = await Downloads.getAll();
    return songs.filter((song) => (
      song.title?.toLowerCase().includes(q) ||
      song.artist_name?.toLowerCase().includes(q) ||
      song.artist?.toLowerCase().includes(q) ||
      song.artists?.some((a) => a.name?.toLowerCase().includes(q))
    ));
  },

  /** Clear search results and restore normal view. */
  clearSearch() {
    if (this.searchResults) this.searchResults.style.display = 'none';
    if (this.popularSection) this.popularSection.style.display = 'block';
    if (this.allSongsSection) this.allSongsSection.style.display = 'block';
    const sugBox = document.getElementById('searchSuggestions');
    if (sugBox) sugBox.style.display = 'none';
    SearchHistory.hide();
    UI.showEmptyState(false);
  },
};

// ─── Song Page Controller ──────────────────────────────────────
const SongPage = {
  async init() {
    const slug = Utils.getSlugFromUrl();
    if (!slug) {
      this.showError();
      return;
    }

    await this.loadSong(slug);
  },

  async loadSong(slug) {
    try {
      let song;

      if (Utils.isOnline()) {
        try {
          song = await API.getSong(slug);
        } catch (err) {
          song = await Downloads.get(slug); // network hiccup — fall back to the downloaded copy
          if (!song) throw err;
          UI.setOfflineMode(true);
        }
        // Keep a downloaded song's stored copy up to date (songs are never stored unless downloaded).
        if (Downloads.has(slug) && song?.slug && Utils.isOnline()) Downloads.add(song).catch(() => {});
      } else {
        song = await Downloads.get(slug);
        if (!song) {
          this.showError();
          return;
        }
        UI.setOfflineMode(true);
      }

      this.renderSong(song);
      this.updateMeta(song);
      this.countView(slug);
    } catch (err) {
      console.warn('Failed to load song:', err);
      this.showError();
    }
  },

  renderSong(song) {
    const skeleton = document.getElementById('songSkeleton');
    const detail = document.getElementById('songDetail');
    const error = document.getElementById('songError');

    if (skeleton) skeleton.style.display = 'none';
    if (error) error.style.display = 'none';
    if (detail) detail.style.display = 'block';

    const titleEl = document.getElementById('songTitle');
    const artistEl = document.getElementById('songArtist');
    const categoryEl = document.getElementById('songCategory');
    const viewsEl = document.getElementById('songViews');
    const lyricsEl = document.getElementById('songLyrics');

    if (titleEl) titleEl.textContent = song.title;
    if (artistEl) {
      artistEl.innerHTML = song.artists?.length
        ? Utils.renderCreditedPeople(song.artists, 'artist', I18n.t('song.various_artists'))
        : Utils.renderNameLink(song.artist_name || song.artist, song.artist_slug, 'artist');
    }
    const composerEl = document.getElementById('songComposer');
    if (composerEl) {
      composerEl.innerHTML = song.composers?.length
        ? Utils.renderCreditedPeople(song.composers, 'composer', I18n.t('song.various_composers'))
        : Utils.renderNameLink(song.composer_name || song.composer, song.composer_slug, 'composer');
    }
    if (categoryEl) categoryEl.textContent = song.category || I18n.t('common.uncategorized');
    if (viewsEl) viewsEl.textContent = Utils.formatViews(song.views);

    // Copyright owner (only show if present — displayed at footer of song card)
    const coWrap = document.getElementById('songCopyrightOwnerWrap');
    const coEl = document.getElementById('songCopyrightOwner');
    if (coWrap && coEl) {
      if (song.copyright_owner_name) {
        const link = Utils.renderNameLink(song.copyright_owner_name, song.copyright_owner_slug, 'copyright-owner');
        coEl.innerHTML = `© ${link}`;
        coWrap.style.display = 'block';
      } else {
        coWrap.style.display = 'none';
      }
    }

    // Update breadcrumb
    const breadcrumbTitle = document.getElementById('breadcrumbTitle');
    if (breadcrumbTitle) breadcrumbTitle.textContent = song.title;

    if (lyricsEl) {
      // Replace literal \n with actual newlines (D1 may store escaped newlines)
      const cleanLyrics = (song.lyrics || '').replace(/\\n/g, '\n');
      lyricsEl.textContent = cleanLyrics;
    }

    // Feedback button — build link with song context
    const reportBtn = document.getElementById('btnReportError');
    if (reportBtn) {
      const params = new URLSearchParams({
        song: song.slug || '',
        title: song.title || '',
        artist: Utils.joinNames(song.artists, song.artist_name || song.artist || ''),
      });
      reportBtn.href = '/report?' + params.toString();
    }

    // Favorite toggle — actual click handling is the shared delegated listener; this
    // just gives it the current song's slug and reflects its saved favorite state.
    const favoriteBtn = document.getElementById('btnFavoriteSong');
    if (favoriteBtn && song.slug) {
      favoriteBtn.dataset.slug = song.slug;
      updateFavoriteButton(favoriteBtn, Favorites.has(song.slug));
    }
    const downloadBtn = document.getElementById('btnDownloadSong');
    if (downloadBtn && song.slug) {
      downloadBtn.dataset.slug = song.slug;
      updateDownloadButton(downloadBtn, Downloads.has(song.slug));
    }
    const pinBtn = document.getElementById('btnPinSong');
    if (pinBtn && song.slug) {
      pinBtn.dataset.slug = song.slug;
      updatePinButton(pinBtn, Pins.has(song.slug));
      pinBtn.hidden = !Favorites.has(song.slug);
    }

    this._currentSong = song;
    this.wireSongActions();
  },

  /** Wire up Copy/Share buttons once; handlers read the current song at click-time. */
  wireSongActions() {
    if (this._actionsWired) return;
    this._actionsWired = true;

    const copyBtn = document.getElementById('btnCopyLyrics');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const song = this._currentSong;
        if (!song) return;
        const lyrics = (song.lyrics || '').replace(/\\n/g, '\n');
        try {
          await navigator.clipboard.writeText(lyrics);
          if (typeof Toast !== 'undefined') Toast.show(I18n.t('song.copy_success'), { type: 'success' });
        } catch {
          if (typeof Toast !== 'undefined') Toast.show(I18n.t('song.copy_error'), { type: 'error' });
        }
      });
    }

    const shareBtn = document.getElementById('btnShareSong');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        const song = this._currentSong;
        if (!song) return;
        const shareData = {
          title: `${song.title} — MaraLyrics`,
          text: `${song.title} — ${Utils.joinNames(song.artists, song.artist_name || song.artist || I18n.t('common.unknown_artist'))} — MaraLyrics`,
          url: window.location.href,
        };
        try {
          if (navigator.share) {
            await navigator.share(shareData);
          } else {
            await navigator.clipboard.writeText(shareData.url);
            if (typeof Toast !== 'undefined') Toast.show(I18n.t('song.share_success'), { type: 'success' });
          }
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          if (typeof Toast !== 'undefined') Toast.show(I18n.t('song.share_error'), { type: 'error' });
        }
      });
    }
  },

  /** Update page title, meta tags, and JSON-LD. */
  updateMeta(song) {
    const artistDisplay = Utils.joinNames(song.artists, song.artist_name || song.artist || I18n.t('common.unknown'));
    const title = `${song.title} Lyrics – Mara Song | MaraLyrics`;
    const desc = `Read the full lyrics of ${song.title}, a Mara song by ${artistDisplay}. Discover Mara music on MaraLyrics.`;
    const url = `https://maralyrics.com/song/${song.slug}`;

    document.title = title;

    const metaDesc = document.getElementById('metaDesc');
    if (metaDesc) metaDesc.content = desc;

    const ogTitle = document.getElementById('ogTitle');
    if (ogTitle) ogTitle.content = title;

    const ogDesc = document.getElementById('ogDesc');
    if (ogDesc) ogDesc.content = desc;

    const ogUrl = document.getElementById('ogUrl');
    if (ogUrl) ogUrl.content = url;

    const twTitle = document.getElementById('twTitle');
    if (twTitle) twTitle.content = title;

    const twDesc = document.getElementById('twDesc');
    if (twDesc) twDesc.content = desc;

    const canonicalUrl = document.getElementById('canonicalUrl');
    if (canonicalUrl) canonicalUrl.href = url;

    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) pageTitle.textContent = title;

    // JSON-LD structured data
    const jsonLd = document.getElementById('jsonLd');
    // The server-rendered page already carries the full graph (incl. breadcrumbs); only fall
    // back to building it here when it didn't (e.g. a direct hit on the static shell).
    if (jsonLd && !jsonLd.textContent.includes('@graph')) {
      jsonLd.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'MusicRecording',
        name: song.title,
        byArtist: {
          '@type': 'MusicGroup',
          name: artistDisplay,
        },
        inLanguage: 'mrh',
        url,
        publisher: {
          '@type': 'Organization',
          name: 'MaraLyrics',
        },
      });
    }
  },

  /** Increment view (with cooldown). */
  async countView(slug) {
    if (!Utils.isOnline()) return;
    if (!Cache.canCountView(slug)) return;

    try {
      await API.incrementView(slug);
      Cache.markViewCounted(slug);
    } catch (err) {
      console.warn('View count failed:', err);
    }
  },

  showError() {
    const skeleton = document.getElementById('songSkeleton');
    const detail = document.getElementById('songDetail');
    const error = document.getElementById('songError');

    if (skeleton) skeleton.style.display = 'none';
    if (detail) detail.style.display = 'none';
    if (error) error.style.display = 'block';
  },
};

// ─── Profile Page Controller (Artist / Composer) ───────────────
const ProfilePage = {
  type: 'artist', // or 'composer'

  async init(type) {
    this.type = type;
    const slug = Utils.getSlugFromUrl();
    if (!slug) {
      this.showError();
      return;
    }
    await this.loadProfile(slug);
  },

  async loadProfile(slug) {
    try {
      let data;
      const cacheKey = `${this.type}_${slug}`;

      if (Utils.isOnline()) {
        data = this.type === 'artist'
          ? await API.getArtist(slug)
          : await API.getComposer(slug);
        Cache.set(cacheKey, data);
      } else {
        data = Cache.get(cacheKey);
        if (!data) {
          this.showError();
          return;
        }
        UI.setOfflineMode(true);
      }

      this.renderProfile(data);
      this.updateMeta(data);
    } catch (err) {
      console.warn(`Failed to load ${this.type}:`, err);
      const cached = Cache.get(`${this.type}_${slug}`);
      if (cached) {
        this.renderProfile(cached);
        this.updateMeta(cached);
        UI.setOfflineMode(true);
      } else {
        this.showError();
      }
    }
  },

  renderProfile(data) {
    const skeleton = document.getElementById('profileSkeleton');
    const detail = document.getElementById('profileDetail');
    const error = document.getElementById('profileError');

    if (skeleton) skeleton.style.display = 'none';
    if (error) error.style.display = 'none';
    if (detail) detail.style.display = 'block';

    // Name
    const nameEl = document.getElementById('profileName');
    if (nameEl) {
      nameEl.textContent = data.name;
      if (data.green) nameEl.insertAdjacentHTML('beforeend', GreenMark.html());
    }

    // Update "Songs by {name}" section title
    const songsTitleEl = document.getElementById('songsSectionTitle');
    if (songsTitleEl && data.name) {
      songsTitleEl.textContent = I18n.t('common.songs_by_name', { name: data.name });
    }

    // Breadcrumb
    const breadcrumbEl = document.getElementById('breadcrumbName');
    if (breadcrumbEl) breadcrumbEl.textContent = data.name;

    // Avatar fallback (initials)
    const avatarEl = document.getElementById('profileAvatar');
    const fallbackEl = document.getElementById('avatarFallback');
    if (data.image_url && avatarEl) {
      avatarEl.innerHTML = `<img src="${Utils.escapeHtml(data.image_url)}" alt="${Utils.escapeHtml(data.name)}" class="profile-page__avatar-img" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" /><span class="profile-page__avatar-fallback" style="display:none;">${Utils.escapeHtml(data.name?.charAt(0) || '?')}</span>`;
    } else if (fallbackEl) {
      fallbackEl.textContent = data.name?.charAt(0) || '?';
    }

    // Recognition badges (month / year / lifetime)
    const badgesEl = document.getElementById('profileBadges');
    if (badgesEl) {
      badgesEl.innerHTML = Badges.list(this.type, data.badges);
      badgesEl.hidden = !(data.badges && data.badges.length);
    }

    // "Is this you? Claim this profile" — only while nobody owns the profile yet
    const claimEl = document.getElementById('profileClaim');
    if (claimEl) {
      claimEl.href = `/my-profile?claim=${this.type}:${encodeURIComponent(data.slug || '')}`;
      claimEl.hidden = data.claimed !== false;
    }

    // Bio
    const bioEl = document.getElementById('profileBio');
    if (bioEl) {
      // `bio_html` is the rich version (sanitized by the server and cleaned again here); `bio` is plain text.
      if (data.bio_html && window.RichText) bioEl.innerHTML = RichText.clean(data.bio_html);
      else bioEl.textContent = data.bio || '';
      bioEl.style.display = data.bio ? 'block' : 'none';
    }

    // Social links
    const socialEl = document.getElementById('profileSocial');
    if (socialEl && data.social_links) {
      try {
        const links = JSON.parse(data.social_links);
        if (Array.isArray(links) && links.length) {
          // The worker already rejects a non-http(s)/mailto link at write time — this
          // filter is defense in depth against old rows saved before that check existed.
          socialEl.innerHTML = links.filter(Utils.isSafeUrl).map(url => {
            const p = Utils.detectSocialPlatform(url);
            return `<a href="${Utils.escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="social-icon" title="${Utils.escapeHtml(p.name)}">${p.icon}</a>`;
          }).join('');
          socialEl.style.display = 'flex';
        } else {
          socialEl.style.display = 'none';
        }
      } catch { socialEl.style.display = 'none'; }
    } else if (socialEl) {
      socialEl.style.display = 'none';
    }

    // Songs
    const songGrid = document.getElementById('profileSongGrid');
    const emptyEl = document.getElementById('profileEmpty');
    const countEl = document.getElementById('songCount');
    const songs = data.songs || [];

    if (countEl) countEl.textContent = `(${songs.length})`;

    if (songs.length === 0) {
      if (songGrid) songGrid.innerHTML = '';
      if (emptyEl) emptyEl.style.display = 'block';
    } else {
      if (emptyEl) emptyEl.style.display = 'none';
      if (songGrid) {
        songGrid.innerHTML = songs.map((s, i) => UI.createSongCard(s, i)).join('');
      }
    }
  },

  updateMeta(data) {
    // Kept byte-identical to the server-side title/description templates in
    // functions/artist/[[catchall]].js and functions/composer/[[catchall]].js — a
    // crawler/social scraper sees the SSR version before this ever runs, so a page
    // whose meta tags change wording once JS loads looks inconsistent to both.
    // Deliberately English/SEO-fixed rather than i18n-driven, same as Song/Article's.
    const songCount = data.songs?.length || 0;
    const countText = songCount === 1 ? '1 song' : `${songCount} songs`;
    const plainBio = (data.bio || '').replace(/\s+/g, ' ');
    const bio = plainBio ? ` ${plainBio}` : '';
    const title = this.type === 'artist'
      ? `${data.name} — Mara Artist Lyrics & Songs | MaraLyrics`
      : `${data.name} — Mara Composer | MaraLyrics`;
    const desc = this.type === 'artist'
      ? `Explore ${countText} by ${data.name} on MaraLyrics.${bio}`.trim().slice(0, 300)
      : `Explore ${countText} composed by ${data.name} on MaraLyrics.${bio}`.trim().slice(0, 300);

    document.title = title;

    const metaDesc = document.getElementById('metaDesc');
    if (metaDesc) metaDesc.content = desc;

    const ogTitle = document.getElementById('ogTitle');
    if (ogTitle) ogTitle.content = title;

    const ogDesc = document.getElementById('ogDesc');
    if (ogDesc) ogDesc.content = desc;

    const ogUrl = document.getElementById('ogUrl');
    if (ogUrl) ogUrl.content = window.location.href;

    const twTitle = document.getElementById('twTitle');
    if (twTitle) twTitle.content = title;

    const twDesc = document.getElementById('twDesc');
    if (twDesc) twDesc.content = desc;

    const canonicalUrl = document.getElementById('canonicalUrl');
    if (canonicalUrl) canonicalUrl.href = window.location.href;

    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) pageTitle.textContent = title;

    const jsonLd = document.getElementById('jsonLd');
    // The server-rendered page already carries the full graph (incl. breadcrumbs); only fall
    // back to building it here when it didn't (e.g. a direct hit on the static shell).
    if (jsonLd && !jsonLd.textContent.includes('@graph')) {
      // Matches the SSR schema's fields exactly (image/sameAs, not description) —
      // see functions/artist|composer/[[catchall]].js's buildArtistSeo/buildComposerSeo.
      let sameAs;
      try {
        const links = JSON.parse(data.social_links || 'null');
        // Same filter as the rendered social-icon links above — a pre-existing row saved
        // before the server-side URL-scheme check (see worker/routes/admin.js) shouldn't
        // surface an unsafe URL here either, even though JSON-LD isn't itself clickable.
        const safe = Array.isArray(links) ? links.filter(Utils.isSafeUrl) : [];
        if (safe.length) sameAs = safe;
      } catch { /* malformed social_links — omit sameAs, same as the SSR side */ }

      jsonLd.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': this.type === 'artist' ? 'MusicGroup' : 'Person',
        name: data.name,
        url: window.location.href,
        ...(data.image_url ? { image: data.image_url } : {}),
        ...(sameAs ? { sameAs } : {}),
      });
    }
  },

  showError() {
    const skeleton = document.getElementById('profileSkeleton');
    const detail = document.getElementById('profileDetail');
    const error = document.getElementById('profileError');

    if (skeleton) skeleton.style.display = 'none';
    if (detail) detail.style.display = 'none';
    if (error) error.style.display = 'block';
  },
};

// ─── Copyright Owner Page Controller ───────────────────────────
const CopyrightOwnerPage = {
  async init() {
    const slug = Utils.getSlugFromUrl();
    if (!slug) {
      this.showError();
      return;
    }
    await this.loadOwner(slug);
  },

  async loadOwner(slug) {
    try {
      let data;
      const cacheKey = `copyright_owner_${slug}`;

      if (Utils.isOnline()) {
        data = await API.getCopyrightOwner(slug);
        Cache.set(cacheKey, data);
      } else {
        data = Cache.get(cacheKey);
        if (!data) { this.showError(); return; }
        UI.setOfflineMode(true);
      }

      this.render(data);
      this.updateMeta(data);
    } catch (err) {
      console.warn('Failed to load copyright owner:', err);
      const cached = Cache.get(`copyright_owner_${slug}`);
      if (cached) {
        this.render(cached);
        this.updateMeta(cached);
        UI.setOfflineMode(true);
      } else {
        this.showError();
      }
    }
  },

  render(data) {
    const skeleton = document.getElementById('profileSkeleton');
    const detail = document.getElementById('profileDetail');
    const error = document.getElementById('profileError');

    if (skeleton) skeleton.style.display = 'none';
    if (error) error.style.display = 'none';
    if (detail) detail.style.display = 'block';

    // Name & breadcrumb
    const nameEl = document.getElementById('profileName');
    if (nameEl) nameEl.textContent = data.owner?.name || data.name || '';

    const breadcrumbEl = document.getElementById('breadcrumbName');
    if (breadcrumbEl) breadcrumbEl.textContent = data.owner?.name || data.name || '';

    const owner = data.owner || data;

    // Avatar fallback (© icon)
    const avatarEl = document.getElementById('profileAvatar');
    if (avatarEl) {
      avatarEl.innerHTML = '<span class="profile-page__avatar-fallback" style="font-size:2rem;">©</span>';
    }

    // Role label
    const roleEl = document.querySelector('.profile-page__role');
    if (roleEl) roleEl.textContent = I18n.t('copyright_owner.role');

    // Hide social links section
    const socialEl = document.getElementById('profileSocial');
    if (socialEl) socialEl.style.display = 'none';

    // Bio area becomes copyright info
    const bioEl = document.getElementById('profileBio');
    if (bioEl) {
      bioEl.style.display = 'none';
    }

    // Copyright details section
    const infoContainer = document.getElementById('copyrightInfoSection');
    if (infoContainer) {
      let html = '';
      const fields = [
        { label: I18n.t('copyright_owner.full_legal_name'), value: owner.full_legal_name },
        { label: I18n.t('copyright_owner.organization'), value: owner.organization },
        { label: I18n.t('copyright_owner.territory'), value: owner.territory },
        { label: I18n.t('copyright_owner.email'), value: owner.email, isEmail: true },
        { label: I18n.t('common.website'), value: owner.website, isUrl: true },
        { label: I18n.t('copyright_owner.address'), value: owner.address },
        { label: I18n.t('copyright_owner.ipi_number'), value: owner.ipi_number },
        { label: I18n.t('copyright_owner.isrc_prefix'), value: owner.isrc_prefix },
        { label: I18n.t('copyright_owner.pro_affiliation'), value: owner.pro_affiliation },
      ];

      const visibleFields = fields.filter(f => f.value);
      if (visibleFields.length) {
        html += '<div class="copyright-info">';
        visibleFields.forEach(f => {
          let val = Utils.escapeHtml(f.value);
          if (f.isEmail) val = `<a href="mailto:${val}" class="meta-link">${val}</a>`;
          if (f.isUrl) {
            const normalized = Utils.normalizeUrl(f.value);
            // Same defense-in-depth as the social links above — render unsafe/malformed
            // values as plain text instead of a clickable link.
            if (Utils.isSafeUrl(normalized)) {
              val = `<a href="${Utils.escapeHtml(normalized)}" target="_blank" rel="noopener noreferrer" class="meta-link">${val}</a>`;
            }
          }
          html += `<div class="copyright-info__row"><span class="copyright-info__label">${f.label}</span><span class="copyright-info__value">${val}</span></div>`;
        });
        if (owner.notes) {
          html += `<div class="copyright-info__row"><span class="copyright-info__label">${I18n.t('copyright_owner.notes')}</span><span class="copyright-info__value">${Utils.escapeHtml(owner.notes)}</span></div>`;
        }
        html += '</div>';
      }
      infoContainer.innerHTML = html;
      infoContainer.style.display = visibleFields.length ? 'block' : 'none';
    }

    // Songs
    const songs = data.songs || [];
    const songGrid = document.getElementById('profileSongGrid');
    const emptyEl = document.getElementById('profileEmpty');
    const countEl = document.getElementById('songCount');
    const songsTitleEl = document.getElementById('songsSectionTitle');

    if (songsTitleEl && owner.name) {
      songsTitleEl.textContent = I18n.t('copyright_owner.songs_claimed_by', { name: owner.name });
    }
    if (countEl) countEl.textContent = `(${songs.length})`;
    if (songs.length === 0) {
      if (songGrid) songGrid.innerHTML = '';
      if (emptyEl) {
        emptyEl.style.display = 'block';
        const emptyText = emptyEl.querySelector('.empty-state__text');
        if (emptyText) emptyText.textContent = I18n.t('copyright_owner.no_songs');
      }
    } else {
      if (emptyEl) emptyEl.style.display = 'none';
      if (songGrid) songGrid.innerHTML = songs.map((s, i) => UI.createSongCard(s, i)).join('');
    }
  },

  updateMeta(data) {
    // Kept byte-identical to functions/copyright-owner/[[catchall]].js's buildOwnerSeo —
    // see the comment on ProfilePage.updateMeta above for why.
    const owner = data.owner || data;
    const songCount = data.songs?.length || 0;
    const countText = songCount === 1 ? '1 song' : `${songCount} songs`;
    const org = owner.organization ? ` (${owner.organization})` : '';
    const title = `${owner.name} — Copyright Owner | MaraLyrics`;
    const desc = `${countText} claimed by ${owner.name}${org} on MaraLyrics.`.trim().slice(0, 300);

    document.title = title;
    const metaDesc = document.getElementById('metaDesc');
    if (metaDesc) metaDesc.content = desc;
    const ogTitle = document.getElementById('ogTitle');
    if (ogTitle) ogTitle.content = title;
    const ogDesc = document.getElementById('ogDesc');
    if (ogDesc) ogDesc.content = desc;
    const ogUrl = document.getElementById('ogUrl');
    if (ogUrl) ogUrl.content = window.location.href;
    const twTitle = document.getElementById('twTitle');
    if (twTitle) twTitle.content = title;
    const twDesc = document.getElementById('twDesc');
    if (twDesc) twDesc.content = desc;
    const canonicalUrl = document.getElementById('canonicalUrl');
    if (canonicalUrl) canonicalUrl.href = window.location.href;
    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) pageTitle.textContent = title;

    const jsonLd = document.getElementById('jsonLd');
    // The server-rendered page already carries the full graph (incl. breadcrumbs); only fall
    // back to building it here when it didn't (e.g. a direct hit on the static shell).
    if (jsonLd && !jsonLd.textContent.includes('@graph')) {
      jsonLd.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: owner.organization || owner.name,
        url: window.location.href,
        ...(owner.website && Utils.isSafeUrl(owner.website) ? { sameAs: [owner.website] } : {}),
      });
    }
  },

  showError() {
    const skeleton = document.getElementById('profileSkeleton');
    const detail = document.getElementById('profileDetail');
    const error = document.getElementById('profileError');

    if (skeleton) skeleton.style.display = 'none';
    if (detail) detail.style.display = 'none';
    if (error) error.style.display = 'block';
  },
};

// ─── My Downloads Page ─────────────────────────────────────────
const DownloadsPage = {
  async init() {
    this.grid = document.getElementById('downloadsGrid');
    this.empty = document.getElementById('downloadsEmpty');
    this.summary = document.getElementById('downloadsSummary');
    this.clearBtn = document.getElementById('downloadsClearBtn');
    this.sortSelect = document.getElementById('downloadsSort');
    if (!this.grid) return;
    this.sort = (() => { try { return localStorage.getItem('maralyrics.downloads_sort') || 'recent'; } catch { return 'recent'; } })();
    if (this.sortSelect) {
      this.sortSelect.value = this.sort;
      this.sortSelect.addEventListener('change', () => {
        this.sort = this.sortSelect.value;
        try { localStorage.setItem('maralyrics.downloads_sort', this.sort); } catch { /* ignore */ }
        this.render();
      });
    }
    if (this.clearBtn) {
      this.clearBtn.addEventListener('click', async () => {
        if (!Downloads.count || !window.confirm(I18n.t('downloads.confirm_clear'))) return;
        try { await Downloads.clear(); } catch { /* ignore */ }
      });
    }
    document.addEventListener('downloads-changed', () => this.render());
    await Downloads.init();
    await this.render();
  },

  async render() {
    let songs = [];
    try { songs = await Downloads.getAll(); } catch { /* ignore */ }
    if (this.sort === 'name') songs.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));
    else if (this.sort === 'views') songs.sort((a, b) => (b.views || 0) - (a.views || 0));
    // 'recent' is already newest download first

    const has = songs.length > 0;
    this.grid.style.display = has ? '' : 'none';
    if (this.empty) this.empty.style.display = has ? 'none' : 'block';
    if (this.clearBtn) this.clearBtn.style.display = has ? '' : 'none';
    if (this.sortSelect) this.sortSelect.style.display = has ? '' : 'none';
    if (this.summary) this.summary.textContent = has ? I18n.t('downloads.summary', { count: songs.length }) : '';
    this.grid.innerHTML = songs.map((song, i) => UI.createSongCard(song, i)).join('');
  },
};

// ─── Articles List Page Controller (/articles) ─────────────────
const ArticlesPage = {
  currentPage: 1,

  async init() {
    await this.loadArticles(1);
  },

  async loadArticles(page) {
    const loading = document.getElementById('articlesLoading');
    const listSection = document.getElementById('articlesListSection');
    const empty = document.getElementById('articlesEmpty');
    const skeletonGrid = document.getElementById('articleSkeletonGrid');
    const grid = document.getElementById('articleGrid');
    if (!loading || !listSection || !grid) return;

    if (skeletonGrid) skeletonGrid.innerHTML = UI.createArticleSkeletons(6);

    try {
      const data = await API.getArticles(page);
      this.currentPage = data.page || 1;
      const articles = data.articles || [];

      loading.style.display = 'none';

      if (!articles.length) {
        listSection.style.display = 'none';
        if (empty) empty.style.display = 'block';
        return;
      }

      if (empty) empty.style.display = 'none';
      listSection.style.display = 'block';
      grid.innerHTML = articles.map((a, i) => UI.createArticleCard(a, i)).join('');
      this.renderPagination(data.page, data.totalPages);
    } catch (err) {
      console.warn('Failed to load articles:', err);
      loading.style.display = 'none';
      listSection.style.display = 'none';
      if (empty) {
        empty.style.display = 'block';
        const title = empty.querySelector('.empty-state__title');
        const text = empty.querySelector('.empty-state__text');
        if (title) title.textContent = I18n.t('articles.error_title');
        if (text) text.textContent = I18n.t('articles.error_text');
      }
    }
  },

  renderPagination(page, totalPages) {
    const el = document.getElementById('articlesPagination');
    if (!el) return;
    if (!totalPages || totalPages <= 1) { el.innerHTML = ''; return; }

    el.innerHTML = UI.createPagination(page, totalPages);
    el.querySelectorAll('[data-page]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = Number(btn.dataset.page);
        if (target) {
          this.loadArticles(target);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    });
  },
};


// ─── Dropdown ──────────────────────────────────────────────────
// Styled, accessible replacement for a native <select> (whose option popup can't be
// themed). The <select> stays the source of truth and keeps firing 'change', so
// existing code keeps working; call .sync() after setting select.value in code.
const Dropdown = {
  enhance(select) {
    if (!select || select.dataset.enhanced) return null;
    select.dataset.enhanced = '1';
    const id = `dd-${Math.random().toString(36).slice(2, 8)}`;
    const wrap = document.createElement('div');
    wrap.className = 'dropdown';
    wrap.innerHTML = `
      <button type="button" class="dropdown__btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}">
        <svg class="dropdown__lead" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M6 12h12M10 18h4"/></svg>
        <span class="dropdown__label"></span>
        <svg class="dropdown__chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <ul class="dropdown__menu" id="${id}" role="listbox" tabindex="-1"></ul>`;
    select.classList.add('dropdown__native');
    select.setAttribute('tabindex', '-1');
    select.setAttribute('aria-hidden', 'true');
    select.after(wrap);
    const btn = wrap.querySelector('.dropdown__btn');
    const menu = wrap.querySelector('.dropdown__menu');
    const label = wrap.querySelector('.dropdown__label');
    const aria = select.getAttribute('aria-label');
    if (aria) { btn.setAttribute('aria-label', aria); menu.setAttribute('aria-label', aria); }
    let active = -1;

    const items = () => [...menu.querySelectorAll('.dropdown__item')];
    const build = () => {
      menu.innerHTML = [...select.options].map((o, i) => `
        <li class="dropdown__item" role="option" id="${id}-${i}" data-value="${Utils.escapeHtml(o.value)}" aria-selected="${o.selected}">
          <span class="dropdown__text">${Utils.escapeHtml(o.textContent)}</span>
          <svg class="dropdown__check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
        </li>`).join('');
      label.textContent = select.selectedOptions[0]?.textContent || '';
    };
    const setActive = (i) => {
      const list = items();
      if (!list.length) return;
      active = (i + list.length) % list.length;
      list.forEach((el, n) => el.classList.toggle('is-active', n === active));
      btn.setAttribute('aria-activedescendant', list[active].id);
      list[active].scrollIntoView({ block: 'nearest' });
    };
    const open = () => {
      wrap.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      setActive(select.selectedIndex);
    };
    const close = (refocus) => {
      wrap.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-activedescendant');
      if (refocus) btn.focus();
    };
    const choose = (i) => {
      if (select.selectedIndex !== i) {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      build();
      close(true);
    };

    btn.addEventListener('click', () => (wrap.classList.contains('is-open') ? close() : open()));
    menu.addEventListener('click', (e) => {
      const li = e.target.closest('.dropdown__item');
      if (li) choose(items().indexOf(li));
    });
    menu.addEventListener('mousemove', (e) => {
      const li = e.target.closest('.dropdown__item');
      if (li) setActive(items().indexOf(li));
    });
    btn.addEventListener('keydown', (e) => {
      const isOpen = wrap.classList.contains('is-open');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) open(); else setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Home' || e.key === 'End') {
        if (isOpen) { e.preventDefault(); setActive(e.key === 'Home' ? 0 : -1); }
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (isOpen) { e.preventDefault(); choose(active); }
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        if (isOpen) close(e.key === 'Escape');
      }
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });

    build();
    return { sync: build };
  },
};

// ─── Badges (artist / composer recognition: month, year, lifetime) ───
// Awarded by a Super Admin; the API sends them already ordered most-prestigious first.
// Chip text uses data-i18n so it follows a language switch; a custom title is shown verbatim.
const Badges = {
  ICONS: { lifetime: '👑', year: '🏆', month: '🏅' },
  RANK: { lifetime: 0, year: 1, month: 2 },

  sort(list) {
    return [...list].sort((a, b) => this.RANK[a.period] - this.RANK[b.period] || String(b.period_value).localeCompare(String(a.period_value)));
  },

  /** Higher = more recognised; used for the directory's "Most badges" sort. */
  score(list) {
    return (list || []).reduce((sum, b) => sum + (b.period === 'lifetime' ? 100 : b.period === 'year' ? 10 : 1), 0);
  },

  when(b) {
    if (b.period === 'lifetime') return '';
    if (b.period === 'year') return b.period_value;
    const [y, m] = String(b.period_value).split('-').map(Number);
    return new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleDateString(Utils.locale(), { month: 'short', year: 'numeric', timeZone: 'UTC' });
  },

  key(role, b) {
    return b.period === 'lifetime' ? 'badges.lifetime' : `badges.${role}_${b.period}`;
  },

  /** Plain-text label (tooltips, aria). */
  text(role, b) {
    const base = b.title || I18n.t(this.key(role, b));
    const when = this.when(b);
    return when ? `${base} · ${when}` : base;
  },

  chip(role, b) {
    const when = this.when(b);
    const label = b.title
      ? `<span>${Utils.escapeHtml(b.title)}</span>`
      : `<span data-i18n="${this.key(role, b)}">${Utils.escapeHtml(I18n.t(this.key(role, b)))}</span>`;
    return `<span class="badge-chip badge-chip--${b.period}" title="${Utils.escapeHtml(this.text(role, b))}"><span class="badge-chip__icon" aria-hidden="true">${this.ICONS[b.period] || '🏅'}</span>${label}${when ? `<span class="badge-chip__when"> · ${Utils.escapeHtml(when)}</span>` : ''}</span>`;
  },

  /** Icon-only chip (tooltip + aria-label carry the full text) for tight spaces. */
  iconChip(role, b) {
    const text = Utils.escapeHtml(this.text(role, b));
    return `<span class="badge-chip badge-chip--${b.period} badge-chip--icon" title="${text}" aria-label="${text}" role="img">${this.ICONS[b.period] || '🏅'}</span>`;
  },

  /** Row of chips. `compact` (directory cards): the top badge in full, the rest as icons. */
  list(role, badges, { compact = false } = {}) {
    if (!Array.isArray(badges) || !badges.length) return '';
    if (!compact) return badges.map((b) => this.chip(b.role || role, b)).join('');
    const [top, ...rest] = badges;
    const icons = rest.slice(0, 4).map((b) => this.iconChip(b.role || role, b)).join('');
    const more = rest.length - 4;
    return this.chip(top.role || role, top) + icons + (more > 0 ? `<span class="badge-chip badge-chip--more">${Utils.escapeHtml(I18n.t('badges.more', { count: more }))}</span>` : '');
  },
};

// ─── People (Artists & Composers) ──────────────────────────────
// Shared by the home-page spotlight and the /artists-composers directory.
// ─── Green mark (a paid, hand-approved tick next to a name — like a verified mark) ──
const GreenMark = {
  html() {
    const label = Utils.escapeHtml(I18n.t('green.mark'));
    return `<span class="green-mark" role="img" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="currentColor"/><path d="M7 12.6l3.3 3.3L17.2 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  },
};

const People = {
  /** Fetch artists + composers and merge into one list. Someone credited as both
   *  (same name) becomes one entry linking to their artist page. */
  async loadAll() {
    const cacheKey = 'people_all';
    let list = null;
    try {
      const [a, c] = await Promise.all([API.fetchJSON('/artists'), API.fetchJSON('/composers')]);
      await this.fillSongCounts(a.artists || [], c.composers || []);
      const map = new Map();
      const tagBadges = (list, role) => (Array.isArray(list) ? list : []).map((b) => ({ ...b, role }));
      const add = (p, role) => {
        const key = (p.name || '').trim().toLowerCase();
        if (!key) return;
        const existing = map.get(key);
        if (existing) {
          existing.roles.push(role);
          existing.image_url = existing.image_url || p.image_url;
          existing.green = existing.green || !!p.green;
          existing.badges = Badges.sort([...existing.badges, ...tagBadges(p.badges, role)]);
          // A song can credit the same person as artist and composer, so the two
          // counts overlap; the larger one is the best lower bound we have.
          existing.song_count = existing.song_count == null ? p.song_count ?? null : Math.max(existing.song_count, p.song_count ?? 0);
          return;
        }
        map.set(key, {
          name: p.name.trim(), slug: p.slug, roles: [role], role_slug: role,
          image_url: p.image_url || '', bio: p.bio || '', badges: tagBadges(p.badges, role), green: !!p.green,
          song_count: p.song_count ?? null, created_at: p.created_at || '',
        });
      };
      (a.artists || []).forEach((p) => add(p, 'artist'));
      (c.composers || []).forEach((p) => add(p, 'composer'));
      list = [...map.values()].map((p) => ({ ...p, href: `/${p.role_slug}/${encodeURIComponent(p.slug)}` }));
      Cache.set(cacheKey, list);
    } catch (err) {
      list = Cache.get(cacheKey);
      if (!list) throw err;
    }
    return list;
  },

  /** Older API deployments don't send song_count on /artists and /composers. In that
   *  case tally it from the published songs list (each song carries its credited
   *  artists/composers), so counts show up either way. */
  async fillSongCounts(artists, composers) {
    const missing = [...artists, ...composers].some((p) => p.song_count == null);
    if (!missing) return;
    const tally = { artists: new Map(), composers: new Map() };
    try {
      for (let page = 1, pages = 1; page <= pages && page <= 50; page++) {
        const data = await API.fetchJSON(`/songs?page=${page}&limit=100`);
        pages = data.totalPages || 1;
        for (const song of data.songs || []) {
          for (const kind of ['artists', 'composers']) {
            for (const p of song[kind] || []) {
              if (p && p.slug) tally[kind].set(p.slug, (tally[kind].get(p.slug) || 0) + 1);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Could not tally song counts:', err);
      return; // leave song_count unset — the UI then shows no count rather than a wrong one
    }
    artists.forEach((p) => { if (p.song_count == null) p.song_count = tally.artists.get(p.slug) || 0; });
    composers.forEach((p) => { if (p.song_count == null) p.song_count = tally.composers.get(p.slug) || 0; });
  },

  roleLabel(p) {
    if (p.roles.length > 1) return I18n.t('people.role_both');
    return I18n.t(p.roles[0] === 'artist' ? 'people.role_artist' : 'people.role_composer');
  },

  songsLabel(n) {
    if (n == null) return ''; // API without song_count (older worker) — show nothing rather than a false 0
    return I18n.t(n === 1 ? 'people.songs_one' : 'people.songs_other', { count: n });
  },

  avatar(p, cls = '') {
    const initial = Utils.escapeHtml((p.name || '?').charAt(0));
    const img = p.image_url
      ? `<img src="${Utils.escapeHtml(p.image_url)}" alt="" loading="lazy" onerror="this.remove()" />`
      : '';
    return `<span class="person-avatar ${cls}"><span class="person-avatar__initial">${initial}</span>${img}</span>`;
  },

  card(p) {
    return `
      <a href="${Utils.escapeHtml(p.href)}" class="person-card">
        ${this.avatar(p)}
        <span class="person-card__body">
          <span class="person-card__name">${Utils.escapeHtml(p.name)}${p.green ? GreenMark.html() : ''}</span>
          <span class="person-card__role">${Utils.escapeHtml(this.roleLabel(p))}</span>
          <span class="person-card__songs">${Utils.escapeHtml(this.songsLabel(p.song_count))}</span>
          ${p.badges && p.badges.length ? `<span class="person-card__badges" aria-label="${Utils.escapeHtml(I18n.t('badges.aria'))}">${Badges.list(p.role_slug, p.badges, { compact: true })}</span>` : ''}
        </span>
      </a>`;
  },
};

// ─── Featured People spotlight (home page) ─────────────────────
// Shows 7 random artists/composers; re-rolls every 5 minutes. The pick is kept in
// localStorage so a page refresh inside the window doesn't reshuffle.
const FeaturedPeople = {
  COUNT: 7,
  INTERVAL: 5 * 60 * 1000,
  STORE_KEY: 'maralyrics_featured_people',
  all: [],

  async init() {
    const section = document.getElementById('featuredPeopleSection');
    const row = document.getElementById('featuredPeopleRow');
    if (!section || !row) return;
    try {
      this.all = await People.loadAll();
    } catch (err) {
      console.warn('Failed to load featured people:', err);
      return;
    }
    if (!this.all.length) return;
    this.row = row;
    this.section = section;
    const saved = this.readSaved();
    const fresh = saved && Date.now() - saved.ts < this.INTERVAL;
    this.render(fresh ? saved.hrefs : this.pick(), false);
    section.style.display = 'block';
    // Wait out the rest of the current window, then roll every 5 minutes.
    const wait = fresh ? this.INTERVAL - (Date.now() - saved.ts) : this.INTERVAL;
    setTimeout(() => {
      this.rotate();
      setInterval(() => this.rotate(), this.INTERVAL);
    }, wait);
  },

  readSaved() {
    try {
      const v = JSON.parse(localStorage.getItem(this.STORE_KEY));
      return v && Array.isArray(v.hrefs) ? v : null;
    } catch { return null; }
  },

  pick() {
    // Prefer people with a photo; top up with the rest when there are too few.
    const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const withPhoto = shuffle(this.all.filter((p) => p.image_url));
    const rest = shuffle(this.all.filter((p) => !p.image_url));
    const chosen = withPhoto.concat(rest).slice(0, this.COUNT);
    const hrefs = shuffle(chosen).map((p) => p.href);
    try { localStorage.setItem(this.STORE_KEY, JSON.stringify({ ts: Date.now(), hrefs })); } catch { /* storage unavailable */ }
    return hrefs;
  },

  render(hrefs, animate) {
    const byHref = new Map(this.all.map((p) => [p.href, p]));
    const people = hrefs.map((h) => byHref.get(h)).filter(Boolean);
    const html = people.map((p) => `
      <a href="${Utils.escapeHtml(p.href)}" class="featured-person" title="${Utils.escapeHtml(p.name)}">
        ${People.avatar(p, 'person-avatar--lg')}
        <span class="featured-person__name">${Utils.escapeHtml(p.name)}</span>
        ${p.badges && p.badges.length ? `<span class="featured-person__badges" title="${Utils.escapeHtml(p.badges.map((b) => Badges.text(b.role || p.role_slug, b)).join(', '))}" aria-label="${Utils.escapeHtml(I18n.t('badges.aria'))}">${[...new Set(p.badges.map((b) => b.period))].map((per) => Badges.ICONS[per]).join(' ')}</span>` : ''}
      </a>`).join('');
    if (!animate) { this.row.innerHTML = html; return; }
    this.row.classList.add('is-swapping');
    setTimeout(() => { this.row.innerHTML = html; this.row.classList.remove('is-swapping'); }, 300);
  },

  rotate() {
    if (!document.hidden) { this.render(this.pick(), true); return; }
    // Tab in background: re-roll as soon as it's visible again instead of churning DOM.
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVisible);
      this.render(this.pick(), true);
    };
    document.addEventListener('visibilitychange', onVisible);
  },
};

// ─── Artists & Composers directory (/artists-composers) ────────
const PeoplePage = {
  PAGE_SIZE: 48,
  state: { q: '', sort: 'name_asc', role: 'all', view: 'card', shown: 48 },
  all: [],

  SORTS: {
    name_asc: (a, b) => a.name.localeCompare(b.name),
    name_desc: (a, b) => b.name.localeCompare(a.name),
    songs_desc: (a, b) => (b.song_count ?? 0) - (a.song_count ?? 0) || a.name.localeCompare(b.name),
    songs_asc: (a, b) => (a.song_count ?? 0) - (b.song_count ?? 0) || a.name.localeCompare(b.name),
    badges_desc: (a, b) => Badges.score(b.badges) - Badges.score(a.badges) || a.name.localeCompare(b.name),
    added_desc: (a, b) => (b.created_at || '').localeCompare(a.created_at || '') || a.name.localeCompare(b.name),
    added_asc: (a, b) => (a.created_at || '').localeCompare(b.created_at || '') || a.name.localeCompare(b.name),
  },

  $(id) { return document.getElementById(id); },

  async init() {
    const params = new URLSearchParams(location.search);
    if (this.SORTS[params.get('sort')]) this.state.sort = params.get('sort');
    if (['artist', 'composer'].includes(params.get('role'))) this.state.role = params.get('role');
    this.state.q = (params.get('q') || '').slice(0, 100);
    try { this.state.view = localStorage.getItem('maralyrics_people_view') === 'list' ? 'list' : 'card'; } catch { /* ignore */ }

    this.$('peopleSkeleton').innerHTML = Array(8).fill('<div class="skeleton person-skeleton"></div>').join('');
    this.sortDropdown = Dropdown.enhance(this.$('peopleSort'));
    this.bind();
    this.syncControls();

    try {
      this.all = await People.loadAll();
    } catch (err) {
      console.warn('Failed to load people:', err);
      this.$('peopleLoading').style.display = 'none';
      this.showEmpty(I18n.t('people.error_title'), I18n.t('people.error_text'), false);
      return;
    }
    this.$('peopleLoading').style.display = 'none';
    this.renderStats();
    this.render();
  },

  bind() {
    const search = this.$('peopleSearch');
    const onSearch = Utils.debounce(() => {
      this.state.q = search.value.trim();
      this.state.shown = this.PAGE_SIZE;
      this.render();
    }, 200);
    search.addEventListener('input', () => { this.$('peopleSearchClear').style.display = search.value ? 'block' : 'none'; onSearch(); });
    this.$('peopleSearchClear').addEventListener('click', () => { search.value = ''; this.$('peopleSearchClear').style.display = 'none'; this.state.q = ''; this.state.shown = this.PAGE_SIZE; this.render(); search.focus(); });
    this.$('peopleSort').addEventListener('change', (e) => { this.state.sort = e.target.value; this.state.shown = this.PAGE_SIZE; this.render(); });
    this.$('peopleRoleTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-role]');
      if (!btn) return;
      this.state.role = btn.dataset.role; this.state.shown = this.PAGE_SIZE; this.syncControls(); this.render();
    });
    document.querySelectorAll('.view-toggle__btn').forEach((btn) => btn.addEventListener('click', () => {
      this.state.view = btn.dataset.view;
      try { localStorage.setItem('maralyrics_people_view', this.state.view); } catch { /* ignore */ }
      this.syncControls(); this.render();
    }));
    this.$('peopleMore').addEventListener('click', () => { this.state.shown += this.PAGE_SIZE; this.render(); });
    this.$('peopleReset').addEventListener('click', () => {
      this.state = { ...this.state, q: '', role: 'all', sort: 'name_asc', shown: this.PAGE_SIZE };
      this.syncControls(); this.render();
    });
    this.$('peopleAlpha').addEventListener('click', (e) => {
      const a = e.target.closest('[data-letter]');
      if (!a) return;
      e.preventDefault();
      // Make sure the target letter is rendered before scrolling to it.
      const idx = this.filtered.findIndex((p) => this.letterOf(p) === a.dataset.letter);
      if (idx >= this.state.shown) { this.state.shown = idx + this.PAGE_SIZE; this.render(); }
      const target = document.querySelector(`.person-card[data-letter="${CSS.escape(a.dataset.letter)}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  },

  syncControls() {
    this.$('peopleSearch').value = this.state.q;
    this.$('peopleSearchClear').style.display = this.state.q ? 'block' : 'none';
    this.$('peopleSort').value = this.state.sort;
    if (this.sortDropdown) this.sortDropdown.sync();
    document.querySelectorAll('#peopleRoleTabs [data-role]').forEach((b) => {
      const on = b.dataset.role === this.state.role;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.view-toggle__btn').forEach((b) => {
      const on = b.dataset.view === this.state.view;
      b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
    });
  },

  letterOf(p) {
    const c = (p.name || '#').charAt(0).toUpperCase();
    return /\p{L}/u.test(c) ? c : '#';
  },

  renderStats() {
    const el = this.$('peopleStats');
    const total = this.all.length;
    const artists = this.all.filter((p) => p.roles.includes('artist')).length;
    const composers = this.all.filter((p) => p.roles.includes('composer')).length;
    el.textContent = I18n.t('people.stats', { total, artists, composers });
    el.hidden = !total;
  },

  showEmpty(title, text, canReset = true) {
    this.$('peopleListSection').style.display = 'none';
    this.$('peopleEmpty').style.display = 'block';
    this.$('peopleEmptyTitle').textContent = title;
    this.$('peopleEmptyText').textContent = text;
    this.$('peopleReset').style.display = canReset ? '' : 'none';
  },

  render() {
    const { q, sort, role, view, shown } = this.state;
    const needle = q.toLowerCase();
    this.filtered = this.all
      .filter((p) => role === 'all' || p.roles.includes(role))
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.bio.toLowerCase().includes(needle))
      .sort(this.SORTS[sort]);

    // Keep the URL shareable without adding history entries per keystroke.
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (sort !== 'name_asc') params.set('sort', sort);
    if (role !== 'all') params.set('role', role);
    history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''));

    this.$('peopleCount').textContent = I18n.t('people.count', { count: this.filtered.length });
    if (!this.filtered.length) {
      this.$('peopleAlpha').innerHTML = '';
      this.showEmpty(I18n.t('people.empty_title'), I18n.t('people.empty_text'));
      return;
    }
    this.$('peopleEmpty').style.display = 'none';
    this.$('peopleListSection').style.display = 'block';

    const grid = this.$('peopleGrid');
    grid.classList.toggle('people-grid--list', view === 'list');
    grid.innerHTML = this.filtered.slice(0, shown)
      .map((p) => People.card(p).replace('class="person-card"', `class="person-card" data-letter="${Utils.escapeHtml(this.letterOf(p))}"`))
      .join('');
    this.$('peopleMore').hidden = this.filtered.length <= shown;

    // A–Z jump bar only makes sense when sorted by name.
    const byName = sort === 'name_asc';
    const letters = byName ? [...new Set(this.filtered.map((p) => this.letterOf(p)))] : [];
    this.$('peopleAlpha').innerHTML = letters.map((l) => `<a href="#" data-letter="${Utils.escapeHtml(l)}">${Utils.escapeHtml(l)}</a>`).join('');
  },
};

// ─── Mara Idol ─────────────────────────────────────────────────
// Seasons (editions) and their contestants, edited in the admin dashboard. Pages:
//   /mara-idol                 index: seasons + every idol (searchable, filterable)
//   /mara-idol/:season         one season with its contestants
//   /mara-idol/:season/:idol   one idol: photo, result, bio, videos, linked artist
const Idol = {
  RESULTS: ['winner', 'runner_up', 'second_runner_up', 'finalist', 'semi_finalist', 'contestant'],
  ICONS: { winner: '🏆', runner_up: '🥈', second_runner_up: '🥉', finalist: '⭐', semi_finalist: '🎤', contestant: '' },
  // Wording used in <title>/<meta description>. Deliberately English and identical to
  // functions/_shared/seo.js so crawlers and browsers see the same text.
  RESULT_SEO: { winner: 'winner', runner_up: 'runner-up', second_runner_up: 'second runner-up', finalist: 'finalist', semi_finalist: 'semi-finalist', contestant: 'contestant' },

  /** [season-slug, idol-slug] from the URL path. */
  pathParts() {
    return location.pathname.split('/').filter(Boolean).slice(1).map((p) => {
      try { return decodeURIComponent(p); } catch { return p; }
    });
  },

  esc: (v) => Utils.escapeHtml(v),

  /** Result chip. A plain "contestant" gets no chip unless `all` is set. */
  resultChip(result, placement, { all = false } = {}) {
    if (result === 'contestant' && !all) return '';
    const key = `idol.result_${result}`;
    const icon = this.ICONS[result] ? `<span class="idol-chip__icon" aria-hidden="true">${this.ICONS[result]}</span>` : '';
    return `<span class="idol-chip idol-chip--${this.esc(result)}">${icon}<span data-i18n="${key}">${this.esc(I18n.t(key))}</span>${placement ? `<span class="idol-chip__place"> · #${Number(placement)}</span>` : ''}</span>`;
  },

  /** Photo avatar with an initial underneath (the photo sits on top; a broken image just disappears). */
  avatar(photo, name, cls = '') {
    const initial = this.esc((name || '?').charAt(0));
    const img = photo ? `<img src="${this.esc(photo)}" alt="" loading="lazy" onerror="this.remove()" />` : '';
    return `<span class="person-avatar ${cls}"><span class="person-avatar__initial">${initial}</span>${img}</span>`;
  },

  /** "12 Dec 2024 – 14 Dec 2024" / "12 Dec 2024" / '' — in the visitor's language. */
  dateRange(season) {
    const fmt = (iso) => {
      const [y, m, d] = String(iso).split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(Utils.locale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    };
    if (!season.start_date) return '';
    return season.end_date && season.end_date !== season.start_date ? `${fmt(season.start_date)} – ${fmt(season.end_date)}` : fmt(season.start_date);
  },

  seasonMeta(season) {
    return [this.dateRange(season), season.venue].filter(Boolean).join(' · ');
  },

  youtubeId(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
      let id = '';
      if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
      else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        id = u.searchParams.get('v') || (u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/) || [])[1] || '';
      }
      return /^[\w-]{11}$/.test(id) ? id : '';
    } catch { return ''; }
  },

  /** Start time in seconds from a "copy video URL at current time" link: `?t=95`, `&t=95s`, `?t=1h2m3s`,
   *  `?start=95`, `?time_continue=95` or `#t=95`. 0 when there is none. */
  youtubeStart(url) {
    try {
      const u = new URL(url);
      const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
      const raw = ['t', 'start', 'time_continue'].map((k) => u.searchParams.get(k) || hash.get(k)).find(Boolean) || '';
      if (/^\d+$/.test(raw)) return Math.min(Number(raw), 86400);
      const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(raw);
      if (!m || !raw) return 0;
      return Math.min(Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0), 86400);
    } catch { return 0; }
  },

  /** Thumbnail for a video: the one an admin uploaded, else the video platform's own (YouTube). Other
   *  platforms have no automatic thumbnail. `hqdefault` is 4:3 with black bars; `object-fit: cover` in the
   *  16:9 box crops the bars away. */
  videoThumb(v, id) {
    return v.thumb || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '');
  },

  /** Videos: YouTube links become click-to-play (the player itself is only requested when the visitor
   *  clicks); any other link is a plain external link. Always keeps the original link. */
  videosHtml(videos) {
    return (videos || []).map((v) => {
      const id = this.youtubeId(v.url);
      const start = id ? this.youtubeStart(v.url) : 0;
      const title = v.title || I18n.t('idol.watch_video');
      const thumb = this.videoThumb(v, id);
      const img = thumb
        ? `<img class="idol-video__thumb" src="${this.esc(thumb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.closest('.idol-video__play').classList.remove('idol-video__play--thumb');this.remove()" />`
        : '';
      const face = `${img}<span class="idol-video__icon" aria-hidden="true">▶</span><span class="idol-video__title">${this.esc(title)}</span>`;
      const cls = `idol-video__play${thumb ? ' idol-video__play--thumb' : ''}`;
      const link = `<a class="idol-video__link" href="${this.esc(v.url)}" target="_blank" rel="noopener noreferrer">${this.esc(I18n.t('idol.open_link'))} ↗</a>`;
      if (!id) {
        // Non-YouTube: a card that opens the link (with the uploaded thumbnail, if any).
        if (!thumb) return `<div class="idol-video idol-video--external"><span class="idol-video__title">${this.esc(title)}</span>${link}</div>`;
        return `<div class="idol-video"><a class="${cls} idol-video__play--link" href="${this.esc(v.url)}" target="_blank" rel="noopener noreferrer" aria-label="${this.esc(I18n.t('idol.open_link'))}: ${this.esc(title)}">${face}</a></div>`;
      }
      return `<div class="idol-video"><button type="button" class="${cls}" data-yt="${id}"${start ? ` data-start="${start}"` : ''} data-title="${this.esc(title)}" aria-label="${this.esc(I18n.t('idol.play'))}: ${this.esc(title)}">${face}</button>${link}</div>`;
    }).join('');
  },

  /** Click-to-load player (privacy-friendly youtube-nocookie embed). */
  bindVideos(container) {
    if (!container || container.dataset.bound) return;
    container.dataset.bound = '1';
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('button.idol-video__play');
      if (!btn) return;
      const frame = document.createElement('iframe');
      const start = Number(btn.dataset.start) > 0 ? `&start=${Number(btn.dataset.start)}` : '';
      frame.src = `https://www.youtube-nocookie.com/embed/${btn.dataset.yt}?autoplay=1&rel=0${start}`;
      frame.title = btn.dataset.title || '';
      frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.className = 'idol-video__frame';
      // The title goes away while the video is being watched and comes back as a caption over the player's
      // top edge once the visitor moves on (clicks elsewhere or starts another video). The video keeps playing.
      const stage = document.createElement('div');
      stage.className = 'idol-video__stage';
      const caption = document.createElement('span');
      caption.className = 'idol-video__caption';
      caption.setAttribute('aria-hidden', 'true');
      caption.textContent = btn.dataset.title || '';
      stage.append(frame, caption);
      btn.replaceWith(stage);
      this.activateStage(stage);
    });
    this.bindVideoFocus();
  },

  /** Marks one player as the active one (caption hidden); every other player shows its caption again. */
  activateStage(stage) {
    document.querySelectorAll('.idol-video__stage').forEach((s) => s.classList.toggle('is-active', s === stage));
  },

  /** Page-wide: a click outside any player, or focus moving into another player's iframe, decides which one is active. */
  bindVideoFocus() {
    if (this._videoFocusBound) return;
    this._videoFocusBound = true;
    // Clicking somewhere else on the page → no player is active → captions come back.
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.idol-video__stage, button.idol-video__play')) this.activateStage(null);
    }, true);
    // A click inside the YouTube iframe never reaches this page, but it moves focus into the iframe, which fires
    // `blur` on the window (deferred one tick so document.activeElement is up to date).
    window.addEventListener('blur', () => setTimeout(() => {
      const frame = document.activeElement;
      if (frame && frame.classList && frame.classList.contains('idol-video__frame')) this.activateStage(frame.parentNode);
    }, 0));
  },

  /** Card for one idol (index "All Idols" tab and season pages). */
  card(i, { showSeason = false } = {}) {
    const href = `/mara-idol/${encodeURIComponent(i.season_slug)}/${encodeURIComponent(i.slug)}`;
    return `
      <a href="${href}" class="person-card idol-card">
        ${this.avatar(i.photo_url, i.name)}
        <span class="person-card__body">
          <span class="person-card__name">${this.esc(i.name)}</span>
          ${this.resultChip(i.result, i.placement)}
          ${showSeason ? `<span class="person-card__songs">${this.esc(i.season_title)}</span>` : ''}
        </span>
      </a>`;
  },

  seasonCard(s) {
    const winners = (s.winners || []).map((w) => this.esc(w.name)).join(', ');
    const cover = s.cover_url
      ? `<img src="${this.esc(s.cover_url)}" alt="" loading="lazy" onerror="this.remove()" />`
      : '';
    const photo = s.photo_url
      ? `<span class="idol-season-card__photo"><img src="${this.esc(s.photo_url)}" alt="" loading="lazy" onerror="this.parentNode.remove()" /></span>`
      : '';
    return `
      <a href="/mara-idol/${encodeURIComponent(s.slug)}" class="idol-season-card">
        <span class="idol-season-card__cover"><span class="idol-season-card__fallback" aria-hidden="true">🎤</span>${cover}<span class="idol-season-card__year">${Number(s.year)}</span>${photo}</span>
        <span class="idol-season-card__body">
          <h2 class="idol-season-card__title">${this.esc(s.title)}</h2>
          ${this.seasonMeta(s) ? `<span class="idol-season-card__meta">${this.esc(this.seasonMeta(s))}</span>` : ''}
          ${winners ? `<span class="idol-season-card__winner">🏆 <span data-i18n="idol.result_winner">${this.esc(I18n.t('idol.result_winner'))}</span>: ${winners}</span>` : ''}
          <span class="idol-season-card__count">${this.esc(I18n.t(s.contestant_count === 1 ? 'idol.count_one' : 'idol.count_other', { count: s.contestant_count }))}</span>
        </span>
      </a>`;
  },
};

// ─── /mara-idol ────────────────────────────────────────────────
const IdolIndexPage = {
  state: { tab: 'seasons', q: '', season: '', result: '' },
  data: { seasons: [], idols: [] },

  $(id) { return document.getElementById(id); },

  async init() {
    const params = new URLSearchParams(location.search);
    if (params.get('tab') === 'idols') this.state.tab = 'idols';
    this.state.q = (params.get('q') || '').slice(0, 100);
    this.state.season = params.get('season') || '';
    this.state.result = Idol.RESULTS.includes(params.get('result')) ? params.get('result') : '';

    this.$('idolSkeleton').innerHTML = Array(6).fill('<div class="skeleton person-skeleton"></div>').join('');
    try {
      let data;
      try {
        data = await API.getIdolIndex();
        Cache.set('idol_index', data);
      } catch (err) {
        data = Cache.get('idol_index');
        if (!data) throw err;
      }
      this.data = { seasons: data.seasons || [], idols: data.idols || [] };
    } catch (err) {
      console.warn('Failed to load Mara Idol:', err);
      this.$('idolLoading').style.display = 'none';
      this.showEmpty(I18n.t('idol.error_index_title'), I18n.t('idol.error_index_text'));
      return;
    }
    this.$('idolLoading').style.display = 'none';
    this.buildFilters();
    this.bind();
    this.syncControls();
    this.renderStats();
    this.render();
  },

  buildFilters() {
    const seasonSel = this.$('idolSeasonFilter');
    seasonSel.innerHTML = `<option value="">${Idol.esc(I18n.t('idol.all_seasons'))}</option>` +
      this.data.seasons.map((s) => `<option value="${Idol.esc(s.slug)}">${Idol.esc(s.title)}</option>`).join('');
    const resultSel = this.$('idolResultFilter');
    resultSel.innerHTML = `<option value="">${Idol.esc(I18n.t('idol.all_results'))}</option>` +
      Idol.RESULTS.map((r) => `<option value="${r}">${Idol.esc(I18n.t(`idol.result_${r}`))}</option>`).join('');
    this.seasonDd = Dropdown.enhance(seasonSel);
    this.resultDd = Dropdown.enhance(resultSel);
  },

  bind() {
    const search = this.$('idolSearch');
    const onSearch = Utils.debounce(() => { this.state.q = search.value.trim(); this.render(); }, 200);
    search.addEventListener('input', () => { this.$('idolSearchClear').style.display = search.value ? 'block' : 'none'; onSearch(); });
    this.$('idolSearchClear').addEventListener('click', () => { search.value = ''; this.$('idolSearchClear').style.display = 'none'; this.state.q = ''; this.render(); search.focus(); });
    this.$('idolTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      this.state.tab = btn.dataset.tab; this.syncControls(); this.render();
    });
    this.$('idolSeasonFilter').addEventListener('change', (e) => { this.state.season = e.target.value; this.render(); });
    this.$('idolResultFilter').addEventListener('change', (e) => { this.state.result = e.target.value; this.render(); });
  },

  syncControls() {
    this.$('idolSearch').value = this.state.q;
    this.$('idolSearchClear').style.display = this.state.q ? 'block' : 'none';
    document.querySelectorAll('#idolTabs [data-tab]').forEach((b) => {
      const on = b.dataset.tab === this.state.tab;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
    });
    this.$('idolIdolControls').hidden = this.state.tab !== 'idols';
    this.$('idolSeasonFilter').value = this.state.season;
    this.$('idolResultFilter').value = this.state.result;
    if (this.seasonDd) this.seasonDd.sync();
    if (this.resultDd) this.resultDd.sync();
  },

  renderStats() {
    const el = this.$('idolStats');
    el.textContent = I18n.t('idol.stats', { seasons: this.data.seasons.length, idols: this.data.idols.length });
    el.hidden = !this.data.seasons.length;
  },

  showEmpty(title, text) {
    this.$('idolSeasonsSection').style.display = 'none';
    this.$('idolIdolsSection').style.display = 'none';
    this.$('idolEmpty').style.display = 'block';
    this.$('idolEmptyTitle').textContent = title;
    this.$('idolEmptyText').textContent = text;
  },

  render() {
    const { tab, q, season, result } = this.state;
    const needle = q.toLowerCase();

    const params = new URLSearchParams();
    if (tab === 'idols') params.set('tab', 'idols');
    if (q) params.set('q', q);
    if (tab === 'idols' && season) params.set('season', season);
    if (tab === 'idols' && result) params.set('result', result);
    history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''));

    this.$('idolEmpty').style.display = 'none';
    if (tab === 'seasons') {
      this.$('idolIdolsSection').style.display = 'none';
      const seasons = this.data.seasons.filter((s) => !needle ||
        [s.title, s.venue, String(s.year), ...(s.winners || []).map((w) => w.name)].some((v) => String(v || '').toLowerCase().includes(needle)));
      if (!seasons.length) {
        this.showEmpty(I18n.t(this.data.seasons.length ? 'idol.no_match_title' : 'idol.empty_title'), I18n.t(this.data.seasons.length ? 'idol.no_match_text' : 'idol.empty_text'));
        return;
      }
      this.$('idolSeasonsSection').style.display = 'block';
      this.$('idolSeasonGrid').innerHTML = seasons.map((s) => Idol.seasonCard(s)).join('');
    } else {
      this.$('idolSeasonsSection').style.display = 'none';
      const idols = this.data.idols.filter((i) =>
        (!season || i.season_slug === season) && (!result || i.result === result) &&
        (!needle || [i.name, i.season_title].some((v) => String(v || '').toLowerCase().includes(needle))));
      if (!idols.length) {
        this.showEmpty(I18n.t('idol.no_match_title'), I18n.t('idol.no_match_text'));
        return;
      }
      this.$('idolIdolsSection').style.display = 'block';
      this.$('idolIdolGrid').innerHTML = idols.map((i) => Idol.card(i, { showSeason: true })).join('');
    }
  },
};

// ─── /mara-idol/:season ────────────────────────────────────────
const IdolSeasonPage = {
  async init() {
    const [slug] = Idol.pathParts();
    if (!slug) return this.showError();
    try {
      let data;
      try {
        data = await API.getIdolSeason(slug);
        Cache.set(`idol_season_${slug}`, data);
      } catch (err) {
        data = Cache.get(`idol_season_${slug}`);
        if (!data) throw err;
      }
      this.render(data);
      this.updateMeta(data);
    } catch (err) {
      console.warn('Failed to load season:', err);
      this.showError();
    }
  },

  showError() {
    document.getElementById('idolSkeletonBox').style.display = 'none';
    document.getElementById('idolSeasonDetail').style.display = 'none';
    document.getElementById('idolError').style.display = 'block';
  },

  render(s) {
    document.getElementById('idolSkeletonBox').style.display = 'none';
    document.getElementById('idolError').style.display = 'none';
    document.getElementById('idolSeasonDetail').style.display = 'block';
    document.getElementById('breadcrumbName').textContent = s.title;
    document.getElementById('idolTitle').textContent = s.title;
    document.getElementById('idolYear').textContent = String(s.year);
    const meta = Idol.seasonMeta(s);
    const metaEl = document.getElementById('idolMeta');
    metaEl.textContent = meta;
    metaEl.hidden = !meta;
    const desc = document.getElementById('idolDescription');
    desc.textContent = s.description || '';
    desc.hidden = !s.description;
    const cover = document.getElementById('idolCover');
    const photoEl = document.getElementById('idolPhoto');
    if (s.photo_url) { photoEl.innerHTML = `<img src="${Idol.esc(s.photo_url)}" alt="" onerror="this.parentNode.hidden=true" />`; photoEl.hidden = false; } else { photoEl.hidden = true; }
    if (s.cover_url) { cover.innerHTML = `<img src="${Idol.esc(s.cover_url)}" alt="" onerror="this.closest('.idol-hero__cover').hidden=true" />`; cover.hidden = false; } else { cover.hidden = true; }

    const videos = document.getElementById('idolVideos');
    document.getElementById('idolVideosSection').hidden = !(s.videos && s.videos.length);
    videos.innerHTML = Idol.videosHtml(s.videos);
    Idol.bindVideos(videos);

    const list = s.contestants || [];
    document.getElementById('idolCount').textContent = `(${list.length})`;
    document.getElementById('idolNoContestants').style.display = list.length ? 'none' : 'block';
    document.getElementById('idolContestantGrid').innerHTML = list
      .map((c) => Idol.card({ ...c, season_slug: s.slug, season_title: s.title })).join('');
  },

  // Same wording as functions/mara-idol/[[catchall]].js (crawlers see that version first).
  updateMeta(s) {
    const title = `${s.title} (${s.year}) — Mara Idol | MaraLyrics`;
    const text = String(s.description || '').replace(/\s+/g, ' ').trim();
    const desc = text ? text.slice(0, 200) : `${s.title} — Mara Idol ${s.year} on MaraLyrics.`;
    const url = `https://maralyrics.com/mara-idol/${encodeURIComponent(s.slug)}`;
    Idol.applyMeta({ title, desc, url, image: s.cover_url || s.photo_url });
  },
};

// ─── /mara-idol/:season/:idol ──────────────────────────────────
const IdolProfilePage = {
  async init() {
    const [season, idol] = Idol.pathParts();
    if (!season || !idol) return this.showError();
    try {
      let data;
      try {
        data = await API.getIdolContestant(season, idol);
        Cache.set(`idol_${season}_${idol}`, data);
      } catch (err) {
        data = Cache.get(`idol_${season}_${idol}`);
        if (!data) throw err;
      }
      this.render(data);
      this.updateMeta(data);
    } catch (err) {
      console.warn('Failed to load idol:', err);
      this.showError();
    }
  },

  showError() {
    document.getElementById('idolSkeletonBox').style.display = 'none';
    document.getElementById('idolDetail').style.display = 'none';
    document.getElementById('idolError').style.display = 'block';
  },

  render(i) {
    document.getElementById('idolSkeletonBox').style.display = 'none';
    document.getElementById('idolError').style.display = 'none';
    document.getElementById('idolDetail').style.display = 'block';
    const seasonHref = `/mara-idol/${encodeURIComponent(i.season.slug)}`;
    const crumb = document.getElementById('breadcrumbSeason');
    crumb.textContent = i.season.title; crumb.href = seasonHref;
    document.getElementById('breadcrumbName').textContent = i.name;
    document.getElementById('idolName').textContent = i.name;
    document.getElementById('idolTags').innerHTML = Idol.resultChip(i.result, i.placement, { all: true });
    const link = document.getElementById('idolSeasonLink');
    link.href = seasonHref; link.textContent = `${i.season.title} · ${i.season.year}`;

    const avatar = document.getElementById('idolAvatar');
    avatar.innerHTML = i.photo_url
      ? `<img src="${Idol.esc(i.photo_url)}" alt="${Idol.esc(i.name)}" class="profile-page__avatar-img" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" /><span class="profile-page__avatar-fallback" style="display:none;">${Idol.esc((i.name || '?').charAt(0))}</span>`
      : `<span class="profile-page__avatar-fallback">${Idol.esc((i.name || '?').charAt(0))}</span>`;

    const bio = document.getElementById('idolBio');
    bio.textContent = i.bio || '';
    bio.hidden = !i.bio;

    const artistSection = document.getElementById('idolArtistSection');
    if (i.artist) {
      document.getElementById('idolArtistCard').href = `/artist/${encodeURIComponent(i.artist.slug)}`;
      document.getElementById('idolArtistCard').innerHTML = `${People.avatar({ name: i.artist.name, image_url: i.artist.image_url })}
        <span class="person-card__body"><span class="person-card__name">${Idol.esc(i.artist.name)}</span>
        <span class="person-card__role">${Idol.esc(I18n.t('idol.view_artist'))}</span>
        ${i.artist.badges && i.artist.badges.length ? `<span class="person-card__badges">${Badges.list('artist', i.artist.badges, { compact: true })}</span>` : ''}</span>`;
      artistSection.hidden = false;
    } else {
      artistSection.hidden = true;
    }

    const videos = document.getElementById('idolVideos');
    document.getElementById('idolVideosSection').hidden = !(i.videos && i.videos.length);
    videos.innerHTML = Idol.videosHtml(i.videos);
    Idol.bindVideos(videos);
  },

  updateMeta(i) {
    const title = `${i.name} — ${i.season.title} | Mara Idol | MaraLyrics`;
    const lead = i.result === 'contestant'
      ? `${i.name} — contestant in ${i.season.title} (${i.season.year}), Mara Idol.`
      : `${i.name} — ${Idol.RESULT_SEO[i.result]} of ${i.season.title} (${i.season.year}), Mara Idol.`;
    const desc = `${lead}${i.bio ? ` ${i.bio}` : ''}`.slice(0, 300);
    const url = `https://maralyrics.com/mara-idol/${encodeURIComponent(i.season.slug)}/${encodeURIComponent(i.slug)}`;
    Idol.applyMeta({ title, desc, url, image: i.photo_url });
  },
};

/** Browser-side mirror of the server-rendered tags (see updateMeta in the page controllers). */
Idol.applyMeta = function applyMeta({ title, desc, url, image }) {
  document.title = title;
  const set = (id, attr, value) => { const el = document.getElementById(id); if (el) el[attr] = value; };
  set('pageTitle', 'textContent', title);
  set('metaDesc', 'content', desc);
  set('ogTitle', 'content', title); set('twTitle', 'content', title);
  set('ogDesc', 'content', desc); set('twDesc', 'content', desc);
  set('ogUrl', 'content', url); set('canonicalUrl', 'href', url);
  if (image && /^https:\/\//i.test(image)) { set('ogImage', 'content', image); set('twImage', 'content', image); }
};

// ─── Article Detail Page Controller (/article/:slug) ───────────
const ArticlePage = {
  async init() {
    const slug = Utils.getSlugFromUrl();
    if (!slug) {
      this.showError();
      return;
    }
    await this.loadArticle(slug);
  },

  async loadArticle(slug) {
    try {
      const article = await API.getArticle(slug);
      this.renderArticle(article);
      this.updateMeta(article);
    } catch (err) {
      console.warn('Failed to load article:', err);
      this.showError();
    }
  },

  renderArticle(article) {
    const skeleton = document.getElementById('articleSkeleton');
    const detail = document.getElementById('articleDetail');
    const error = document.getElementById('articleError');

    if (skeleton) skeleton.style.display = 'none';
    if (error) error.style.display = 'none';
    if (detail) detail.style.display = 'block';

    const titleEl = document.getElementById('articleTitle');
    const authorEl = document.getElementById('articleAuthor');
    const dateEl = document.getElementById('articleDate');
    const summaryEl = document.getElementById('articleSummary');
    const contentEl = document.getElementById('articleContent');
    const breadcrumbTitle = document.getElementById('breadcrumbTitle');

    if (titleEl) titleEl.textContent = article.title;
    if (authorEl) authorEl.textContent = article.author_name;
    if (dateEl) dateEl.textContent = Utils.formatDateShort(article.published_at || article.created_at);
    if (breadcrumbTitle) breadcrumbTitle.textContent = article.title;

    if (summaryEl) {
      if (article.summary) {
        summaryEl.textContent = article.summary;
        summaryEl.style.display = 'block';
      } else {
        summaryEl.style.display = 'none';
      }
    }

    if (contentEl) {
      // Content is sanitized server-side (an allowlist of tags/attributes —
      // see worker/lib/sanitizeHtml.js) before it's ever stored, so it's
      // safe to render directly rather than escaping it as plain text.
      contentEl.innerHTML = article.content || '';
    }

    this._currentArticle = article;
    this.wireActions();
  },

  wireActions() {
    if (this._actionsWired) return;
    this._actionsWired = true;

    const shareBtn = document.getElementById('btnShareArticle');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        const article = this._currentArticle;
        if (!article) return;
        const shareData = {
          title: `${article.title} — MaraLyrics`,
          text: `${article.title} by ${article.author_name} — MaraLyrics`,
          url: window.location.href,
        };
        try {
          if (navigator.share) {
            await navigator.share(shareData);
          } else {
            await navigator.clipboard.writeText(shareData.url);
            if (typeof Toast !== 'undefined') Toast.show(I18n.t('song.share_success'), { type: 'success' });
          }
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          if (typeof Toast !== 'undefined') Toast.show(I18n.t('song.share_error'), { type: 'error' });
        }
      });
    }
  },

  updateMeta(article) {
    const title = `${article.title} | MaraLyrics`;
    const desc = (article.summary || Utils.stripHtml(article.content)).slice(0, 200);
    const url = `https://maralyrics.com/article/${article.slug}`;

    document.title = title;
    const set = (id, prop, value) => {
      const el = document.getElementById(id);
      if (el) el[prop] = value;
    };
    set('metaDesc', 'content', desc);
    set('ogTitle', 'content', title);
    set('ogDesc', 'content', desc);
    set('ogUrl', 'content', url);
    set('twTitle', 'content', title);
    set('twDesc', 'content', desc);
    set('canonicalUrl', 'href', url);
    set('pageTitle', 'textContent', title);

    const jsonLd = document.getElementById('jsonLd');
    // The server-rendered page already carries the full graph (incl. breadcrumbs); only fall
    // back to building it here when it didn't (e.g. a direct hit on the static shell).
    if (jsonLd && !jsonLd.textContent.includes('@graph')) {
      jsonLd.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: article.title,
        author: { '@type': 'Person', name: article.author_name },
        datePublished: article.published_at || article.created_at,
        url,
        publisher: { '@type': 'Organization', name: 'MaraLyrics' },
      });
    }
  },

  showError() {
    const skeleton = document.getElementById('articleSkeleton');
    const detail = document.getElementById('articleDetail');
    const error = document.getElementById('articleError');

    if (skeleton) skeleton.style.display = 'none';
    if (detail) detail.style.display = 'none';
    if (error) error.style.display = 'block';
  },
};

// ─── Service Worker Registration ───────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // Prefetch page shells and API data in background
    if (reg.active) {
      reg.active.postMessage({ type: 'PRECACHE_PAGES' });
      reg.active.postMessage({ type: 'PRECACHE_API', apiBase: CONFIG.API_BASE });
    }
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'activated') {
          newWorker.postMessage({ type: 'PRECACHE_PAGES' });
          newWorker.postMessage({ type: 'PRECACHE_API', apiBase: CONFIG.API_BASE });
          // Notify user of update if not first install
          if (navigator.serviceWorker.controller) {
            Toast.show(I18n.t('toast.content_updated'), { type: 'success', duration: 2500 });
          }
        }
      });
    });
  }).catch(() => {});
}

// ─── Offline Detection ─────────────────────────────────────────

function initOfflineDetection() {
  // Delegate to centralized Toast module
  if (typeof Toast !== 'undefined') {
    Toast.initOffline();
  }
}

// ─── Credited People Popover (Various Artists / Various Composers) ─────
function closeCreditsPopovers(except) {
  document.querySelectorAll('.credits-wrap.open').forEach((wrap) => {
    if (wrap === except) return;
    wrap.classList.remove('open');
    wrap.querySelector('.credits-trigger')?.setAttribute('aria-expanded', 'false');
  });
}
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('.credits-trigger');
  if (trigger) {
    e.preventDefault();
    const wrap = trigger.closest('.credits-wrap');
    const willOpen = !wrap.classList.contains('open');
    closeCreditsPopovers();
    if (willOpen) {
      wrap.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
    }
    return;
  }
  if (!e.target.closest('.credits-popover')) closeCreditsPopovers();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCreditsPopovers();
});

// ─── Favorite Toggle (delegated — covers every song-grid, plus the song detail page) ────
function updatePinButton(btn, isPinned) {
  btn.classList.toggle('active', isPinned);
  btn.setAttribute('aria-pressed', String(isPinned));
  const label = I18n.t(isPinned ? 'common.unpin' : 'common.pin');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  const text = btn.querySelector('[data-pin-label]');
  if (text) text.textContent = label;
}

function updateFavoriteButton(btn, isFavorited) {
  btn.classList.toggle('active', isFavorited);
  btn.setAttribute('aria-pressed', String(isFavorited));
  const label = I18n.t(isFavorited ? 'common.remove_from_favorites' : 'common.add_to_favorites');
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function initAppPromotion() {
  const footer = document.querySelector('.footer');
  const footerBottom = footer?.querySelector('.footer__bottom');
  if (!footer || !footerBottom || footer.querySelector('.app-promotion')) return;

  const promotion = document.createElement('section');
  promotion.className = 'app-promotion';
  promotion.setAttribute('aria-labelledby', 'appPromotionTitle');
  promotion.innerHTML = `
    <div class="app-promotion__copy">
      <span class="app-promotion__icon" aria-hidden="true">
        <img src="/google-play.ico" alt="" />
      </span>
      <div>
        <h2 id="appPromotionTitle" class="app-promotion__title" data-i18n="footer.app_title">MaraLyrics on Android</h2>
        <p class="app-promotion__text" data-i18n="footer.app_description">Take Mara song lyrics with you. Get the MaraLyrics app on Google Play.</p>
        <span class="app-promotion__offline" data-i18n="footer.app_offline">100% Offline</span>
      </div>
    </div>
    <a class="app-promotion__link" href="https://play.google.com/store/apps/details?id=com.maralyrics.laitei" target="_blank" rel="noopener noreferrer" data-i18n="footer.app_download" data-i18n-title="footer.app_download_title" title="Download MaraLyrics on Google Play">Download app</a>
  `;
  footerBottom.before(promotion);
}

function initAppPromotionDialog() {
  const seenKey = 'ml_app_promo_seen';
  try {
    if (localStorage.getItem(seenKey) === '1') return;
    localStorage.setItem(seenKey, '1');
  } catch (_) {}

  const dialog = document.createElement('div');
  dialog.className = 'app-promo-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'appPromoDialogTitle');
  dialog.setAttribute('aria-describedby', 'appPromoDialogDescription');
  dialog.innerHTML = `
    <div class="app-promo-dialog__backdrop" data-app-promo-close></div>
    <section class="app-promo-dialog__panel">
      <div class="app-promo-dialog__controls">
        <div class="app-promo-dialog__language">
          <button type="button" class="app-promo-dialog__language-btn" aria-label="Choose language" data-i18n-aria="app_promo.language_aria" aria-expanded="false" aria-controls="appPromoLanguageMenu">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          </button>
          <div class="app-promo-dialog__language-menu" id="appPromoLanguageMenu" role="menu" aria-label="Languages" data-i18n-aria="app_promo.language_menu_aria">
            <button type="button" role="menuitem" class="app-promo-dialog__language-option" data-dialog-lang="en">EN</button>
            <button type="button" role="menuitem" class="app-promo-dialog__language-option" data-dialog-lang="mrh">Mara</button>
            <button type="button" role="menuitem" class="app-promo-dialog__language-option" data-dialog-lang="my">မြန်မာ</button>
          </div>
        </div>
        <button type="button" class="app-promo-dialog__close" data-app-promo-close aria-label="Close" data-i18n-aria="app_promo.close_aria">&times;</button>
      </div>
      <div class="app-promo-dialog__art" aria-hidden="true">
        <div class="app-promo-dialog__glow"></div>
        <div class="app-promo-dialog__icon"><img src="/google-play.ico" alt="" /></div>
      </div>
      <div class="app-promo-dialog__content">
        <span class="app-promo-dialog__eyebrow" data-i18n="app_promo.eyebrow">Made for Mara music</span>
        <h2 id="appPromoDialogTitle" class="app-promo-dialog__title" data-i18n="app_promo.title">MaraLyrics, wherever you are</h2>
        <p id="appPromoDialogDescription" class="app-promo-dialog__description" data-i18n="app_promo.description">Keep your favorite Mara song lyrics close with the MaraLyrics Android app.</p>
        <span class="app-promo-dialog__offline" data-i18n="app_promo.offline">100% Offline</span>
        <div class="app-promo-dialog__actions">
          <a class="app-promo-dialog__download" href="https://play.google.com/store/apps/details?id=com.maralyrics.laitei" target="_blank" rel="noopener noreferrer" data-i18n="app_promo.download" data-i18n-title="app_promo.download_title" title="Download MaraLyrics on Google Play">Get the app</a>
          <button type="button" class="app-promo-dialog__later" data-app-promo-close data-i18n="app_promo.later">Maybe later</button>
        </div>
      </div>
    </section>
  `;

  document.body.appendChild(dialog);
  I18n.applyToDOM();

  const close = () => {
    dialog.classList.remove('visible');
    document.body.classList.remove('app-promo-dialog-open');
    document.removeEventListener('keydown', onKeydown);
    setTimeout(() => dialog.remove(), 250);
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') close();
  };

  dialog.querySelectorAll('[data-app-promo-close]').forEach((element) => {
    element.addEventListener('click', close);
  });
  const languageButton = dialog.querySelector('.app-promo-dialog__language-btn');
  const languageMenu = dialog.querySelector('.app-promo-dialog__language-menu');
  languageButton.addEventListener('click', () => {
    const isOpen = languageMenu.classList.toggle('open');
    languageButton.setAttribute('aria-expanded', String(isOpen));
  });
  dialog.querySelectorAll('[data-dialog-lang]').forEach((option) => {
    option.addEventListener('click', async () => {
      await I18n.setLanguage(option.dataset.dialogLang);
      languageMenu.classList.remove('open');
      languageButton.setAttribute('aria-expanded', 'false');
      dialog.querySelector('.app-promo-dialog__close').focus();
    });
  });
  dialog.querySelector('.app-promo-dialog__download').addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);
  document.body.classList.add('app-promo-dialog-open');
  requestAnimationFrame(() => dialog.classList.add('visible'));
  dialog.querySelector('.app-promo-dialog__close').focus();
}

// Mirrors the fixed category set marareih.org's own calendars.html uses, so
// a calendar's icon matches what it shows there — shared by the calendar
// dialog's picker pills and the default-calendar prompt/settings.
const CALENDAR_CATEGORY_ICONS = {
  general: '📅', church: '⛪', education: '🎓', holiday: '🎉',
  youth: '🎈', music: '🎵', community: '🤝', women: '👩', family: '👪',
};

// ─── Calendar preference (default calendar, set in Settings) ───────────────
// Shared by the Settings dropdown, the calendar dialog's initial selection,
// and the homepage's "Today's Event" lookup, so all three agree on which
// calendar the visitor cares about. Also owns the one shared /api/calendars
// fetch per page load, so those three don't each make their own request.
const CalendarPrefs = (() => {
  const STORAGE_KEY = 'ml_default_calendar';
  const PROMPTED_KEY = 'ml_calendar_pref_prompted';
  const API = 'https://calendar-api.marareih.org';
  let calendarsPromise = null;

  function get() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
  }

  function set(slug) {
    try {
      if (slug) localStorage.setItem(STORAGE_KEY, slug);
      else localStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* ignore */ }
  }

  /** Fetches and caches the calendar list for this page load. Rejects (and
   *  clears the cache so the next call retries) if the request fails. */
  function loadCalendars() {
    if (!calendarsPromise) {
      calendarsPromise = fetch(`${API}/api/calendars`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => (data.calendars || []).slice().sort((a, b) => a.name.localeCompare(b.name)))
        .catch((err) => {
          calendarsPromise = null;
          throw err;
        });
    }
    return calendarsPromise;
  }

  /** Populates the Settings panel's calendar <select>, if present on this
   *  page, and persists the visitor's choice on change. */
  async function initSelect() {
    const select = document.getElementById('calendarPrefSelect');
    if (!select) return;

    try {
      const calendars = await loadCalendars();
      calendars.forEach((cal) => {
        const opt = document.createElement('option');
        opt.value = cal.slug;
        opt.textContent = cal.name;
        select.appendChild(opt);
      });
      const saved = get();
      select.value = calendars.some((cal) => cal.slug === saved) ? saved : '';
    } catch (err) {
      console.warn('[calendar] failed to load calendars for settings:', err);
      select.disabled = true;
      return;
    }

    select.addEventListener('change', () => {
      set(select.value);
      if (typeof Toast !== 'undefined') {
        Toast.show(I18n.t('toast.default_calendar_changed'), { type: 'info', duration: 2000 });
      }
    });
  }

  /** First-visit-only prompt asking which calendar's events should show in
   *  Today's Event. Resolves once dismissed (by a choice, Skip, backdrop, or
   *  Escape) or immediately if there's nothing to ask, so callers can
   *  sequence it ahead of other first-visit dialogs (e.g. the app promo). */
  function promptIfNeeded() {
    return new Promise((resolve) => {
      let alreadyPrompted = true;
      try { alreadyPrompted = localStorage.getItem(PROMPTED_KEY) === '1'; } catch (e) { /* default true: skip on storage errors */ }

      if (alreadyPrompted || get()) {
        resolve();
        return;
      }
      try { localStorage.setItem(PROMPTED_KEY, '1'); } catch (e) { /* ignore */ }

      const dialog = document.createElement('div');
      dialog.className = 'calendar-pref-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'calendarPrefDialogTitle');
      dialog.innerHTML = `
        <div class="calendar-pref-dialog__backdrop" data-calendar-pref-skip></div>
        <section class="calendar-pref-dialog__panel">
          <span class="calendar-pref-dialog__icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </span>
          <h2 id="calendarPrefDialogTitle" class="calendar-pref-dialog__title" data-i18n="calendar_pref_dialog.title">Pick your calendar</h2>
          <p class="calendar-pref-dialog__desc" data-i18n="calendar_pref_dialog.description">Choose which community calendar's events show in Today's Event on the homepage. You can change this anytime in Settings.</p>
          <div class="calendar-pref-dialog__list" id="calendarPrefDialogList">
            <p class="calendar-pref-dialog__loading" data-i18n="calendar.loading">Loading events…</p>
          </div>
          <button type="button" class="calendar-pref-dialog__skip" data-calendar-pref-skip data-i18n="calendar_pref_dialog.skip">Skip for now</button>
        </section>
      `;
      document.body.appendChild(dialog);
      I18n.applyToDOM();
      document.body.classList.add('calendar-pref-dialog-open');
      requestAnimationFrame(() => dialog.classList.add('visible'));

      const close = () => {
        dialog.classList.remove('visible');
        document.body.classList.remove('calendar-pref-dialog-open');
        document.removeEventListener('keydown', onKeydown);
        setTimeout(() => dialog.remove(), 250);
        resolve();
      };
      const onKeydown = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', onKeydown);
      dialog.querySelectorAll('[data-calendar-pref-skip]').forEach((el) => el.addEventListener('click', close));

      const list = dialog.querySelector('#calendarPrefDialogList');
      loadCalendars().then((calendars) => {
        const allOption = `<button type="button" class="calendar-pref-dialog__option calendar-pref-dialog__option--all" data-calendar-slug="">
          <span class="calendar-pref-dialog__option-name" data-i18n="settings_panel.calendar_all">All calendars</span>
        </button>`;
        const calendarOptions = calendars.map((cal) => {
          const icon = CALENDAR_CATEGORY_ICONS[cal.category] || CALENDAR_CATEGORY_ICONS.general;
          return `<button type="button" class="calendar-pref-dialog__option" data-calendar-slug="${Utils.escapeHtml(cal.slug)}">
            <span class="calendar-pref-dialog__option-icon" aria-hidden="true">${icon}</span>
            <span class="calendar-pref-dialog__option-name">${Utils.escapeHtml(cal.name)}</span>
          </button>`;
        }).join('');
        list.innerHTML = allOption + calendarOptions;
        I18n.applyToDOM();
        list.querySelectorAll('[data-calendar-slug]').forEach((btn) => {
          btn.addEventListener('click', () => {
            set(btn.dataset.calendarSlug);
            const select = document.getElementById('calendarPrefSelect');
            if (select) select.value = btn.dataset.calendarSlug;
            if (typeof Toast !== 'undefined') {
              Toast.show(I18n.t('toast.default_calendar_changed'), { type: 'success', duration: 2200 });
            }
            close();
          });
        });
      }).catch((err) => {
        console.warn('[calendar] failed to load calendars for the first-visit prompt:', err);
        list.innerHTML = `<p class="calendar-pref-dialog__error" data-i18n="calendar.calendars_error">Could not load calendars. Please try again later.</p>`;
        I18n.applyToDOM();
      });
    });
  }

  return { get, set, loadCalendars, initSelect, promptIfNeeded };
})();

// ─── Event Detail (modal opened from the Today's Event card and event notifications) ────
// Shows one calendar event in full: date block, live status, when / where / about, plus
// "Add to calendar" (.ics download) and a jump to the full community calendar.
const EventDetail = (() => {
  let el = null;
  let lastFocus = null;

  const isAllDay = (str) => /^\d{4}-\d{2}-\d{2}$/.test(str || '');
  const parse = (str) => new Date(isAllDay(str) ? str + 'T00:00:00' : str);
  const DAY = 24 * 60 * 60 * 1000;

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  function describeWhen(ev) {
    const start = parse(ev.start);
    const long = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const short = { month: 'short', day: 'numeric', year: 'numeric' };
    if (isAllDay(ev.start)) {
      if (!ev.end || ev.end === ev.start) {
        return { primary: start.toLocaleDateString(Utils.locale(), long), secondary: I18n.t('event_detail.all_day') };
      }
      const end = parse(ev.end);
      const days = Math.round((end - start) / DAY) + 1;
      return {
        primary: `${start.toLocaleDateString(Utils.locale(), short)} – ${end.toLocaleDateString(Utils.locale(), short)}`,
        secondary: `${I18n.t('event_detail.all_day')} · ${I18n.t('event_detail.days', { count: days })}`,
      };
    }
    const time = { hour: '2-digit', minute: '2-digit' };
    const end = ev.end ? parse(ev.end) : null;
    let secondary = start.toLocaleTimeString(Utils.locale(), time);
    if (end && !isNaN(end)) {
      secondary += ' – ' + (startOfDay(end).getTime() === startOfDay(start).getTime()
        ? end.toLocaleTimeString(Utils.locale(), time)
        : end.toLocaleString(Utils.locale(), { month: 'short', day: 'numeric', ...time }));
    }
    return { primary: start.toLocaleDateString(Utils.locale(), long), secondary };
  }

  /** { live: true/false, text } — "Happening today/now", "Tomorrow", "In N days", "Ended". */
  function status(ev) {
    const now = new Date();
    const today = startOfDay(now);
    const startDay = startOfDay(parse(ev.start));
    const endDay = isAllDay(ev.start) && ev.end ? startOfDay(parse(ev.end)) : startDay;
    if (today >= startDay && today <= endDay) {
      if (!isAllDay(ev.start)) {
        const startAt = parse(ev.start);
        const endAt = ev.end ? parse(ev.end) : new Date(startAt.getTime() + 60 * 60 * 1000);
        if (now >= startAt && now <= endAt) return { live: true, text: I18n.t('event_detail.status_now') };
        if (now > endAt) return { live: false, text: I18n.t('event_detail.status_ended') };
      }
      return { live: true, text: I18n.t('event_detail.status_today') };
    }
    if (today > endDay) return { live: false, text: I18n.t('event_detail.status_ended') };
    const diff = Math.round((startDay - today) / DAY);
    return { live: false, text: diff === 1 ? I18n.t('event_detail.status_tomorrow') : I18n.t('event_detail.status_soon', { count: diff }) };
  }

  // ── .ics (works with Google / Apple / Outlook calendars) ──
  function icsEscape(text) {
    return String(text || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
  }
  function icsDate(d) {
    return d.toISOString().replace(/[-:]|\.\d{3}/g, '');
  }
  function icsDay(str) {
    return str.replace(/-/g, '');
  }
  function buildIcs(ev) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MaraLyrics//Event//EN', 'BEGIN:VEVENT',
      `UID:${icsEscape(ev.id || ev.title)}-${icsDay(ev.start.slice(0, 10))}@maralyrics.com`,
      `DTSTAMP:${icsDate(new Date())}`];
    if (isAllDay(ev.start)) {
      const endExclusive = new Date(parse(ev.end || ev.start).getTime() + DAY); // DTEND is exclusive for all-day
      const e = `${endExclusive.getFullYear()}${String(endExclusive.getMonth() + 1).padStart(2, '0')}${String(endExclusive.getDate()).padStart(2, '0')}`;
      lines.push(`DTSTART;VALUE=DATE:${icsDay(ev.start)}`, `DTEND;VALUE=DATE:${e}`);
    } else {
      const startAt = parse(ev.start);
      const endAt = ev.end ? parse(ev.end) : new Date(startAt.getTime() + 60 * 60 * 1000);
      lines.push(`DTSTART:${icsDate(startAt)}`, `DTEND:${icsDate(endAt)}`);
    }
    lines.push(`SUMMARY:${icsEscape(ev.title)}`);
    if (ev.description) lines.push(`DESCRIPTION:${icsEscape(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n');
  }
  function downloadIcs(ev) {
    const blob = new Blob([buildIcs(ev)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (String(ev.title || 'event').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '') || 'event') + '.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const ICONS = {
    clock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    pin: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    text: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>',
  };

  function row(icon, label, bodyHtml) {
    return `<div class="event-modal__row">
      <span class="event-modal__row-icon">${icon}</span>
      <div class="event-modal__row-body"><span class="event-modal__row-label">${Utils.escapeHtml(label)}</span>${bodyHtml}</div>
    </div>`;
  }

  function render(ev) {
    const start = parse(ev.start);
    const st = status(ev);
    const when = describeWhen(ev);
    const month = start.toLocaleDateString(Utils.locale(), { month: 'short' }).toUpperCase();
    const weekday = start.toLocaleDateString(Utils.locale(), { weekday: 'short' });
    const mapUrl = ev.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}` : '';

    el.querySelector('.event-modal__panel').classList.toggle('event-modal__panel--live', st.live);
    el.querySelector('.event-modal__content').innerHTML = `
      <div class="event-modal__hero">
        <div class="event-modal__date" aria-hidden="true">
          <span class="event-modal__date-month">${Utils.escapeHtml(month)}</span>
          <span class="event-modal__date-day">${String(start.getDate()).padStart(2, '0')}</span>
          <span class="event-modal__date-weekday">${Utils.escapeHtml(weekday)}</span>
        </div>
        <div class="event-modal__hero-text">
          <span class="event-modal__status${st.live ? ' event-modal__status--live' : ''}"><span class="event-modal__status-dot"></span>${Utils.escapeHtml(st.text)}</span>
          <h2 class="event-modal__title" id="eventModalTitle">${Utils.escapeHtml(ev.title)}</h2>
        </div>
      </div>
      <div class="event-modal__body">
        ${row(ICONS.clock, I18n.t('event_detail.when'), `<span class="event-modal__row-main">${Utils.escapeHtml(when.primary)}</span><span class="event-modal__row-sub">${Utils.escapeHtml(when.secondary)}</span>`)}
        ${ev.location ? row(ICONS.pin, I18n.t('event_detail.where'), `<span class="event-modal__row-main">${Utils.escapeHtml(ev.location)}</span><a class="event-modal__map" href="${Utils.escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer">${Utils.escapeHtml(I18n.t('event_detail.open_map'))} →</a>`) : ''}
        ${row(ICONS.text, I18n.t('event_detail.about'), ev.description
          ? `<p class="event-modal__desc">${Utils.escapeHtml(ev.description).replace(/\n/g, '<br>')}</p>`
          : `<p class="event-modal__desc event-modal__desc--empty">${Utils.escapeHtml(I18n.t('event_detail.no_description'))}</p>`)}
      </div>
      <div class="event-modal__actions">
        <button type="button" class="event-modal__btn event-modal__btn--primary" data-event-ics>${Utils.escapeHtml(I18n.t('event_detail.add_to_calendar'))}</button>
        <button type="button" class="event-modal__btn" data-event-calendar>${Utils.escapeHtml(I18n.t('event_detail.view_calendar'))}</button>
      </div>`;

    el.querySelector('[data-event-ics]').addEventListener('click', () => downloadIcs(ev));
    el.querySelector('[data-event-calendar]').addEventListener('click', () => {
      close();
      document.dispatchEvent(new CustomEvent('open-community-calendar'));
    });
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && el && el.classList.contains('visible')) close();
  }

  function build() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'event-modal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'eventModalTitle');
    el.innerHTML = `
      <div class="event-modal__backdrop" data-event-close></div>
      <section class="event-modal__panel">
        <button type="button" class="event-modal__close" data-event-close aria-label="${Utils.escapeHtml(I18n.t('calendar.close_aria'))}">&times;</button>
        <div class="event-modal__content"></div>
      </section>`;
    document.body.appendChild(el);
    el.querySelectorAll('[data-event-close]').forEach((n) => n.addEventListener('click', close));
    document.addEventListener('keydown', onKeydown);
  }

  function open(ev) {
    if (!ev || !ev.start || !ev.title) return;
    build();
    lastFocus = document.activeElement;
    render(ev);
    el.classList.add('visible');
    document.body.classList.add('calendar-dialog-open'); // reuses the scroll lock
    el.querySelector('.event-modal__close').focus();
  }

  function close() {
    if (!el) return;
    el.classList.remove('visible');
    document.body.classList.remove('calendar-dialog-open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }

  function init() {
    // The Today's Event card (whole card, or its "View details" button).
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-calendar-open]')) return; // that link opens the full calendar
      if (!e.target.closest('[data-event-open]')) return;
      const ev = typeof HomePage !== 'undefined' ? HomePage.featuredEvent : null;
      if (ev) open(ev);
    });
  }

  return { init, open, close };
})();

// ─── Community Calendar (events pulled live from calendar-api.marareih.org) ────
// Read-only, unauthenticated, CORS-open JSON feed — see marareih.org's
// calendar-worker/API.md. We fetch one year at a time and let the visitor
// step forward/back; nothing here writes to that API.
const CalendarFeature = (() => {
  const API = 'https://calendar-api.marareih.org';
  const MIN_YEAR = 1970;
  const MAX_YEAR = 2200;

  const LOADING_HTML = `
    <div class="calendar-dialog__loading">
      <span class="calendar-dialog__spinner" aria-hidden="true"></span>
      <p data-i18n="calendar.loading">Loading events…</p>
    </div>`;

  function errorHtml(key, fallback) {
    return `
      <div class="calendar-dialog__error">
        <svg class="calendar-dialog__state-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 17h.01"/></svg>
        <p data-i18n="${key}">${fallback}</p>
        <button type="button" class="calendar-dialog__retry" data-calendar-retry data-i18n="calendar.retry">Try again</button>
      </div>`;
  }

  const NO_CALENDARS_HTML = `
    <div class="calendar-dialog__empty">
      <svg class="calendar-dialog__state-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9.5" y1="14.5" x2="14.5" y2="19.5"/><line x1="14.5" y1="14.5" x2="9.5" y2="19.5"/></svg>
      <p data-i18n="calendar.no_calendars">No calendars available yet.</p>
    </div>`;

  const eventsCache = {}; // `${calendarSlug}:${year}` -> events[]
  let calendarsList = null; // null = not loaded yet, [] = loaded but empty
  let calendarsLoadFailed = false;
  let dialog = null;
  let currentYear = new Date().getFullYear();
  let currentCalendarSlug = null;
  let requestSeq = 0;

  function isAllDayDate(str) {
    return /^\d{4}-\d{2}-\d{2}$/.test(str);
  }

  function formatEventWhen(ev) {
    if (isAllDayDate(ev.start)) {
      const startFmt = new Date(ev.start + 'T00:00:00').toLocaleDateString(Utils.locale(), { month: 'short', day: 'numeric', year: 'numeric' });
      if (ev.start === ev.end) return startFmt;
      const endFmt = new Date(ev.end + 'T00:00:00').toLocaleDateString(Utils.locale(), { month: 'short', day: 'numeric', year: 'numeric' });
      return `${startFmt} – ${endFmt}`;
    }
    return new Date(ev.start).toLocaleString(Utils.locale(), { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function isSingleAllDay(ev) {
    return isAllDayDate(ev.start) && ev.start === ev.end;
  }

  /** A compact "05 / MAR" day badge for the common single-day case; falls
   *  back to the full date range as text for multi-day/timed events. */
  function eventBadgeHtml(ev) {
    if (isSingleAllDay(ev)) {
      const d = new Date(ev.start + 'T00:00:00');
      const day = d.toLocaleDateString(Utils.locale(), { day: '2-digit' });
      const month = d.toLocaleDateString(Utils.locale(), { month: 'short' }).toUpperCase();
      return `<span class="calendar-event__badge"><span class="calendar-event__badge-day">${day}</span><span class="calendar-event__badge-month">${Utils.escapeHtml(month)}</span></span>`;
    }
    return `<span class="calendar-event__badge calendar-event__badge--text">${Utils.escapeHtml(formatEventWhen(ev))}</span>`;
  }

  function monthLabel(ev) {
    const d = new Date(isAllDayDate(ev.start) ? ev.start + 'T00:00:00' : ev.start);
    return d.toLocaleDateString(Utils.locale(), { month: 'long' });
  }

  function currentCalendarName() {
    const cal = (calendarsList || []).find((c) => c.slug === currentCalendarSlug);
    return cal ? cal.name : '';
  }

  // ── Calendar picker (MEC / ECM / MADC / …, whatever exists in the API) ──
  function renderCalendarPicker() {
    const picker = dialog.querySelector('#calendarDialogPicker');
    if (!calendarsList || !calendarsList.length) {
      picker.innerHTML = '';
      return;
    }
    picker.innerHTML = calendarsList.map((cal) => {
      const icon = CALENDAR_CATEGORY_ICONS[cal.category] || CALENDAR_CATEGORY_ICONS.general;
      return `<button type="button" class="calendar-dialog__picker-pill${cal.slug === currentCalendarSlug ? ' active' : ''}" data-calendar-slug="${Utils.escapeHtml(cal.slug)}" aria-pressed="${cal.slug === currentCalendarSlug}">${icon} ${Utils.escapeHtml(cal.name)}</button>`;
    }).join('');
    picker.querySelectorAll('[data-calendar-slug]').forEach((btn) => {
      btn.addEventListener('click', () => selectCalendar(btn.dataset.calendarSlug));
    });
  }

  function selectCalendar(slug) {
    if (slug === currentCalendarSlug) return;
    currentCalendarSlug = slug;
    renderCalendarPicker();
    renderYear(currentYear);
  }

  async function ensureCalendars() {
    if (calendarsList !== null || calendarsLoadFailed) return;
    try {
      calendarsList = await CalendarPrefs.loadCalendars();
      const defaultSlug = CalendarPrefs.get();
      const hasDefault = calendarsList.some((cal) => cal.slug === defaultSlug);
      currentCalendarSlug = hasDefault ? defaultSlug : (calendarsList.length ? calendarsList[0].slug : null);
    } catch (err) {
      console.warn('[calendar] failed to load calendars:', err);
      calendarsLoadFailed = true;
    }
  }

  // ── Event list + inline expandable details, grouped by month ──
  function renderEvents(events) {
    const body = dialog.querySelector('#calendarDialogBody');
    if (!events.length) {
      body.innerHTML = `
        <div class="calendar-dialog__empty">
          <svg class="calendar-dialog__state-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9.5" y1="14.5" x2="14.5" y2="19.5"/><line x1="14.5" y1="14.5" x2="9.5" y2="19.5"/></svg>
          <p></p>
        </div>`;
      body.querySelector('p').textContent = I18n.t('calendar.empty_for', { calendar: currentCalendarName(), year: currentYear });
      return;
    }

    let lastMonth = null;
    const rows = events.map((ev, i) => {
      const month = monthLabel(ev);
      const monthHeader = month !== lastMonth ? `<li class="calendar-event-month" role="presentation">${Utils.escapeHtml(month)}</li>` : '';
      lastMonth = month;
      const delay = (Math.min(i, 10) * 0.04).toFixed(2);
      return `${monthHeader}<li class="calendar-event" style="animation-delay:${delay}s">
        <button type="button" class="calendar-event__summary" aria-expanded="false" aria-controls="calEventDetails${i}">
          ${eventBadgeHtml(ev)}
          <span class="calendar-event__summary-text">
            <span class="calendar-event__title">${Utils.escapeHtml(ev.title)}</span>
            ${ev.location ? `<span class="calendar-event__meta">📍 ${Utils.escapeHtml(ev.location)}</span>` : ''}
          </span>
          <svg class="calendar-event__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="calendar-event__details" id="calEventDetails${i}" hidden>
          <p>${ev.description ? Utils.escapeHtml(ev.description).replace(/\n/g, '<br>') : Utils.escapeHtml(I18n.t('calendar.no_description'))}</p>
        </div>
      </li>`;
    });

    body.innerHTML = `<ul class="calendar-event-list">${rows.join('')}</ul>`;

    body.querySelectorAll('.calendar-event__summary').forEach((btn) => {
      btn.addEventListener('click', () => {
        const details = btn.nextElementSibling;
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        details.hidden = expanded;
      });
    });
  }

  async function renderYear(year) {
    if (!currentCalendarSlug) return;

    dialog.querySelector('#calendarDialogYear').textContent = String(year);
    dialog.querySelectorAll('[data-year-step]').forEach((btn) => {
      const target = year + Number(btn.dataset.yearStep);
      btn.disabled = target < MIN_YEAR || target > MAX_YEAR;
    });

    const cacheKey = `${currentCalendarSlug}:${year}`;
    if (eventsCache[cacheKey]) {
      renderEvents(eventsCache[cacheKey]);
      return;
    }

    const body = dialog.querySelector('#calendarDialogBody');
    body.innerHTML = LOADING_HTML;
    I18n.applyToDOM();

    const seq = ++requestSeq;
    try {
      const res = await fetch(`${API}/api/events?year=${year}&calendar=${encodeURIComponent(currentCalendarSlug)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (seq !== requestSeq) return; // superseded by a newer year/calendar switch
      eventsCache[cacheKey] = data.events || [];
      renderEvents(eventsCache[cacheKey]);
    } catch (err) {
      if (seq !== requestSeq) return;
      console.warn('[calendar] failed to load events:', err);
      body.innerHTML = errorHtml('calendar.error', 'Could not load events. Please try again later.');
      I18n.applyToDOM();
    }
  }

  /** Retries whichever request last failed — the calendars list or the
   *  current year's events — without losing the visitor's place. */
  function retry() {
    if (calendarsLoadFailed) {
      calendarsLoadFailed = false;
      open();
      return;
    }
    if (currentCalendarSlug) {
      delete eventsCache[`${currentCalendarSlug}:${currentYear}`];
      renderYear(currentYear);
    }
  }

  function stepYear(delta) {
    const next = currentYear + delta;
    if (next < MIN_YEAR || next > MAX_YEAR) return;
    currentYear = next;
    renderYear(currentYear);
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && dialog && dialog.classList.contains('visible')) close();
  }

  function close() {
    if (!dialog) return;
    dialog.classList.remove('visible');
    document.body.classList.remove('calendar-dialog-open');
  }

  function buildDialog() {
    if (dialog) return dialog;

    dialog = document.createElement('div');
    dialog.className = 'calendar-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'calendarDialogTitle');
    dialog.innerHTML = `
      <div class="calendar-dialog__backdrop" data-calendar-close></div>
      <section class="calendar-dialog__panel">
        <header class="calendar-dialog__header">
          <h2 id="calendarDialogTitle" class="calendar-dialog__title">
            <span class="calendar-dialog__title-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </span>
            <span data-i18n="calendar.title">Community Calendar</span>
          </h2>
          <button type="button" class="calendar-dialog__close" data-calendar-close aria-label="Close" data-i18n-aria="calendar.close_aria">&times;</button>
        </header>
        <div class="calendar-dialog__picker" id="calendarDialogPicker" role="group" aria-label="Choose a calendar" data-i18n-aria="calendar.picker_aria"></div>
        <div class="calendar-dialog__year-nav">
          <button type="button" class="calendar-dialog__year-btn" data-year-step="-1" aria-label="Previous year" data-i18n-aria="calendar.prev_year_aria">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span class="calendar-dialog__year" id="calendarDialogYear"></span>
          <button type="button" class="calendar-dialog__year-btn" data-year-step="1" aria-label="Next year" data-i18n-aria="calendar.next_year_aria">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
        <div class="calendar-dialog__body" id="calendarDialogBody"></div>
        <footer class="calendar-dialog__footer">
          <a href="https://marareih.org/calendars.html" target="_blank" rel="noopener noreferrer" data-i18n="calendar.subscribe_link">See all calendars &amp; subscribe →</a>
        </footer>
      </section>
    `;
    document.body.appendChild(dialog);
    I18n.applyToDOM();

    dialog.querySelectorAll('[data-calendar-close]').forEach((el) => el.addEventListener('click', close));
    dialog.querySelectorAll('[data-year-step]').forEach((btn) => {
      btn.addEventListener('click', () => stepYear(Number(btn.dataset.yearStep)));
    });
    dialog.addEventListener('click', (e) => {
      if (e.target.closest('[data-calendar-retry]')) retry();
    });
    document.addEventListener('keydown', onKeydown);

    return dialog;
  }

  async function open() {
    buildDialog();
    dialog.classList.add('visible');
    document.body.classList.add('calendar-dialog-open');
    dialog.querySelector('.calendar-dialog__close').focus();

    const body = dialog.querySelector('#calendarDialogBody');
    if (calendarsList === null && !calendarsLoadFailed) {
      body.innerHTML = LOADING_HTML;
      I18n.applyToDOM();
    }

    await ensureCalendars();
    renderCalendarPicker();
    dialog.classList.toggle('calendar-dialog--no-calendar', !currentCalendarSlug);

    if (calendarsLoadFailed) {
      body.innerHTML = errorHtml('calendar.calendars_error', 'Could not load calendars. Please try again later.');
      I18n.applyToDOM();
      return;
    }
    if (!currentCalendarSlug) {
      body.innerHTML = NO_CALENDARS_HTML;
      I18n.applyToDOM();
      return;
    }
    renderYear(currentYear);
  }

  // Delegated so buttons added later (e.g. the Today's Event card, injected
  // after this runs) open the dialog too, without needing their own binding.
  function init() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-calendar-open]')) open();
    });
    // Lets other widgets (the event detail modal) jump to the full calendar.
    document.addEventListener('open-community-calendar', open);
  }

  return { init };
})();

// ─── In-app Notifications (new songs + today's events, checked while the site is open) ────
// Not push notifications — there's no server-side subscription or send path.
// While a tab is open we poll the same public APIs everything else here
// uses, diff against what's already been seen (localStorage), and surface
// the delta both in the panel and — if permission was granted — as a
// native browser Notification.
const NotificationsFeature = (() => {
  const ITEMS_KEY = 'ml_notif_items';
  const SEEN_SONGS_KEY = 'ml_notif_seen_songs';
  const SEEN_EVENTS_KEY = 'ml_notif_seen_events';
  const SEEN_ARTICLES_KEY = 'ml_notif_seen_articles';
  const MAX_ITEMS = 30;
  const MAX_SEEN = 500;
  const CHECK_INTERVAL_MS = 5 * 60 * 1000;

  let items = [];

  function loadItems() {
    try {
      const raw = localStorage.getItem(ITEMS_KEY);
      items = raw ? JSON.parse(raw) : [];
    } catch (e) {
      items = [];
    }
  }

  function saveItems() {
    items = items.slice(0, MAX_ITEMS);
    try { localStorage.setItem(ITEMS_KEY, JSON.stringify(items)); } catch (e) { /* ignore */ }
  }

  function getSeenSet(key) {
    try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch (e) { return new Set(); }
  }

  function saveSeenSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify(Array.from(set).slice(-MAX_SEEN))); } catch (e) { /* ignore */ }
  }

  function updateBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    const unread = items.filter((i) => !i.read).length;
    if (unread > 0) {
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function renderList() {
    const list = document.getElementById('notifList');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = `<p class="notif-panel__empty" data-i18n="notifications.empty">Nothing new yet.</p>`;
      I18n.applyToDOM();
      return;
    }
    list.innerHTML = items.map((item) => `
      <a href="${Utils.escapeHtml(item.url || '#')}" class="notif-item${item.read ? '' : ' unread'}" data-notif-id="${Utils.escapeHtml(item.id)}">
        <span class="notif-item__icon" aria-hidden="true">${{ song: '🎵', article: '📰', event: '📅' }[item.type] || '🔔'}</span>
        <span class="notif-item__body">
          <span class="notif-item__title">${Utils.escapeHtml(item.title)}</span>
          ${item.body ? `<span class="notif-item__meta">${Utils.escapeHtml(item.body)}</span>` : ''}
        </span>
      </a>`).join('');
  }

  function fireBrowserNotification(item) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(item.title, { body: item.body || '', icon: '/icon.svg', tag: item.id });
      n.onclick = () => {
        window.focus();
        if (item.url) window.location.href = item.url;
        n.close();
      };
    } catch (e) {
      // Notification constructor can throw in some contexts (e.g. certain mobile browsers) — the in-app panel still has it.
    }
  }

  function addItem(item) {
    items = items.filter((i) => i.id !== item.id);
    items.unshift(item);
    saveItems();
    updateBadge();
    renderList();
    fireBrowserNotification(item);
  }

  // All credited artists, up to 5 — "A, B, C and 2 more" beyond that. Falls back to the legacy
  // single artist_name/artist field when the API didn't send the `artists` list.
  const MAX_NOTIF_ARTISTS = 5;
  function artistsLabel(song) {
    const names = (Array.isArray(song.artists) ? song.artists.map((a) => a && a.name).filter(Boolean) : []);
    if (!names.length) return song.artist_name || song.artist || '';
    const shown = names.slice(0, MAX_NOTIF_ARTISTS).join(', ');
    const extra = names.length - MAX_NOTIF_ARTISTS;
    return extra > 0 ? shown + ' ' + I18n.t('notifications.and_more', { count: extra }) : shown;
  }

  async function checkNewSongs() {
    try {
      const data = await API.getSongs(1, null, 'created_desc');
      const songs = data.songs || [];
      const seen = getSeenSet(SEEN_SONGS_KEY);
      const firstRun = seen.size === 0;
      const freshSongs = songs.filter((s) => s.slug && !seen.has(s.slug));
      songs.forEach((s) => { if (s.slug) seen.add(s.slug); });
      saveSeenSet(SEEN_SONGS_KEY, seen);

      // First check ever: this seeds "already known" songs rather than notifying about the whole catalog.
      if (firstRun) return;

      freshSongs.forEach((song) => {
        addItem({
          id: 'song_' + song.slug,
          type: 'song',
          title: I18n.t('notifications.new_song_title'),
          body: song.title + (artistsLabel(song) ? ' — ' + artistsLabel(song) : ''),
          url: '/song/' + song.slug,
          read: false,
          ts: Date.now(),
        });
      });
    } catch (err) {
      console.warn('[notifications] failed to check new songs:', err);
    }
  }

  async function checkNewArticles() {
    try {
      // Sorted by published_at (the default) — that's what "just went live" means for
      // articles, unlike created_desc which wouldn't move when a long-drafted article
      // finally gets published.
      const data = await API.getArticles(1);
      const articles = data.articles || [];
      const seen = getSeenSet(SEEN_ARTICLES_KEY);
      const firstRun = seen.size === 0;
      const freshArticles = articles.filter((a) => a.slug && !seen.has(a.slug));
      articles.forEach((a) => { if (a.slug) seen.add(a.slug); });
      saveSeenSet(SEEN_ARTICLES_KEY, seen);

      // First check ever: seeds "already known" articles rather than notifying about the whole backlog.
      if (firstRun) return;

      freshArticles.forEach((article) => {
        addItem({
          id: 'article_' + article.slug,
          type: 'article',
          title: I18n.t('notifications.new_article_title'),
          body: article.title + ' — ' + article.author_name,
          url: '/article/' + article.slug,
          read: false,
          ts: Date.now(),
        });
      });
    } catch (err) {
      console.warn('[notifications] failed to check new articles:', err);
    }
  }

  async function checkTodaysEvents() {
    try {
      const todayStr = Utils.todayLocalISODate();
      const defaultCal = CalendarPrefs.get();
      const url = new URL('https://calendar-api.marareih.org/api/events');
      url.searchParams.set('year', new Date().getFullYear());
      if (defaultCal) url.searchParams.set('calendar', defaultCal);
      // See the matching comment in HomePage.getTodaysEvent() — this
      // endpoint is cached for 5 minutes server-side, which combined with
      // this poll's own 5-minute interval could delay a same-day event
      // notification by up to ~10 minutes. Bust both cache layers.
      url.searchParams.set('_', Date.now());

      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const todaysEvents = (data.events || []).filter((ev) => HomePage.isEventOnDate(ev, todayStr));

      const seen = getSeenSet(SEEN_EVENTS_KEY);
      todaysEvents.forEach((ev) => {
        const seenKey = ev.id + ':' + todayStr;
        if (seen.has(seenKey)) return;
        seen.add(seenKey);
        addItem({
          id: 'event_' + seenKey,
          type: 'event',
          title: I18n.t('notifications.event_today_title'),
          body: ev.title + (ev.location ? ' — ' + ev.location : ''),
          url: '/',
          // Kept on the item so clicking the notification can open the full event detail.
          event: { id: ev.id, title: ev.title, description: ev.description, location: ev.location, start: ev.start, end: ev.end },
          read: false,
          ts: Date.now(),
        });
      });
      saveSeenSet(SEEN_EVENTS_KEY, seen);
    } catch (err) {
      console.warn('[notifications] failed to check today\'s events:', err);
    }
  }

  function runChecks() {
    checkNewSongs();
    checkNewArticles();
    checkTodaysEvents();
  }

  function updatePermissionBanner() {
    const banner = document.getElementById('notifPermissionBanner');
    if (!banner) return;
    banner.hidden = !(typeof Notification !== 'undefined' && Notification.permission === 'default');
  }

  function markRead(id) {
    const item = items.find((i) => i.id === id);
    if (!item || item.read) return;
    item.read = true;
    saveItems();
    updateBadge();
    const el = document.querySelector(`.notif-item[data-notif-id="${CSS.escape(id)}"]`);
    if (el) el.classList.remove('unread');
  }

  function clearAll() {
    items = [];
    saveItems();
    updateBadge();
    renderList();
  }

  function init() {
    loadItems();
    updateBadge();
    renderList();
    updatePermissionBanner();

    const enableBtn = document.getElementById('notifEnableBtn');
    if (enableBtn) {
      enableBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (typeof Notification === 'undefined') return;
        const permission = await Notification.requestPermission();
        updatePermissionBanner();
        if (permission === 'granted' && typeof Toast !== 'undefined') {
          Toast.show(I18n.t('notifications.enabled_toast'), { type: 'success', duration: 2200 });
        }
      });
    }

    const clearBtn = document.getElementById('notifClearBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearAll();
      });
    }

    document.addEventListener('click', (e) => {
      const item = e.target.closest('.notif-item');
      if (!item) return;
      markRead(item.dataset.notifId);
      // Event notifications open the event itself instead of just landing on the homepage.
      // (Items saved before events were stored on them have no `event` and keep the old link.)
      const saved = items.find((i) => i.id === item.dataset.notifId);
      if (saved && saved.type === 'event' && saved.event) {
        e.preventDefault();
        const toggle = document.querySelector('.notif-toggle');
        if (toggle) {
          toggle.classList.remove('open');
          toggle.querySelector('.notif-toggle__btn')?.setAttribute('aria-expanded', 'false');
        }
        EventDetail.open(saved.event);
      }
    });

    runChecks();
    setInterval(runChecks, CHECK_INTERVAL_MS);
  }

  return { init };
})();

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.song-card__favorite, .song-page__favorite');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();

  const slug = btn.dataset.slug;
  if (!slug) return;
  const nowFavorited = Favorites.toggle(slug);

  if (nowFavorited === false && Pins.has(slug)) Pins.remove(slug); // un-favoriting also un-pins
  if (nowFavorited !== null) syncPinButtons(slug);

  if (nowFavorited === null) {
    if (typeof Toast !== 'undefined') Toast.show(I18n.t('toast.favorites_consent_required'), { type: 'warning' });
    return;
  }

  // Keep every button for this song in sync (it can appear in more than one grid at once).
  document.querySelectorAll(`.song-card__favorite[data-slug="${CSS.escape(slug)}"], .song-page__favorite[data-slug="${CSS.escape(slug)}"]`)
    .forEach((el) => updateFavoriteButton(el, nowFavorited));

  if (typeof Toast !== 'undefined') {
    Toast.show(I18n.t(nowFavorited ? 'toast.added_to_favorites' : 'toast.removed_from_favorites'), { type: 'success', duration: 2000 });
  }
});

// ─── Download buttons (cards, song page) ───────────────────────
function updateDownloadButton(btn, isDownloaded) {
  btn.classList.toggle('active', isDownloaded);
  btn.setAttribute('aria-pressed', String(isDownloaded));
  const label = I18n.t(isDownloaded ? 'common.downloaded_remove' : 'common.download');
  btn.setAttribute('aria-label', label);
  btn.title = label;
  const text = btn.querySelector('[data-download-label]');
  if (text) text.textContent = I18n.t(isDownloaded ? 'common.downloaded_btn' : 'common.download_btn');
}

/** Keeps every download button / mark for a song, and the nav badge, in step with its state. */
function syncDownloadUI(slug) {
  if (slug) {
    const downloaded = Downloads.has(slug);
    const sel = CSS.escape(slug);
    document.querySelectorAll(`.song-card__download[data-slug="${sel}"], .song-page__download[data-slug="${sel}"]`)
      .forEach((el) => { el.classList.remove('busy'); updateDownloadButton(el, downloaded); });
    document.querySelectorAll(`.song-card__dlmark[data-slug="${sel}"]`).forEach((el) => { el.hidden = !downloaded; });
  }
  updateDownloadsBadge();
}

function updateDownloadsBadge() {
  const count = Downloads.count;
  document.querySelectorAll('.downloads-toggle__badge').forEach((badge) => {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
  });
}

document.addEventListener('downloads-changed', (e) => {
  if (e.detail?.slug) syncDownloadUI(e.detail.slug); else {
    document.querySelectorAll('.song-card__download, .song-page__download').forEach((el) => updateDownloadButton(el, Downloads.has(el.dataset.slug)));
    document.querySelectorAll('.song-card__dlmark').forEach((el) => { el.hidden = !Downloads.has(el.dataset.slug); });
    updateDownloadsBadge();
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.song-card__download, .song-page__download');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const slug = btn.dataset.slug;
  if (!slug || btn.classList.contains('busy')) return;
  const toast = (key, type = 'success') => { if (typeof Toast !== 'undefined') Toast.show(I18n.t(key), { type, duration: 2400 }); };

  if (!Downloads.supported) { toast('downloads.unsupported', 'warning'); return; }

  // Removing a download is a deliberate act — downloaded songs are kept until the visitor says so.
  if (Downloads.has(slug)) {
    if (!window.confirm(I18n.t('downloads.confirm_remove'))) return;
    try {
      await Downloads.remove(slug);
      toast('downloads.removed');
    } catch (err) {
      console.warn('[downloads] remove failed:', err);
      toast('downloads.error', 'error');
    }
    return;
  }

  if (!Utils.isOnline()) { toast('downloads.need_internet', 'warning'); return; }
  btn.classList.add('busy');
  try {
    const song = await API.getSong(slug);
    await Downloads.add(song);
    Downloads.prepareOffline();
    toast('downloads.saved');
  } catch (err) {
    console.warn('[downloads] save failed:', err);
    btn.classList.remove('busy');
    toast('downloads.error', 'error');
  }
});

// Pin buttons only show for favorited songs; keep every copy of a song's pin button in step
// with its favorite/pin state, and refresh the home page's Pinned section.
function syncPinButtons(slug) {
  const favorited = Favorites.has(slug);
  const pinned = Pins.has(slug);
  document.querySelectorAll(`.song-card__pin[data-slug="${CSS.escape(slug)}"], .song-page__pin[data-slug="${CSS.escape(slug)}"]`)
    .forEach((el) => { el.hidden = !favorited; updatePinButton(el, pinned); });
  document.querySelectorAll(`.song-card[data-slug="${CSS.escape(slug)}"]`).forEach((el) => el.classList.toggle('song-card--pinned', pinned));
  if (typeof HomePage !== 'undefined' && HomePage.songGrid) HomePage.refreshList();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.song-card__pin, .song-page__pin');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const slug = btn.dataset.slug;
  if (!slug) return;

  const result = Pins.toggle(slug);
  const messages = {
    pinned: ['toast.pinned', 'success'],
    unpinned: ['toast.unpinned', 'success'],
    full: ['toast.pin_limit', 'warning'],
    not_favorite: ['toast.pin_requires_favorite', 'warning'],
    no_consent: ['toast.favorites_consent_required', 'warning'],
  };
  if (result === 'pinned' || result === 'unpinned') syncPinButtons(slug);
  const [key, type] = messages[result];
  if (typeof Toast !== 'undefined') Toast.show(I18n.t(key, { max: Pins.MAX }), { type, duration: 2200 });
});

// ─── App Initialization ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize cookie consent
  if (typeof CookieConsent !== 'undefined') CookieConsent.init();

  // Initialize i18n first
  try {
    await I18n.init();
  } catch (err) {
    console.warn('I18n.init failed:', err);
  }

  initAppPromotion();
  CalendarFeature.init();
  EventDetail.init();
  CalendarPrefs.initSelect();
  NotificationsFeature.init();
  // The calendar prompt (first visit only) goes first — once it's dismissed
  // (or skipped immediately, on a returning visit), the app promo dialog
  // follows on its usual delay, instead of the two stacking on top of each other.
  setTimeout(() => {
    CalendarPrefs.promptIfNeeded().then(() => {
      setTimeout(initAppPromotionDialog, 400);
    });
  }, 900);

  // Downloaded songs: load the saved list so cards and the nav badge reflect it from the start.
  await Downloads.init();
  updateDownloadsBadge();

  // Initialize theme
  Theme.init();

  // Restore the card/list display preference on every song grid on this page
  DisplayMode.init();

  // Settings + Notifications panel toggle(s) — opening one closes the other.
  const dropdownToggles = document.querySelectorAll('.settings-toggle, .notif-toggle');
  if (dropdownToggles.length) {
    dropdownToggles.forEach((wrap) => {
      const btn = wrap.querySelector('.settings-toggle__btn, .notif-toggle__btn');
      if (!btn) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdownToggles.forEach((other) => {
          if (other !== wrap) other.classList.remove('open');
        });
        wrap.classList.toggle('open');
      });
    });

    document.addEventListener('click', (e) => {
      dropdownToggles.forEach((wrap) => {
        if (!wrap.contains(e.target)) wrap.classList.remove('open');
      });
    });
  }

  // On small screens (where the desktop nav is hidden behind the menu button) pull the
  // Notifications and Settings icons out into the header bar, next to the menu button,
  // so they stay one tap away instead of being buried in the drawer. On larger screens
  // they go back to their place inside the desktop nav. The elements are moved, not
  // cloned, so their event listeners and state are preserved.
  (function pinHeaderActions() {
    const menuBtn = document.querySelector('.header__menu-btn');
    const inner = menuBtn && menuBtn.parentElement;
    const toggles = ['.notif-toggle', '.settings-toggle']
      .map((sel) => document.querySelector(sel))
      .filter(Boolean);
    if (!menuBtn || !inner || !toggles.length) return;

    const actions = document.createElement('div');
    actions.className = 'header__actions';
    inner.insertBefore(actions, menuBtn);

    // Remember each toggle's original spot so it can be restored on wide screens.
    const homes = toggles.map((el) => ({ el, parent: el.parentElement, next: el.nextElementSibling }));
    let pinned = false;

    function update() {
      const small = window.getComputedStyle(menuBtn).display !== 'none';
      if (small === pinned) return;
      pinned = small;
      homes.forEach(({ el, parent, next }) => {
        el.classList.remove('open');
        if (small) actions.appendChild(el);
        else if (next && next.parentElement === parent) parent.insertBefore(el, next);
        else parent.appendChild(el);
      });
    }
    update();
    window.addEventListener('resize', update);
  })();

  // Mobile drawer toggle
  const menuBtn = document.querySelector('.header__menu-btn');
  const mobileDrawer = document.querySelector('.mobile-drawer');
  const mobileDrawerClose = document.querySelector('.mobile-drawer__close');
  const mobileDrawerBackdrop = document.querySelector('.mobile-drawer__backdrop');
  const mobileDrawerLinks = document.querySelectorAll('.mobile-drawer__link');

  const closeMobileDrawer = () => {
    if (!mobileDrawer || !menuBtn) return;
    mobileDrawer.classList.remove('open');
    mobileDrawer.setAttribute('aria-hidden', 'true');
    menuBtn.setAttribute('aria-expanded', 'false');
  };

  const openMobileDrawer = () => {
    if (!mobileDrawer || !menuBtn) return;
    mobileDrawer.classList.add('open');
    mobileDrawer.setAttribute('aria-hidden', 'false');
    menuBtn.setAttribute('aria-expanded', 'true');
  };

  if (menuBtn && mobileDrawer) {
    menuBtn.addEventListener('click', () => {
      if (mobileDrawer.classList.contains('open')) {
        closeMobileDrawer();
      } else {
        openMobileDrawer();
      }
    });

    if (mobileDrawerClose) mobileDrawerClose.addEventListener('click', closeMobileDrawer);
    if (mobileDrawerBackdrop) mobileDrawerBackdrop.addEventListener('click', closeMobileDrawer);
    mobileDrawerLinks.forEach((link) => link.addEventListener('click', closeMobileDrawer));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mobileDrawer.classList.contains('open')) closeMobileDrawer();
    });

    window.addEventListener('resize', () => {
      const menuVisible = window.getComputedStyle(menuBtn).display !== 'none';
      if (!menuVisible && mobileDrawer.classList.contains('open')) {
        closeMobileDrawer();
      }
    });
  }

  initOfflineDetection();

  // Detect which page we're on
  const pageType = Utils.getPageType();

  switch (pageType) {
    case 'song':
      SongPage.init();
      break;
    case 'artist':
      ProfilePage.init('artist');
      break;
    case 'composer':
      ProfilePage.init('composer');
      break;
    case 'copyright-owner':
      CopyrightOwnerPage.init();
      break;
    case 'article':
      ArticlePage.init();
      break;
    case 'articles':
      ArticlesPage.init();
      break;
    case 'people':
      PeoplePage.init();
      break;
    case 'idol-index':
      IdolIndexPage.init();
      break;
    case 'idol-season':
      IdolSeasonPage.init();
      break;
    case 'idol':
      IdolProfilePage.init();
      break;
    case 'downloads':
      DownloadsPage.init();
      break;
    default:
      HomePage.init();
      break;
  }
});
