#!/usr/bin/env node
// Checks for the Christmas theme (1–31 December).   npm run test:christmas
//
//   • the season: Christmas.isSeason() is true from 1 December to the end of 31 December (every year) and false the day before
//     and the day after, at the first and the last second of those days
//   • what makes it work: every page with the theme switcher loads /christmas.js (and the two pages without it do not), the
//     service worker keeps it for offline, declining cookies for preferences forgets the switch, the English strings exist
//   • the colours: the text, link and button colours of the Christmas palette (dark and light) read well on its backgrounds
//     (WCAG contrast), and the tree/greeting colours on the snow
//   • nothing from another site is loaded by it, and nothing is added to the page by the script out of season
// The real browser run (snow falling, the trees, the switch, reduced motion, a phone screen) is in scripts/e2e-guitar-node.mjs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passes = 0;
let failures = 0;
const check = (cond, msg) => { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } };

const source = read('public/christmas.js');
const Christmas = vm.runInNewContext(`${source}; Christmas`, {});   // no `document` here: the file only defines the theme

// ─── The season ──────────────────────────────────────────────────────────────
console.log('The season');
check(Christmas.FROM === 1201 && Christmas.UNTIL === 1231, 'the season is 1 December to 31 December (change FROM and UNTIL on purpose, and this check with them)');
const at = (y, m, d, h = 12, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s);
check(Christmas.isSeason(at(2026, 12, 1, 0, 0, 0)) === true, '1 December, the first second, is in');
check(Christmas.isSeason(at(2026, 11, 30, 23, 59, 59)) === false, '30 November, the last second, is out');
check(Christmas.isSeason(at(2026, 12, 25)) === true && Christmas.isSeason(at(2026, 12, 24, 18)) === true, 'Christmas Eve and Christmas Day are in');
check(Christmas.isSeason(at(2026, 12, 31, 23, 59, 59)) === true, '31 December, the last second, is in (the theme goes at midnight, not the day before)');
check(Christmas.isSeason(at(2027, 1, 1, 0, 0, 0)) === false, '1 January, the first second, is out');
check([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].every((m) => !Christmas.isSeason(at(2026, m, 15))), 'no other month is in');
check([2026, 2027, 2028, 2031, 2040].every((y) => Christmas.isSeason(at(y, 12, 10)) && !Christmas.isSeason(at(y, 1, 10)) && !Christmas.isSeason(at(y, 6, 10))), 'it comes back every year');
check(Christmas.isSeason(at(2028, 2, 29)) === false, 'a leap day is out');

// ─── The page wiring ─────────────────────────────────────────────────────────
console.log('Pages, service worker, consent, strings');
const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
const withSwitcher = pages.filter((f) => read(`public/${f}`).includes('src="/theme.js"'));
const without = pages.filter((f) => !withSwitcher.includes(f));
check(withSwitcher.length >= 20, `the pages with the theme switcher are found (${withSwitcher.length})`);
const tag = /<script src="\/christmas\.js\?v=\d+"><\/script>/g;
const missing = withSwitcher.filter((f) => (read(`public/${f}`).match(tag) || []).length !== 1);
check(missing.length === 0, `every page with the theme switcher loads /christmas.js once, with a ?v=${missing.length ? ` (not on: ${missing.join(', ')})` : ''}`);
const after = withSwitcher.filter((f) => { const h = read(`public/${f}`); return h.search(/\/app\.js\?v=\d+/) > h.search(/\/christmas\.js/); });
check(after.length === 0, `…after app.js and the scripts it needs${after.length ? ` (wrong order on: ${after.join(', ')})` : ''}`);
check(without.sort().join() === 'account.html,app-auth.html' && without.every((f) => !read(`public/${f}`).includes('christmas.js')), 'account.html and app-auth.html (no theme switcher, no footer scene) do not load it');
check(/'\/christmas\.js'/.test(read('public/sw.js')), 'the service worker keeps /christmas.js for offline');
check(/localStorage\.removeItem\('ml_christmas'\)/.test(read('public/consent.js')), 'declining preference cookies also forgets the Christmas switch (ml_christmas)');
const en = JSON.parse(read('public/locales/en.json')).christmas || {};
for (const key of ['greeting', 'setting', 'on', 'off']) check(typeof en[key] === 'string' && en[key].length > 0, `en.json has christmas.${key}`);
const used = [...source.matchAll(/['"](christmas\.[a-z_]+)['"]/g), ...source.matchAll(/data-i18n="(christmas\.[a-z_]+)"/g)].map((m) => m[1].split('.')[1]);
check([...new Set(used)].sort().join() === 'greeting,off,on,setting' && used.every((k) => k in en), `every christmas.* string the script uses is in en.json (${[...new Set(used)].join(', ')})`);

// ─── Safety: nothing from outside, nothing out of season, nothing stored without a choice ────
console.log('Safety');
check(!/https?:\/\//.test(source.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '').replace(/https:\/\/maralyrics\.com\/\?christmas=preview/g, '')), 'the script contains no address of another site');
check(!/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|eval|new Function|document\.write)\b/.test(source.replace(/\/\/.*$/gm, '')), 'it makes no requests and runs no strings as code');
check(/if \(!isSeason\(\) && !previewing\(\)\) return;/.test(source), 'out of season init() returns before it adds anything to the page');
check(/CookieConsent\.hasConsent\(\)/.test(source), 'the switch is only remembered when preference cookies were accepted');
check(/prefers-reduced-motion: reduce/.test(source) && /saveData/.test(source), 'the snow is left out for "reduce motion" and Save-Data');

// ─── The palette ─────────────────────────────────────────────────────────────
console.log('Colours (WCAG contrast)');
const css = read('public/style.css');
const block = (selector) => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return null;
  return css.slice(start, css.indexOf('}', start));
};
const vars = (text) => Object.fromEntries([...text.matchAll(/--([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const dark = vars(block('[data-season="christmas"]:not([data-theme="light"])') || '');
const light = vars(block('[data-season="christmas"][data-theme="light"]') || '');
const rgb = (value) => {
  let m = /^#([0-9a-f]{6})$/i.exec(value);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(([^)]+)\)$/.exec(value);
  if (m) return m[1].split(',').slice(0, 3).map((n) => Number(n));
  return null;
};
const over = (top, alpha, bottom) => top.map((c, i) => Math.round(c * alpha + bottom[i] * (1 - alpha)));
const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const need = (label, fg, bg, min) => { const r = ratio(fg, bg); check(r >= min, `${label}: ${r.toFixed(2)}:1 (needs ${min}:1)`); };
const WHITE = [255, 255, 255];

for (const [name, v, min] of [['dark', dark, 4.5], ['light', light, 4.5]]) {
  check(Object.keys(v).length >= 14, `the ${name} palette is found in style.css (${Object.keys(v).length} colours)`);
  const bg = rgb(v['bg-primary']);
  const bg2 = rgb(v['bg-secondary']);
  const cardTop = rgb(v['bg-card']);
  const card = over(cardTop, Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(v['bg-card'])[1]), bg);
  for (const [label, key] of [['text', 'text-primary'], ['secondary text', 'text-secondary'], ['muted text', 'text-muted']]) {
    need(`${name}: ${label} on the page`, rgb(v[key]), bg, min);
    need(`${name}: ${label} on the second background`, rgb(v[key]), bg2, min);
    need(`${name}: ${label} on a card`, rgb(v[key]), card, min);
  }
  need(`${name}: links (accent-light) on the page`, rgb(v['accent-light']), bg, min);
  need(`${name}: links (accent-light) on a card`, rgb(v['accent-light']), card, min);
  need(`${name}: accent text (hover, bio links) on the page`, rgb(v.accent), bg, min);
  need(`${name}: white on the button colour (accent-dark)`, WHITE, rgb(v['accent-dark']), 4.5);
  need(`${name}: the three accent greens, reds and blues on the page`, rgb(v['neon-pink']), bg, min);
  need(`${name}: neon-green on the page`, rgb(v['neon-green']), bg, min);
  need(`${name}: neon-cyan on the page`, rgb(v['neon-cyan']), bg, min);
}
// white on the plain accent (hover and "selected" chips) is no better than the purple it replaces (4.2:1); keep it at least that good
need('dark: white on the accent (selected chips, hovers)', WHITE, rgb(dark.accent), 4.0);
need('light: white on the accent (selected chips, hovers)', WHITE, rgb(light.accent), 4.5);
for (const snow of [[244, 249, 255], [223, 236, 248], [234, 243, 252], [210, 227, 244]]) need(`the greeting (#1b3a57) on the snow rgb(${snow})`, [27, 58, 87], snow, 7);

console.log(failures ? `\n✗ ${failures} failed, ${passes} passed` : `\n✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
