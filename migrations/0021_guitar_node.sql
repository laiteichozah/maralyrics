-- Guitar Node: a song's original musical key and its guitar chords (kept apart from the lyrics).
-- Run BEFORE deploying the matching Worker:  npm run db:migrate
--
--   original_key  the key the song was written in, as 'C', 'F#', 'Bb' (major) or 'Am', 'F#m' (minor); NULL = not known.
--                 It is never guessed: an editor sets it (or leaves it unknown).
--   chords        JSON  { "v": 1, "lines": { "<lyric line index>": [ [<character offset>, "<chord>"], … ] } }; NULL = no chords.
--                 The lyrics column is untouched. What a visitor sees when they pick another key is worked out in the browser.
-- Existing songs keep both columns NULL and display exactly as before.
ALTER TABLE songs ADD COLUMN original_key TEXT;
ALTER TABLE songs ADD COLUMN chords TEXT;

-- A proposed edit (the revision queue) carries them too. has_chord_data = 1 when the submitter sent the key / chords at all,
-- so a revision made before this migration does not wipe a song's chords when it is approved.
ALTER TABLE song_revisions ADD COLUMN original_key TEXT;
ALTER TABLE song_revisions ADD COLUMN chords TEXT;
ALTER TABLE song_revisions ADD COLUMN has_chord_data INTEGER NOT NULL DEFAULT 0;
