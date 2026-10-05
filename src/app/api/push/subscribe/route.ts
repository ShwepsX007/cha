import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getVapidPublicKey, isPushConfigured, savePushSubscription } from "@/lib/push";

export const dynamic = "force-dynamic";

function isValidBase64(s: unknown): s is string {
  return typeof s === "string" && s.length > 10 && s.length < 4096 && /^[A-Za-z0-9_\-+/=]+$/.test(s);
}

export async function GET() {
  return NextResponse.json({
    configured: isPushConfigured(),
    publicKey: getVapidPublicKey(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const payload = await getCurrentUser();
    if (!payload) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isPushConfigured()) {
      return NextResponse.json({ error: "Push is not configured on the server" }, { status: 503 });
    }
    const body = await req.json().catch(() => ({}));
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    const p256dh = typeof body.p256dh === "string" ? body.p256dh.trim() : "";
    const auth = typeof body.auth === "string" ? body.auth.trim() : "";
    if (!endpoint.startsWith("https://") || !isValidBase64(p256dh) || !isValidBase64(auth)) {
      return NextResponse.json({ error: "Invalid push subscription" }, { status: 400 });
    }
    await savePushSubscription(payload.userId, { endpoint, p256dh, auth });
    return NextResponse.json({ ok: true, publicKey: getVapidPublicKey() });
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
