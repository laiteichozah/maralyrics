// ╔══════════════════════════════════════════════════════════════╗
// ║        MaraLyrics — Christmas theme                         ║
// ║        Falling snow · Christmas trees · until 31 December   ║
// ╚══════════════════════════════════════════════════════════════╝
//
// From 13 November to 31 December 2026 (the visitor's own calendar) the site dresses up:
//   • a festive palette (the [data-season="christmas"] rules in style.css, dark and light),
//   • snow falling over the page (a canvas that ignores the mouse and touch),
//   • three Christmas trees and a pile of gifts standing in the snow above the footer,
//   • and a switch in Settings, so anybody can turn all of it off (and back on).
// On 1 January it all disappears by itself: nothing is added to the page out of season (the file is only read).
//
// The snow is left out for visitors who asked their device for less motion (prefers-reduced-motion) or for less data
// (Save-Data); the lights, trees and colours stay, as they do not move... except for a slow twinkle that the stylesheet
// also stops under prefers-reduced-motion.
//
//   https://maralyrics.com/?christmas=preview     shows the theme on any day of the year (not remembered; for looking at it)
//
// To change the dates, change SEASONS below (year, month and day as one number, both days included). To bring the theme
// back next year, add next year's window to the list (and to the check in scripts/check-christmas.mjs).
'use strict';

const Christmas = (() => {
  const SEASONS = [[20261113, 20261231]];   // 13 November to 31 December 2026, both days included (yyyymmdd)
  const STORAGE_KEY = 'ml_christmas';       // 'off' = the visitor turned the theme off (kept like the theme and language, with consent)

  /** Is this date inside a season? The visitor's own calendar day, the whole day. */
  function isSeason(date = new Date()) {
    const day = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
    return SEASONS.some(([from, until]) => day >= from && day <= until);
  }

  const previewing = () => { try { return /[?&]christmas=preview(?:&|#|$)/.test(location.search); } catch (_) { return false; } };
  const readChoice = () => { try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; } };

  let enabled = true;     // the visitor's choice
  let running = false;    // the theme is on the page right now
  let sceneEl = null;
  const stats = { frames: 0 };

  // ─── The trees ───────────────────────────────────────────────
  const BULB_COLORS = ['#ff5a5a', '#ffd54a', '#63c7ff', '#ff8ad8'];

  /** One Christmas tree as inline SVG (a unique `uid` keeps the gradient ids apart when there are several on a page). */
  function treeSvg(uid, cls) {
    const tiers = [
      { top: 14, base: 52, hw: 22, bulbs: 4 },
      { top: 32, base: 84, hw: 32, bulbs: 5 },
      { top: 52, base: 114, hw: 44, bulbs: 7 },
    ];
    const bulbs = BULB_COLORS.map(() => []);
    let body = '';
    tiers.slice().reverse().forEach((tier, drawn) => {
      const index = tiers.length - 1 - drawn;
      const { top, base, hw, bulbs: n } = tier;
      body += `<polygon points="50,${top} ${50 - hw},${base} ${50 + hw},${base}" fill="url(#xg-${uid})" stroke="#0b3d24" stroke-width="1.4" stroke-linejoin="round"/>`;
      // snow on the branches: a cap with a ragged lower edge
      const t = 0.4;
      const ly = top + (base - top) * t;
      const lx = hw * t;
      let cap = `50,${top} ${(50 - lx).toFixed(1)},${ly.toFixed(1)}`;
      for (let i = 1; i <= 4; i++) cap += ` ${(50 - lx + (2 * lx * i) / 4).toFixed(1)},${(ly + (i % 2 ? 3.4 : -0.4)).toFixed(1)}`;
      body += `<polygon points="${cap}" fill="#f4f9ff" stroke="#f4f9ff" stroke-width="1.4" stroke-linejoin="round"/>`;
      // a string of lights sagging across the tier
      const f = 0.74;
      const y0 = top + (base - top) * f;
      const x0 = 50 - hw * f + 3.5;
      const x1 = 50 + hw * f - 3.5;
      for (let i = 0; i < n; i++) {
        const x = x0 + ((x1 - x0) * i) / (n - 1);
        const y = y0 + 3.4 * Math.sin((Math.PI * i) / (n - 1));
        bulbs[(i + index) % BULB_COLORS.length].push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.2" fill="${BULB_COLORS[(i + index) % 4]}" opacity=".28"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="${BULB_COLORS[(i + index) % 4]}"/>`);
      }
    });
    body += '<rect x="44" y="113" width="12" height="14" rx="1.5" fill="#7a4a22"/>';
    // the baubles
    [[53, 48, 2.8, '#ff5a5a'], [37, 70, 3.2, '#ffd54a'], [63, 72, 3, '#63c7ff'], [62, 98, 3.4, '#ff5a5a'], [32, 101, 3, '#ffd54a'], [48, 92, 3, '#ff8ad8']]
      .forEach(([x, y, r, c]) => { body += `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" stroke="#0b3d24" stroke-width=".6"/><circle cx="${x - r * 0.35}" cy="${y - r * 0.35}" r="${r * 0.3}" fill="#fff" opacity=".75"/>`; });
    bulbs.forEach((group, i) => { body += `<g class="xmas-bulbs xmas-bulbs--${i}">${group.join('')}</g>`; });
    // the star
    let star = '';
    for (let i = 0; i < 10; i++) {
      const angle = ((-90 + i * 36) * Math.PI) / 180;
      const r = i % 2 ? 3.8 : 9;
      star += `${(50 + r * Math.cos(angle)).toFixed(1)},${(11 + r * Math.sin(angle)).toFixed(1)} `;
    }
    body += `<circle class="xmas-halo" cx="50" cy="11" r="15" fill="#ffd54a" opacity=".3"/><polygon points="${star.trim()}" fill="#ffd54a" stroke="#e0a800" stroke-width=".8" stroke-linejoin="round"/>`;
    return `<svg class="xmas-tree ${cls}" viewBox="0 0 100 128" aria-hidden="true" focusable="false"><defs><linearGradient id="xg-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3fb36b"/><stop offset="1" stop-color="#12643a"/></linearGradient></defs>${body}</svg>`;
  }

  const bow = (x, y, color) => `<g transform="translate(${x} ${y})"><ellipse cx="-4.5" cy="-1" rx="5" ry="3" transform="rotate(-25 -4.5 -1)" fill="${color}"/><ellipse cx="4.5" cy="-1" rx="5" ry="3" transform="rotate(25 4.5 -1)" fill="${color}"/><circle cx="0" cy="0" r="2.2" fill="${color}" stroke="#0003" stroke-width=".4"/></g>`;

  /** A pile of presents, as inline SVG. */
  function giftsSvg() {
    return '<svg class="xmas-gifts" viewBox="0 0 106 52" aria-hidden="true" focusable="false">'
      + '<rect x="2" y="26" width="30" height="24" rx="2" fill="#d93a3a"/><rect x="14" y="26" width="6" height="24" fill="#ffd54a"/><rect x="2" y="35" width="30" height="5" fill="#ffd54a"/>' + bow(17, 25, '#ffd54a')
      + '<rect x="36" y="14" width="32" height="36" rx="2" fill="#2f7be5"/><rect x="49" y="14" width="6" height="36" fill="#ff5a5a"/><rect x="36" y="27" width="32" height="5" fill="#ff5a5a"/>' + bow(52, 13, '#ff5a5a')
      + '<rect x="72" y="30" width="28" height="20" rx="2" fill="#1f9d55"/><rect x="83" y="30" width="6" height="20" fill="#f4f9ff"/><rect x="72" y="37" width="28" height="4.5" fill="#f4f9ff"/>' + bow(86, 29, '#f4f9ff')
      + '</svg>';
  }

  const WAVE = '<svg class="xmas-scene__wave" viewBox="0 0 1440 16" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path fill="currentColor" d="M0 16V9C100 1 220 1 340 7S570 15 710 8 960 0 1100 5 1340 13 1440 4V16Z"/><path class="xmas-scene__edge" fill="none" vector-effect="non-scaling-stroke" d="M0 9C100 1 220 1 340 7S570 15 710 8 960 0 1100 5 1340 13 1440 4"/></svg>';

  function addScene() {
    const footer = document.querySelector('.footer');
    if (sceneEl || !footer) return;
    sceneEl = document.createElement('div');
    sceneEl.className = 'xmas-scene';
    sceneEl.setAttribute('data-xmas', '');
    sceneEl.innerHTML = `
      <div class="xmas-scene__trees" aria-hidden="true">
        ${treeSvg('a', 'xmas-tree--md')}${treeSvg('b', 'xmas-tree--lg')}${giftsSvg()}${treeSvg('c', 'xmas-tree--sm')}
      </div>
      <div class="xmas-scene__ground">
        ${WAVE}
        <p class="xmas-scene__greeting"><span aria-hidden="true">❄︎</span> <span data-i18n="christmas.greeting">Merry Christmas from MaraLyrics</span> <span aria-hidden="true">❄︎</span></p>
      </div>`;
    footer.before(sceneEl);
    translate();
  }

  function removeScene() {
    if (sceneEl) sceneEl.remove();
    sceneEl = null;
  }

  // ─── The snow ────────────────────────────────────────────────
  let canvas = null;
  let ctx = null;
  let flakes = [];
  let width = 0;
  let height = 0;
  let ratio = 1;
  let frame = 0;
  let last = 0;
  let clock = 0;
  let resizeTimer = 0;
  let sprite = null;
  let ink = '255,255,255';
  let themeWatch = null;

  /** Visitors who asked for less motion or less data get the lights and the trees, without the falling snow. */
  function calm() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
      return !!(navigator.connection && navigator.connection.saveData);
    } catch (_) { return false; }
  }

  const wantedFlakes = () => Math.round(Math.min(130, Math.max(36, (width * height) / 15000)));

  function newFlake(anywhere) {
    const depth = Math.random();            // 0 far away … 1 close
    return {
      x: Math.random() * width,
      y: anywhere ? Math.random() * height : -12 - Math.random() * 60,
      r: 0.8 + depth * 2.4,
      vy: 22 + depth * 50,                   // px per second
      sway: 8 + Math.random() * 18,
      freq: 0.5 + Math.random() * 0.9,
      phase: Math.random() * Math.PI * 2,
      a: 0.35 + depth * 0.55,
      star: depth > 0.88,                    // the few biggest are little six-armed flakes
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 1.4,
    };
  }

  /** A six-armed snowflake drawn once, in the colour the snow has on this theme. */
  function makeSprite() {
    const s = document.createElement('canvas');
    s.width = s.height = 48;
    const c = s.getContext('2d');
    c.translate(24, 24);
    c.strokeStyle = `rgb(${ink})`;
    c.lineCap = 'round';
    for (let arm = 0; arm < 6; arm++) {
      c.rotate(Math.PI / 3);
      c.lineWidth = 3;
      c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -20); c.stroke();
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(0, -11); c.lineTo(-5, -16); c.moveTo(0, -11); c.lineTo(5, -16); c.stroke();
    }
    return s;
  }

  const pickInk = () => { ink = document.documentElement.getAttribute('data-theme') === 'light' ? '104,146,196' : '255,255,255'; };

  function resize() {
    if (!canvas) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    // phones keep changing the height as the address bar slides away: that is not a new size
    if (w === width && Math.abs(h - height) < 120 && canvas.width) return;
    const sx = width ? w / width : 1;
    const sy = height ? h / height : 1;
    width = w; height = h;
    ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    flakes.forEach((f) => { f.x *= sx; f.y *= sy; });
    const wanted = wantedFlakes();
    while (flakes.length < wanted) flakes.push(newFlake(true));
    if (flakes.length > wanted) flakes.length = wanted;
  }

  function tick(now) {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    clock += dt;
    const wind = Math.sin(clock * 0.12) * 14;
    ctx.clearRect(0, 0, width, height);
    for (const f of flakes) {
      f.y += f.vy * dt;
      f.x += (Math.sin(clock * f.freq + f.phase) * f.sway + wind * (0.4 + f.r / 3)) * dt;
      f.rot += f.spin * dt;
      if (f.y > height + 10) { f.y = -10; f.x = Math.random() * width; }
      if (f.x < -12) f.x = width + 12; else if (f.x > width + 12) f.x = -12;
      if (f.star) {
        const size = f.r * 5;                // a little smaller and fainter than a dot of the same size, so that they never hide a word
        ctx.save();
        ctx.globalAlpha = f.a * 0.8;
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rot);
        ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
        ctx.restore();
      } else {
        ctx.fillStyle = `rgba(${ink},${f.a.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    stats.frames++;
  }

  function play() {
    if (frame || !canvas) return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function pause() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  const onVisibility = () => { if (document.hidden) pause(); else play(); };
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150); };

  function addSnow() {
    if (canvas || calm() || !document.body) return;
    canvas = document.createElement('canvas');
    canvas.className = 'xmas-snow';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    if (!ctx) { canvas.remove(); canvas = null; return; }
    width = height = 0;
    flakes = [];
    pickInk();
    sprite = makeSprite();
    resize();
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);
    // a different colour theme (light, dark) changes the colour of the snow
    themeWatch = new MutationObserver(() => { pickInk(); sprite = makeSprite(); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (!document.hidden) play();
  }

  function removeSnow() {
    pause();
    clearTimeout(resizeTimer);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    if (themeWatch) themeWatch.disconnect();
    themeWatch = null;
    if (canvas) canvas.remove();
    canvas = ctx = sprite = null;
    flakes = [];
  }

  // ─── Settings: the switch ────────────────────────────────────
  const SNOWFLAKE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="2" x2="12" y2="22"/><line x1="3.3" y1="7" x2="20.7" y2="17"/><line x1="3.3" y1="17" x2="20.7" y2="7"/><polyline points="9 4 12 6.5 15 4"/><polyline points="9 20 12 17.5 15 20"/></svg>';

  function translate() {
    try { if (typeof I18n !== 'undefined') I18n.applyToDOM(); } catch (_) { /* the English text in the markup stays */ }
  }

  function addSwitch() {
    const panel = document.querySelector('.settings-panel');
    if (!panel || panel.querySelector('[data-xmas-setting]')) return;
    const row = document.createElement('div');
    row.setAttribute('data-xmas-setting', '');
    row.innerHTML = `
      <div class="settings-panel__divider"></div>
      <div class="settings-panel__section">
        <div class="settings-panel__label">${SNOWFLAKE}<span id="xmasSettingLabel" data-i18n="christmas.setting">Christmas theme</span></div>
        <button type="button" class="xmas-switch" role="switch" aria-checked="${enabled}" aria-labelledby="xmasSettingLabel">
          <span class="xmas-switch__knob" aria-hidden="true"></span>
          <span class="xmas-switch__text" data-i18n="${enabled ? 'christmas.on' : 'christmas.off'}">${enabled ? 'On' : 'Off'}</span>
        </button>
      </div>`;
    panel.appendChild(row);
    row.querySelector('.xmas-switch').addEventListener('click', () => setEnabled(!enabled));
    translate();
  }

  function syncSwitch() {
    const button = document.querySelector('[data-xmas-setting] .xmas-switch');
    if (!button) return;
    button.setAttribute('aria-checked', String(enabled));
    const text = button.querySelector('.xmas-switch__text');
    text.setAttribute('data-i18n', enabled ? 'christmas.on' : 'christmas.off');
    text.textContent = enabled ? 'On' : 'Off';
    translate();
  }

  // ─── On and off ──────────────────────────────────────────────
  function start() {
    if (running) return;
    running = true;
    document.documentElement.setAttribute('data-season', 'christmas');
    addScene();
    addSnow();
  }

  function stop() {
    running = false;
    document.documentElement.removeAttribute('data-season');
    removeSnow();
    removeScene();
  }

  /** The visitor's switch. Remembered like the theme and the language (only when cookies for preferences were accepted). */
  function setEnabled(on) {
    enabled = !!on;
    if (!previewing() && (typeof CookieConsent === 'undefined' || CookieConsent.hasConsent())) {
      try { if (enabled) localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, 'off'); } catch (_) { /* storage blocked */ }
    }
    if (enabled) start(); else stop();
    syncSwitch();
  }

  function init() {
    if (!isSeason() && !previewing()) return;     // out of season nothing at all is added to the page
    enabled = previewing() ? true : readChoice() !== 'off';
    addSwitch();
    if (enabled) start();
    // a device that switches to "reduce motion" while the page is open stops the snow at once
    try {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      const change = () => { if (!running) return; if (calm()) removeSnow(); else addSnow(); };
      if (query.addEventListener) query.addEventListener('change', change);
    } catch (_) { /* old browser: the setting is read when the page opens */ }
  }

  if (typeof document !== 'undefined') init();

  return { isSeason, isActive: () => running, isEnabled: () => enabled, setEnabled, frames: () => stats.frames, SEASONS };
})();
