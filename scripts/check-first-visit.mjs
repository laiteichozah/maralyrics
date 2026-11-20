#!/usr/bin/env node
// A new visitor, and a crawler, meet the home page: nothing jumps, and nothing covers it.   npm run test:firstvisit
//
// Measured on a phone over slow 4G before this change: the home page shifted by 0.78 (Google's "good" is 0.1) because two sections
// (Song of the Day, 275 px, and Featured Artists & Composers, 249 px) were display:none until their data arrived and then pushed
// everything down; a full-screen "Pick your calendar" dialog covered every page, song pages included, 0.9 s after load, for crawlers
// too; and the cookie notice filled a third of a phone screen.
//
// Pure helpers are lifted out of public/app.js and run here; the rest is read from the source, the page and the stylesheet.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const APP = read('public/app.js');
const CSS = read('public/style.css');
const HOME = read('public/index.html');

let passes = 0;
let failures = 0;
const check = (cond, msg) => { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } };

/** A top-level function of app.js, run on its own with the given globals. */
function lift(names, globals) {
  const code = names.map((name) => {
    const m = APP.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
    if (!m) { failures++; console.error(`  ✗ function ${name} is missing from app.js`); return `function ${name}() { return undefined; }`; }   // a stub, so the checks below fail cleanly
    return m[0];
  }).join('\n');
  return vm.runInNewContext(`${code}\n({ ${names.join(', ')} })`, globals);
}

// ─── who is asked ────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('Automated visitors');
const asking = (userAgent, webdriver = false) => lift(['isAutomatedVisitor'], { navigator: { userAgent, webdriver } }).isAutomatedVisitor();
const CRAWLERS = {
  Googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Googlebot smartphone': 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'AdSense crawler': 'Mediapartners-Google',
  AdsBot: 'AdsBot-Google (+http://www.google.com/adsbot.html)',
  'Search Console': 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
  Lighthouse: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
  PageSpeed: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 PageSpeed',
  'headless Chrome': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36',
  bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  DuckDuckBot: 'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
  Applebot: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  'a generic crawler': 'Example-Crawler/1.0 (+https://example.com/crawler)',
};
for (const [name, ua] of Object.entries(CRAWLERS)) check(asking(ua) === true, `${name} is recognised as automated`);
check(asking('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', true) === true, 'a browser driven by automation (navigator.webdriver) is recognised');
const PEOPLE = {
  'Chrome on Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Chrome on Android': 'Mozilla/5.0 (Linux; Android 13; SM-A176B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'Safari on iPhone': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Firefox on Linux': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Samsung Internet': 'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
  'a Cubot phone (its name ends in "bot")': 'Mozilla/5.0 (Linux; Android 12; CUBOT P60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  'UC Browser': 'Mozilla/5.0 (Linux; U; Android 9; en-US; Redmi Note 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 UCBrowser/13.4.0.1306 Mobile Safari/537.36',
  'Opera Mini': 'Opera/9.80 (Android; Opera Mini/36.2.2254/119.132; U; id) Presto/2.12.423 Version/12.16',
};
for (const [name, ua] of Object.entries(PEOPLE)) check(asking(ua) === false, `${name} is NOT mistaken for a crawler`);
check(lift(['isAutomatedVisitor'], {}).isAutomatedVisitor() === false, 'with no navigator at all it does not guess');

// ─── when they are asked ─────────────────────────────────────────────────────────────────────────────────────────────────
console.log('Waiting for the visitor');
function stage({ ua = PEOPLE['Chrome on Android'], webdriver = false } = {}) {
  const listeners = [];
  const timers = [];
  const win = {
    addEventListener: (name, fn, opts) => listeners.push({ name, fn, capture: opts === true || !!(opts && opts.capture), passive: !!(opts && opts.passive) }),
    removeEventListener: (name, fn, opts) => { const i = listeners.findIndex((l) => l.name === name && l.fn === fn && l.capture === (opts === true || !!(opts && opts.capture))); if (i >= 0) listeners.splice(i, 1); },
  };
  const api = lift(['isAutomatedVisitor', 'afterFirstInteraction'], { navigator: { userAgent: ua, webdriver }, window: win, setTimeout: (fn, ms) => timers.push({ fn, ms }) });
  return { api, listeners, timers, fire: (name) => listeners.filter((l) => l.name === name).forEach((l) => l.fn({ type: name })) };
}
let s = stage();
let calls = 0;
s.api.afterFirstInteraction(() => { calls++; });
check(s.listeners.length >= 4 && s.timers.length === 0 && calls === 0, 'nothing is scheduled until the visitor does something');
check(['pointerdown', 'keydown', 'touchstart', 'scroll'].every((n) => s.listeners.some((l) => l.name === n)), 'a tap, a key press, a touch and a scroll all count');
check(s.listeners.every((l) => l.passive && l.capture), 'the listeners are passive (they never slow scrolling) and see the event first');
s.fire('scroll');
check(s.timers.length === 1 && s.timers[0].ms === 3000 && calls === 0, 'the first interaction schedules the question 3 seconds later, not at once');
s.fire('pointerdown'); s.fire('scroll');
check(s.timers.length === 1, 'further interaction does not schedule it again');
check(s.listeners.length === 0, 'the listeners are removed after the first one');
s.timers[0].fn();
check(calls === 1, 'the question is asked exactly once');
s = stage();
s.api.afterFirstInteraction(() => { calls++; }, 500);
s.fire('keydown');
check(s.timers[0].ms === 500, 'the delay can be chosen');

for (const [name, opts] of [['Googlebot', { ua: CRAWLERS.Googlebot }], ['the AdSense crawler', { ua: CRAWLERS['AdSense crawler'] }], ['Lighthouse', { ua: CRAWLERS.Lighthouse }], ['an automated browser', { webdriver: true }]]) {
  const t = stage(opts);
  let asked = 0;
  t.api.afterFirstInteraction(() => { asked++; });
  t.fire('scroll'); t.fire('pointerdown');
  check(t.listeners.length === 0 && t.timers.length === 0 && asked === 0, `${name} is never asked anything`);
}

// ─── what app.js does with it ────────────────────────────────────────────────────────────────────────────────────────────
console.log('Start-up');
const startup = /afterFirstInteraction\(\(\) => \{[\s\S]*?\n  \}\);/.exec(APP)?.[0] || '';
check(startup.length > 0, 'the first-visit questions are scheduled through afterFirstInteraction');
check(/CalendarPrefs\.promptIfNeeded\(\)/.test(startup) && /initAppPromotionDialog/.test(startup), 'both questions (calendar, Android app) are inside it');
check(/getPageType\(\) === 'home'/.test(startup) && /Promise\.resolve\(\)/.test(startup), 'the calendar question is asked on the home page only (it is about Today\'s Event there), never over a song page');
check(!/\n  \}, 900\);\n/.test(APP), 'the old timer that opened the dialogs 0.9 s after load is gone');
check((APP.match(/CalendarPrefs\.promptIfNeeded\(\)/g) || []).length === 1, 'the calendar question is asked from one place only (the start-up block above)');

// ─── nothing jumps ───────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('Reserved space');
for (const id of ['songOfTheDaySection', 'featuredPeopleSection']) {
  const section = new RegExp(`<section id="${id}"[^>]*style="display:none;"[^>]*>[\\s\\S]*?</section>\\s*<div class="late-reserve" aria-hidden="true"></div>`);
  check(section.test(HOME), `${id} is followed by a reserve block (it still starts hidden, so nothing changes if there is nothing to show)`);
}
check(/\.late-reserve\s*\{\s*display:\s*none;?\s*\}/.test(CSS), 'a reserve block is invisible by default');
const rule = (id) => new RegExp(`#${id}\\[style\\*="display:none"\\] \\+ \\.late-reserve \\{ display: block; min-height: (\\d+)px; \\}`);
check(rule('songOfTheDaySection').test(CSS) && Number(rule('songOfTheDaySection').exec(CSS)[1]) === 275, 'it holds 275 px while Song of the Day is not there yet (its height on a phone)');
check(rule('featuredPeopleSection').test(CSS) && Number(rule('featuredPeopleSection').exec(CSS)[1]) === 249, 'it holds 249 px while Featured Artists & Composers is not there yet');
check(/@media \(max-width: 380px\) \{[^}]*#songOfTheDaySection[^}]*min-height: 313px[^}]*\}[\s\S]*?#featuredPeopleSection[^}]*min-height: 297px/.test(CSS), 'narrow phones (360 px) hold their taller 313 / 297 px');
check(/@media \(min-width: 1100px\) \{[^}]*#featuredPeopleSection[^}]*min-height: 219px/.test(CSS), 'desktops hold the shorter 219 px');
check(/\.calendar-pref-dialog__list\s*\{[^}]*min-height:\s*\d+px/.test(CSS), 'the calendar dialog keeps its list height while "Loading…" turns into the choices (it used to jump)');
check(!/\.late-reserve[^{]*\{[^}]*(?:background|border|color)/.test(CSS), 'a reserve block draws nothing, it only holds space');
// The sections must still be revealed the way app.js does it: by setting display. The reserve disappears because the inline style changes.
check(/songOfTheDaySection\.style\.display = 'block'/.test(APP) && /section\.style\.display = 'block'/.test(APP), 'app.js still reveals both sections with style.display, which is what hides their reserve');

// ─── the cookie notice ───────────────────────────────────────────────────────────────────────────────────────────────────
console.log('Cookie notice on a phone');
const mobile = /@media \(max-width: 600px\) \{\s*(?:\/\*[\s\S]*?\*\/\s*)?\.cookie-consent \{[\s\S]*?\n\}/.exec(CSS)?.[0] || '';
check(mobile.length > 0, 'the phone rules of the cookie notice are found');
check(/\.cookie-consent__content \{ flex-direction: row;/.test(mobile), 'the icon sits beside the text, not above it');
check(/\.cookie-consent__actions \{ flex-direction: row;/.test(mobile) && /flex: 1/.test(mobile), 'the two buttons sit side by side');
check(!/\.cookie-consent__actions \{ flex-direction: column;/.test(mobile) && !/\.cookie-consent__content \{ flex-direction: column;/.test(mobile), 'nothing is stacked any more');
check(/\.cookie-consent__btn \{[^}]*min-height: 44px/.test(mobile), 'the buttons are still at least 44 px tall (easy to tap)');

// ─── the service worker serves static files cache-first, so a changed stylesheet or script needs a new cache ──────────────
console.log('Caches');
const version = Number(/CACHE_VERSION = 'ml-v(\d+)'/.exec(read('public/sw.js'))[1]);
check(version >= 56, `the service worker's cache version was bumped (ml-v${version}), so returning visitors get the new files`);

console.log(failures ? `\n✗ ${failures} failed, ${passes} passed` : `\n✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
