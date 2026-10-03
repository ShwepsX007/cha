import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { messages, chatMembers } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { getFileFromTelegram } from "@/lib/telegram";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> }
) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { messageId } = await params;
    const msgId = Number(messageId);

    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, msgId));

    if (!msg) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Check membership
    const [membership] = await db
      .select()
      .from(chatMembers)
      .where(
        and(eq(chatMembers.chatId, msg.chatId), eq(chatMembers.userId, payload.userId))
      );

    if (!membership) {
      return NextResponse.json({ error: "Not a member" }, { status: 403 });
    }

    if (!msg.telegramFileId) {
      return NextResponse.json({ error: "File not available (Telegram not configured)" }, { status: 404 });
    }

    const result = await getFileFromTelegram(msg.telegramFileId);
    if (!result) {
      return NextResponse.json({ error: "Could not retrieve file" }, { status: 500 });
    }

    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": msg.mimeType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${msg.fileName || "file"}"`,
      },
    });
  } catch (error) {
    console.error("File download error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
