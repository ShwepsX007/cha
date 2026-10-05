import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/db";
import { chats } from "@/db/schema";
import { requireAdmin, writeAdminAuditLog } from "@/lib/admin";
import { removeAvatarFile, saveAvatarFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Chat avatars for the admin panel — same pipeline as profile avatars
 * (resized to 256px WebP under UPLOAD_DIR/avatars, served via /avatars/…),
 * and replacing one removes the previous file, just like for users.
 */
async function parseAvatar(file: File) {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new Error("Поддерживаются только JPG, PNG и WebP");
  }
  if (file.size > MAX_AVATAR_BYTES) {
    throw new Error("Файл слишком большой. Максимум 2 МБ");
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  return sharp(buffer).rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
}

async function resolveChat(request: NextRequest, rawChatId: string | null) {
  if (!rawChatId || !/^\d+$/.test(rawChatId)) {
    return { response: NextResponse.json({ error: "Некорректный ID чата" }, { status: 400 }) } as const;
  }
  const chatId = Number(rawChatId);
  const [chat] = await db
    .select({ id: chats.id, avatarUrl: chats.avatarUrl })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  if (!chat) return { response: NextResponse.json({ error: "Чат не найден" }, { status: 404 }) } as const;
  return { chatId, chat };
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  try {
    const formData = await req.formData();
    const resolved = await resolveChat(req, String(formData.get("chatId") ?? ""));
    if ("response" in resolved) return resolved.response;

    const file = formData.get("avatar");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Файл аватарки не передан" }, { status: 400 });
    }

    const processed = await parseAvatar(file);
    const avatarUrl = await saveAvatarFile(`chat-${resolved.chatId}-${randomBytes(4).toString("hex")}.webp`, processed);

    const now = new Date();
    await db
      .update(chats)
      .set({ avatarUrl, avatarUpdatedAt: now })
      .where(eq(chats.id, resolved.chatId));
    if (resolved.chat.avatarUrl) await removeAvatarFile(resolved.chat.avatarUrl);

    await writeAdminAuditLog({
      adminId: auth.admin.id,
      action: "chats.avatar.set",
      targetType: "chat",
      targetId: String(resolved.chatId),
      details: { avatarUrl },
    });

    return NextResponse.json({ avatarUrl, avatarUpdatedAt: now.toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Не удалось сохранить аватарку" },
      { status: 400 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.admin) return auth.response;

  try {
    const resolved = await resolveChat(req, req.nextUrl.searchParams.get("chatId"));
    if ("response" in resolved) return resolved.response;

    const previousAvatar = resolved.chat.avatarUrl;
    const now = new Date();
    await db
      .update(chats)
      .set({ avatarUrl: null, avatarUpdatedAt: now })
      .where(eq(chats.id, resolved.chatId));
    if (previousAvatar) await removeAvatarFile(previousAvatar);

    await writeAdminAuditLog({
      adminId: auth.admin.id,
      action: "chats.avatar.remove",
      targetType: "chat",
      targetId: String(resolved.chatId),
      details: { previousAvatar },
    });

    return NextResponse.json({ avatarUrl: null, avatarUpdatedAt: now.toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Remove chat avatar error:", error);
    return NextResponse.json({ error: "Не удалось удалить аватарку чата" }, { status: 500 });
  }
}
