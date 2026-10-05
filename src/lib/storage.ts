import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/**
 * Runtime-uploaded files (avatars, local assets) must NOT live inside `public/`.
 *
 * Next.js snapshots the `public/` directory when `next start` boots, so a file
 * written there after startup is not served until the process is restarted:
 * an uploaded avatar would answer 200 with a URL that returns 404 in the
 * browser. Keeping uploads in a data directory and streaming them through a
 * route handler works in dev, in production and in standalone output.
 */
const DEFAULT_UPLOAD_DIR = join(process.cwd(), ".data");

export function getUploadRoot(): string {
  const configured = process.env.UPLOAD_DIR?.trim();
  return configured ? resolve(configured) : DEFAULT_UPLOAD_DIR;
}

export function getAvatarDir(): string {
  return join(getUploadRoot(), "avatars");
}

/** Legacy location used before the fix; still read so old profile rows resolve. */
export function getLegacyAvatarDir(): string {
  return join(process.cwd(), "public", "avatars");
}

export function isSafeFileName(fileName: string): boolean {
  if (!fileName || fileName.length > 200) return false;
  if (fileName !== basename(fileName)) return false;
  return /^[A-Za-z0-9._-]+$/.test(fileName);
}

export async function saveAvatarFile(fileName: string, buffer: Buffer): Promise<string> {
  const dir = getAvatarDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), buffer);
  return `/avatars/${fileName}`;
}

export async function readAvatarFile(fileName: string): Promise<Buffer | null> {
  if (!isSafeFileName(fileName)) return null;
  for (const dir of [getAvatarDir(), getLegacyAvatarDir()]) {
    try {
      return await readFile(
        /*turbopackIgnore: true*/ join(
          /*turbopackIgnore: true*/ dir,
          fileName,
        ),
      );
    } catch {
      // Try the next location.
    }
  }
  return null;
}

export async function removeAvatarFile(publicPath?: string | null): Promise<void> {
  if (!publicPath || typeof publicPath !== "string") return;
  const fileName = basename(publicPath);
  if (!isSafeFileName(fileName)) return;
  for (const dir of [getAvatarDir(), getLegacyAvatarDir()]) {
    try {
      await unlink(
        /*turbopackIgnore: true*/ join(
          /*turbopackIgnore: true*/ dir,
          fileName,
        ),
      );
    } catch {
      // Already gone or never existed in this location.
    }
  }
}
