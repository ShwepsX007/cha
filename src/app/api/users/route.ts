import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { ne } from "drizzle-orm";

export async function GET() {
  try {
    const payload = await getCurrentUser();
    if (!payload) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const allUsers = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarColor: users.avatarColor,
        lastSeen: users.lastSeen,
      })
      .from(users)
      .where(ne(users.id, payload.userId));

    return NextResponse.json({ users: allUsers });
  } catch (error) {
    console.error("Users error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
