-- Receipts (read markers), push subscriptions, avatar cache-buster column.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_updated_at timestamp with time zone;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS delivery_status varchar(20) NOT NULL DEFAULT 'sent';

CREATE TABLE IF NOT EXISTS message_receipts (
  id serial PRIMARY KEY,
  message_id integer NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'delivered',
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_receipts_message ON message_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_message_receipts_user ON message_receipts(user_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
