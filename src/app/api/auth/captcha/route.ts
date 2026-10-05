import { NextRequest, NextResponse } from "next/server";
import {
  clientIpFromHeaders,
  consumeRateBucket,
  createCaptchaToken,
  generateCaptchaCode,
  pruneExpiredCaptchaNonces,
  renderCaptchaSvg,
} from "@/lib/captcha";

export const dynamic = "force-dynamic";

/**
 * Issues a registration captcha challenge. POST on purpose: nginx micro-caches
 * API GETs (3 s), and a cached challenge shared between concurrent visitors
 * would be a needless footgun. The token is stateless (HMAC) and single-use;
 * only the rendered SVG leaves this handler — the answer itself never does.
 */
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromHeaders(req.headers);
    // One challenge per click is legitimate, so the cap is generous; it only
    // stops a farm from pre-generating challenges (each costs us the SVG work).
    if (!consumeRateBucket("captcha-issue", ip, 30, 10 * 60 * 1000)) {
      return NextResponse.json({ error: "Слишком много запросов капчи, попробуйте позже" }, { status: 429 });
    }

    const code = generateCaptchaCode();
    const { token } = createCaptchaToken(code);
    const svg = renderCaptchaSvg(code);

    // Challenges expire in minutes; issuing is the cheapest place to sweep the
    // spent/expired nonces so the table cannot grow from failed attempts alone.
    void pruneExpiredCaptchaNonces();

    return NextResponse.json(
      { token, image: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}` },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Captcha issue error:", error);
    return NextResponse.json({ error: "Не удалось выдать капчу" }, { status: 500 });
  }
}
