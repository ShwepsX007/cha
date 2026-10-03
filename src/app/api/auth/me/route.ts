import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";

export async function GET() {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ user: null }, { status: 401 });
    }

    const [user] = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarColor: users.avatarColor,
      })
      .from(users)
      .where(eq(users.id, payload.userId));

    if (!user) {
      return NextResponse.json({ user: null }, { status: 401 });
    }

    // Update last seen
    await db.update(users).set({ lastSeen: new Date() }).where(eq(users.id, user.id));

    return NextResponse.json({ user });
  } catch {
    return NextResponse.json({ user: null }, { status: 401 });
  }
}
