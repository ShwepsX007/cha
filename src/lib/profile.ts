import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";

export interface Profile {
  id: number;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  avatarUpdatedAt: string | null;
  role: "user" | "admin";
  bannedUntil: string | null;
  banReason: string | null;
  matrixResetRequired: boolean;
}

const DISPLAY_NAME_INVALID = /[<>]|[\u0000-\u001f\u007f]|&lt;|&gt;|&amp;/i;

export function sanitizeDisplayName(input: unknown): string {
  return typeof input === "string" ? input.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
}

export function validateDisplayName(displayName: string): string | null {
  if (!displayName) return "Отображаемое имя не может быть пустым";
  if (displayName.length > 50) return "Отображаемое имя должно быть не длиннее 50 символов";
  if (DISPLAY_NAME_INVALID.test(displayName)) return "Отображаемое имя не должно содержать специальные символы HTML и управляющие символы";
  return null;
}

export async function getAuthenticatedUser(userId: number) {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
      avatarColor: users.avatarColor,
      avatarUrl: users.avatarUrl,
      avatarUpdatedAt: users.avatarUpdatedAt,
      role: users.role,
      bannedUntil: users.bannedUntil,
      banReason: users.banReason,
      matrixResetRequired: users.matrixResetRequired,
    })
    .from(users)
    .where(eq(users.id, userId));
  return user;
}

type ProfileRow = Omit<Profile, "role" | "bannedUntil" | "avatarUpdatedAt"> & {
  role: string;
  bannedUntil: Date | string | null;
  avatarUpdatedAt: Date | string | null;
  passwordHash?: string;
};

export function serializeProfile(user: ProfileRow): Profile {
  const { passwordHash: _passwordHash, ...rest } = user;
  void _passwordHash;
  return {
    ...rest,
    role: user.role === "admin" ? "admin" : "user",
    bannedUntil: user.bannedUntil instanceof Date ? user.bannedUntil.toISOString() : user.bannedUntil ?? null,
    avatarUpdatedAt: user.avatarUpdatedAt instanceof Date ? user.avatarUpdatedAt.toISOString() : user.avatarUpdatedAt ?? null,
  };
}

export async function requireProfile(): Promise<{ user: Profile } | { response: NextResponse }> {
  const payload = await getCurrentUser();
  if (!payload) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const user = await getAuthenticatedUser(payload.userId);
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  return { user: serializeProfile(user) };
}
