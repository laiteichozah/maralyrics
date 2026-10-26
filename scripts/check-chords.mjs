#!/usr/bin/env node
// Checks for the Guitar Node chord engine (public/chords.js): parsing, transposing, keys, validation, the chord sheet.   npm run test:chords
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = await import(pathToFileURL(path.join(ROOT, 'public/chords.js')).href);

let passes = 0;
let failures = 0;
const check = (cond, msg) => { if (cond) passes++; else { failures++; console.error(`  ✗ ${msg}`); } };
const eq = (got, want, msg) => check(JSON.stringify(got) === JSON.stringify(want), `${msg} — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// ─── Parsing chords ───────────────────────────────────────────────────────────
const GOOD = ['C', 'Am', 'G7', 'F#m', 'Bb', 'Dsus4', 'C/E', 'Cmaj7', 'CM7', 'Cm7', 'Cm7b5', 'C7#9', 'C7b9', 'Cadd9', 'C6', 'C6/9', 'C9', 'C11', 'C13', 'Cdim', 'Cdim7', 'Caug', 'C+', 'Csus2', 'C7sus4', 'Cm(maj7)', 'C7(b9,#11)',
  'Cmaj9', 'Cmin7', 'C5', 'Em7/D', 'F#m7/C#', 'Bbm', 'Ebmaj7', 'Ab', 'G#dim', 'Cø', 'C°', 'Cadd11', 'Cno3', 'Cmmaj7', 'C♯m', 'D♭', 'N.C.', 'NC', 'Am7/G', 'Dsus', 'Gsus2/B', 'Fmaj7#11', 'Cb', 'Fb', 'E#'];
for (const chord of GOOD) check(C.parseChord(chord).ok, `parses ${chord}`);
const BAD = ['', ' ', 'H', 'Bridge', 'Chorus', 'x', 'Am7x', 'C/', 'C//E', '/E', 'Cmaj7#', 'am', 'dm', 'Cx', 'Z7', 'C7 b9', 'Hello', 'Add9', 'Dim', 'E.', 'C##', 'Cbb', 'Csus4sus9z', 'A'.repeat(30), 'C/H', 'C/e', 'Cbb', 'C##', 'C(b9', 'Cb9)', 'Cadd', 'Cno', null, undefined, 42];
for (const chord of BAD) {
  const parsed = C.parseChord(chord);
  check(!parsed.ok, `rejects ${JSON.stringify(chord)}`);
}
{
  const c = C.parseChord('F#m7/C#');
  check(c.ok && c.root === 'F#' && c.suffix === 'm7' && c.bass.name === 'C#', 'F#m7/C# → root F#, "m7", bass C#');
  const d = C.parseChord('C6/9');
  check(d.ok && d.suffix === '6/9' && d.bass === null, '"C6/9" is a 6/9 chord, not a chord over a bass');
  const e = C.parseChord('Bb');
  check(e.root === 'Bb' && e.suffix === '', '"Bb" is B-flat (not B with a flat alteration)');
  check(C.parseChord('N.C.').kind === 'nochord', 'N.C. is "no chord"');
  check(C.normalizeChord('C♯m7♭5/G♭') === 'C#m7b5/Gb', 'Unicode sharps and flats are written the standard way');
  check(C.normalizeChord('Bridge') === null, 'normalizeChord: not a chord → null');
}

// ─── Transposing: the table from the brief (C major → D major) ────────────────
const spell = (from, to) => (chord) => C.transposeToKey(chord, from, to);
const toD = spell('C', 'D');
for (const [from, to] of [['C', 'D'], ['Em', 'F#m'], ['Am', 'Bm'], ['F', 'G'], ['G', 'A'], ['G7', 'A7'], ['F#m7', 'G#m7'], ['C/E', 'D/F#']]) eq(toD(from), to, `C → D major: ${from}`);

// ─── Qualities survive ────────────────────────────────────────────────────────
const QUALITIES = ['', 'm', '7', 'm7', 'maj7', 'M7', 'sus4', 'sus2', '7sus4', 'dim', 'dim7', 'aug', '+', 'add9', '6', 'm6', '9', 'm9', '11', '13', 'm7b5', '7#9', '7b9', 'maj9', '5', 'mMaj7', 'm(maj7)', '6/9', '7(b9,#11)', 'ø', '°', 'no3'];
for (const root of ['C', 'F#', 'Bb', 'E']) for (const q of QUALITIES) {
  const chord = root + q;
  const up = C.transposeToKey(chord, 'C', 'E'); // +4
  check(C.parseChord(up).ok && up.endsWith(q) && C.parseChord(up).suffix === q.replace(/[♯♭]/g, (m) => ({ '♯': '#', '♭': 'b' }[m])), `${chord} → ${up}: the quality "${q}" is kept`);
}
{
  const c = (n) => C.transposeChord('Cm7b5/Gb', n, ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
  eq(c(2), 'Dm7b5/G#', 'bass and root both move, the alteration "b5" does not');
  eq(c(12), 'Cm7b5/Gb', 'a whole octave (12) changes nothing');
  eq(c(0), 'Cm7b5/Gb', '0 changes nothing');
}

// ─── Every key: up and back is the identity, and the roots move by the right amount ───
const ALL = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
for (const from of ALL) for (const to of ALL) {
  const a = C.parseKey(from), b = C.parseKey(to);
  const n = C.semitonesBetween(a, b);
  const there = C.transposeToKey('G7', from, to);
  const root = C.parseChord(there).pc;
  check(root === (7 + n) % 12 && there.endsWith('7'), `G7 from ${from} to ${to} → ${there}`);
  const home = C.transposeToKey(there, to, from);
  check(C.parseChord(home).pc === 7, `…and back from ${to} to ${from} → ${home}`);
}
check(C.transposeToKey('Am', 'C', 'C') === 'Am', 'same key: unchanged');

// ─── Spelling follows the target key ──────────────────────────────────────────
eq(C.transposeToKey('C', 'C', 'F'), 'F', 'C → F');
eq(C.transposeToKey('G', 'C', 'F'), 'C', 'G → C in F');
eq(C.transposeToKey('F', 'C', 'F'), 'Bb', 'F → Bb in F (flat key: Bb, not A#)');
eq(C.transposeToKey('F', 'C', 'Bb'), 'Eb', 'F → Eb in Bb');
eq(C.transposeToKey('C', 'C', 'Eb'), 'Eb', 'C → Eb');
eq(C.transposeToKey('Em', 'C', 'Db'), 'Fm', 'Em → Fm in Db');
eq(C.transposeToKey('Am', 'C', 'Db'), 'Bbm', 'Am → Bbm in Db (flat key)');
eq(C.transposeToKey('F', 'C', 'G'), 'C', 'F → C in G');
eq(C.transposeToKey('Em', 'C', 'A'), 'C#m', 'Em → C#m in A (sharp key)');
eq(C.transposeToKey('G', 'C', 'B'), 'F#', 'G → F# in B');
eq(C.transposeToKey('Bb', 'F', 'G'), 'C', 'Bb (IV of F) → C in G');
eq(C.transposeToKey('D#', 'C', 'F#'), 'A', 'sharp names are accepted as input (D# + 6 semitones)');
eq(C.transposeToKey('Eb', 'C', 'D'), 'F', 'bIII of C is F in D');
eq(C.transposeToKey('Ab', 'C', 'D'), 'Bb', 'a borrowed flat chord keeps its flat: bVI of C is Bb in D (not A#), even though D has sharps');
eq(C.transposeToKey('Bb', 'C', 'D'), 'C', 'bVII of C is C in D');
eq(C.transposeToKey('Bb', 'C', 'E'), 'D', 'bVII of C is D in E');
eq(C.transposeToKey('Eb', 'C', 'E'), 'G', 'bIII of C is G in E');
eq(C.transposeToKey('F#m7b5', 'C', 'G'), 'C#m7b5', '#iv (F#) of C is C# in G');
eq(C.transposeToKey('Bb', 'C', 'A'), 'G', 'bVII of C is G in A');
eq(C.transposeToKey('Eb', 'Bb', 'A'), 'D', 'IV of Bb is D in A');
eq(C.transposeToKey('Ebm', 'Db', 'E'), 'F#m', 'ii of Db is F#m in E — diatonic notes follow the new key');
eq(C.transposeToKey('Gb', 'Db', 'D'), 'G', 'IV of Db is G in D');
eq(C.transposeToKey('Bb', 'G', 'F#'), 'A', 'bVII of G is A in F#');
eq(C.transposeToKey('E', 'G', 'C'), 'A', 'E → A (G to C)');
eq(C.transposeToKey('Bb', 'G', 'C'), 'Eb', 'a ♭VII (F) from G … Bb → Eb in C');
eq(C.transposeToKey('F#', 'G', 'C'), 'B', 'F# → B (G to C)');
eq(C.transposeToKey('C#dim', 'D', 'C'), 'Bdim', 'C#dim in D → Bdim in C');

// ─── Minor keys ───────────────────────────────────────────────────────────────
eq(C.transposeToKey('Am', 'Am', 'Bm'), 'Bm', 'A minor → B minor: Am → Bm');
eq(['Am', 'Dm', 'E7', 'G', 'F', 'C', 'Am7', 'E/G#'].map(spell('Am', 'Bm')), ['Bm', 'Em', 'F#7', 'A', 'G', 'D', 'Bm7', 'F#/A#'], 'a minor-key song A minor → B minor keeps minor, major, seventh and slash chords');
eq(['Em', 'Am', 'B7', 'C', 'D', 'G'].map(spell('Em', 'Am')), ['Am', 'Dm', 'E7', 'F', 'G', 'C'], 'E minor → A minor');
eq(['Bm', 'G', 'D', 'A', 'F#m', 'Em'].map(spell('Bm', 'Cm')), ['Cm', 'Ab', 'Eb', 'Bb', 'Gm', 'Fm'], 'B minor → C minor uses flats (Cm is a flat key)');
eq(['Am', 'E7', 'G#dim'].map(spell('Am', 'Dm')), ['Dm', 'A7', 'C#dim'], 'A minor → D minor, with the leading tone');
eq(['Am', 'E7', 'G#dim7', 'C', 'Dm'].map(spell('Am', 'Cm')), ['Cm', 'G7', 'Bdim7', 'Eb', 'Fm'], 'A minor → C minor');
eq(['Cm', 'G7', 'Fm'].map(spell('Cm', 'C#m')), ['C#m', 'G#7', 'F#m'], 'C minor → C# minor');
eq(['Am', 'F', 'C', 'G'].map(spell('Am', 'Am')), ['Am', 'F', 'C', 'G'], 'A minor reset: unchanged');
// the mode of the song is never changed by transposing
check(C.transposeToKey('Em', 'C', 'D') === 'F#m' && C.transposeToKey('E', 'C', 'D') === 'F#', 'Em stays minor, E stays major — chords are never turned all-major');

// ─── Bare semitone shifts, enharmonics ────────────────────────────────────────
eq(C.transposeChord('C', 1), 'C#', '+1 with no table: sharps going up');
eq(C.transposeChord('C', -1), 'B', '−1');
eq(C.transposeChord('C', -2), 'Bb', '−2 with no table: flats going down');
eq(C.transposeChord('C', 13), 'C#', '13 = 1');
eq(C.transposeChord('C', -13), 'B', '−13 = −1');
eq(C.transposeChord('C', 1.9), 'C#', 'a fractional shift is cut to a whole semitone');
eq(C.transposeChord('C', NaN), 'C', 'NaN shifts nothing');
eq(C.transposeChord('C♯m', 2), 'D#m', 'the Unicode sharp is understood');
eq(C.transposeChord('Db', 1), 'D', 'Db up one = D');
eq(C.transposeChord('Cb', 1), 'C', 'Cb up one = C (Cb is B)');
eq(C.transposeChord('E#', 1), 'F#', 'E# is F');
eq(C.transposeChord('B#', 1), 'C#', 'B# is C');
eq(C.spellingFromChords(['Bb', 'Eb', 'F'], 2).join(), ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'].join(), 'with no key, a song written with flats keeps flats');
eq(C.spellingFromChords(['F#m', 'D', 'A'], -2)[1], 'C#', 'a song written with sharps keeps sharps');
eq(C.spellingFromChords(['C', 'G'], -3)[1], 'Db', 'no accidentals: flats going down');
eq(C.spellingFromChords(['C', 'G'], 3)[1], 'C#', 'no accidentals: sharps going up');

// ─── Things that are not chords are never touched ────────────────────────────
for (const text of ['Chorus', 'Bridge', 'x2', '(repeat)', 'Hello', 'H', '', 'N.C.', 'Am7x']) eq(C.transposeChord(text, 5), text, `transposing ${JSON.stringify(text)} leaves it alone`);
eq(C.transposeToKey('Bridge', 'C', 'D'), 'Bridge', 'not a chord, not changed (key to key)');
eq(C.transposeToKey('C', 'unknown', 'D'), 'C', 'an unknown original key changes nothing');
eq(C.transposeToKey('C', 'C', 'nonsense'), 'C', 'an unknown target key changes nothing');
eq(C.transposeChord(null, 3), null, 'null in, null out');
eq(C.transposeChord(undefined, 3), undefined, 'undefined in, undefined out');

// ─── Keys ─────────────────────────────────────────────────────────────────────
for (const [text, name, label] of [['C', 'C', 'C Major'], ['C major', 'C', 'C Major'], ['C Major', 'C', 'C Major'], ['Cmaj', 'C', 'C Major'], ['CM', 'C', 'C Major'], ['Am', 'Am', 'A Minor'], ['A minor', 'Am', 'A Minor'], ['a minor', 'Am', 'A Minor'], ['A Min', 'Am', 'A Minor'],
  ['F#m', 'F#m', 'F# Minor'], ['F♯ minor', 'F#m', 'F# Minor'], ['Bb', 'Bb', 'Bb Major'], ['E♭ major', 'Eb', 'Eb Major'], ['  D  ', 'D', 'D Major'], ['Bm', 'Bm', 'B Minor'], ['Em', 'Em', 'E Minor'], ['G', 'G', 'G Major']]) {
  const k = C.parseKey(text);
  check(k && k.name === name && k.label === label, `key ${JSON.stringify(text)} → ${name} / ${label} (got ${k && k.name} / ${k && k.label})`);
}
for (const text of ['', 'H', 'C dorian', 'Cx', 'major', '12', null, undefined, 'C minorr', 'Cmm']) check(C.parseKey(text) === null, `not a key: ${JSON.stringify(text)}`);
check(C.normalizeKey('') === null && C.normalizeKey('unknown') === null && C.normalizeKey('Am') === 'Am', 'normalizeKey');
eq(C.keyOptions(false).map((k) => k.name), ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'], '12 major keys, by pitch class');
eq(C.keyOptions(true).map((k) => k.name), ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'], '12 minor keys');
check(C.keyOptions(true).every((k, pc) => C.parseKey(k.name).pc === pc && C.parseKey(k.name).minor) && C.keyOptions(false).every((k, pc) => C.parseKey(k.name).pc === pc && !C.parseKey(k.name).minor), 'every option sits at its own pitch class, in its own mode');
eq([C.keyForPc(0, false), C.keyForPc(13, false), C.keyForPc(-1, true), C.keyForPc(9, true)], ['C', 'Db', 'Bm', 'Am'], 'keyForPc wraps around');
eq([C.semitonesBetween('C', 'D'), C.semitonesBetween('D', 'C'), C.semitonesBetween('Am', 'Bm'), C.semitonesBetween('C', 'C'), C.semitonesBetween('x', 'C')], [2, 10, 2, 0, null], 'semitonesBetween');
eq(C.spellingFor('F')[10], 'Bb', 'F uses flats');
eq(C.spellingFor('D')[6], 'F#', 'D uses sharps');
eq(C.spellingFor('Dm')[10], 'Bb', 'D minor uses flats');
eq(C.spellingFor('Em')[3], 'D#', 'E minor uses sharps');
eq(C.spellingFor('nonsense')[1], 'C#', 'unknown key: sharps');

// ─── Lines, offsets ───────────────────────────────────────────────────────────
eq(C.lyricLines('a\\nb\r\nc\nd'), ['a', 'b', 'c', 'd'], 'a literal \\n and CRLF are line breaks');
eq([C.snapOffset('abc', -4), C.snapOffset('abc', 99), C.snapOffset('abc', 1.7), C.snapOffset('', 3)], [0, 3, 1, 0], 'snapOffset clamps');
eq(C.snapOffset('a😀b', 2), 1, 'an offset inside an emoji moves to its start');
{
  const word = 'မြန်မာ'; // Burmese: letters with stacked marks
  const mid = 1;
  const snapped = C.snapOffset(word, mid);
  check(snapped === 0 || [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word)].some((s) => s.index === snapped), 'an offset inside a Burmese letter-with-marks moves to a letter boundary');
  check(C.snapOffset('နောက်ဆုံး', 0) === 0 && C.snapOffset('abc', 3) === 3, 'the ends stay put');
}

// ─── Validating stored data ──────────────────────────────────────────────────
const LYRICS = 'Wise men say only fools rush in\nBut I can\'t help falling in love with you\n\nShall I stay? Would it be a sin?';
{
  const good = { v: 1, lines: { 0: [[0, 'C'], [9, 'Em'], [4, 'Am']], 1: [[0, 'F'], [4, 'C♯m7']], 3: [[0, 'N.C.']] } };
  const v = C.validateChordData(good, LYRICS);
  check(v.ok && v.count === 6, 'valid data passes');
  eq(v.value.lines['0'], [[0, 'C'], [4, 'Am'], [9, 'Em']], 'chords are sorted by position');
  eq(v.value.lines['1'][1], [4, 'C#m7'], 'Unicode sharps are stored as #');
  check(C.validateChordData(JSON.stringify(good), LYRICS).ok, 'the stored JSON text is accepted too');
  check(C.validateChordData(null, LYRICS).value === null && C.validateChordData('', LYRICS).value === null && C.validateChordData({ v: 1, lines: {} }, LYRICS).value === null, 'no chords → null');
  check(C.validateChordData({ v: 1, lines: { 0: [] } }, LYRICS).value === null, 'a line with an empty list → no chords');
  for (const [bad, why] of [
    [{ v: 1, lines: { 9: [[0, 'C']] } }, 'a line that does not exist'],
    [{ v: 1, lines: { '-1': [[0, 'C']] } }, 'a negative line'],
    [{ v: 1, lines: { x: [[0, 'C']] } }, 'a line that is not a number'],
    [{ v: 1, lines: { 0: [[99, 'C']] } }, 'an offset past the end of the line'],
    [{ v: 1, lines: { 0: [[-1, 'C']] } }, 'a negative offset'],
    [{ v: 1, lines: { 0: [[1.5, 'C']] } }, 'a fractional offset'],
    [{ v: 1, lines: { 0: [[0, 'Bridge']] } }, 'a chord that is not a chord'],
    [{ v: 1, lines: { 0: [[0, 42]] } }, 'a chord that is not text'],
    [{ v: 1, lines: { 0: 'C' } }, 'a line that is not a list'],
    [{ v: 2, lines: { 0: [[0, 'C']] } }, 'an unknown version'],
    [{ lines: { 0: [[0, 'C']] } }, 'no version'],
    [[], 'an array'],
    ['{nope', 'broken JSON'],
    [{ v: 1, lines: { 0: Array.from({ length: 41 }, () => [0, 'C']) } }, 'too many chords on a line'],
    [{ v: 1, lines: [] }, 'lines as an array'],
  ]) check(!C.validateChordData(bad, LYRICS).ok, `rejects ${why}`);
  const err = C.validateChordData({ v: 1, lines: { 0: [[0, 'Bridge']] } }, LYRICS);
  check(/Bridge/.test(err.errors[0].message) && err.errors[0].line === 0, 'the error names the chord and the line');
  check(C.validateChordData({ v: 1, lines: { 1: [[0, 'C']] } }, 'one\ntwo').ok, 'a literal \\n in lyrics counts as a line break too') ;
  check(C.validateChordData({ v: 1, lines: { 1: [[0, 'C']] } }, 'one\\ntwo').ok, '(escaped newline)');
  eq(C.allChords(good), ['C', 'Am', 'Em', 'F', 'C♯m7', 'N.C.'], 'allChords in reading order (by line, then position)');
}

// ─── The chord sheet ─────────────────────────────────────────────────────────
{
  const sheet = '[C]Wise men [Em]say only [Am]fools rush in\n[F]But I can\'t [C]help falling in [G7]love with you\n\n[Chorus]\n[C] [G] [Am] [F]\nShall I stay?[C]';
  const p = C.parseSheet(sheet);
  check(p.errors.length === 0, 'the sheet parses without errors');
  eq(p.lyrics.split('\n')[0], 'Wise men say only fools rush in', 'the first lyric line has no brackets');
  eq(p.chords.lines['0'], [[0, 'C'], [9, 'Em'], [18, 'Am']], 'positions are where the brackets were');
  check(p.lyrics.split('\n')[3] === '[Chorus]', 'a section label stays in the lyrics');
  const chordLine = p.lyrics.split('\n').findIndex((l, i) => p.chords.lines[String(i)] && l === '');
  eq(p.chords.lines[String(chordLine)], [[0, 'C'], [0, 'G'], [0, 'Am'], [0, 'F']], 'a chord-only line starts at the left');
  eq(p.chords.lines[String(p.lyrics.split('\n').length - 1)], [[13, 'C']], 'a chord after the last word sits at the end of the line');
  const back = C.parseSheet(C.formatSheet(p.lyrics, p.chords));
  eq([back.lyrics, back.chords], [p.lyrics, p.chords], 'sheet → data → sheet → data is stable');
  check(C.validateChordData(p.chords, p.lyrics).ok, 'what the sheet produces always validates');
  check(C.formatSheet('a\nb', null) === 'a\nb', 'no chords: the lyrics as they are');
  const bad = C.parseSheet('[C]ok\nhello [Am7x]world\n[H]no');
  check(bad.errors.length === 2 && /Am7x/.test(bad.errors[0].message) && /line 2/.test(bad.errors[0].message), 'a mistyped chord is reported with its line');
  check(C.parseSheet('[x2]\n[Verse 2]\nhi').errors.length === 0, '[x2] and [Verse 2] are labels, not mistakes');
  check(C.parseSheet('hello [world').lyrics === 'hello [world' && C.parseSheet('hello [world').errors.length === 0, 'a bracket that never closes is just text');
  check(C.parseSheet('[]x').errors.length === 0 && C.parseSheet('[]x').lyrics === '[]x', 'an empty bracket is text');
  const trimmed = C.parseSheet('\n\n[C]one   \n\n[G]two\n\n\n');
  eq(trimmed.lyrics, 'one\n\ntwo', 'blank lines at the ends and trailing spaces are dropped');
  eq([Object.keys(trimmed.chords.lines)], [['0', '2']], 'and the chord line numbers follow');
  eq(C.parseSheet('').chords, null, 'an empty sheet has no chords');
  eq(C.parseSheet('just words').chords, null, 'a sheet without brackets has no chords');
  eq(C.parseSheet('[C♯m]x').chords.lines['0'], [[0, 'C#m']], 'the sheet writes standard sharps');
  eq(C.parseSheet('[ Am ]x').chords.lines['0'], [[0, 'Am']], 'spaces inside the bracket are ignored');
}

// ─── Drawing a song ──────────────────────────────────────────────────────────
{
  const lyrics = 'Wise men say\n\nthe end';
  const data = { v: 1, lines: { 0: [[0, 'C'], [5, 'Em']], 1: [[0, 'G'], [0, 'Am']], 2: [[4, 'D']] } };
  const lines = C.buildSongLines(lyrics, data);
  eq(lines[0].segments, [{ chord: 'C', text: 'Wise ' }, { chord: 'Em', text: 'men say' }], 'text is cut at the chords');
  check(lines[1].chordOnly && lines[1].segments.length === 2 && lines[1].segments.every((s) => s.text === ''), 'a chord-only line has empty segments');
  eq(lines[2].segments, [{ chord: null, text: 'the ' }, { chord: 'D', text: 'end' }], 'text before the first chord has no chord');
  check(lines.map((l) => l.segments.map((s) => s.text).join('')).join('\n') === lyrics.replace('\n\n', '\n\n') || lines.map((l) => l.text).join('\n') === lyrics, 'the lyrics are never changed');
  const shown = C.buildSongLines(lyrics, data, (c) => C.transposeToKey(c, 'C', 'D'));
  eq(shown[0].segments.map((s) => s.chord), ['D', 'F#m'], 'chords are mapped for display');
  eq(C.buildSongLines(lyrics, data)[0].segments[0].chord, 'C', '…without touching the stored data');
  eq(data.lines['0'][0], [0, 'C'], 'the stored data is unchanged after drawing (and after transposing)');
  const plain = C.buildSongLines('no chords here', null);
  eq(plain, [{ text: 'no chords here', chordOnly: false, segments: [{ chord: null, text: 'no chords here' }] }], 'a song without chords is one plain segment per line');
  eq(C.buildSongLines('abc', { v: 1, lines: { 0: [[2, 'C'], [0, 'G']] } })[0].segments.map((s) => `${s.chord}:${s.text}`), ['G:ab', 'C:c'], 'chords are put in position order');
  eq(C.buildSongLines('ab', { v: 1, lines: { 0: [[2, 'C']] } })[0].segments.map((s) => `${s.chord}:${s.text}`), ['null:ab', 'C:'], 'a chord at the very end');
  check(C.buildSongLines('a😀b', { v: 1, lines: { 0: [[2, 'C']] } })[0].segments.map((s) => s.text).join('') === 'a😀b', 'an offset inside an emoji does not split it');
  eq(C.plainLyricsWithoutChordLines('[intro]\n\nline one\n\nline two'.replace('[intro]', ''), null), '\n\nline one\n\nline two', 'no chords: lyrics untouched');
  eq(C.plainLyricsWithoutChordLines('\n\nline one\n\nline two', { v: 1, lines: { 0: [[0, 'C']] } }), '\nline one\n\nline two'.replace('\nline', 'line').replace('line one', 'line one'), '(setup)');
}
{
  const data = { v: 1, lines: { 0: [[0, 'C']], 4: [[0, 'G']] } };
  eq(C.plainLyricsWithoutChordLines('\nOne\n\nTwo\n', data), 'One\n\nTwo', 'chord-only lines are left out of the plain text, and the blank lines they leave do not pile up');
  eq(C.plainLyricsWithoutChordLines('One\n\nTwo', null), 'One\n\nTwo', 'no chords: unchanged');
  eq(C.plainLyricsWithoutChordLines('One\n\n\n\nTwo', { v: 1, lines: { 0: [[0, 'C']] } }), 'One\n\n\n\nTwo', 'a song with chords on its text lines keeps its own blank lines');
}

// ─── Plain text with the chords above the lyrics (Copy) ─────────────────────────
{
  const lyrics = 'Wise men say only fools rush in\nBut I can\'t help\n\nShall I stay';
  const data = { v: 1, lines: { 0: [[0, 'C'], [9, 'Em'], [18, 'Am']], 1: [[0, 'F'], [1, 'C']], 2: [[0, 'G'], [0, 'D']] } };
  const text = C.formatChordText(lyrics, data);
  const rows = text.split('\n');
  eq(rows[0], 'C        Em       Am', 'chords are printed at the column of the word they belong to');
  eq(rows[1], 'Wise men say only fools rush in', '… with the lyric line right below');
  eq(rows[2], 'F C', 'two chords that would touch are kept one space apart');
  eq(rows[3], "But I can't help", '(the lyric line)');
  eq(rows[4], 'G D', 'a chord-only line prints just the chords (no empty lyric line)');
  eq(rows[5], 'Shall I stay', 'lines without chords are printed as they are');
  eq(C.formatChordText(lyrics, data, (c) => C.transposeToKey(c, 'C', 'D')).split('\n')[0], 'D        F#m      Bm', 'the chords shown are the transposed ones');
  eq(C.formatChordText('a\nb', null), 'a\nb', 'no chords: the lyrics');
}

// ─── Converting "chords above the words" text ────────────────────────────────
{
  const sheet = `C        Em       Am
Wise men say only fools rush in

F   C     G7
But I can't help falling in love with you

C   G   Am   F
Intro line with nothing under it`;
  const out = C.overLyricsToSheet(sheet);
  const rows = out.split('\n');
  eq(rows[0], '[C]Wise men [Em]say only [Am]fools rush in', 'each chord goes into the lyric line at the column where it was typed');
  eq(rows[2], "[F]But [C]I can'[G7]t help falling in love with you", 'the second line too (chords keep their typed columns, even inside a word)');
  const parsed = C.parseSheet(out);
  check(parsed.errors.length === 0, 'the converted sheet parses');
  eq(parsed.chords.lines['0'], [[0, 'C'], [9, 'Em'], [18, 'Am']], 'positions are the typed columns');
  eq(parsed.chords.lines['2'], [[0, 'F'], [4, 'C'], [10, 'G7']], '(second line)');
  eq(C.overLyricsToSheet('C   G   Am   F\n\nwords'), '[C] [G] [Am] [F]\n\nwords', 'a chord line followed by a blank line stands alone (an intro)');
  eq(C.overLyricsToSheet('C   G\n'), '[C] [G]\n', 'a chord line at the very end stands alone');
  eq(C.overLyricsToSheet('Just some words\nand more words'), 'Just some words\nand more words', 'text with no chord lines is left alone');
  eq(C.overLyricsToSheet('Am I wrong\nto sing'), 'Am I wrong\nto sing', 'a lyric line that starts with a chord-like word is not a chord line');
  const bars = C.overLyricsToSheet('| C | G | Am |\nwords words words');
  check(!/\|/.test(bars) && C.parseSheet(bars).chords.lines['0'].map((x) => x[1]).join(' ') === 'C G Am', 'bar marks are dropped, the chords are kept');
  eq(C.overLyricsToSheet('        G\nshort'), 'short   [G]', 'a chord typed past the end of the words goes after the spacing');
  // sheet → text → sheet: what Copy gives can be pasted back in and becomes the same song
  const lyrics = 'Wise men say only fools rush in\nBut I can\'t help falling in love';
  const data = { v: 1, lines: { 0: [[0, 'C'], [10, 'Em'], [20, 'Am']], 1: [[0, 'F'], [16, 'G7']] } };
  const back = C.parseSheet(C.overLyricsToSheet(C.formatChordText(lyrics, data)));
  eq([back.lyrics, back.chords], [lyrics, data], 'what Copy gives can be pasted back in and becomes the same song');
}

// ─── The global for the page ─────────────────────────────────────────────────
check(globalThis.MaraChords && typeof globalThis.MaraChords.transposeChord === 'function' && globalThis.MaraChords.parseSheet === C.parseSheet, 'the engine is also on globalThis.MaraChords for the page');
{ // big song: fast
  const lines = Array.from({ length: 500 }, (_, i) => `line number ${i} with some words in it`);
  const data = { v: 1, lines: Object.fromEntries(lines.map((_, i) => [i, [[0, 'C'], [5, 'G7'], [12, 'Am']]])) };
  const t0 = Date.now();
  const out = C.buildSongLines(lines.join('\n'), data, (c) => C.transposeToKey(c, 'C', 'F#'));
  check(out.length === 500 && Date.now() - t0 < 500, `500 lines with chords are drawn fast (${Date.now() - t0} ms)`);
}

console.log(failures ? `\n✗ ${failures} failed, ${passes} passed` : `✓ ${passes} checks passed, 0 failed`);
process.exit(failures ? 1 : 0);
