import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPushSubscriptionCount, isPushConfigured } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const subscriptionCount = await getPushSubscriptionCount(user.userId);
    return NextResponse.json(
      { configured: isPushConfigured(), subscriptionCount },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Push status check failed:", error);
    return NextResponse.json({ error: "Could not check push status" }, { status: 500 });
  }
}
