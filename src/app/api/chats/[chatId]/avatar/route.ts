import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { resolveChatEditAccess } from "@/lib/chat-manage";
import { ChatAvatarError, getChatForAvatar, removeChatAvatar, setChatAvatar } from "@/lib/chat-avatar";

export const dynamic = "force-dynamic";

/**
 * Group avatars for the owner: POST a multipart form with an `avatar` file,
 * DELETE to fall back to the letter tile. Same rules as renaming
 * (creator of a group, or an app admin; public chats are admin-only and the
 * admin panel remains the place for those).
 */
async function resolve(req: NextRequest, rawChatId: string) {
  const payload = await getCurrentUser();
  if (!payload) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  }
  const chatId = Number(rawChatId);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    return { response: NextResponse.json({ error: "Некорректный ID чата" }, { status: 400 }) } as const;
  }
  const access = await resolveChatEditAccess(chatId, payload.userId);
  if (!access.ok) return { response: access.response } as const;
  return { chatId } as const;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  try {
    const resolved = await resolve(req, (await params).chatId);
    if ("response" in resolved) return resolved.response;

    // Body parsing runs only after authorization, so a stranger probing the
    // endpoint gets a clean 403 regardless of what they sent.
    const formData = await req.formData().catch(() => null);
    const file = formData?.get("avatar");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Файл аватарки не передан" }, { status: 400 });
    }

    const result = await setChatAvatar(resolved.chatId, file);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ChatAvatarError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Set chat avatar error:", error);
    return NextResponse.json({ error: "Не удалось сохранить аватарку" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  try {
    const resolved = await resolve(req, (await params).chatId);
    if ("response" in resolved) return resolved.response;

    const chat = await getChatForAvatar(resolved.chatId);
    if (!chat) return NextResponse.json({ error: "Чат не найден" }, { status: 404 });

    const result = await removeChatAvatar(resolved.chatId, chat.avatarUrl);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Remove chat avatar error:", error);
    return NextResponse.json({ error: "Не удалось удалить аватарку чата" }, { status: 500 });
  }
}
