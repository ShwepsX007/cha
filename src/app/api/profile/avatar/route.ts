import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireProfile } from "@/lib/profile";
import { removeAvatarFile, saveAvatarFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

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

export async function POST(req: NextRequest) {
  const auth = await requireProfile();
  if ("response" in auth) return auth.response;

  try {
    const formData = await req.formData();
    const file = formData.get("avatar");
    if (!(file instanceof File)) return NextResponse.json({ error: "Файл аватарки не передан" }, { status: 400 });

    const processed = await parseAvatar(file);
    const previousAvatar = auth.user.avatarUrl;
    const avatarUrl = await saveAvatarFile(`${auth.user.id}-${randomBytes(4).toString("hex")}.webp`, processed);

    const now = new Date();
    await db.update(users).set({ avatarUrl, avatarUpdatedAt: now }).where(eq(users.id, auth.user.id));
    if (previousAvatar) await removeAvatarFile(previousAvatar);

    return NextResponse.json({ avatarUrl, avatarUpdatedAt: now.toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Не удалось сохранить аватарку" }, { status: 400 });
  }
}

export async function DELETE() {
  const auth = await requireProfile();
  if ("response" in auth) return auth.response;

  try {
    const previousAvatar = auth.user.avatarUrl;
    const now = new Date();
    await db.update(users).set({ avatarUrl: null, avatarUpdatedAt: now }).where(eq(users.id, auth.user.id));
    if (previousAvatar) await removeAvatarFile(previousAvatar);
    return NextResponse.json({ avatarUrl: null, avatarUpdatedAt: now.toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Не удалось удалить аватарку" }, { status: 500 });
  }
}
