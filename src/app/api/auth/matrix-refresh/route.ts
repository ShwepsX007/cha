import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { refreshMatrixSession } from "@/lib/matrix/server";

export const dynamic = "force-dynamic";

/**
 * Silently rotates a stored Matrix refresh token into a fresh access token.
 *
 * The browser can call this on every page load without ever asking for the
 * account password, which is what was missing before: an expired Matrix token
 * used to mean "re-enter your password", and with Synapse's default
 * `refreshable_access_token_lifetime` of 5 minutes that happened constantly.
 * A rejected refresh token (already rotated, or the device was revoked) is
 * reported as 401 so the client can fall back to password recovery.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getCurrentUser();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
    }
    const input = body as { refreshToken?: unknown; deviceId?: unknown };
    if (
      typeof input.refreshToken !== "string" || !input.refreshToken || input.refreshToken.length > 8192 ||
      typeof input.deviceId !== "string" || !/^[A-Za-z0-9._=-]{1,255}$/u.test(input.deviceId)
    ) {
      return NextResponse.json({ error: "Нужны Matrix refresh token и device ID" }, { status: 400 });
    }

    const matrixSession = await refreshMatrixSession({
      appUserId: session.userId,
      deviceId: input.deviceId,
      refreshToken: input.refreshToken,
    });

    return NextResponse.json(
      { matrixAvailability: "ready", matrixSession },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const rejected = /rejected \(40[13]\)|could not be verified|does not match/.test(message);
    if (!rejected) console.error("Matrix token refresh failed:", message || "unknown");
    return NextResponse.json(
      { error: rejected
        ? "Matrix-сессия на этом устройстве больше не может обновляться автоматически. Введите пароль один раз."
        : "Не удалось обновить Matrix-сессию" },
      { status: rejected ? 401 : 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
