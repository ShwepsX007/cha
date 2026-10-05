import { NextResponse } from "next/server";
import { isSafeFileName, readAvatarFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

/**
 * Serves user avatars from the runtime upload directory.
 *
 * The route also answers `/avatars/<legacy-file>` for rows that were written
 * into `public/avatars` by earlier versions, so existing profiles keep working.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileName: string }> },
) {
  const { fileName } = await params;
  if (!isSafeFileName(fileName)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const buffer = await readAvatarFile(fileName);
  if (!buffer) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const lower = fileName.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf("."));
  const contentType = CONTENT_TYPES[extension] || "application/octet-stream";

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buffer.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
