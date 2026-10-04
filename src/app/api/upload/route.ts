import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { messages, chatMembers, chats } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { uploadFileToTelegram } from "@/lib/telegram";
import { getActivePublicChatBan } from "@/lib/moderation";

const MAX_ENCRYPTED_FILE_SIZE = 45 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file");
    const chatId = Number(formData.get("chatId"));

    if (!(file instanceof File) || !Number.isInteger(chatId) || chatId <= 0) {
      return NextResponse.json({ error: "file and chatId required" }, { status: 400 });
    }

    const [membership] = await db
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, payload.userId)));
    if (!membership) {
      return NextResponse.json({ error: "Not a member" }, { status: 403 });
    }

    const [chat] = await db
      .select({ securityMode: chats.securityMode })
      .from(chats)
      .where(eq(chats.id, chatId));
    if (!chat) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 });
    }

    if (chat.securityMode === "e2ee") {
      if (formData.get("encrypted") !== "true" || file.type !== "application/octet-stream") {
        return NextResponse.json(
          { error: "Private files must be encrypted in the browser before upload", code: "E2EE_REQUIRED" },
          { status: 409 },
        );
      }
      if (file.size === 0 || file.size > MAX_ENCRYPTED_FILE_SIZE) {
        return NextResponse.json({ error: "Encrypted file size must be between 1 byte and 45 MB" }, { status: 413 });
      }

      const ciphertext = Buffer.from(await file.arrayBuffer());
      const telegramResult = await uploadFileToTelegram(
        ciphertext,
        `ciphertext-${randomUUID()}.bin`,
        "application/octet-stream",
      );
      if (!telegramResult) {
        return NextResponse.json({ error: "Telegram storage is not configured or upload failed" }, { status: 503 });
      }

      // The encrypted Matrix event—not PostgreSQL—will carry the Telegram ID,
      // original filename, MIME type, size, and Matrix decryption metadata.
      return NextResponse.json({
        telegramFileId: telegramResult.fileId,
        ciphertextSize: telegramResult.fileSize,
      });
    }

    if (chat.securityMode !== "public") {
      return NextResponse.json(
        { error: "Legacy private chats cannot accept new plaintext files", code: "E2EE_REQUIRED" },
        { status: 409 },
      );
    }

    const activeBan = await getActivePublicChatBan(payload.userId);
    if (activeBan) {
      return NextResponse.json(
        {
          error: `Загрузка в общий чат заблокирована до ${activeBan.bannedUntil.toISOString()}`,
          bannedUntil: activeBan.bannedUntil.toISOString(),
          banReason: activeBan.banReason,
        },
        { status: 403 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";
    const fileName = file.name;
    let messageType = "file";
    if (mimeType.startsWith("image/")) messageType = "image";
    else if (mimeType.startsWith("video/")) messageType = "video";

    const telegramResult = await uploadFileToTelegram(buffer, fileName, mimeType);
    const [msg] = await db
      .insert(messages)
      .values({
        chatId,
        senderId: payload.userId,
        content: fileName,
        messageType,
        telegramFileId: telegramResult?.fileId || null,
        fileName,
        fileSize: telegramResult?.fileSize || buffer.length,
        mimeType,
      })
      .returning();

    return NextResponse.json({ message: msg, uploaded: !!telegramResult });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
