import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, writeAdminAuditLog } from "@/lib/admin";
import { ChatAvatarError, getChatForAvatar, removeChatAvatar, setChatAvatar } from "@/lib/chat-avatar";

export const dynamic = "force-dynamic";

/**
 * Admin-side chat avatars (any chat, including public ones). The image
 * pipeline itself is shared with group owners via lib/chat-avatar.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  try {
    const formData = await req.formData().catch(() => null);
    const rawChatId = String(formData?.get("chatId") ?? "");
    if (!/^\d+$/.test(rawChatId)) {
      return NextResponse.json({ error: "Некорректный ID чата" }, { status: 400 });
    }
    const chatId = Number(rawChatId);

    const chat = await getChatForAvatar(chatId);
    if (!chat) return NextResponse.json({ error: "Чат не найден" }, { status: 404 });

    const file = formData?.get("avatar");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Файл аватарки не передан" }, { status: 400 });
    }

    // setChatAvatar unlinks the replaced file itself (shared with group owners).
    const result = await setChatAvatar(chatId, file);

    await writeAdminAuditLog({
      adminId: auth.admin.id,
      action: "chats.avatar.set",
      targetType: "chat",
      targetId: String(chatId),
      details: { avatarUrl: result.avatarUrl },
    });

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ChatAvatarError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Admin chat avatar error:", error);
    return NextResponse.json({ error: "Не удалось сохранить аватарку" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  try {
    const rawChatId = req.nextUrl.searchParams.get("chatId") ?? "";
    if (!/^\d+$/.test(rawChatId)) {
      return NextResponse.json({ error: "Некорректный ID чата" }, { status: 400 });
    }
    const chatId = Number(rawChatId);

    const chat = await getChatForAvatar(chatId);
    if (!chat) return NextResponse.json({ error: "Чат не найден" }, { status: 404 });

    const result = await removeChatAvatar(chatId, chat.avatarUrl);

    await writeAdminAuditLog({
      adminId: auth.admin.id,
      action: "chats.avatar.remove",
      targetType: "chat",
      targetId: String(chatId),
      details: { previousAvatar: chat.avatarUrl },
    });

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Admin remove chat avatar error:", error);
    return NextResponse.json({ error: "Не удалось удалить аватарку чата" }, { status: 500 });
  }
}
