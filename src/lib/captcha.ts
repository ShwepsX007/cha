import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { captchaNonces } from "@/db/schema";
import { getCaptchaSecretKey } from "@/lib/auth";

/**
 * Self-hosted, stateless registration captcha.
 *
 * The answer is never sent to the client: only an SVG image is rendered. The
 * challenge is an HMAC-signed token (code + issue time + nonce); verification
 * is pure crypto, so nothing has to be kept in memory or in Redis, and a
 * process restart does not invalidate outstanding challenges. The nonce table
 * (drizzle/0011) makes each token single-use.
 */

const TOKEN_TTL_MS = 5 * 60 * 1000;
/** Bots POST instantly; a real human needs a moment to read the picture. */
export const CAPTCHA_MIN_AGE_MS = 1000;

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I, etc.
const CODE_LENGTH = 4;
export const SVG_WIDTH = 240;
export const SVG_HEIGHT = 80;

function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeSegment(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(payload: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export interface CaptchaTokenPayload {
  code: string;
  issuedAt: number;
  nonce: string;
}

export function createCaptchaToken(code: string): { token: string; issuedAt: number } {
  const issuedAt = Date.now();
  const payload = `${encodeSegment(code)}.${issuedAt}.${encodeSegment(randomBytes(12).toString("hex"))}`;
  const signature = sign(payload, getCaptchaSecretKey());
  return { token: `${payload}.${signature}`, issuedAt };
}

/** Returns null when the token is malformed, forged, expired or missing. */
export function verifyCaptchaToken(token: unknown): CaptchaTokenPayload | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [codeSegment, issuedSegment, nonceSegment, signature] = parts;
  const payload = `${codeSegment}.${issuedSegment}.${nonceSegment}`;
  const expected = sign(payload, getCaptchaSecretKey());
  const providedRaw = Buffer.from(signature);
  const expectedRaw = Buffer.from(expected);
  if (providedRaw.length !== expectedRaw.length || !timingSafeEqual(providedRaw, expectedRaw)) return null;

  let code: string;
  let nonce: string;
  let issuedAt: number;
  try {
    code = decodeSegment(codeSegment);
    nonce = decodeSegment(nonceSegment);
    issuedAt = Number(issuedSegment);
  } catch {
    return null;
  }
  if (!Number.isFinite(issuedAt)) return null;
  if (Date.now() - issuedAt > TOKEN_TTL_MS) return null;
  return { code, issuedAt, nonce };
}

/**
 * Marks a captcha nonce as spent. Uses a unique row as an atomic
 * test-and-set: the first caller wins, replays get false. When the database
 * is unreachable the token is treated as spent (deny) — fail closed.
 */
export async function consumeCaptchaNonce(nonce: string): Promise<boolean> {
  try {
    const [winner] = await db
      .insert(captchaNonces)
      .values({ nonce })
      .onConflictDoNothing({ target: captchaNonces.nonce })
      .returning({ nonce: captchaNonces.nonce });
    return Boolean(winner);
  } catch (error) {
    console.error("Captcha nonce bookkeeping failed:", error);
    return false;
  }
}

/** Best-effort housekeeping: tokens expire in minutes, rows must not pile up. */
export async function pruneExpiredCaptchaNonces(): Promise<void> {
  try {
    await db.delete(captchaNonces).where(lte(captchaNonces.createdAt, sql`now() - interval '15 minutes'`));
  } catch {
    // Nothing critical: the table is pruned again on the next request.
  }
}

export function generateCaptchaCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

/**
 * Hand-rolled distorted SVG (no font/graphics dependency): jittered, rotated,
 * independently coloured glyphs over a noise-field background with a wavy
 * strike-through line. Readable at 2× downsizing, unreadable to a naive OCR.
 */
export function renderCaptchaSvg(code: string): string {
  const rand = (min: number, max: number) => min + Math.random() * (max - min);
  const glyphWidth = SVG_WIDTH / (code.length + 1);

  let body = "";
  // Background noise: scattered dots.
  for (let index = 0; index < 90; index += 1) {
    body += `<circle cx="${rand(0, SVG_WIDTH).toFixed(1)}" cy="${rand(0, SVG_HEIGHT).toFixed(1)}" r="${rand(0.6, 1.8).toFixed(1)}" fill="rgba(168,139,250,${rand(0.08, 0.3).toFixed(2)})"/>`;
  }
  // Glyphs.
  code.split("").forEach((char, index) => {
    const x = (glyphWidth * (index + 0.6)).toFixed(1);
    const y = (SVG_HEIGHT / 2 + rand(-6, 6)).toFixed(1);
    const rotate = rand(-28, 28).toFixed(1);
    const hue = Math.floor(rand(250, 300));
    const lightness = Math.floor(rand(60, 78));
    const fontSize = rand(38, 48).toFixed(1);
    body += `<text x="${x}" y="${y}" font-size="${fontSize}" font-weight="700" font-family="Arial, Helvetica, sans-serif" text-anchor="middle" dominant-baseline="central" transform="rotate(${rotate} ${x} ${y})" fill="hsl(${hue} 85% ${lightness}%)">${char}</text>`;
  });
  // Strike-through squiggles.
  for (let line = 0; line < 2; line += 1) {
    const y1 = rand(10, SVG_HEIGHT - 10).toFixed(1);
    const y2 = rand(10, SVG_HEIGHT - 10).toFixed(1);
    body += `<path d="M -10 ${y1} Q ${SVG_WIDTH * 0.33} ${y2}, ${SVG_WIDTH * 0.5} ${rand(10, 70).toFixed(1)} T ${SVG_WIDTH + 10} ${y1}" stroke="rgba(196,181,253,0.4)" stroke-width="1.6" fill="none"/>`;
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="Капча">` +
    `<rect width="100%" height="100%" fill="#13131a"/>` +
    body +
    `</svg>`
  );
}

/**
 * Per-IP fixed-window counters, kept in the process (single pm2 instance
 * deployment). Stored on globalThis so dev hot-reloads do not reset buckets.
 * Not a distributed limit: it bounds one process; the captcha itself is the
 * main bot barrier, the window is the backstop requested by the owner
 * ("no more than 3 registrations at a time from one IP").
 */
interface Bucket {
  windowStartedAt: number;
  count: number;
}

type LimitStore = Map<string, Map<string, Bucket>>;

function getStore(key: string): LimitStore {
  const store = globalThis as typeof globalThis & { [key]?: LimitStore };
  if (!store[key]) store[key] = new Map();
  return store[key];
}

/** Current usage of a window; 0 when no events (or window expired). */
export function peekRateBucket(namespace: string, clientKey: string, windowMs: number): number {
  const bucket = getStore("__chataRateBuckets").get(clientKey)?.get(namespace);
  if (!bucket || Date.now() - bucket.windowStartedAt > windowMs) return 0;
  return bucket.count;
}

/** Count one event (used for the "3 registrations per hour per IP" success cap). */
export function recordRateEvent(namespace: string, clientKey: string, windowMs: number): void {
  consumeRateBucket(namespace, clientKey, Number.MAX_SAFE_INTEGER, windowMs);
}

/** True when the key is still under `max` events per `windowMs` (counts itself). */
export function consumeRateBucket(
  namespace: string,
  clientKey: string,
  max: number,
  windowMs: number,
): boolean {
  const store = getStore("__chataRateBuckets");
  const now = Date.now();
  if (store.size > 5000) {
    for (const [ip, buckets] of store) {
      for (const [name, bucket] of buckets) {
        if (now - bucket.windowStartedAt > windowMs * 2) buckets.delete(name);
      }
      if (buckets.size === 0) store.delete(ip);
    }
  }
  let buckets = store.get(clientKey);
  if (!buckets) {
    buckets = new Map();
    store.set(clientKey, buckets);
  }
  const bucket = buckets.get(namespace);
  if (!bucket || now - bucket.windowStartedAt > windowMs) {
    buckets.set(namespace, { windowStartedAt: now, count: 1 });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

/** Seconds until the current window for `clientKey` restarts (0 when open). */
export function rateBucketRetryAfterMs(namespace: string, clientKey: string, windowMs: number): number {
  const bucket = getStore("__chataRateBuckets").get(clientKey)?.get(namespace);
  if (!bucket) return 0;
  return Math.max(0, bucket.windowStartedAt + windowMs - Date.now());
}

/**
 * Best-effort client IP. X-Forwarded-For is only trusted because nginx
 * terminates TLS on this deployment; a garbage header is not used as a key
 * (attackers could otherwise mint unlimited buckets) — such requests share
 * the single "unknown" bucket instead.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first && /^[0-9a-fA-F:.]{4,64}$/.test(first)) return first;
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp && /^[0-9a-fA-F:.]{4,64}$/.test(realIp)) return realIp;
  return "unknown";
}
