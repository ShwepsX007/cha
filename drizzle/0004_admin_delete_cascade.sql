-- Allow deleting a user who created a chat without blocking the user cascade.
DO $$
DECLARE
  foreign_key_name text;
BEGIN
  SELECT constraint_row.conname
  INTO foreign_key_name
  FROM pg_constraint AS constraint_row
  JOIN pg_attribute AS column_row
    ON column_row.attrelid = constraint_row.conrelid
   AND column_row.attnum = ANY(constraint_row.conkey)
  WHERE constraint_row.conrelid = 'chats'::regclass
    AND constraint_row.confrelid = 'users'::regclass
    AND constraint_row.contype = 'f'
    AND column_row.attname = 'created_by'
  LIMIT 1;

  IF foreign_key_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE chats DROP CONSTRAINT %I', foreign_key_name);
  END IF;
END $$;

ALTER TABLE chats
  ADD CONSTRAINT chats_created_by_users_id_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
