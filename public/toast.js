// ╔══════════════════════════════════════════════════════════════╗
// ║        MaraLyrics — Toast & Offline Detection Module        ║
// ║        Centralized · Reusable · Mobile-Friendly             ║
// ╚══════════════════════════════════════════════════════════════╝

'use strict';

const Toast = (() => {
  let toastEl = null;
  let hideTimer = null;
  let currentKey = null;

  // ─── Icons (inline SVG) ──────────────────────────────
  const ICONS = {
    success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    warning: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    error:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  };

  // ─── Helpers ─────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getEl() {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'ml-toast';
      toastEl.setAttribute('role', 'alert');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    return toastEl;
  }

  // ─── Show Toast ──────────────────────────────────────
  /**
   * Show a toast notification.
   * @param {string} message - The message to display.
   * @param {Object} [options]
   * @param {number}  [options.duration=3500] - Auto-dismiss time in ms.
   * @param {string}  [options.type='info']   - 'info' | 'success' | 'warning' | 'error'
   * @param {string}  [options.id]            - Unique ID for deduplication.
   */
  function show(message, options = {}) {
    const { duration = 3500, type = 'info', id = null } = options;
    const key = id || message;

    // Deduplicate: skip if same toast is currently visible
    if (currentKey === key && toastEl && toastEl.classList.contains('ml-toast--visible')) {
      return;
    }

    const el = getEl();
    clearTimeout(hideTimer);

    // Remove previous classes
    el.classList.remove('ml-toast--visible', 'ml-toast--exit');
    el.className = 'ml-toast ml-toast--' + type;

    // Build content
    const icon = ICONS[type] || ICONS.info;
    el.innerHTML =
      '<span class="ml-toast__icon">' + icon + '</span>' +
      '<span class="ml-toast__text">' + escapeHtml(message) + '</span>';

    currentKey = key;

    // Trigger enter animation (double rAF for reliable reflow)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.classList.add('ml-toast--visible');
      });
    });

    // Auto-dismiss
    hideTimer = setTimeout(() => hide(), duration);
  }

  // ─── Hide Toast ──────────────────────────────────────
  function hide() {
    if (!toastEl) return;
    toastEl.classList.remove('ml-toast--visible');
    toastEl.classList.add('ml-toast--exit');
    currentKey = null;
  }

  // ─── Offline Detection & Header Badge ────────────────
  let offlineInitialized = false;

  function initOffline() {
    if (offlineInitialized) return;
    offlineInitialized = true;

    // Create header badge dynamically
    const headerInner = document.querySelector('.header__inner');
    if (headerInner && !document.getElementById('offlineHeaderBadge')) {
      const badge = document.createElement('div');
      badge.id = 'offlineHeaderBadge';
      badge.className = 'offline-header-badge';
      badge.innerHTML =
        '<span class="offline-header-badge__dot"></span>' +
        '<span class="offline-header-badge__text" data-i18n="offline.badge_text">' + (typeof I18n !== 'undefined' ? I18n.t('offline.badge_text') : 'Offline') + '</span>';
      // Insert after logo, before nav
      const logo = headerInner.querySelector('.header__logo');
      if (logo && logo.nextElementSibling) {
        headerInner.insertBefore(badge, logo.nextElementSibling);
      } else {
        headerInner.appendChild(badge);
      }
    }

    let wasOffline = !navigator.onLine;

    window.addEventListener('online', () => {
      setBadge(false);
      if (wasOffline) {
        const msg = typeof I18n !== 'undefined' ? I18n.t('toast.back_online') : 'Back online.';
        show(msg, { type: 'success', id: 'connectivity', duration: 3000 });
        wasOffline = false;
      }
    });

    window.addEventListener('offline', async () => {
      // The browser says it lost the network: believe it only when a real request fails too.
      if (await reachable()) return;
      setBadge(true);
      wasOffline = true;
      const msg = typeof I18n !== 'undefined'
        ? I18n.t('toast.offline_message')
        : 'No internet connection. You are viewing offline mode. Some features may not be available.';
      show(
        msg,
        { type: 'warning', id: 'connectivity', duration: 5000 }
      );
    });

    // Initial state. navigator.onLine is only a hint: headless browsers, page renderers and sandboxes report false although the page
    // just came over the network. Saying "Offline" for those is wrong (a search or AI tool then shows a site that "is offline"), so
    // the badge waits for a real request to fail.
    if (!navigator.onLine) {
      reachable().then((up) => { if (!up) setBadge(true); else wasOffline = false; });
    }
  }

  /**
   * Can the site's server be reached? Any answer at all (even an error page) proves a connection; only a request that fails does not.
   * It is a HEAD request with no-cors: the service worker leaves non-GET requests alone, so it cannot answer for the network, and the
   * answer needs no CORS permission to be counted. Gives up after `timeoutMs` (6 seconds unless asked).
   */
  function reachable(timeoutMs = 6000) {
    const base = typeof CONFIG !== 'undefined' && CONFIG.API_BASE ? CONFIG.API_BASE : 'https://api.maralyrics.com/api/v1';
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
    return fetch(base, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) })
      .then(() => true, () => false)
      .finally(() => clearTimeout(timer));
  }

  /** Toggle the header offline badge. */
  function setBadge(offline) {
    const badge = document.getElementById('offlineHeaderBadge');
    if (badge) badge.classList.toggle('visible', offline);
  }

  // ─── Public API ──────────────────────────────────────
  return { show, hide, initOffline, setBadge, reachable };
})();
