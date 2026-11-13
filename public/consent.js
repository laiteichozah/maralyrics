// ╔══════════════════════════════════════════════════════════════╗
// ║        MaraLyrics — Cookie Consent Manager                  ║
// ║        GDPR Compliant · Beautiful · Minimal                 ║
// ╚══════════════════════════════════════════════════════════════╝

'use strict';

const CookieConsent = (() => {
  const CONSENT_KEY = 'ml_cookie_consent';

  /** Get current consent value. */
  function getConsent() {
    try { return localStorage.getItem(CONSENT_KEY); } catch { return null; }
  }

  /** Check if user accepted all cookies (preferences included). */
  function hasConsent() {
    return getConsent() === 'accepted';
  }

  /** Check if user chose essential-only. */
  function isEssentialOnly() {
    return getConsent() === 'essential';
  }

  /** Check if user has made any consent choice. */
  function hasResponded() {
    const c = getConsent();
    return c === 'accepted' || c === 'essential';
  }

  /** Accept all cookies. */
  function accept() {
    try { localStorage.setItem(CONSENT_KEY, 'accepted'); } catch {}
    hideBanner();
  }

  /** Accept essential only — clear non-essential data. */
  function decline() {
    try { localStorage.setItem(CONSENT_KEY, 'essential'); } catch {}
    // Clear non-essential stored data
    try {
      localStorage.removeItem('ml_theme');
      localStorage.removeItem('ml_lang');
      localStorage.removeItem('ml_christmas');
      localStorage.removeItem('ml_search_history');
      // Favorites live in a cookie, not localStorage — expire it directly rather than
      // depending on Cache/Favorites (defined later, in app.js) having loaded yet.
      document.cookie = 'ml_favorites=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/;';
    } catch {}
    hideBanner();
  }

  /** Hide the banner with animation. */
  function hideBanner() {
    const banner = document.getElementById('cookieConsent');
    if (banner) {
      banner.classList.remove('visible');
      banner.classList.add('hiding');
      setTimeout(() => banner.remove(), 500);
    }
  }

  /** Create and show the consent banner. */
  function showBanner() {
    if (document.getElementById('cookieConsent')) return;

    const banner = document.createElement('div');
    banner.id = 'cookieConsent';
    banner.className = 'cookie-consent';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('data-i18n-aria', 'consent.aria_label');
    banner.setAttribute('aria-label', typeof I18n !== 'undefined' ? I18n.t('consent.aria_label') : 'Cookie consent');

    // Falls back to the literal default both when I18n isn't loaded yet AND when it's
    // loaded but the locale fetch hasn't resolved (t() then just echoes the raw key back).
    const _t = (key, fallback) => {
      if (typeof I18n === 'undefined') return fallback;
      const val = I18n.t(key);
      return val === key ? fallback : val;
    };

    banner.innerHTML = `
      <div class="cookie-consent__inner">
        <div class="cookie-consent__content">
          <div class="cookie-consent__icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <circle cx="8" cy="9" r="1" fill="currentColor" stroke="none"/>
              <circle cx="13" cy="7" r="1" fill="currentColor" stroke="none"/>
              <circle cx="16" cy="11" r="1" fill="currentColor" stroke="none"/>
              <circle cx="9" cy="14" r="1" fill="currentColor" stroke="none"/>
              <circle cx="14" cy="16" r="1" fill="currentColor" stroke="none"/>
            </svg>
          </div>
          <div class="cookie-consent__text">
            <p class="cookie-consent__title" data-i18n="consent.title">${_t('consent.title', 'We use cookies')}</p>
            <p class="cookie-consent__desc"><span data-i18n="consent.desc">${_t('consent.desc', 'This site uses cookies and local storage to save your language, theme, and search history for a better experience.')}</span> <a href="/privacy" class="cookie-consent__link" data-i18n="consent.learn_more">${_t('consent.learn_more', 'Learn more')}</a></p>
          </div>
        </div>
        <div class="cookie-consent__actions">
          <button class="cookie-consent__btn cookie-consent__btn--accept" id="cookieAccept" data-i18n="consent.accept_all">${_t('consent.accept_all', 'Accept All')}</button>
          <button class="cookie-consent__btn cookie-consent__btn--decline" id="cookieDecline" data-i18n="consent.essential_only">${_t('consent.essential_only', 'Essential Only')}</button>
        </div>
      </div>
    `;

    document.body.appendChild(banner);

    // Trigger entrance animation
    requestAnimationFrame(() => {
      requestAnimationFrame(() => banner.classList.add('visible'));
    });

    document.getElementById('cookieAccept').addEventListener('click', accept);
    document.getElementById('cookieDecline').addEventListener('click', decline);
  }

  /** Initialize — show banner if no consent decision made yet. */
  function init() {
    if (!hasResponded()) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(showBanner, 800));
      } else {
        setTimeout(showBanner, 800);
      }
    }
  }

  return { init, hasConsent, isEssentialOnly, hasResponded, accept, decline };
})();
