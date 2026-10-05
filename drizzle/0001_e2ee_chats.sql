-- Safe, idempotent schema update for the Matrix E2EE rollout.
-- Existing private-room rows deliberately remain `legacy`; only the existing
-- General Chat is explicitly kept public/plaintext.
ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS security_mode varchar(20) NOT NULL DEFAULT 'legacy';

ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS matrix_room_id text;

ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS e2ee_enabled_at timestamptz;

UPDATE chats
SET security_mode = 'public'
WHERE id = (
  SELECT id
  FROM chats
  WHERE is_group = true AND name = 'Общий чат'
  ORDER BY id ASC
  LIMIT 1
);
