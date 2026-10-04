-- Admin roles, moderation state, Matrix repair flags, and immutable admin audit history.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role varchar(20) NOT NULL DEFAULT 'user';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banned_until timestamptz;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ban_reason text;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS matrix_reset_required boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id serial PRIMARY KEY,
  admin_id integer REFERENCES users(id) ON DELETE SET NULL,
  action varchar(100) NOT NULL,
  target_type varchar(50),
  target_id text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_logs_created_at_idx
  ON admin_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_admin_id_idx
  ON admin_audit_logs (admin_id);
