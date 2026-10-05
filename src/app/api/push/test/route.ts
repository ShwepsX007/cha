import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { isPushConfigured, missingPushEnv, sendPushToUser } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isPushConfigured()) {
    return NextResponse.json(
      {
        error: `Push не настроен на сервере. Не задано: ${missingPushEnv().join(", ") || "проверьте VAPID_*"} . `
          + "VAPID_EMAIL обязателен и должен быть в формате mailto:admin@example.com.",
        missingEnv: missingPushEnv(),
      },
      { status: 503 },
    );
  }

  try {
    const result = await sendPushToUser(user.userId, {
      title: "Secret Chat",
      body: "Тестовое push-уведомление. Если вы видите его, доставка работает.",
      chatId: 0,
      url: "/",
      force: true,
    });
    if (result.subscriptions === 0) {
      return NextResponse.json(
        { error: "Для этого аккаунта нет сохранённых push-подписок. Переподключите уведомления в настройках." },
        { status: 409 },
      );
    }
    if (result.sent === 0) {
      const codes = new Set(result.failureStatusCodes);
      const hint = codes.has(404) || codes.has(410)
        ? "Подписки устарели: выключите и снова включите уведомления в настройках профиля."
        : codes.has(401) || codes.has(403)
          ? "Push-сервис отклонил VAPID-ключи: вероятно, VAPID_PUBLIC_KEY не соответствует VAPID_PRIVATE_KEY или подписка создана другим ключом. Пересоздайте ключи и включите уведомления заново."
          : result.failureStatusCodes.length === 0
            ? "Ни один запрос не дошёл до push-сервиса (нет интернета к fcm.googleapis.com / updates.push.services.mozilla.com или таймаут). Проверьте исходящий трафик на VPS."
            : "Проверьте pm2 logs chata; код ошибки безопасно записан в серверный лог.";
      return NextResponse.json(
        {
          error: `Push-сервис не принял отправку. ${hint}`,
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
