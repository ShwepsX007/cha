"use client";

import type { MatrixSession } from "./types";

/**
 * Matrix session persistence.
 *
 * The session used to live only in `sessionStorage`, which is tab-scoped: every
 * new tab, PWA window, browser restart (and every mobile tab discard) lost the
 * Matrix access token, and because creating a session requires the account
 * password the app could not recover silently. The access token is now kept in
 * `localStorage`, keyed by app user ID so multiple accounts in one browser do
 * not overwrite each other.
 *
 * Security note: this is not a weakening of the existing posture. The E2EE
 * account keys already live unencrypted in IndexedDB for the same origin (see
 * docs/e2ee-implementation.md), so an XSS that could read a persistent token
 * could already read the keys that protect the history. Logging out of the app
 * removes every copy (see `clearMatrixSession`).
 */
const SESSION_KEY_PREFIX = "chata_matrix_session_v2";
const LEGACY_SESSION_KEY = "chata_matrix_session";
export const MATRIX_AVAILABILITY_KEY = "chata_matrix_availability";
export const MATRIX_SESSION_CHANGED_EVENT = "chata:matrix-session-update";

function sessionStorageKey(appUserId: number): string {
  return `${SESSION_KEY_PREFIX}_u${appUserId}`;
}

/** `@chata_u123:example.com` -> 123; null for any MXID that is not ours. */
export function appUserIdFromMatrixUserId(userId: string): number | null {
  const match = userId.match(/^@chata_u(\d+):/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Validates and repairs a stored session.
 *
 * `expiresAt` is intentionally forgiving: a homeserver that omits
 * `expires_in_ms` used to produce `Date.now() + undefined === NaN`, which
 * `JSON.stringify` writes as `null`, and the strict shape check in `page.tsx`
 * then threw the whole session away on the next reload.
 */
export function normalizeMatrixSession(raw: unknown): MatrixSession | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.baseUrl !== "string" || !candidate.baseUrl ||
    typeof candidate.userId !== "string" || !candidate.userId ||
    typeof candidate.accessToken !== "string" || !candidate.accessToken ||
    typeof candidate.deviceId !== "string" || !candidate.deviceId
  ) {
    return null;
  }

  const refreshToken = typeof candidate.refreshToken === "string" && candidate.refreshToken
    ? candidate.refreshToken
    : undefined;
  const expiresAt = typeof candidate.expiresAt === "number" && Number.isFinite(candidate.expiresAt) && candidate.expiresAt > 0
    ? candidate.expiresAt
    : undefined;

  return {
    baseUrl: candidate.baseUrl,
    userId: candidate.userId,
    accessToken: candidate.accessToken,
    deviceId: candidate.deviceId,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function parseStoredSession(serialized: string | null): MatrixSession | null {
  if (!serialized) return null;
  try {
    return normalizeMatrixSession(JSON.parse(serialized));
  } catch {
    return null;
  }
}

/** True when the token is gone or expires within `skewMs` (default 60s). */
export function isMatrixSessionExpired(session: MatrixSession, skewMs = 60_000): boolean {
  return typeof session.expiresAt === "number" && Date.now() + skewMs >= session.expiresAt;
}

/**
 * Reads the session for one app user. Falls back to the legacy tab-scoped key
 * and migrates it, so an in-flight session survives the upgrade without
 * asking for the password again.
 */
export function loadMatrixSession(appUserId: number): MatrixSession | null {
  if (typeof window === "undefined") return null;
  const key = sessionStorageKey(appUserId);

  let fromPersistent: MatrixSession | null = null;
  try {
    fromPersistent = parseStoredSession(window.localStorage.getItem(key));
  } catch {
    fromPersistent = null;
  }
  if (fromPersistent) {
    // Keep the tab copy in sync so other tabs' `storage` events stay meaningful.
    try {
      window.sessionStorage.setItem(key, JSON.stringify(fromPersistent));
    } catch {
      // Private mode / disabled storage: the persistent copy is enough.
    }
    return fromPersistent;
  }

  let fromTab: MatrixSession | null = null;
  try {
    fromTab = parseStoredSession(window.sessionStorage.getItem(key))
      ?? parseStoredSession(window.sessionStorage.getItem(LEGACY_SESSION_KEY));
  } catch {
    fromTab = null;
  }
  if (!fromTab) return null;
  if (appUserIdFromMatrixUserId(fromTab.userId) !== appUserId) {
    // Never hand a session over to a different app account.
    clearMatrixSession(appUserId);
    return null;
  }
  saveMatrixSession(appUserId, fromTab);
  return fromTab;
}

/** Persists to both stores and notifies other tabs/listeners. */
export function saveMatrixSession(appUserId: number, session: MatrixSession | null): void {
  if (typeof window === "undefined") return;
  const key = sessionStorageKey(appUserId);

  try {
    if (session) {
      const serialized = JSON.stringify(session);
      window.localStorage.setItem(key, serialized);
      window.sessionStorage.setItem(key, serialized);
    } else {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    }
    window.localStorage.removeItem(LEGACY_SESSION_KEY);
    window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    // A full or disabled persistent store must not break the running tab, so
    // fall back to the tab-scoped copy only.
    try {
      if (session) window.sessionStorage.setItem(key, JSON.stringify(session));
      else window.sessionStorage.removeItem(key);
    } catch {
      // Nothing else to do; the in-memory session still works.
    }
  }

  if (typeof window.CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent(MATRIX_SESSION_CHANGED_EVENT, { detail: { appUserId } }));
  }
}

export function loadMatrixAvailability(): "ready" | "not_configured" | "unavailable" | null {
  if (typeof window === "undefined") return null;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      const value = storage.getItem(MATRIX_AVAILABILITY_KEY);
      if (value === "ready" || value === "not_configured" || value === "unavailable") return value;
    } catch {
      // Try the next storage.
    }
  }
  return null;
}

export function saveMatrixAvailability(availability: "ready" | "not_configured" | "unavailable"): void {
  if (typeof window === "undefined") return;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      storage.setItem(MATRIX_AVAILABILITY_KEY, availability);
    } catch {
      // Best effort.
    }
  }
}

/** Removes every stored copy of the session for this app user. */
export function clearMatrixSession(appUserId?: number): void {
  if (typeof window === "undefined") return;
  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      storage.removeItem(LEGACY_SESSION_KEY);
      storage.removeItem(MATRIX_AVAILABILITY_KEY);
      if (appUserId !== undefined) storage.removeItem(sessionStorageKey(appUserId));
    } catch {
      // Best effort.
    }
  }
  if (appUserId === undefined) {
    // Logout: drop sessions for all users that were ever stored in this browser.
    for (const storage of [window.localStorage, window.sessionStorage]) {
      try {
        const doomed: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key?.startsWith(SESSION_KEY_PREFIX)) doomed.push(key);
        }
        doomed.forEach((key) => storage.removeItem(key));
      } catch {
        // Best effort.
      }
    }
  }
}

/**
 * Rotates the access token through the app server, without a password prompt.
 *
 * Returns null when the session cannot be refreshed at all (no refresh token),
 * and throws when the homeserver rejects the single-use token, so callers can
 * distinguish "nothing to do" from "ask for the password once".
 */
export async function refreshMatrixSessionFromServer(
  session: MatrixSession,
): Promise<MatrixSession | null> {
  if (typeof window === "undefined") return null;
  const refreshToken = typeof session.refreshToken === "string" && session.refreshToken
    ? session.refreshToken
    : null;
  if (!refreshToken) return null;

  const response = await fetch("/api/auth/matrix-refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken, deviceId: session.deviceId }),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as {
    matrixSession?: unknown;
    error?: string;
  };
  if (!response.ok) throw new Error(data.error || "Не удалось обновить Matrix-сессию");

  const next = normalizeMatrixSession(data.matrixSession);
  if (!next) throw new Error("Сервер вернул некорректную Matrix-сессию");
  const appUserId = appUserIdFromMatrixUserId(next.userId);
  if (appUserId !== null) saveMatrixSession(appUserId, next);
  return next;
}

/**
 * Reads the stored session and refreshes it first when the access token has
 * expired or expires within a minute. This is the silent recovery path that a
 * page reload used to lack.
 */
export async function loadUsableMatrixSession(appUserId: number): Promise<{
  session: MatrixSession | null;
  refreshFailed: boolean;
  error?: string;
}> {
  const stored = loadMatrixSession(appUserId);
  if (!stored) return { session: null, refreshFailed: false };
  if (!isMatrixSessionExpired(stored)) return { session: stored, refreshFailed: false };

  try {
    const refreshed = await refreshMatrixSessionFromServer(stored);
    if (refreshed) return { session: refreshed, refreshFailed: false };
    // No refresh token: the token may still be accepted by the homeserver, so
    // hand it over and let the sync layer report the real outcome.
    return { session: stored, refreshFailed: false };
  } catch (error) {
    return {
      session: null,
      refreshFailed: true,
      error: error instanceof Error ? error.message : "Не удалось обновить Matrix-сессию",
    };
  }
}

/**
 * Lets other tabs adopt rotated tokens (a refresh token is single-use, so two
 * tabs refreshing independently always invalidate each other).
 */
export function subscribeToMatrixSessionChanges(handler: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(SESSION_KEY_PREFIX) || event.key === LEGACY_SESSION_KEY) {
      handler();
    }
  };
  const onLocal = () => handler();
  window.addEventListener("storage", onStorage);
  window.addEventListener(MATRIX_SESSION_CHANGED_EVENT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(MATRIX_SESSION_CHANGED_EVENT, onLocal);
  };
}
