import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { chatMembers, chats } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getFileFromTelegram } from "@/lib/telegram";

export async function GET(req: NextRequest) {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const chatId = Number(req.nextUrl.searchParams.get("chatId"));
    const fileId = req.nextUrl.searchParams.get("fileId") || "";
    if (!Number.isInteger(chatId) || chatId <= 0 || !fileId || fileId.length > 4096) {
      return NextResponse.json({ error: "Invalid chat or file reference" }, { status: 400 });
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
    if (!chat || chat.securityMode !== "e2ee") {
      return NextResponse.json({ error: "Encrypted attachment not found" }, { status: 404 });
    }

    const result = await getFileFromTelegram(fileId);
    if (!result) {
      return NextResponse.json({ error: "Encrypted file is not available" }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="ciphertext.bin"',
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Encrypted file download error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
