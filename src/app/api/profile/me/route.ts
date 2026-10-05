import { NextResponse } from "next/server";
import { requireProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await requireProfile();
  if ("response" in result) return result.response;
  return NextResponse.json({ user: result.user }, { headers: { "Cache-Control": "no-store" } });
}
