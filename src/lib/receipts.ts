import { db } from "@/db";
import { messages, messageReceipts, chatMembers } from "@/db/schema";
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

  // Marking a message as delivered and read can happen almost at the same
  // time when it is first rendered. A SELECT-then-INSERT races against the
  // unique (message_id, user_id) constraint and can lose the read receipt.
  // Use one atomic upsert and never downgrade read -> delivered.
  const nextStatus = status === "read" ? "read" : "delivered";
  await db
    .insert(messageReceipts)
    .values(ids.map((messageId) => ({ messageId, userId, status: nextStatus })))
    .onConflictDoUpdate({
      target: [messageReceipts.messageId, messageReceipts.userId],
      set: {
        status: sql`CASE
          WHEN ${messageReceipts.status} = 'read' OR EXCLUDED.status = 'read' THEN 'read'
          ELSE 'delivered'
        END`,
        updatedAt: new Date(),
      },
    });
  return { updated: ids.length };
}

/**
 * Compute per-message aggregate receipt status from the sender's perspective:
 * sent (no recipients have acked yet), delivered (at least one recipient got
 * it), read (at least one recipient has read it). Per-recipient counts remain
 * available so group senders can see partial acknowledgements.
 */
export type MessageReceiptSummary = Record<
  number,
  { status: ReceiptStatus; readByCount: number; deliveredToCount: number; recipientCount: number }
>;

export async function getMessageReceipts(chatId: number): Promise<MessageReceiptSummary> {
  const rows = await db
    .select({
      messageId: messageReceipts.messageId,
      status: messageReceipts.status,
      senderId: messages.senderId,
    })
    .from(messageReceipts)
    .innerJoin(messages, eq(messages.id, messageReceipts.messageId))
    .where(eq(messages.chatId, chatId));
  const members = await db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(eq(chatMembers.chatId, chatId));

  const summary: MessageReceiptSummary = {};
  for (const r of rows) {
    const prev = summary[r.messageId] || {
      status: "sent" as ReceiptStatus,
      readByCount: 0,
      deliveredToCount: 0,
      recipientCount: members.filter((member) => member.userId !== r.senderId).length,
    };
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
