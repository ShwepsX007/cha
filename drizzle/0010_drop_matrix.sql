-- Matrix/E2EE removal (2026-10): private chats become ordinary PostgreSQL
-- chats on the same pipeline as the public one. Everything that existed only
-- to bridge Synapse (recovery-key envelopes, reset flags, push idempotency
-- rows, room links) is dropped. Message rows for old e2ee chats stay as they
-- are: their Matrix-side history is unreachable by design and the rooms
-- themselves live in Synapse, which is uninstalled separately.

DROP TABLE IF EXISTS matrix_push_events;

ALTER TABLE users DROP COLUMN IF EXISTS matrix_recovery_key_encrypted;
ALTER TABLE users DROP COLUMN IF EXISTS matrix_recovery_key_salt;
ALTER TABLE users DROP COLUMN IF EXISTS matrix_reset_required;

ALTER TABLE chats DROP COLUMN IF EXISTS security_mode;
ALTER TABLE chats DROP COLUMN IF EXISTS matrix_room_id;
ALTER TABLE chats DROP COLUMN IF EXISTS e2ee_enabled_at;
