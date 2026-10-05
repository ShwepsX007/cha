import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { chats } from "@/db/schema";
import { removeAvatarFile, saveAvatarFile } from "@/lib/storage";

/**
 * Chat avatars shared by the admin panel and by group owners. Same pipeline
 * as profile avatars: image resized to 256px WebP under UPLOAD_DIR/avatars,
 * served through /avatars/[fileName] (outside public/ on purpose — see
 * lib/storage.ts), with an `avatar_updated_at` timestamp for cache busting.
 */

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/** User-facing avatar problems (format/size/corrupt image) — routes map these
 *  to 400 with the message; anything else is a 500. */
export class ChatAvatarError extends Error {}

export interface ChatAvatarResult {
  avatarUrl: string | null;
  avatarUpdatedAt: string;
}

export async function getChatForAvatar(chatId: number) {
  const [chat] = await db
    .select({ id: chats.id, avatarUrl: chats.avatarUrl })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);
  return chat ?? null;
}

export async function setChatAvatar(chatId: number, file: File): Promise<ChatAvatarResult> {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new ChatAvatarError("Поддерживаются только JPG, PNG и WebP");
  }
  if (file.size > MAX_AVATAR_BYTES) {
    throw new ChatAvatarError("Файл слишком большой. Максимум 2 МБ");
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  let processed: Buffer;
  try {
    processed = await sharp(buffer)
      .rotate()
      .resize(256, 256, { fit: "cover" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new ChatAvatarError("Не удалось обработать изображение — проверьте, что файл действительно картинка");
  }

  // Read the old path BEFORE updating: UPDATE..RETURNING yields the new row,
  // and unlinking that would delete the file we just saved.
  const [before] = await db
    .select({ avatarUrl: chats.avatarUrl })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);

  const avatarUrl = await saveAvatarFile(`chat-${chatId}-${randomBytes(4).toString("hex")}.webp`, processed);
  const now = new Date();
  await db
    .update(chats)
    .set({ avatarUrl, avatarUpdatedAt: now })
    .where(eq(chats.id, chatId));

  // The replaced file goes after the row points at the new one; a failure
  // here would only leave an orphan under UPLOAD_DIR, never a dangling row.
  if (before?.avatarUrl && before.avatarUrl !== avatarUrl) await removeAvatarFile(before.avatarUrl);

  return { avatarUrl, avatarUpdatedAt: now.toISOString() };
}

export async function removeChatAvatar(chatId: number, previousAvatar: string | null): Promise<ChatAvatarResult> {
  const now = new Date();
  await db
    .update(chats)
    .set({ avatarUrl: null, avatarUpdatedAt: now })
    .where(eq(chats.id, chatId));
  if (previousAvatar) await removeAvatarFile(previousAvatar);
  return { avatarUrl: null, avatarUpdatedAt: now.toISOString() };
}
