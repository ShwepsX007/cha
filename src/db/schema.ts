import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  varchar,
  bigint,
  jsonb,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 50 }).notNull().unique(),
  displayName: varchar("display_name", { length: 100 }).notNull(),
  passwordHash: text("password_hash").notNull(),
  // Ciphertext only: the recovery key is encrypted in the browser with a
  // PBKDF2-derived key before either value reaches the application server.
  matrixRecoveryKeyEncrypted: text("matrix_recovery_key_encrypted"),
  matrixRecoveryKeySalt: text("matrix_recovery_key_salt"),
  role: varchar("role", { length: 20 }).notNull().default("user"),
  bannedUntil: timestamp("banned_until", { withTimezone: true }),
  banReason: text("ban_reason"),
  matrixResetRequired: boolean("matrix_reset_required").notNull().default(false),
  avatarColor: varchar("avatar_color", { length: 7 }).notNull().default("#6C5CE7"),
  lastSeen: timestamp("last_seen").defaultNow(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const adminAuditLogs = pgTable("admin_audit_logs", {
  id: serial("id").primaryKey(),
  adminId: integer("admin_id").references(() => users.id, { onDelete: "set null" }),
  action: varchar("action", { length: 100 }).notNull(),
  targetType: varchar("target_type", { length: 50 }),
  targetId: text("target_id"),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const chats = pgTable("chats", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }),
  isGroup: boolean("is_group").notNull().default(false),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  // Legacy is deliberately the default: historical rooms must not be
  // mistaken for encrypted until a verified Matrix room is linked.
  securityMode: varchar("security_mode", { length: 20 }).notNull().default("legacy"),
  matrixRoomId: text("matrix_room_id"),
  e2eeEnabledAt: timestamp("e2ee_enabled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const chatMembers = pgTable("chat_members", {
  id: serial("id").primaryKey(),
  chatId: integer("chat_id")
    .references(() => chats.id, { onDelete: "cascade" })
    .notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  chatId: integer("chat_id")
    .references(() => chats.id, { onDelete: "cascade" })
    .notNull(),
  senderId: integer("sender_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  content: text("content"),
  messageType: varchar("message_type", { length: 20 }).notNull().default("text"),
  // Telegram file storage
  telegramFileId: text("telegram_file_id"),
  fileName: varchar("file_name", { length: 500 }),
  fileSize: bigint("file_size", { mode: "number" }),
  mimeType: varchar("mime_type", { length: 200 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
