import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { messages, chatMembers } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { uploadFileToTelegram } from "@/lib/telegram";

export async function POST(req: NextRequest) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const chatId = Number(formData.get("chatId"));

    if (!file || !chatId) {
      return NextResponse.json({ error: "file and chatId required" }, { status: 400 });
    }

    // Check membership
    const [membership] = await db
      .select()
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, payload.userId))
      );

    if (!membership) {
      return NextResponse.json({ error: "Not a member" }, { status: 403 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";
    const fileName = file.name;

    // Determine message type
    let messageType = "file";
    if (mimeType.startsWith("image/")) messageType = "image";
    else if (mimeType.startsWith("video/")) messageType = "video";

    // Try to upload to Telegram
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
