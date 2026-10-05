"use client";

const PBKDF2_ITERATIONS = 100_000;
const RECOVERY_KEY_AAD = new TextEncoder().encode("chata-matrix-recovery-key-v1");

export interface EncryptedRecoveryKeyRecord {
  encryptedKey: string;
  salt: string;
}

interface RecoveryKeyEnvelope {
  version: 1;
  iv: string;
  ciphertext: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Некорректный формат ключа восстановления");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deriveEncryptionKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(password);
  try {
    const material = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    passwordBytes.fill(0);
  }
}

export async function encryptRecoveryKeyForProfile(
  recoveryKey: string,
  password: string,
): Promise<EncryptedRecoveryKeyRecord> {
  if (!recoveryKey || !password) throw new Error("Нужны recovery key и пароль аккаунта");
  if (!crypto.subtle) throw new Error("Браузер не поддерживает безопасное хранение ключей");

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(recoveryKey);
  try {
    const encryptionKey = await deriveEncryptionKey(password, salt);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: RECOVERY_KEY_AAD },
      encryptionKey,
      plaintext,
    );
    const envelope: RecoveryKeyEnvelope = {
      version: 1,
      iv: toBase64Url(iv),
      ciphertext: toBase64Url(new Uint8Array(encrypted)),
    };
    return { encryptedKey: JSON.stringify(envelope), salt: toBase64Url(salt) };
  } finally {
    plaintext.fill(0);
    salt.fill(0);
    iv.fill(0);
  }
}

export async function decryptRecoveryKeyFromProfile(
  record: EncryptedRecoveryKeyRecord,
  password: string,
): Promise<string> {
  if (!password) throw new Error("Введите пароль аккаунта, чтобы открыть recovery key");
  if (!crypto.subtle) throw new Error("Браузер не поддерживает безопасное хранение ключей");

  if (record.encryptedKey.length > 16_384 || record.salt.length > 64) {
    throw new Error("Сохранённый recovery key повреждён");
  }

  let envelope: RecoveryKeyEnvelope;
  try {
    const parsed = JSON.parse(record.encryptedKey) as Partial<RecoveryKeyEnvelope>;
    if (
      parsed.version !== 1 ||
      typeof parsed.iv !== "string" ||
      parsed.iv.length > 64 ||
      typeof parsed.ciphertext !== "string" ||
      parsed.ciphertext.length > 12_000
    ) {
      throw new Error("Некорректный формат");
    }
    envelope = parsed as RecoveryKeyEnvelope;
  } catch {
    throw new Error("Сохранённый recovery key имеет неверный формат");
  }

  const salt = fromBase64Url(record.salt);
  const iv = fromBase64Url(envelope.iv);
  const ciphertext = fromBase64Url(envelope.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16 || ciphertext.length > 8192) {
    throw new Error("Сохранённый recovery key повреждён");
  }

  const encryptionKey = await deriveEncryptionKey(password, salt);
  let plaintext: Uint8Array<ArrayBuffer> | null = null;
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: RECOVERY_KEY_AAD },
      encryptionKey,
      ciphertext,
    );
    plaintext = new Uint8Array(decrypted);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new Error("Не удалось открыть recovery key. Проверьте пароль аккаунта или используйте ключ вручную.");
  } finally {
    plaintext?.fill(0);
    salt.fill(0);
    iv.fill(0);
    ciphertext.fill(0);
  }
}

export async function fetchStoredRecoveryKey(): Promise<EncryptedRecoveryKeyRecord | null> {
  const response = await fetch("/api/matrix/recovery-key", { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 401 ? "Сессия приложения истекла" : "Не удалось получить recovery key из профиля");
  const data = await response.json() as { recoveryKey?: EncryptedRecoveryKeyRecord | null };
  if (!data.recoveryKey) return null;
  if (
    typeof data.recoveryKey.encryptedKey !== "string" ||
    typeof data.recoveryKey.salt !== "string"
  ) {
    throw new Error("Сохранённый recovery key имеет неверный формат");
  }
  return data.recoveryKey;
}

export async function saveRecoveryKeyToProfile(
  recoveryKey: string,
  password: string,
): Promise<void> {
  if (!recoveryKey || !password) throw new Error("Нужны recovery key и пароль аккаунта");

  const verification = await fetch("/api/auth/verify-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    cache: "no-store",
  });
  if (!verification.ok) {
    throw new Error(verification.status === 401
      ? "Пароль аккаунта неверен; recovery key не сохранён"
      : "Не удалось подтвердить пароль аккаунта; recovery key не сохранён");
  }

  const encrypted = await encryptRecoveryKeyForProfile(recoveryKey, password);
  const response = await fetch("/api/matrix/recovery-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(encrypted),
  });
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Сессия приложения истекла" : "Не удалось сохранить зашифрованный recovery key в профиле");
  }
}
