import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { removePushSubscription } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const payload = await getCurrentUser();
    if (!payload) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    if (endpoint) await removePushSubscription(endpoint);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
