import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

function isBase64Url(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9_-]+$/u.test(value);
}

function isEncryptedEnvelope(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 16_384) return false;
  try {
    const envelope = JSON.parse(value) as Record<string, unknown>;
    return envelope.version === 1 &&
      isBase64Url(envelope.iv, 64) &&
      isBase64Url(envelope.ciphertext, 12_000);
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const [profile] = await db
      .select({
        encryptedKey: users.matrixRecoveryKeyEncrypted,
        salt: users.matrixRecoveryKeySalt,
      })
      .from(users)
      .where(eq(users.id, user.userId));

    if (!profile?.encryptedKey || !profile.salt) {
      return NextResponse.json({ recoveryKey: null }, { headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json(
      { recoveryKey: { encryptedKey: profile.encryptedKey, salt: profile.salt } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    console.error("Matrix recovery-key read failed");
    return NextResponse.json({ error: "Не удалось прочитать настройки восстановления" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const payload: unknown = await req.json();
    if (!payload || typeof payload !== "object") {
      return NextResponse.json({ error: "Некорректный зашифрованный recovery key" }, { status: 400 });
    }
    const body = payload as { encryptedKey?: unknown; salt?: unknown };
    if (
      !isEncryptedEnvelope(body.encryptedKey) ||
      !isBase64Url(body.salt, 64)
    ) {
      return NextResponse.json({ error: "Некорректный зашифрованный recovery key" }, { status: 400 });
    }

    const envelope = JSON.parse(body.encryptedKey) as { iv: string; ciphertext: string };
    const saltBytes = Buffer.from(body.salt, "base64url");
    const ivBytes = Buffer.from(envelope.iv, "base64url");
    const ciphertextBytes = Buffer.from(envelope.ciphertext, "base64url");
    if (saltBytes.length !== 16 || ivBytes.length !== 12 || ciphertextBytes.length < 16) {
      return NextResponse.json({ error: "Некорректный зашифрованный recovery key" }, { status: 400 });
    }

    await db.update(users).set({
      matrixRecoveryKeyEncrypted: body.encryptedKey,
      matrixRecoveryKeySalt: body.salt,
    }).where(eq(users.id, user.userId));

    return NextResponse.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("Matrix recovery-key write failed");
    return NextResponse.json({ error: "Не удалось сохранить recovery key" }, { status: 500 });
  }
}
