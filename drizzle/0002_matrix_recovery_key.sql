-- The encrypted payload and PBKDF2 salt are produced client-side. The app
-- server never receives a plaintext Matrix recovery key or a derived AES key.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS matrix_recovery_key_encrypted text;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS matrix_recovery_key_salt text;
