-- Tighten display name length to the enforced UI/server validation limit. The
-- old column was created as 100 chars; existing shorter values remain valid.
ALTER TABLE users
  ALTER COLUMN display_name TYPE varchar(50);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url text;
