-- Base schema for the chat application.
--
-- Why this file exists: the repository used to ship only incremental
-- migrations (0001+). On a fresh server `drizzle-kit push` had to be run first
-- to create the base tables, and without it every API route failed at runtime
-- while `next start` still reported "Ready". This migration is idempotent, so
-- it is safe on both fresh and already-provisioned databases.
--
-- Apply with: npm run db:setup  (see scripts/db-setup.ts)

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  username varchar(50) NOT NULL UNIQUE,
  display_name varchar(50) NOT NULL,
  password_hash text NOT NULL,
  matrix_recovery_key_encrypted text,
  matrix_recovery_key_salt text,
  role varchar(20) NOT NULL DEFAULT 'user',
  banned_until timestamptz,
  ban_reason text,
  matrix_reset_required boolean NOT NULL DEFAULT false,
  avatar_color varchar(7) NOT NULL DEFAULT '#6C5CE7',
  avatar_url text,
  avatar_updated_at timestamp with time zone,
  last_seen timestamp DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chats (
  id serial PRIMARY KEY,
  name varchar(100),
  is_group boolean NOT NULL DEFAULT false,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  security_mode varchar(20) NOT NULL DEFAULT 'legacy',
  matrix_room_id text,
  e2ee_enabled_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_members (
  id serial PRIMARY KEY,
  chat_id integer NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notifications_muted boolean NOT NULL DEFAULT false,
  joined_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id serial PRIMARY KEY,
  chat_id integer NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content text,
  message_type varchar(20) NOT NULL DEFAULT 'text',
  telegram_file_id text,
  file_name varchar(500),
  file_size bigint,
  mime_type varchar(200),
  delivery_status varchar(20) NOT NULL DEFAULT 'sent',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id serial PRIMARY KEY,
  admin_id integer REFERENCES users(id) ON DELETE SET NULL,
  action varchar(100) NOT NULL,
  target_type varchar(50),
  target_id text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_receipts (
  id serial PRIMARY KEY,
  message_id integer NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'delivered',
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Hot paths: the public chat is polled every 2 seconds and every chat list
-- request reads the newest message per chat.
CREATE INDEX IF NOT EXISTS idx_messages_chat_created_at ON messages (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs (created_at DESC);
