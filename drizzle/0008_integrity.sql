-- Data-integrity cleanup that later application code relies on:
--   * one membership row per (chat, user) so the general chat cannot be joined twice;
--   * a lookup index for the per-user chat list.
--
-- Deduplicate first: older versions could insert the same membership more than
-- once because the registration flow checked the wrong row.

DELETE FROM chat_members a
USING chat_members b
WHERE a.id > b.id
  AND a.chat_id = b.chat_id
  AND a.user_id = b.user_id;

CREATE UNIQUE INDEX IF NOT EXISTS chat_members_chat_user_uidx
  ON chat_members (chat_id, user_id);

CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id);
