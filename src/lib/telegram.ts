
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim() || "";

export const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

export function isTelegramConfigured() {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

function createFormData(field: "photo" | "audio" | "video" | "document", buffer: Buffer, fileName: string, mimeType: string) {
  const formData = new FormData();
  formData.append("chat_id", CHAT_ID);
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  formData.append(field, blob, fileName);
  return formData;
}

async function tgFetch(method: string, formData: FormData): Promise<any> {
  const res = await fetch(`${BASE_URL}/${method}`, { method: "POST", body: formData });
  return res.json();
}

function sanitizeName(name: string, fallbackPrefix: string): string {
  const safe = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").trim();
  if (!safe) return `${fallbackPrefix}_${Date.now()}`;
  return safe;
}

export interface TelegramUploadResult {
  fileId: string;
  fileSize: number;
  /** Bot-API message id inside the storage chat; lets us delete the file later. */
  messageId: number | null;
}

export async function uploadFileToTelegram(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<TelegramUploadResult | null> {
  if (!isTelegramConfigured()) return null;

  const safeName = sanitizeName(fileName, "file");
  const mime = String(mimeType || "application/octet-stream").toLowerCase();

  // Telegram audio endpoint handles mp3/ogg/audio mimes with proper metadata.
  if (mime.startsWith("audio/") || mime === "application/ogg") {
    const fd = createFormData("audio", fileBuffer, safeName, mime);
    const data = await tgFetch("sendAudio", fd);
    if (data.ok && data.result.audio?.file_id) {
      return {
        fileId: data.result.audio.file_id,
        fileSize: data.result.audio.file_size || fileBuffer.length,
        messageId: typeof data.result.message_id === "number" ? data.result.message_id : null,
      };
    }
  }

  // Video endpoint for mp4/webm etc. Falls back to document if Telegram rejects.
  if (mime.startsWith("video/")) {
    const fd = createFormData("video", fileBuffer, safeName, mime);
    const data = await tgFetch("sendVideo", fd);
    if (data.ok && data.result.video?.file_id) {
      return {
        fileId: data.result.video.file_id,
        fileSize: data.result.video.file_size || fileBuffer.length,
        messageId: typeof data.result.message_id === "number" ? data.result.message_id : null,
      };
    }
  }

  // Photo endpoint only accepts images. Use its own fresh FormData so a failed
  // photo request cannot leak a duplicate field into the document fallback.
  if (mime.startsWith("image/")) {
    const fd = createFormData("photo", fileBuffer, safeName, mime);
    const data = await tgFetch("sendPhoto", fd);
    if (data.ok && data.result.photo) {
      const largest = data.result.photo[data.result.photo.length - 1];
      return {
        fileId: largest.file_id,
        fileSize: largest.file_size || fileBuffer.length,
        messageId: typeof data.result.message_id === "number" ? data.result.message_id : null,
      };
    }
  }

  // Everything else: pdf/docx/zip/mp3-fallback etc. sendDocument is the
  // universal endpoint Telegram uses for arbitrary attachments.
  const docFd = createFormData("document", fileBuffer, safeName, mime);
  const data = await tgFetch("sendDocument", docFd);
  if (data.ok && data.result.document?.file_id) {
    return {
      fileId: data.result.document.file_id,
      fileSize: data.result.document.file_size || fileBuffer.length,
      messageId: typeof data.result.message_id === "number" ? data.result.message_id : null,
    };
  }

  return null;
}

/**
 * Removes the bot's storage message (and with it the attachment). Only works
 * for files uploaded while the API bot was configured the same way; every
 * failure is tolerated because the PostgreSQL row is the source of truth.
 */
export async function deleteTelegramMessage(messageId: number): Promise<boolean> {
  if (!isTelegramConfigured() || !Number.isSafeInteger(messageId) || messageId <= 0) return false;
  try {
    const res = await fetch(`${BASE_URL}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, message_id: messageId }),
    });
    const data = await res.json().catch(() => null);
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

export interface TelegramFileResult {
  url: string;
  buffer: Buffer;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
}

export async function getFileFromTelegram(fileId: string): Promise<TelegramFileResult | null> {
  if (!isTelegramConfigured()) return null;

  const getFileUrl = new URL(`${BASE_URL}/getFile`);
  getFileUrl.searchParams.set("file_id", fileId);
  const res = await fetch(getFileUrl);
  const data = await res.json();

  if (!data.ok || !data.result?.file_path) return null;
  if (typeof data.result.file_size === "number" && data.result.file_size > MAX_TELEGRAM_DOWNLOAD_BYTES) {
    console.error("Telegram file too large for Bot API download:", data.result.file_size);
    return null;
  }

  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) return null;
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  return {
    url: fileUrl,
    buffer,
    fileSize: data.result.file_size,
  };
}
