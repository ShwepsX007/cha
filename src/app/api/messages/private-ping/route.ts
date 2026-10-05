import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatMembers, chats, matrixPushEvents, users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { notifyPrivateChatMessage } from "@/lib/notifications";

export const dynamic = "force-dynamic";

/**
 * Keep an authenticated notification ping below an abusive rate while leaving
 * plenty of headroom for a busy chat. The count includes recent claims made by
 * both this endpoint and the older Matrix-verified relay.
 */
const MAX_CLAIMS_PER_MINUTE = 60;

function isValidEventId(eventId: string): boolean {
  return eventId.length <= 255 && eventId.startsWith("$") && !/\s/u.test(eventId);
}

/**
 * A lightweight ping that says "I just sent an encrypted message into this
 * chat". Private message plaintext never reaches this server. The older relay
 * at `/api/messages/matrix-push` also verifies the event against Synapse, but
 * that verification depends on a live Matrix token. This authenticated ping
 * keeps push working when that token has just expired or rotated. This endpoint
 * intentionally does not treat eventId as proof that Synapse accepted a message;
 * it only deduplicates client pings. The app session, chat membership, generic
 * notification body, and per-chat throttle bound that trade-off.
 */
export async function POST(req: NextRequest) {
  try {
    const appUser = await getCurrentUser();
    if (!appUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
    }
    const input = body as { chatId?: unknown; eventId?: unknown };
    const chatId = Number(input.chatId);
    const eventId = typeof input.eventId === "string" ? input.eventId : "";
    if (!Number.isInteger(chatId) || chatId <= 0) {
      return NextResponse.json({ error: "chatId required" }, { status: 400 });
    }
    if (!isValidEventId(eventId)) {
      return NextResponse.json({ error: "eventId required" }, { status: 400 });
    }

    const [chat] = await db
      .select({ securityMode: chats.securityMode })
      .from(chats)
      .where(eq(chats.id, chatId));
    // Public chats notify from `POST /api/messages`, where the content exists.
    if (!chat) return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    if (chat.securityMode !== "e2ee") {
      return NextResponse.json({ error: "Chat is not end-to-end encrypted" }, { status: 409 });
    }

    const [membership] = await db
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, appUser.userId)))
      .limit(1);
    if (!membership) return NextResponse.json({ error: "Not a member" }, { status: 403 });

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(matrixPushEvents)
      .where(
        and(
          eq(matrixPushEvents.chatId, chatId),
          sql`${matrixPushEvents.createdAt} > now() - interval '1 minute'`,
        ),
      );
    if (Number(count) >= MAX_CLAIMS_PER_MINUTE) {
      return NextResponse.json({ error: "Слишком много уведомлений" }, { status: 429 });
    }

    // Read display name before claiming the event, so a DB error here does not
    // mark an event as delivered before the push fan-out has even started.
    const [sender] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, appUser.userId));

    // Claim the event id first: a client retry must never double-notify.
    const [claimedEvent] = await db
      .insert(matrixPushEvents)
      .values({ eventId, chatId })
      .onConflictDoNothing()
      .returning({ eventId: matrixPushEvents.eventId });
    if (!claimedEvent) {
      return NextResponse.json({ ok: true, duplicate: true }, { headers: { "Cache-Control": "no-store" } });
    }

    // Expire idempotency records after a month to keep this table bounded.
    void db
      .execute(sql`DELETE FROM matrix_push_events WHERE created_at < now() - interval '30 days'`)
      .catch(() => undefined);

    const result = await notifyPrivateChatMessage({
      chatId,
      senderId: appUser.userId,
      senderName: sender?.displayName || "Secret Chat",
    });

    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Private chat push dispatch failed:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Не удалось отправить уведомление" }, { status: 500 });
  }
}
