import { NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { ne } from "drizzle-orm";
import { ensureMatrixIdentity, getMatrixUserId } from "@/lib/matrix/server";

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
        avatarUrl: users.avatarUrl,
        lastSeen: users.lastSeen,
      })
      .from(users)
      .where(ne(users.id, payload.userId));

    const usersWithMatrixIds = await Promise.all(
      allUsers.map(async (user) => {
        try {
          await ensureMatrixIdentity(user.id, user.displayName);
        } catch (error) {
          // Keep public-chat user discovery available if Matrix is not ready.
          console.error("Matrix identity provisioning failed:", error);
        }

        return { ...user, matrixUserId: getMatrixUserId(user.id) };
      }),
    );

    return NextResponse.json({ users: usersWithMatrixIds });
  } catch (error) {
    console.error("Users error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
