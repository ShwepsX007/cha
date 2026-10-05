-- Admin-manageable general chats (2026-10).
--
-- The "general chat" concept moves from name-matching to a persistent flag,
-- so renaming (a requested admin action) can no longer orphan the public-chat
-- rules or make ensureGeneralChatMembership() create a second "Общий чат".
-- avatar_* mirror the users.avatar_* pattern: files live in UPLOAD_DIR/avatars
-- and are served through /avatars/[fileName].

ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_general boolean NOT NULL DEFAULT false;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_updated_at timestamp with time zone;

-- Backfill: every existing group chat named "Общий чат" becomes flagged.
UPDATE chats SET is_general = true
WHERE is_group AND name = 'Общий чат' AND is_general = false;
