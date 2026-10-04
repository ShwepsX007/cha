-- Per-chat notification mute toggle and small index to speed up receipt lookups.
ALTER TABLE chat_members
  ADD COLUMN IF NOT EXISTS notifications_muted boolean NOT NULL DEFAULT false;

-- Help the server quickly find a recipient's subscription and filter muted chats.
CREATE INDEX IF NOT EXISTS idx_chat_members_user_muted ON chat_members(user_id, notifications_muted);
CREATE INDEX IF NOT EXISTS idx_message_receipts_message_status ON message_receipts(message_id, status);
