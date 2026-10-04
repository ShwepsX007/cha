import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { isPushConfigured, sendPushToUser } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isPushConfigured()) {
    return NextResponse.json({ error: "Push is not configured on the server" }, { status: 503 });
  }

  try {
    const result = await sendPushToUser(user.userId, {
      title: "Secret Chat",
      body: "Тестовое push-уведомление. Если вы видите его, доставка работает.",
      chatId: 0,
      url: "/",
    });
    if (result.subscriptions === 0) {
      return NextResponse.json(
        { error: "Для этого аккаунта нет сохранённых push-подписок. Переподключите уведомления в настройках." },
        { status: 409 },
      );
    }
    if (result.sent === 0) {
      return NextResponse.json(
        {
          error: "Push-сервис не принял отправку. Проверьте pm2 logs chata; код ошибки безопасно записан в серверный лог.",
          attempted: result.subscriptions,
          failed: result.failed,
          failureStatusCodes: result.failureStatusCodes,
        },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, sent: result.sent, failed: result.failed });
  } catch (error) {
    console.error("Test push dispatch failed:", error instanceof Error ? error.name : "UnknownError");
    return NextResponse.json({ error: "Test push failed; check the server log" }, { status: 502 });
  }
}
