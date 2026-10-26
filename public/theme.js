// ╔══════════════════════════════════════════════════════════════╗
// ║        MaraLyrics — Theme Manager                           ║
// ║        Light · Dark · Follow System · Follow Time           ║
// ╚══════════════════════════════════════════════════════════════╝

'use strict';

const Theme = (() => {
  const STORAGE_KEY = 'ml_theme';
  const MODES = ['dark', 'light', 'system', 'time'];
  const DEFAULT_MODE = 'dark';

  let currentMode = DEFAULT_MODE;
  let systemQuery = null;
  let initialized = false;

  // ─── SVG Icons ───────────────────────────────────────
  const ICONS = {
    dark:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    light:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
    system: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    time:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  };

  const LABELS = {
    dark:   'theme.dark',
    light:  'theme.light',
    system: 'theme.system',
    time:   'theme.auto_time',
  };

  // ─── Helpers ─────────────────────────────────────────

  /** Determine effective theme (light or dark) based on mode. */
  function resolveTheme(mode) {
    if (mode === 'light') return 'light';
    if (mode === 'dark') return 'dark';
    if (mode === 'system') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    if (mode === 'time') {
      const hour = new Date().getHours();
      // Light from 6 AM to 6 PM
      return (hour >= 6 && hour < 18) ? 'light' : 'dark';
    }
    return 'dark';
  }

  /** Apply theme class to document. */
  function applyTheme() {
    const theme = resolveTheme(currentMode);
    document.documentElement.setAttribute('data-theme', theme);
    // Update header bg for light mode
    updateActiveButton();
  }

  /** Update which theme button is active. */
  function updateActiveButton() {
    document.querySelectorAll('.theme-switcher__btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === currentMode);
    });
  }

  // ─── Core API ────────────────────────────────────────

  /** Set and persist theme mode. */
  function setMode(mode) {
    if (!MODES.includes(mode)) mode = DEFAULT_MODE;
    currentMode = mode;
    // Only persist if user has accepted cookies
    if (typeof CookieConsent === 'undefined' || CookieConsent.hasConsent()) {
      localStorage.setItem(STORAGE_KEY, mode);
    }
    applyTheme();
    // Show toast only after initialization (not on page load)
    if (initialized && typeof Toast !== 'undefined') {
      const label = typeof I18n !== 'undefined' ? I18n.t(LABELS[mode]) : mode;
      const msg = typeof I18n !== 'undefined'
        ? I18n.t('toast.theme_changed', { theme: label })
        : 'Theme changed to ' + mode + '.';
      Toast.show(msg, { type: 'info', duration: 2500 });
    }
  }

  /** Get saved mode. */
  function getSavedMode() {
    const saved = localStorage.getItem(STORAGE_KEY);
    return MODES.includes(saved) ? saved : DEFAULT_MODE;
  }

  /** Initialize theme system. */
  function init() {
    currentMode = getSavedMode();
    applyTheme();

    // Listen for system preference changes
    systemQuery = window.matchMedia('(prefers-color-scheme: light)');
    systemQuery.addEventListener('change', () => {
      if (currentMode === 'system') applyTheme();
    });

    // For "time" mode, recheck every minute
    setInterval(() => {
      if (currentMode === 'time') applyTheme();
    }, 60000);

    // Bind buttons
    bindButtons();

    initialized = true;
  }

  /** Bind theme switcher buttons. */
  function bindButtons() {
    document.querySelectorAll('.theme-switcher__btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const mode = btn.dataset.theme;
        if (mode) {
          setMode(mode);
          // A theme the visitor chose follows their account to their other devices.
          if (typeof Sync !== 'undefined') Sync.record('pref', 'theme', true, mode);
        }
      });
    });
  }

  /** Get current mode. */
  function getMode() {
    return currentMode;
  }

  return { init, setMode, getMode, ICONS, LABELS };
})();
