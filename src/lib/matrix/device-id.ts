"use client";

/** Stable per-browser Matrix device ID. The E2EE IndexedDB is keyed by this ID. */
export function getMatrixDeviceId(username: string, forceNew = false): string {
  const storageKey = `chata_matrix_device_${username.toLowerCase()}`;
  try {
    const existing = localStorage.getItem(storageKey);
    if (!forceNew && existing && /^[A-Za-z0-9._=-]{1,255}$/u.test(existing)) return existing;

    const deviceId = crypto.randomUUID().replaceAll("-", "").toUpperCase();
    localStorage.setItem(storageKey, deviceId);
    return deviceId;
  } catch {
    return crypto.randomUUID().replaceAll("-", "").toUpperCase();
  }
}
