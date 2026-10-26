/**
 * Guitar Node on the server: checks the key and chords an editor sends with a song, and decides what is stored when a
 * song's lyrics change. The chord engine itself is shared with the browser (public/chords.js).
 *
 * Rules:
 *  · original_key is stored as 'C', 'F#', 'Bb' (major) or 'Am', 'F#m' (minor), or NULL when unknown. It is never guessed.
 *  · chords are stored as the engine's canonical JSON, checked against the lyrics (every chord must parse, every position
 *    must lie inside its lyric line); anything else is refused with a message naming the chord.
 *  · A request that does not mention the key / chords at all (an older admin page, an offline edit queued before the
 *    update) keeps the stored ones — unless the lyrics changed, in which case the chords are dropped because their
 *    positions no longer mean anything.
 */
import { normalizeKey, validateChordData, lyricLines, readChordData } from '../../public/chords.js';

const sameLyrics = (a, b) => lyricLines(a).join('\n') === lyricLines(b).join('\n');

/**
 * Reads the key / chords out of a request body.
 *   → { ok: true, has: boolean, hasKey, hasChords, original_key, chords }    (chords: JSON text | null)
 *   → { ok: false, error }
 */
export function readChordFields(data, lyrics) {
  const hasKey = Object.prototype.hasOwnProperty.call(data, 'original_key');
  const hasChords = Object.prototype.hasOwnProperty.call(data, 'chords');
  const out = { ok: true, has: hasKey || hasChords, hasKey, hasChords, original_key: null, chords: null };
  if (hasKey && data.original_key !== null && data.original_key !== '') {
    const key = typeof data.original_key === 'string' ? normalizeKey(data.original_key) : null;
    if (!key) return { ok: false, error: 'The original key must look like C, F#, Bb, Am or F#m (or be left unknown).' };
    out.original_key = key;
  }
  if (hasChords) {
    const checked = validateChordData(data.chords, lyrics);
    if (!checked.ok) {
      const messages = checked.errors.slice(0, 3).map((e) => e.message).join('; ');
      return { ok: false, error: `The guitar chords could not be saved: ${messages}.` };
    }
    out.chords = checked.value ? JSON.stringify(checked.value) : null;
  }
  return out;
}

/**
 * The key and chords to store for a song after an edit.
 * `existing` is the song as stored ({ lyrics, original_key, chords }), or null for a new song; `fields` is what
 * readChordFields returned; `lyrics` the lyrics being saved.
 */
export function resolveChordColumns(existing, fields, lyrics) {
  const unchangedLyrics = !!existing && sameLyrics(existing.lyrics, lyrics);
  const key = fields.hasKey ? fields.original_key : (existing ? existing.original_key || null : null);
  let chords;
  if (fields.hasChords) chords = fields.chords;
  else chords = existing && unchangedLyrics ? existing.chords || null : null;
  return { original_key: key, chords, cleared: !fields.hasChords && !!existing?.chords && !unchangedLyrics };
}

/** A song row as the API returns it: the chords as an object (or null), never the raw JSON text. */
export function shapeChords(row) {
  if (!row) return row;
  return { ...row, original_key: row.original_key || null, chords: readChordData(row.chords) };
}
