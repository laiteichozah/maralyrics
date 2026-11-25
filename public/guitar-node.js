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

  // ── The music-note button and its panel ──────────────────────────
  // A slim bar above the lyrics: the music-note button, and beside it what is being shown. The button opens the options panel
  // (show or hide the chords, the key, transposing); a popover on a wide screen, a sheet from the bottom on a phone.
  const panelOpen = () => { const p = el('gnPanel'); return !!p && !p.hidden; };

  /** Where the panel goes. On a phone the stylesheet makes it a sheet from the bottom of the screen; on a wide screen it hangs under the
      button (or above it when there is no room below), kept inside the window. It lives at the top of the page (see wire()), not in the
      song's card, which clips what sticks out of it. */
  function placePanel() {
    const panel = el('gnPanel');
    if (!panel || panel.hidden) return;
    const phone = window.matchMedia('(max-width: 600px)').matches;
    for (const prop of ['top', 'bottom', 'left', 'maxHeight']) panel.style[prop] = '';
    if (phone) return;
    const r = el('gnButton').getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const gap = 8;
    const below = vh - r.bottom - gap - 16;
    const above = r.top - gap - 16;
    panel.style.left = `${Math.max(16, Math.min(r.left, vw - panel.offsetWidth - 16))}px`;
    if (below >= 320 || below >= above) { panel.style.top = `${r.bottom + gap}px`; panel.style.maxHeight = `${Math.max(200, Math.min(600, below))}px`; }
    else { panel.style.bottom = `${vh - r.top + gap}px`; panel.style.maxHeight = `${Math.max(200, Math.min(600, above))}px`; }
  }

  function openPanel() {
    const panel = el('gnPanel');
    if (!s || !panel || !panel.hidden) return;
    panel.hidden = false;
    el('gnBackdrop').hidden = false;
    el('gnButton').setAttribute('aria-expanded', 'true');
    placePanel();
    el('gnToggle').focus({ preventScroll: true });
  }

  function closePanel({ restoreFocus = false } = {}) {
    const panel = el('gnPanel');
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    el('gnBackdrop').hidden = true;
    el('gnButton').setAttribute('aria-expanded', 'false');
    if (restoreFocus) el('gnButton').focus({ preventScroll: true });
  }

  function drawSummary(key) {
    const summary = el('gnSummary');
    summary.textContent = '';
    const word = (cls, text) => { const n = document.createElement('span'); n.className = cls; n.textContent = text; return n; };
    if (!s.show) { summary.append(word('guitar-node__summary-quiet', t('guitar.summary_hidden', 'Chords hidden'))); return; }
    const moved = s.shift % 12 !== 0;
    const shift = s.key ? nearest(s.shift) : s.shift;
    if (s.key) {
      summary.append(word('guitar-node__summary-label', t('guitar.summary_key', 'Key')), ' ', word('guitar-node__summary-key', keyLabel(key)));
    } else {
      summary.append(word('guitar-node__summary-quiet', moved ? t('guitar.summary_moved', 'Moved') : t('guitar.summary_asis', 'Chords as written')));
    }
    if (moved) summary.append(' ', word('guitar-node__badge', signed(shift)));
  }

  function drawControls() {
    const C = chordsApi();
    const box = el('guitarNode');
    if (!box) return;
    box.hidden = false;
    const key = displayKey();

    // the button: its state, and the line beside it (what is shown, at a glance)
    el('gnButton').dataset.chords = s.show ? 'on' : 'off';
    drawSummary(key);

    // the panel: the switch for the chords, and below it the key controls (dimmed and off while the chords are hidden)
    el('gnToggle').setAttribute('aria-checked', String(s.show));
    const controls = el('gnControls');
    controls.classList.toggle('is-off', !s.show);

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
    select.disabled = !s.show;
    el('gnDown').disabled = !s.show || (!s.key && s.shift <= -11);
    el('gnUp').disabled = !s.show || (!s.key && s.shift >= 11);
    el('gnReset').disabled = !s.show || s.shift % 12 === 0;

    // the readout between − and +: the key being shown and how far it is from the original (or, without a key, the semitones)
    const shift = s.key ? nearest(s.shift) : s.shift;
    if (s.key) {
      el('gnReadoutMain').textContent = keyLabel(key);
      el('gnReadoutSub').textContent = s.shift % 12 === 0 ? t('guitar.readout_original', 'Original key') : t('guitar.readout_shift', '{shift} semitones', { shift: signed(shift) });
    } else {
      el('gnReadoutMain').textContent = signed(shift);
      el('gnReadoutSub').textContent = t('guitar.readout_unit', 'semitones');
    }

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
    const box = el('guitarNode');
    if (!box || box.dataset.wired) return;
    box.dataset.wired = '1';
    // The panel and its backdrop move to the top level of the page: the song's card has overflow hidden and a backdrop filter, which would
    // clip a popover and make a fixed sheet position itself against the card instead of the screen.
    document.body.append(el('gnBackdrop'), el('gnPanel'));
    window.addEventListener('resize', placePanel);
    window.addEventListener('scroll', placePanel, { passive: true });
    // open and close: the button, the close button, a tap on the backdrop (phone), Escape, a click or the focus going elsewhere
    el('gnButton').addEventListener('click', () => { if (panelOpen()) closePanel(); else openPanel(); });
    el('gnClose').addEventListener('click', () => closePanel({ restoreFocus: true }));
    el('gnBackdrop').addEventListener('click', () => closePanel());
    const outside = (target) => !(target instanceof Element) || !target.closest('#gnPanel, #gnButton');
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !panelOpen()) return;
      if (e.target === el('gnKey')) return;          // Escape belongs to the open key list first
      e.preventDefault();
      closePanel({ restoreFocus: true });
    });
    document.addEventListener('pointerdown', (e) => { if (panelOpen() && outside(e.target)) closePanel(); });
    document.addEventListener('focusin', (e) => { if (panelOpen() && outside(e.target)) closePanel(); });
    // the switch: show or hide the chords
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
    closePanel();
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
