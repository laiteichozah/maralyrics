// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — forgiving search matching          │
// └───────────────────────────────────────────────┘
// One matcher for every search box of the admin dashboard (the Worker uses it for the song and article lists, which are paged
// on the server; the browser uses it for the lists it loads whole). It replaces SQLite's LIKE (which ignores case only for plain
// A–Z, so "RAMÂ" never found "ramâ") and the plain "contains the typed text" test (no typos, no word order).
//
// A query is split into words. Every word has to match something in the text, and the match may be
//   exact · the start of a word · inside a word · a word with a typo (one edit in a word of 4–5 letters, two in 6 or more:
//   a missing, extra, wrong or swapped letter), so "fallng" finds "Falling" and "sad waltx" finds "Sad Waltz"
// in any order ("waltz sad" finds "Sad Waltz"), across several fields at once (title + artist + category). Case, accents and
// the apostrophe are ignored ("RAMÂ" = "rama" = "Rama'"). Marks that carry meaning in other scripts (Burmese) are kept.
// Results can be ranked best-first. Typo matches are only offered when nothing matches the typed words as they are (so "mara"
// is not drowned in "mari", "mark" and "mare" while real "mara" results exist).
//
//   MaraMatch.fold(text)                      → the text in the form that is compared
//   MaraMatch.score(query, text)              → 0 (no match) … 1 (exact); an empty query scores 1
//   MaraMatch.rank(items, query, fields)      → [{ item, score }] best first (a tie keeps the original order); every item for an empty query
//   MaraMatch.filter(items, query, fields)    → just the items, best first (the same array for an empty query)
// `fields` are property names (or functions that return the text) of each item.
//
// This file is an ES module (the Worker imports it) that also sets globalThis.MaraMatch (the admin page loads it as a script).
const MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g; // accents on Latin, Greek and Cyrillic letters
const SPECIAL = { 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'ı': 'i', 'ŋ': 'n' };
const MAX_WORDS = 300;          // words looked at in one text (a long report body)
const MIN_WORD_SCORE = 0.5;     // a query word that matches worse than this does not count

export function fold(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(MARKS, '')
    .replace(/[ßæœøđðþłıŋ]/g, (c) => SPECIAL[c])
    .replace(/['’‘ʼ`´]/g, '');   // "don't" = "dont"
}

const words = (folded) => (folded.match(/[\p{L}\p{N}\p{M}]+/gu) || []).slice(0, MAX_WORDS);

/** Edits between two words (insert, delete, change, swap two neighbours), or max + 1 once it is certain to be more than max. */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

/** How well one typed word matches one word of the text: 1 exact, then start of word, inside a word, a typo; 0 for none. */
function wordScore(q, t) {
  if (q === t) return 1;
  if (t.startsWith(q)) return 0.92 - Math.min(0.12, (t.length - q.length) * 0.01);
  if (q.length >= 2 && t.includes(q)) return 0.8;
  const allowed = q.length >= 6 ? 2 : q.length >= 4 ? 1 : 0;      // very short words must be right
  if (!allowed || (q.length < 6 && q[0] !== t[0])) return 0;      // …and a short word keeps its first letter
  const d = Math.min(distance(q, t, allowed), distance(q, t.slice(0, q.length), allowed)); // the whole word, or the start of it (still being typed)
  return d <= allowed ? 0.74 - 0.1 * d : 0;
}

/** { score, as }: the score (0 = no match) and the weakest word's match: 'typed' when every word matched as typed, 'typo' when one needed a typo. */
function detail(query, text) {
  const foldedQuery = fold(query).trim();
  if (!foldedQuery) return { score: 1, as: 'typed' };
  const q = words(foldedQuery);
  const folded = fold(text);
  if (!q.length) return { score: folded.includes(foldedQuery) ? 1 : 0, as: 'typed' };   // only punctuation was typed: look for it as it is
  const t = words(folded);
  let total = 0;
  let weakest = 1;
  for (const word of q) {
    let best = 0;
    for (const candidate of t) {
      const s = wordScore(word, candidate);
      if (s > best) { best = s; if (s === 1) break; }
    }
    if (best < MIN_WORD_SCORE) return { score: 0, as: 'typo' };
    total += best;
    weakest = Math.min(weakest, best);
  }
  let result = total / q.length;
  if (q.length > 1 && !t.join(' ').includes(q.join(' '))) result *= 0.95; // the words in a row rank above the same words apart or in another order
  return { score: result, as: weakest >= 0.8 ? 'typed' : 'typo' };
}

export function score(query, text) {
  return detail(query, text).score;
}

const textOf = (item, field) => (typeof field === 'function' ? field(item) : item == null ? '' : item[field]);

export function rank(items, query, fields) {
  if (!fold(query).trim()) return items.map((item) => ({ item, score: 1 }));
  let out = [];
  items.forEach((item, index) => {
    const parts = fields.map((f) => textOf(item, f));
    // the best single field, or the words spread over several fields (title + artist)
    let best = { score: 0, as: 'typo' };
    for (const d of [...parts.map((p) => detail(query, p)), detail(query, parts.join(' '))]) {
      if (d.score > 0 && (d.as === 'typed' && best.as === 'typo' || d.score > best.score && d.as === best.as)) best = d;
    }
    if (best.score > 0) out.push({ item, score: best.score, as: best.as, index });
  });
  if (out.some((r) => r.as === 'typed')) out = out.filter((r) => r.as === 'typed'); // typo matches only when nothing matches as typed
  out.sort((a, b) => b.score - a.score || a.index - b.index);
  return out.map(({ item, score: s }) => ({ item, score: s }));
}

export function filter(items, query, fields) {
  if (!fold(query).trim()) return items;
  return rank(items, query, fields).map((r) => r.item);
}

if (typeof globalThis !== 'undefined') globalThis.MaraMatch = { fold, score, rank, filter };
