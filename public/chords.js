// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — Guitar Node: chord engine         │
// └───────────────────────────────────────────────┘
// Pure functions (no DOM, no network) that parse guitar chords and keys, transpose them, check a song's chord data and
// convert between the structured form kept in the database and the editor's "chord sheet" text. The same file runs in
// the browser (loaded as a module; the API is also on `globalThis.MaraChords`), in the Worker (to validate what an
// editor saves) and in the tests (scripts/check-chords.mjs).
//
// Stored form (songs.chords, JSON):  { "v": 1, "lines": { "<line index>": [ [<character offset>, "<chord>"], … ] } }
//   · the line index counts the lines of the song's lyrics (after turning a literal "\n" into a newline), from 0;
//   · the offset is the position in that line's text where the chord sits (0 = above the first character);
//   · only lines that have chords are listed; the lyrics themselves are never changed by the chords.
// Chord sheet (what editors type):   [C]Wise men [Em]say only [Am]fools rush in      — a chord in brackets right before
//   the syllable it belongs to; a line of only chords is a chord line (intro, solo, …).
//
// A chord is a root (A–G, optionally # or b), a quality / extensions made only of known tokens (m, maj7, sus4, add9, dim,
// aug, 7, 9, b5, #11, (b9), 6/9, …) and an optional bass note after a slash (C/E). Anything else is NOT a chord and is
// never touched by transposition. Transposition changes only the root and the bass note; the rest is copied as written.

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// C major and A minor have no accidentals of their own; the notes outside the key are spelled the way players usually
// see them (♭III, ♭VI, ♭VII with flats; the sharpened 4th and the leading tone with sharps).
const C_MAJOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const A_MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];   // the 12 keys offered, by pitch class
const MINOR_KEYS = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
// Keys written with flats / with sharps (by tonic pitch class), for choosing how to spell a transposed chord.
const FLAT_MAJOR_PCS = new Set([5, 10, 3, 8, 1]);       // F, Bb, Eb, Ab, Db
const FLAT_MINOR_PCS = new Set([2, 7, 0, 5, 10, 3]);    // Dm, Gm, Cm, Fm, Bbm, Ebm

export const MAX_CHORD_LENGTH = 24;
export const MAX_CHORDS_PER_LINE = 40;
export const MAX_CHORD_LINES = 600;
export const MAX_CHORD_JSON = 20000;

// ─── Notes and chords ─────────────────────────────────────────────────────────────────────────────────────────────

const ASCII_ACCIDENTAL = { '♯': '#', '♭': 'b' };
const asciiAccidentals = (text) => String(text).replace(/[♯♭]/g, (m) => ASCII_ACCIDENTAL[m]);

/** "F#" → { name: 'F#', pc: 6 }; null when it is not a note. Accepts ♯ and ♭. */
export function parseNote(text) {
  const m = /^([A-G])([#b♯♭]?)$/.exec(String(text));
  if (!m) return null;
  const acc = asciiAccidentals(m[2]);
  const pc = (LETTER_PC[m[1]] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0) + 12) % 12;
  return { name: m[1] + acc, pc };
}

// The tokens a chord's quality / extensions may be made of. Longest first, so "maj7" is not read as "m" + "aj7".
const SUFFIX_TOKENS = [
  'maj', 'Maj', 'MAJ', 'min', 'Min', 'MIN', 'dim', 'aug', 'sus', 'add', 'omit', 'alt', 'no',
  'M', 'm', '+', '-', '°', 'ø', 'Δ', 'o',
  '13', '12', '11', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1',
  '#', 'b', '♯', '♭', '(', ')', ',',
];
const NO_CHORD = /^N\.?C\.?$/;

/**
 * Is the part after the root made only of known tokens, put together sensibly? A "/9" (as in 6/9) is allowed; a slash
 * before a note is the bass and is handled by the caller. An accidental must belong to a number (b5, #9, b13), and
 * add / no / omit need a number too; brackets must pair up.
 */
function suffixOk(suffix) {
  let rest = suffix;
  let depth = 0;
  while (rest.length) {
    if (rest[0] === '/' && /^\/\d/.test(rest)) { rest = rest.slice(1); continue; }
    const token = SUFFIX_TOKENS.find((t) => rest.startsWith(t));
    if (!token) return false;
    rest = rest.slice(token.length);
    if (['#', 'b', '♯', '♭', 'add', 'no', 'omit'].includes(token) && !/^\d/.test(rest)) return false;
    if (token === '(') depth++;
    if (token === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Parses a chord symbol.
 *   → { ok: true, kind: 'chord', root: 'F#', pc, suffix: 'm7', bass: { name: 'C#', pc } | null }
 *   → { ok: true, kind: 'nochord' }                (N.C.)
 *   → { ok: false, reason }                       (not a chord we understand)
 */
export function parseChord(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not text' };
  const raw = text.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (raw.length > MAX_CHORD_LENGTH) return { ok: false, reason: 'too long' };
  if (NO_CHORD.test(raw)) return { ok: true, kind: 'nochord', text: raw };
  const m = /^([A-G])([#b♯♭]?)(.*)$/.exec(raw);
  if (!m) return { ok: false, reason: 'does not start with a note A–G' };
  const root = parseNote(m[1] + m[2]);
  let rest = m[3];
  let bass = null;
  // A bass note follows the LAST slash, and only if what follows is a note ("C/E", "Am7/G#"; not "6/9").
  const slash = rest.lastIndexOf('/');
  if (slash !== -1) {
    const maybe = parseNote(rest.slice(slash + 1));
    if (maybe) { bass = maybe; rest = rest.slice(0, slash); }
  }
  if (!suffixOk(rest)) return { ok: false, reason: `unknown chord notation "${rest}"` };
  return { ok: true, kind: 'chord', root: root.name, pc: root.pc, suffix: asciiAccidentals(rest), bass };
}

export const isChord = (text) => parseChord(text).ok;

/** The chord written the standard way (ASCII sharps and flats); null if it is not a chord. */
export function normalizeChord(text) {
  const c = parseChord(text);
  if (!c.ok) return null;
  if (c.kind === 'nochord') return c.text;
  return c.root + c.suffix + (c.bass ? `/${c.bass.name}` : '');
}

// ─── Keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * "C", "C major", "Am", "A minor", "F# min", "Bb", "E♭" → { name: 'Bb' | 'Am', tonic, pc, minor, label: 'A Minor' }; null if not a key.
 * A bare letter is a MAJOR key; "m" / "minor" / "min" make it minor. Nothing is guessed.
 */
export function parseKey(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*([A-Ga-g])([#b♯♭]?)\s*(.*?)\s*$/.exec(text);
  if (!m) return null;
  const mode = m[3];
  let minor;
  if (mode === '' || mode === 'M' || /^(major|maj)$/i.test(mode)) minor = false;
  else if (mode === 'm' || /^(minor|min)$/i.test(mode)) minor = true;
  else return null;
  const note = parseNote(m[1].toUpperCase() + m[2]);
  if (!note) return null;
  return { name: note.name + (minor ? 'm' : ''), tonic: note.name, pc: note.pc, minor, label: `${note.name} ${minor ? 'Minor' : 'Major'}` };
}

/** Canonical key name for storing ('C', 'F#m'), or null when empty / not a key. */
export const normalizeKey = (text) => { const k = parseKey(text); return k ? k.name : null; };

/** The 12 keys offered for a mode, in pitch-class order: [{ name: 'Eb', label: 'Eb Major', pc: 3 }, …]. */
export function keyOptions(minor) {
  return (minor ? MINOR_KEYS : MAJOR_KEYS).map((name, pc) => ({ name, pc, label: parseKey(name).label }));
}

/** The conventional name of the key with tonic pitch class `pc` in the given mode. */
export const keyForPc = (pc, minor) => (minor ? MINOR_KEYS : MAJOR_KEYS)[((pc % 12) + 12) % 12];

/** How the 12 notes are spelled when the music is in this key (sharps, flats, or the usual mixture for C / Am). */
export function spellingFor(key) {
  const k = typeof key === 'string' ? parseKey(key) : key;
  if (!k) return SHARP_NAMES;
  if (!k.minor) return k.pc === 0 ? C_MAJOR_NAMES : FLAT_MAJOR_PCS.has(k.pc) ? FLAT_NAMES : SHARP_NAMES;
  return k.pc === 9 ? A_MINOR_NAMES : FLAT_MINOR_PCS.has(k.pc) ? FLAT_NAMES : SHARP_NAMES;
}

/** Semitones to go up from key `from` to key `to` (0–11). Works across modes by tonic only. */
export function semitonesBetween(from, to) {
  const a = typeof from === 'string' ? parseKey(from) : from;
  const b = typeof to === 'string' ? parseKey(to) : to;
  if (!a || !b) return null;
  return (((b.pc - a.pc) % 12) + 12) % 12;
}

// ─── Transposing ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Moves a chord by `semitones` (positive = up, any integer). Only the root and the bass note change; the quality and
 * everything after the root is copied exactly as written. `spelling` is a 12-name table (see spellingFor); if it is
 * omitted, sharps are used going up and flats going down. Not a chord (or N.C.) → returned unchanged.
 * A shift of 0 (or any multiple of 12) returns the chord exactly as it was written.
 */
export function transposeChord(text, semitones, spelling) {
  const n = Math.trunc(Number(semitones)) || 0;
  if (n % 12 === 0) return text;
  const c = parseChord(text);
  if (!c.ok || c.kind !== 'chord') return text;
  const names = spelling || (n > 0 ? SHARP_NAMES : FLAT_NAMES);
  const at = (pc) => names[(((pc + n) % 12) + 12) % 12];
  return at(c.pc) + c.suffix + (c.bass ? `/${at(c.bass.pc)}` : '');
}

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/**
 * Moves one note up by an interval given as a number of letter steps and of semitones, keeping the spelling right
 * (a flat chord borrowed from the minor stays flat: Ab in C → Bb in D). A result that would need a double sharp or
 * double flat is spelled from the target key's own table instead.
 */
function moveNote(note, letterSteps, semitones, fallbackNames) {
  const letter = LETTERS[(LETTERS.indexOf(note.name[0]) + letterSteps) % 7];
  const pc = (((note.pc + semitones) % 12) + 12) % 12;
  const diff = ((((pc - LETTER_PC[letter]) % 12) + 12 + 6) % 12) - 6; // −6 … +5
  if (diff === 0) return letter;
  if (diff === 1) return `${letter}#`;
  if (diff === -1) return `${letter}b`;
  return fallbackNames[pc];
}

/**
 * Transposes a chord from `originalKey` to `targetKey`: the same musical interval for the root and the bass note, spelled
 * as that interval would be written (so sharps and flats come out right for the new key, borrowed chords included).
 * The quality and everything else in the chord is copied as written. Not a chord, or an unknown key → unchanged.
 */
export function transposeToKey(text, originalKey, targetKey) {
  const from = parseKey(originalKey);
  const to = parseKey(targetKey);
  if (!from || !to) return text;
  const semitones = semitonesBetween(from, to);
  if (semitones === 0) return text;
  const c = parseChord(text);
  if (!c.ok || c.kind !== 'chord') return text;
  const letterSteps = (LETTERS.indexOf(to.tonic[0]) - LETTERS.indexOf(from.tonic[0]) + 7) % 7;
  const names = spellingFor(to);
  const root = moveNote({ name: c.root, pc: c.pc }, letterSteps, semitones, names);
  const bass = c.bass ? `/${moveNote(c.bass, letterSteps, semitones, names)}` : '';
  return root + c.suffix + bass;
}

/** The spelling to use when only a number of semitones is known (no original key): flats if the song's chords use flats. */
export function spellingFromChords(chordNames, semitones) {
  let flats = 0, sharps = 0;
  for (const name of chordNames) {
    const c = parseChord(name);
    if (!c.ok || c.kind !== 'chord') continue;
    for (const part of [c.root, c.bass && c.bass.name]) { if (!part) continue; if (part[1] === 'b') flats++; if (part[1] === '#') sharps++; }
  }
  if (flats > sharps) return FLAT_NAMES;
  if (sharps > flats) return SHARP_NAMES;
  return semitones < 0 ? FLAT_NAMES : SHARP_NAMES;
}

// ─── Lyrics lines ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The lyrics as a list of lines. A literal "\n" (how some older songs were stored) counts as a newline. */
export const lyricLines = (lyrics) => String(lyrics || '').replace(/\\n/g, '\n').split(/\r?\n/);

/** Moves an offset off the middle of a character: a surrogate pair, or (when the browser can tell) a letter with its marks. */
export function snapOffset(text, at) {
  let i = Math.max(0, Math.min(text.length, Math.trunc(at)));
  if (i > 0 && i < text.length) {
    const prev = text.charCodeAt(i - 1);
    const next = text.charCodeAt(i);
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) i -= 1;
  }
  if (i > 0 && i < text.length && typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
      const start = part.index;
      const end = start + part.segment.length;
      if (i > start && i < end) { i = start; break; }  // in the middle of a letter and its marks: back to where it starts
      if (start >= i) break;
    }
  }
  return i;
}

// ─── Stored chord data ────────────────────────────────────────────────────────────────────────────────────────────

/** Accepts the stored JSON text or an object; → a plain { v, lines } object, or null when there is nothing usable. */
export function readChordData(value) {
  let data = value;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return null; } }
  if (!data || typeof data !== 'object' || data.v !== 1 || !data.lines || typeof data.lines !== 'object') return null;
  return Object.keys(data.lines).length ? data : null;
}

/**
 * Checks chord data against the song's lyrics and returns it in canonical form.
 *   → { ok: true, value: { v: 1, lines: {…} } | null, count }     (value is null when there are no chords)
 *   → { ok: false, errors: [{ line, at, chord, message }] }
 * Every chord must parse, every line index must exist, every offset must lie inside its line.
 */
export function validateChordData(input, lyrics) {
  if (input === null || input === undefined || input === '') return { ok: true, value: null, count: 0 };
  let data = input;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return { ok: false, errors: [{ message: 'The chord data is not valid JSON' }] }; } }
  if (!data || typeof data !== 'object' || data.v !== 1 || !data.lines || typeof data.lines !== 'object' || Array.isArray(data.lines)) {
    return { ok: false, errors: [{ message: 'The chord data has an unknown format' }] };
  }
  const lines = lyricLines(lyrics);
  const out = {};
  const errors = [];
  let count = 0;
  const keys = Object.keys(data.lines);
  if (keys.length > MAX_CHORD_LINES) return { ok: false, errors: [{ message: `At most ${MAX_CHORD_LINES} lines can have chords` }] };
  for (const key of keys) {
    const index = Number(key);
    if (!/^\d+$/.test(key) || index >= lines.length) { errors.push({ line: key, message: `Line ${key} does not exist in the lyrics` }); continue; }
    const list = data.lines[key];
    if (!Array.isArray(list)) { errors.push({ line: index, message: 'Chords of a line must be a list' }); continue; }
    if (list.length > MAX_CHORDS_PER_LINE) { errors.push({ line: index, message: `A line can have at most ${MAX_CHORDS_PER_LINE} chords` }); continue; }
    const text = lines[index];
    const seen = [];
    for (const item of list) {
      const [at, chord] = Array.isArray(item) ? item : [];
      const normalized = typeof chord === 'string' ? normalizeChord(chord) : null;
      if (!Number.isInteger(at) || at < 0 || at > text.length) { errors.push({ line: index, at, chord, message: `A chord on line ${index + 1} is outside the line` }); continue; }
      if (!normalized) { errors.push({ line: index, at, chord, message: `"${String(chord).slice(0, 30)}" on line ${index + 1} is not a chord` }); continue; }
      seen.push([at, normalized]);
    }
    seen.sort((a, b) => a[0] - b[0]);
    if (seen.length) { out[String(index)] = seen; count += seen.length; }
  }
  if (errors.length) return { ok: false, errors };
  if (!count) return { ok: true, value: null, count: 0 };
  const value = { v: 1, lines: out };
  if (JSON.stringify(value).length > MAX_CHORD_JSON) return { ok: false, errors: [{ message: 'The chord data is too large' }] };
  return { ok: true, value, count };
}

/** Every chord name in the data, in reading order. */
export function allChords(data) {
  const d = readChordData(data);
  if (!d) return [];
  return Object.keys(d.lines).sort((a, b) => a - b).flatMap((k) => [...d.lines[k]].sort((x, y) => x[0] - y[0]).map((x) => x[1]));
}

// ─── Showing a song with its chords ───────────────────────────────────────────────────────────────────────────────

/**
 * The lines of a song ready to draw. `mapChord(name)` turns a stored chord into the one to show (transposed, or as is).
 *   → [{ text, chordOnly, segments: [{ chord: string | null, text }] }]
 * A line without chords is one segment with no chord. With chords, the text before the first chord is a segment of its
 * own, and each chord owns the text from its position up to the next chord. A line of only chords (an intro, say) has
 * empty segments. Offsets are moved off the middle of a character before the text is cut.
 */
export function buildSongLines(lyrics, chordData, mapChord = (c) => c) {
  const data = readChordData(chordData);
  return lyricLines(lyrics).map((text, index) => {
    const list = data && data.lines[String(index)];
    if (!list || !list.length) return { text, chordOnly: false, segments: [{ chord: null, text }] };
    const marks = list.map(([at, chord]) => [snapOffset(text, at), chord]).sort((a, b) => a[0] - b[0]);
    const chordOnly = text.trim() === '';
    const segments = [];
    if (!chordOnly && marks[0][0] > 0) segments.push({ chord: null, text: text.slice(0, marks[0][0]) });
    marks.forEach(([at, chord], i) => {
      const end = i + 1 < marks.length ? marks[i + 1][0] : text.length;
      segments.push({ chord: mapChord(chord), text: chordOnly ? '' : text.slice(at, end) });
    });
    return { text, chordOnly, segments };
  });
}

/** The lyrics without the lines that only hold chords (an intro, a solo) and without runs of blank lines they leave behind. */
export function plainLyricsWithoutChordLines(lyrics, chordData) {
  const data = readChordData(chordData);
  const lines = lyricLines(lyrics);
  if (!data) return lines.join('\n');
  const out = [];
  let removed = false; // a chord-only line was just taken out: the blank line it leaves must not double up
  lines.forEach((text, i) => {
    const hasChords = data.lines[String(i)] && data.lines[String(i)].length;
    if (text.trim() === '' && hasChords) { removed = true; return; }
    if (text.trim() === '' && removed && (out.length === 0 || out[out.length - 1].trim() === '')) return;
    if (text.trim() !== '') removed = false;
    out.push(text);
  });
  while (out.length && out[out.length - 1].trim() === '' && removed) out.pop();
  return out.join('\n');
}

/**
 * The song as plain text with each line of chords printed above its lyric line (what the Copy button gives a musician):
 *     C       Em
 *     Wise men say
 * A chord sits above the character it belongs to; when two chords would touch, the second moves right so they stay apart.
 */
export function formatChordText(lyrics, chordData, mapChord = (c) => c) {
  return buildSongLines(lyrics, chordData, mapChord).map((line) => {
    if (line.segments.length === 1 && line.segments[0].chord === null) return line.text;
    let chordLine = '';
    let column = 0;
    for (const seg of line.segments) {
      if (seg.chord !== null) {
        chordLine = chordLine.padEnd(Math.max(column, chordLine.length ? chordLine.length + 1 : 0), ' ') + seg.chord;
      }
      column += seg.text.length;
    }
    return line.chordOnly ? chordLine.trimEnd() : `${chordLine.trimEnd()}\n${line.text}`;
  }).join('\n');
}

// ─── The chord sheet (editor text) ────────────────────────────────────────────────────────────────────────────────

// Words in brackets that label a section ("[Chorus]", "[Verse 2]", "[x2]") — kept as lyrics text, not read as chords.
const LABEL = /^(?:(?:verse|chorus|bridge|intro|outro|pre-?chorus|interlude|refrain|solo|tag|instrumental|ending|coda|hook|break)\b.*|x\s*\d+|\d+\s*x|[^\s]*\s[^]*|\d+)$/i;

/** Turns the structured data and the lyrics into chord sheet text: chords in [brackets] at their positions. */
export function formatSheet(lyrics, chordData) {
  const data = readChordData(chordData);
  return lyricLines(lyrics).map((text, index) => {
    const list = data && data.lines[String(index)];
    if (!list || !list.length) return text;
    let out = '';
    let last = 0;
    const marks = [...list].sort((a, b) => a[0] - b[0]);
    for (const [at, chord] of marks) { const i = Math.min(at, text.length); out += text.slice(last, i) + `[${chord}]`; last = i; }
    return out + text.slice(last);
  }).join('\n');
}

/**
 * Reads chord sheet text back into lyrics and structured chord data.
 *   → { lyrics, chords: { v, lines } | null, count, errors: [{ line, message }] }
 * A bracket that holds a chord becomes a chord; a bracket that is a section label ([Chorus], [x2]) stays in the lyrics;
 * any other bracket is reported as an error (most likely a mistyped chord). Trailing spaces are dropped from each line
 * and blank lines at the start and end of the song are removed (the chord line numbers follow).
 */
export function parseSheet(sheet) {
  const rawLines = String(sheet || '').replace(/\\n/g, '\n').split(/\r?\n/);
  const errors = [];
  const parsed = rawLines.map((raw, i) => {
    let text = '';
    const chords = [];
    let rest = raw;
    while (rest.length) {
      const open = rest.indexOf('[');
      if (open === -1) { text += rest; break; }
      const close = rest.indexOf(']', open + 1);
      if (close === -1) { text += rest; break; }
      text += rest.slice(0, open);
      const inside = rest.slice(open + 1, close).trim();
      const normalized = normalizeChord(inside);
      if (normalized) chords.push([text.length, normalized]);
      else if (!inside) text += rest.slice(open, close + 1);              // "[]" is just text
      else if (LABEL.test(inside)) text += `[${inside}]`;
      else errors.push({ line: i, message: `"${rest.slice(open + 1, close).slice(0, 30)}" on line ${i + 1} is not a chord` });
      rest = rest.slice(close + 1);
    }
    const trimmed = text.replace(/\s+$/, '');
    return { text: trimmed, chords: chords.map(([at, c]) => [Math.min(at, trimmed.length), c]) };
  });
  while (parsed.length && parsed[0].text === '' && !parsed[0].chords.length) parsed.shift();
  while (parsed.length && parsed[parsed.length - 1].text === '' && !parsed[parsed.length - 1].chords.length) parsed.pop();
  // A line with only chords starts at the left: their offsets mean nothing without text.
  const lines = {};
  let count = 0;
  parsed.forEach((p, i) => {
    if (!p.chords.length) return;
    lines[String(i)] = p.text === '' ? p.chords.map(([, c]) => [0, c]) : p.chords;
    count += p.chords.length;
  });
  return { lyrics: parsed.map((p) => p.text).join('\n'), chords: count ? { v: 1, lines } : null, count, errors };
}

/**
 * Converts a song sheet written the classic way — a line of chords printed above the line of words — into chord sheet
 * text ([C]Wise men [Em]say …), which the editor then saves as structured chord data.
 *     C       Em                 →   [C]Wise men [Em]say only fools rush in
 *     Wise men say only fools rush in
 * A chord is put in the lyric line at the column where it was typed. A line of chords with no words under it (an intro,
 * a solo, or the last line) becomes a chord-only line; bar marks (|) are dropped. A line that is not made only of chords
 * is left as it is.
 */
export function overLyricsToSheet(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const chordsOf = (line) => {
    const found = [];
    for (const m of line.matchAll(/\S+/g)) {
      const chord = normalizeChord(m[0]);
      if (chord) found.push([m.index, chord]);
      else if (!/^[|%/\\:-]+$/.test(m[0])) return null; // a word: this is a lyric line
    }
    return found.length ? found : null;
  };
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const marks = chordsOf(lines[i]);
    if (!marks) { out.push(lines[i]); continue; }
    const next = lines[i + 1];
    if (next !== undefined && next.trim() !== '' && !chordsOf(next)) {
      let merged = next;
      for (const [column, chord] of [...marks].sort((a, b) => b[0] - a[0])) {
        if (column > merged.length) merged = merged.padEnd(column, ' ');
        merged = merged.slice(0, column) + `[${chord}]` + merged.slice(column);
      }
      out.push(merged);
      i++;
    } else {
      out.push(marks.map(([, chord]) => `[${chord}]`).join(' '));
    }
  }
  return out.join('\n');
}

// ─── Browser global (the song page and the admin dashboard use `MaraChords`) ──────────────────────────────────────

const api = {
  parseNote, parseChord, isChord, normalizeChord, parseKey, normalizeKey, keyOptions, keyForPc, spellingFor, semitonesBetween,
  transposeChord, transposeToKey, spellingFromChords, lyricLines, snapOffset, readChordData, validateChordData, allChords,
  buildSongLines, plainLyricsWithoutChordLines, formatChordText, formatSheet, parseSheet, overLyricsToSheet,
};
if (typeof globalThis !== 'undefined') globalThis.MaraChords = api;
export default api;
