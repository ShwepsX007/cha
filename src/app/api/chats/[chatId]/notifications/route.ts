import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { chatMembers } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { eq, and } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function PATCH(
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
    const body = await req.json().catch(() => ({}));
    const muted = Boolean(body.muted);

    const [membership] = await db
      .select({ id: chatMembers.id })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, payload.userId)));
    if (!membership) return NextResponse.json({ error: "Not a member" }, { status: 403 });

    await db
      .update(chatMembers)
      .set({ notificationsMuted: muted })
      .where(eq(chatMembers.id, membership.id));

    return NextResponse.json({ muted });
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
