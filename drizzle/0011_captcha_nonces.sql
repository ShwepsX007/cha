-- Registration captcha + attachment hygiene (2026-10).
--
-- 1) captcha_nonces: single-use registry for stateless HMAC captcha tokens
--    (src/lib/captcha.ts). Rows live only as long as a token is valid; the
--    app prunes them periodically, so the table stays tiny.
-- 2) messages.telegram_message_id: the Bot API message id of an uploaded
--    attachment inside the storage chat. Storing it lets message/chat
--    deletions also remove the Telegram-side copy (best-effort for rows
--    created after this migration; older rows simply keep their file).

CREATE TABLE IF NOT EXISTS captcha_nonces (
  nonce text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_captcha_nonces_created_at
  ON captcha_nonces (created_at);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS telegram_message_id bigint;
