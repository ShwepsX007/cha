import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { chatMembers } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { markReceipts, getMessageReceipts } from "@/lib/receipts";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  try {
    const payload = await getCurrentUser();
    if (!payload) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { chatId: chatIdParam } = await params;
    const chatId = Number(chatIdParam);
    if (!Number.isInteger(chatId) || chatId <= 0) {
      return NextResponse.json({ error: "Invalid chat" }, { status: 400 });
    }
    const [membership] = await db
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, payload.userId)));
    if (!membership) return NextResponse.json({ error: "Not a member" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const messageIds = Array.isArray(body.messageIds)
      ? body.messageIds.map((x: unknown) => Number(x)).filter((n: number) => Number.isInteger(n) && n > 0)
      : [];
    const status = body.status === "read" ? "read" : body.status === "delivered" ? "delivered" : "delivered";
    const { updated } = await markReceipts({ userId: payload.userId, chatId, messageIds, status });
    return NextResponse.json({ updated });
  } catch (error) {
    console.error("Message receipt update failed:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  try {
    const payload = await getCurrentUser();
    if (!payload) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { chatId: chatIdParam } = await params;
    const chatId = Number(chatIdParam);
    if (!Number.isInteger(chatId) || chatId <= 0) {
      return NextResponse.json({ error: "Invalid chat" }, { status: 400 });
    }
    const [membership] = await db
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, payload.userId)));
    if (!membership) return NextResponse.json({ error: "Not a member" }, { status: 403 });
    const receipts = await getMessageReceipts(chatId);
    return NextResponse.json({ receipts });
  } catch (error) {
    console.error("Message receipt read failed:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
