-- Public-chat replies retain a foreign key to the original message. Deleting
-- the original leaves the reply intact with a missing quote rather than
-- deleting a second message.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id integer REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to
  ON messages (reply_to_message_id);

-- Idempotency for E2EE push fan-out. The payload only contains an event ID;
-- encrypted message bodies remain exclusively in Matrix ciphertext.
CREATE TABLE IF NOT EXISTS matrix_push_events (
  event_id text PRIMARY KEY,
  chat_id integer NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_matrix_push_events_created_at
  ON matrix_push_events (created_at);
