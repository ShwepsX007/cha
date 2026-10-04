import { db } from "@/db";
import { messages, messageReceipts } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

export type ReceiptStatus = "sent" | "delivered" | "read";

/**
 * Mark a list of messages as delivered/read for the given user. Only applies
 * to messages NOT authored by that user (a user does not "read" their own
 * messages) in the specified chat. Used when a recipient opens a chat and
 * its messages are visible.
 */
export async function markReceipts(params: {
  userId: number;
  chatId: number;
  messageIds: number[];
  status: ReceiptStatus;
}) {
  const { userId, chatId, messageIds, status } = params;
  if (!messageIds.length) return { updated: 0 };
  // Safety: only update messages in this chat authored by someone else.
  const valid = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        sql`${messages.senderId} <> ${userId}`,
        inArray(messages.id, messageIds),
      ),
    );
  const ids = valid.map((r) => r.id);
  if (!ids.length) return { updated: 0 };

  // Upsert receipts. If a row already exists, only promote status upward
  // (sent < delivered < read).
  const level = status === "read" ? 2 : status === "delivered" ? 1 : 0;
  let updated = 0;
  for (const id of ids) {
    const [existing] = await db
      .select({ id: messageReceipts.id, status: messageReceipts.status })
      .from(messageReceipts)
      .where(
        and(
          eq(messageReceipts.messageId, id),
          eq(messageReceipts.userId, userId),
        ),
      );
    const existingLevel = existing
      ? existing.status === "read" ? 2 : existing.status === "delivered" ? 1 : 0
      : -1;
    if (!existing) {
      await db.insert(messageReceipts).values({
        messageId: id,
        userId,
        status: level >= 2 ? "read" : level === 1 ? "delivered" : "delivered",
      });
      updated += 1;
    } else if (level > existingLevel) {
      await db
        .update(messageReceipts)
        .set({
          status: level >= 2 ? "read" : "delivered",
          updatedAt: new Date(),
        })
        .where(eq(messageReceipts.id, existing.id));
      updated += 1;
    }
  }
  return { updated };
}

/**
 * Compute per-message aggregate receipt status from the perspective of the
 * sender: sent (no recipients have acked yet), delivered (at least one
 * recipient got it), read (all non-sender recipients in the chat read it).
 */
export type MessageReceiptSummary = Record<
  number,
  { status: ReceiptStatus; readByCount: number; deliveredToCount: number }
>;

export async function getMessageReceipts(chatId: number): Promise<MessageReceiptSummary> {
  const rows = await db
    .select({
      messageId: messageReceipts.messageId,
      status: messageReceipts.status,
    })
    .from(messageReceipts)
    .innerJoin(messages, eq(messages.id, messageReceipts.messageId))
    .where(eq(messages.chatId, chatId));

  const summary: MessageReceiptSummary = {};
  for (const r of rows) {
    const prev = summary[r.messageId] || { status: "sent" as ReceiptStatus, readByCount: 0, deliveredToCount: 0 };
    if (r.status === "read") {
      prev.readByCount += 1;
      prev.deliveredToCount += 1;
      prev.status = "read";
    } else if (r.status === "delivered") {
      prev.deliveredToCount += 1;
      if (prev.status !== "read") prev.status = "delivered";
    }
    summary[r.messageId] = prev;
  }
  return summary;
}
