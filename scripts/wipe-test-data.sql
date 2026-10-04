-- WARNING: irreversible.
-- Run this ONLY against your app PostgreSQL database when you want to remove
-- all existing test users/chats/messages/admin logs and start fresh.
-- After running this, the next registered account will become the first admin.

TRUNCATE TABLE
  admin_audit_logs,
  messages,
  chat_members,
  chats,
  users
RESTART IDENTITY CASCADE;
