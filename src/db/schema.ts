import {
  AnyPgColumn,
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
  displayName: varchar("display_name", { length: 50 }).notNull(),
  passwordHash: text("password_hash").notNull(),
  role: varchar("role", { length: 20 }).notNull().default("user"),
  bannedUntil: timestamp("banned_until", { withTimezone: true }),
  banReason: text("ban_reason"),
  avatarColor: varchar("avatar_color", { length: 7 }).notNull().default("#6C5CE7"),
  avatarUrl: text("avatar_url"),
  avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
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
  // Public chats live in the DB, not in the name: admins can rename them
  // freely, and membership/“join everything public” is driven by this flag
  // (drizzle/0012 backfilled it from the historical "Общий чат" name).
  isGeneral: boolean("is_general").notNull().default(false),
  avatarUrl: text("avatar_url"),
  avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
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
  notificationsMuted: boolean("notifications_muted").notNull().default(false),
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
  replyToMessageId: integer("reply_to_message_id").references(
    (): AnyPgColumn => messages.id,
    { onDelete: "set null" },
  ),
  // Telegram file storage
  telegramFileId: text("telegram_file_id"),
  // Bot-API message id of the uploaded attachment in the storage chat; lets
  // deletions remove the Telegram copy too (null for rows predating it).
  telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
  fileName: varchar("file_name", { length: 500 }),
  fileSize: bigint("file_size", { mode: "number" }),
  mimeType: varchar("mime_type", { length: 200 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const messageReceipts = pgTable("message_receipts", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id")
    .references(() => messages.id, { onDelete: "cascade" })
    .notNull(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  status: varchar("status", { length: 20 }).notNull().default("delivered"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Single-use registry for registration captcha tokens (drizzle/0011). Rows
 * are garbage-collected by the app; the table is intentionally bare.
 */
export const captchaNonces = pgTable("captcha_nonces", {
  nonce: text("nonce").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
