import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

export async function getActivePublicChatBan(userId: number) {
  const [user] = await db
    .select({ bannedUntil: users.bannedUntil, banReason: users.banReason })
    .from(users)
    .where(eq(users.id, userId));

  if (!user?.bannedUntil) return null;
  const bannedUntil = user.bannedUntil instanceof Date ? user.bannedUntil : new Date(user.bannedUntil);
  if (!Number.isFinite(bannedUntil.getTime()) || bannedUntil.getTime() <= Date.now()) return null;
  return { bannedUntil, banReason: user.banReason };
}
