const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

export function isTelegramConfigured() {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

export async function uploadFileToTelegram(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<{ fileId: string; fileSize: number } | null> {
  if (!isTelegramConfigured()) return null;

  const formData = new FormData();
  formData.append("chat_id", CHAT_ID);

  const uint8 = new Uint8Array(fileBuffer);
  const blob = new Blob([uint8], { type: mimeType });

  if (mimeType.startsWith("image/")) {
    formData.append("photo", blob, fileName);
    const res = await fetch(`${BASE_URL}/sendPhoto`, {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    if (data.ok && data.result.photo) {
      const largest = data.result.photo[data.result.photo.length - 1];
      return { fileId: largest.file_id, fileSize: largest.file_size || fileBuffer.length };
    }
  }

  // For videos, documents, and everything else
  formData.append("document", blob, fileName);
  const res = await fetch(`${BASE_URL}/sendDocument`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (data.ok && data.result.document) {
    return {
      fileId: data.result.document.file_id,
      fileSize: data.result.document.file_size || fileBuffer.length,
    };
  }

  return null;
}

export async function getFileFromTelegram(fileId: string): Promise<{
  url: string;
  buffer: Buffer;
} | null> {
  if (!isTelegramConfigured()) return null;

  const getFileUrl = new URL(`${BASE_URL}/getFile`);
  getFileUrl.searchParams.set("file_id", fileId);
  const res = await fetch(getFileUrl);
  const data = await res.json();

  if (!data.ok || !data.result.file_path) return null;

  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  return { url: fileUrl, buffer };
}
