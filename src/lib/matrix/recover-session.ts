"use client";

import { getMatrixDeviceId } from "./device-id";
import type { MatrixAvailability, MatrixSession } from "./types";
import { normalizeMatrixSession, saveMatrixAvailability, saveMatrixSession } from "./session-store";
import { clearLocalMatrixCryptoStores } from "./client";

export interface RecoverMatrixSessionResult {
  session: MatrixSession;
  /** False when the old crypto device had to be discarded and replaced. */
  reusedDevice: boolean;
  localKeysKept: boolean;
  notice?: string;
}

async function requestSession(password: string, deviceId: string): Promise<
  { ok: true; session: MatrixSession; availability: MatrixAvailability } | { ok: false; status: number; error: string }
> {
  const response = await fetch("/api/auth/matrix-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, deviceId }),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    matrixAvailability?: MatrixAvailability;
    matrixSession?: unknown;
  };
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: data.error || "Не удалось восстановить Matrix-сессию",
    };
  }

  const session = normalizeMatrixSession(data.matrixSession);
  if (!session) {
    return { ok: false, status: 503, error: "Matrix пока недоступен. Повторите попытку позже." };
  }
  return { ok: true, session, availability: data.matrixAvailability || "unavailable" };
}

/**
 * Restores a Matrix session for the device this browser already owns.
 *
 * Recovery used to always mint a brand-new device ID and wipe the local crypto
 * store, which threw away the room keys that history is decrypted with. When the
 * homeserver revoked the device but kept its record, re-authenticating the *same*
 * device ID is enough - and the IndexedDB store stays valid, so the old
 * conversations keep opening. A fresh device is now only used when the server
 * reports that this device ID is already taken.
 */
export async function recoverMatrixSession(input: {
  username: string;
  appUserId: number;
  password: string;
  resetRequired?: boolean;
}): Promise<RecoverMatrixSessionResult> {
  const existingDeviceId = getMatrixDeviceId(input.username);
  const attempt = await requestSession(input.password, existingDeviceId);

  if (attempt.ok) {
    await finishReset(input.appUserId, attempt.session);
    return {
      session: attempt.session,
      reusedDevice: true,
      localKeysKept: true,
      notice: "Matrix-сессия восстановлена на прежнем устройстве; локальные ключи E2EE сохранены.",
    };
  }

  // 409 from the reset guard: the device still exists on the homeserver, so it
  // must be replaced. Clearing the local store is best effort - if another tab
  // holds IndexedDB open, the new device ID alone already keeps the store apart.
  if (input.resetRequired && attempt.status === 409) {
    const freshDeviceId = getMatrixDeviceId(input.username, true);
    let localKeysKept = false;
    try {
      await clearLocalMatrixCryptoStores(input.appUserId);
    } catch {
      localKeysKept = false;
    }
    const retry = await requestSession(input.password, freshDeviceId);
    if (!retry.ok) throw new Error(retry.error);
    await finishReset(input.appUserId, retry.session);
    return {
      session: retry.session,
      reusedDevice: false,
      localKeysKept,
      notice: "Пришлось создать новое Matrix-устройство: старое ещё числится на homeserver. "
        + (localKeysKept
          ? "Старые сообщения доступны, если ключи есть в резервной копии Matrix."
          : "Старые сообщения потребуется восстановить по recovery key."),
    };
  }

  throw new Error(attempt.error);
}

async function finishReset(appUserId: number, session: MatrixSession): Promise<void> {
  saveMatrixSession(appUserId, session);
  saveMatrixAvailability("ready");
  // Older deployments clear the reset flag only through this endpoint; it is a
  // no-op once `/api/auth/matrix-session` cleared it itself.
  await fetch("/api/auth/matrix-reset-complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: session.deviceId }),
    cache: "no-store",
  }).catch(() => undefined);
}
