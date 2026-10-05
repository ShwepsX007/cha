import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const configuredJwtSecret = process.env.JWT_SECRET;

if (!configuredJwtSecret && process.env.NODE_ENV === "production") {
  throw new Error("JWT_SECRET is required in production");
}

const JWT_SECRET = new TextEncoder().encode(
  configuredJwtSecret || "development-only-secret-do-not-use-in-production"
);

/**
 * Signing key for stateless challenge tokens (currently: the registration
 * captcha). Separate from JWT_SECRET so captcha tokens cannot be mistaken
 * for session tokens; falls back to it so a deploy needs no new env var.
 */
export function getCaptchaSecretKey(): Uint8Array {
  const secret = process.env.CAPTCHA_SECRET?.trim() || configuredJwtSecret || "";
  return new TextEncoder().encode(secret || "development-only-captcha-secret");
}

export async function createToken(userId: number, username: string) {
  return new SignJWT({ userId, username })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as { userId: number; username: string };
  } catch {
    return null;
  }
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  if (!token) return null;
  return verifyToken(token);
}
