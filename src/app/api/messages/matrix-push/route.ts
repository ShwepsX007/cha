import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { chatMembers, chats, matrixPushEvents } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { verifyEncryptedMessageEvent } from "@/lib/matrix/server";
import { notifyChatMessage } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const appUser = await getCurrentUser();
    if (!appUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
    }
    const input = body as {
      chatId?: unknown;
      roomId?: unknown;
      eventId?: unknown;
      accessToken?: unknown;
      deviceId?: unknown;
    };
    if (
      !Number.isInteger(input.chatId) || Number(input.chatId) <= 0 ||
      typeof input.roomId !== "string" ||
      typeof input.eventId !== "string" ||
      typeof input.accessToken !== "string" ||
      typeof input.deviceId !== "string"
    ) {
      return NextResponse.json({ error: "Недостаточно данных Matrix-события" }, { status: 400 });
    }

    const chatId = Number(input.chatId);
    const [chat] = await db
      .select({ securityMode: chats.securityMode, matrixRoomId: chats.matrixRoomId })
      .from(chats)
      .where(eq(chats.id, chatId));
    if (!chat || chat.securityMode !== "e2ee" || chat.matrixRoomId !== input.roomId) {
      return NextResponse.json({ error: "Зашифрованный чат не найден" }, { status: 404 });
    }

    const [membership] = await db
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, appUser.userId)))
      .limit(1);
    if (!membership) return NextResponse.json({ error: "Not a member" }, { status: 403 });

    try {
      await verifyEncryptedMessageEvent({
        roomId: input.roomId,
        eventId: input.eventId,
        accessToken: input.accessToken,
        deviceId: input.deviceId,
        authenticatedAppUserId: appUser.userId,
      });
    } catch {
      // Do not log Matrix access tokens, encrypted payloads, or raw request data.
      return NextResponse.json({ error: "Matrix-событие не прошло проверку" }, { status: 403 });
    }

    const [claimedEvent] = await db
      .insert(matrixPushEvents)
      .values({ eventId: input.eventId, chatId })
      .onConflictDoNothing()
      .returning({ eventId: matrixPushEvents.eventId });
    if (!claimedEvent) return NextResponse.json({ ok: true, duplicate: true });

    // Expire idempotency records after a month to keep this table bounded.
    void db.execute(
      sql`DELETE FROM matrix_push_events WHERE created_at < now() - interval '30 days'`,
    ).catch(() => undefined);

    // E2EE content is intentionally never sent to Web Push. The title/body are
    // generic; only the chat ID is included to open the correct conversation.
    await notifyChatMessage({
      chatId,
      senderId: appUser.userId,
      senderName: "Secret Chat",
      textPreview: "Новое сообщение в приватном чате",
      url: `/?chatId=${chatId}`,
    });

    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Encrypted message push dispatch failed:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Не удалось отправить уведомление" }, { status: 500 });
  }
}
