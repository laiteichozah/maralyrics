-- Reader accounts get a profile: a display name and a photo (a small data:image URL, only the owner sees it).
-- Run BEFORE deploying the matching Worker:  npm run db:migrate
ALTER TABLE person_accounts ADD COLUMN display_name TEXT;
ALTER TABLE person_accounts ADD COLUMN avatar TEXT;
