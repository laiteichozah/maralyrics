// ┌───────────────────────────────────────────────┐
// │  MaraLyrics — Guitar Node (song page)           │
// └───────────────────────────────────────────────┘
// Shows a song's guitar chords above its lyrics and lets the visitor move the song to another key without reloading.
// The chord engine is public/chords.js (MaraChords). Nothing here changes the song: the stored key and chords stay as
// they are, and the visitor's chosen key is only remembered in this browser (localStorage), per song.
//
//   GuitarNode.mount(song, lyricsEl)  → true when the song has chords and they are drawn; false → the caller shows plain lyrics
//   GuitarNode.copyText()             → the lyrics with the chords above them as plain text (as shown), or null
const GuitarNode = (() => {
  'use strict';
  const STORE_KEY = 'ml_guitar_node';  // { show: boolean, keys: { [slug]: shift in semitones (−11…11) } }
  const MAX_REMEMBERED = 100;

  let s = null; // the mounted song: { song, lyricsEl, key, chords, shift, show, names }

  const el = (id) => document.getElementById(id);
  const t = (key, fallback, vars) => {
    try {
      let v = I18n.t(key, vars);
      if (!v || v === key) v = fallback;
      return String(v).replace(/\{(\w+)\}/g, (m, name) => (vars && name in vars ? vars[name] : m));
    } catch { return String(fallback).replace(/\{(\w+)\}/g, (m, name) => (vars && name in vars ? vars[name] : m)); }
  };
  const chordsApi = () => (typeof MaraChords !== 'undefined' ? MaraChords : null);

  // ── What the visitor chose, remembered per song ─────────────────
  function readStore() {
    try { const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); return v && typeof v === 'object' ? { show: v.show !== false, keys: v.keys && typeof v.keys === 'object' ? v.keys : {} } : { show: true, keys: {} }; } catch { return { show: true, keys: {} }; }
  }
  function writeStore(mutate) {
    try {
      const store = readStore();
      mutate(store);
      const slugs = Object.keys(store.keys);
      if (slugs.length > MAX_REMEMBERED) slugs.slice(0, slugs.length - MAX_REMEMBERED).forEach((k) => delete store.keys[k]);
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch { /* storage blocked: the choice just lasts until the page is closed */ }
  }

  // ── Keys and shifting ───────────────────────────────────────────
  const modeWord = (key) => t(key.minor ? 'guitar.minor' : 'guitar.major', key.minor ? 'Minor' : 'Major');
  const keyLabel = (key) => `${key.tonic} ${modeWord(key)}`;
  const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');
  const nearest = (shift) => (shift > 6 ? shift - 12 : shift); // 0…11 → −5…+6: the shorter way round, for the words

  /** The key being shown: the original key moved by the current shift. */
  function displayKey() {
    const C = chordsApi();
    if (!s.key) return null;
    return C.parseKey(C.keyForPc(s.key.pc + s.shift, s.key.minor));
  }

  /** The function that turns a stored chord into the one to show. */
  function mapper() {
    const C = chordsApi();
    if (s.shift % 12 === 0) return (chord) => chord;
    if (s.key) { const target = displayKey().name; const from = s.key.name; return (chord) => C.transposeToKey(chord, from, target); }
    const names = C.spellingFromChords(s.names, s.shift);
    return (chord) => C.transposeChord(chord, s.shift, names);
  }

  // ── Drawing the lyrics ──────────────────────────────────────────
  function drawLyrics() {
    const C = chordsApi();
    const box = s.lyricsEl;
    box.textContent = '';
    box.classList.toggle('song-page__lyrics--chords', s.show);
    if (!s.show) {
      box.setAttribute('aria-label', t('guitar.lyrics_plain', 'Lyrics'));
      box.removeAttribute('role');
      box.textContent = C.plainLyricsWithoutChordLines(s.song.lyrics, s.chords);
      return;
    }
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('guitar.lyrics_with_chords', 'Lyrics with guitar chords'));
    const frag = document.createDocumentFragment();
    for (const line of C.buildSongLines(s.song.lyrics, s.chords, mapper())) {
      const row = document.createElement('div');
      if (line.segments.length === 1 && line.segments[0].chord === null) {
        row.className = line.text.trim() === '' ? 'gn-line gn-line--blank' : 'gn-line gn-line--plain';
        row.textContent = line.text;
      } else {
        row.className = `gn-line${line.chordOnly ? ' gn-line--chords' : ''}`;
        for (const seg of line.segments) {
          const col = document.createElement('span');
          col.className = 'gn-seg';
          const chord = document.createElement('span');
          chord.className = 'gn-chord';
          if (seg.chord !== null) chord.textContent = seg.chord;
          const text = document.createElement('span');
          text.className = 'gn-text';
          text.textContent = seg.text;
          col.append(chord, text);
          row.appendChild(col);
        }
      }
      frag.appendChild(row);
    }
    box.appendChild(frag);
  }

  // ── The control panel ───────────────────────────────────────────
  function drawControls() {
    const C = chordsApi();
    const panel = el('guitarNode');
    if (!panel) return;
    panel.hidden = false;
    const key = displayKey();
    const toggle = el('gnToggle');
    toggle.textContent = t(s.show ? 'guitar.hide' : 'guitar.show', s.show ? 'Hide chords' : 'Show chords');
    toggle.setAttribute('aria-pressed', String(s.show));
    el('gnControls').hidden = !s.show;

    const original = el('gnOriginal');
    original.textContent = s.key ? keyLabel(s.key) : t('guitar.key_unknown', 'not set');
    el('gnKeyField').hidden = !s.key;

    // the display key list: the 12 keys of the song's mode, the original marked
    const select = el('gnKey');
    if (s.key) {
      select.textContent = '';
      for (const opt of C.keyOptions(s.key.minor)) {
        const o = document.createElement('option');
        o.value = String(opt.pc);
        const k = C.parseKey(opt.name);
        o.textContent = keyLabel(k) + (opt.pc === s.key.pc ? ` (${t('guitar.original_tag', 'original')})` : '');
        select.appendChild(o);
      }
      select.value = String((s.key.pc + s.shift + 12) % 12);
    }
    el('gnDown').disabled = !s.key && s.shift <= -11;
    el('gnUp').disabled = !s.key && s.shift >= 11;
    el('gnReset').disabled = s.shift % 12 === 0;

    // what is shown, in words (also read out by screen readers when it changes)
    let text;
    if (s.shift % 12 === 0) text = s.key ? t('guitar.status_original', 'Showing the original key, {key}.', { key: keyLabel(s.key) }) : t('guitar.status_original_unknown', 'Showing the chords as written.');
    else if (s.key) text = t('guitar.status_key', 'Showing chords in {key} ({shift} semitones from the original).', { key: keyLabel(key), shift: signed(nearest(s.shift)) });
    else text = t('guitar.status_shift', 'Chords moved {shift} semitones. The original key of this song is not set.', { shift: signed(s.shift) });
    el('gnStatus').textContent = text;
  }

  function setShift(shift, { remember = true } = {}) {
    s.shift = s.key ? ((shift % 12) + 12) % 12 : Math.max(-11, Math.min(11, shift));
    if (remember && s.song.slug) writeStore((store) => { if (s.shift % 12 === 0) delete store.keys[s.song.slug]; else store.keys[s.song.slug] = s.shift; });
    drawLyrics();
    drawControls();
  }

  function wire() {
    const panel = el('guitarNode');
    if (!panel || panel.dataset.wired) return;
    panel.dataset.wired = '1';
    el('gnToggle').addEventListener('click', () => {
      if (!s) return;
      s.show = !s.show;
      writeStore((store) => { store.show = s.show; });
      drawLyrics();
      drawControls();
    });
    el('gnKey').addEventListener('change', (e) => { if (s && s.key) setShift(Number(e.target.value) - s.key.pc); });
    // one semitone down / up: of the displayed key (when the original key is set), or of the chords as they are
    el('gnDown').addEventListener('click', () => { if (s) setShift(s.shift - 1); });
    el('gnUp').addEventListener('click', () => { if (s) setShift(s.shift + 1); });
    el('gnReset').addEventListener('click', () => { if (s) setShift(0); });
    document.addEventListener('i18n-applied', () => { if (s) { drawLyrics(); drawControls(); } });
  }

  // ── Public ──────────────────────────────────────────────────────
  function mount(song, lyricsEl) {
    unmount();
    const C = chordsApi();
    const data = C && song ? C.readChordData(song.chords) : null;
    if (!C || !data || !lyricsEl) return false;
    const key = song.original_key ? C.parseKey(song.original_key) : null; // an unreadable stored key counts as "not set": nothing is guessed
    const store = readStore();
    s = { song, lyricsEl, key, chords: data, shift: 0, show: store.show, names: C.allChords(data) };
    const saved = Number(store.keys[song.slug]);
    if (Number.isInteger(saved) && saved !== 0) s.shift = key ? ((saved % 12) + 12) % 12 : Math.max(-11, Math.min(11, saved));
    wire();
    drawLyrics();
    drawControls();
    return true;
  }

  /** Back to a song without chords: hides the panel and restores the plain lyrics' look. */
  function unmount() {
    s = null;
    const panel = el('guitarNode');
    if (panel) panel.hidden = true;
    const box = el('songLyrics');
    if (box) { box.classList.remove('song-page__lyrics--chords'); box.removeAttribute('role'); box.removeAttribute('aria-label'); }
  }

  function copyText() {
    if (!s || !s.show) return null;
    return chordsApi().formatChordText(s.song.lyrics, s.chords, mapper());
  }

  /** For tests and tools: what is being shown right now. */
  function current() {
    return s ? { shift: s.shift, key: s.key && s.key.name, displayKey: s.key ? displayKey().name : null, show: s.show } : null;
  }

  return { mount, unmount, copyText, current };
})();
