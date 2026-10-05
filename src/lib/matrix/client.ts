"use client";

import {
  ClientEvent,
  EventType,
  HistoryVisibility,
  MsgType,
  Preset,
  Visibility,
  MatrixError,
  SyncState,
  createClient,
  type MatrixClient,
  type UIAuthCallback,
} from "matrix-js-sdk";
import type {
  CryptoApi,
  CryptoCallbacks,
  ImportRoomKeyProgressData,
  KeyBackupRestoreResult,
} from "matrix-js-sdk/lib/crypto-api/index";
import { decodeRecoveryKey, encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import type { IEncryptedFile } from "matrix-encrypt-attachment";
import type { MatrixSession } from "./types";
import type { MatrixEvent } from "matrix-js-sdk/lib/models/event";
import {
  decryptRecoveryKeyFromProfile,
  fetchStoredRecoveryKey,
  saveRecoveryKeyToProfile,
} from "./recovery-key-storage";
import {
  appUserIdFromMatrixUserId,
  clearMatrixSession,
  loadMatrixSession,
  refreshMatrixSessionFromServer,
  saveMatrixSession,
} from "./session-store";

let clientPromise: Promise<MatrixClient> | null = null;
let currentSessionKey: string | null = null;
let currentSessionToken: string | null = null;
const backfilledRoomIds = new Set<string>();
const roomPreparationPromises = new Map<string, Promise<MatrixClient>>();
const directHistoryVisibilityPromises = new Map<string, Promise<void>>();
const secretStorageKeyCache = new Map<
  string,
  { keyId?: string; key: Uint8Array<ArrayBuffer> }
>();
const matrixSyncReadyPromises = new WeakMap<MatrixClient, Promise<void>>();
const toDeviceEventListeners = new WeakMap<MatrixClient, (event: MatrixEvent) => void>();
const outboxSendPromises = new Map<string, Promise<string>>();
const automaticRecoveryNotices = new Map<string, MatrixRecoveryNotice>();

export const MATRIX_OUTBOX_EVENT = "chata:matrix-outbox-update";
export const MATRIX_RECOVERY_EVENT = "chata:matrix-recovery-update";

export interface MatrixReplyReference {
  eventId: string;
  senderMxid: string;
  senderUserId: string;
  senderDisplayName: string;
  senderUsername: string;
  body: string;
  messageType: string;
}

export interface EncryptedOutboxMessage {
  id: string;
  transactionId: string;
  chatId: number;
  roomId: string;
  isDirect: boolean;
  body: string;
  replyTo?: MatrixReplyReference;
  mentionUserIds?: string[];
  createdAt: string;
  status: "queued" | "sending" | "error";
  error?: string;
}

export interface MatrixOutboxUpdate {
  id: string;
  chatId: number;
  roomId: string;
  status: "sending" | "sent" | "error";
  error?: string;
  eventId?: string;
}

export interface MatrixRecoveryNotice {
  status: "restoring" | "restored" | "needs-recovery" | "error";
  message: string;
}

export interface MatrixLoginCryptoResult {
  recoveryKey?: string;
  recoveryKeySaved?: boolean;
  notice?: string;
}

export interface MatrixDeviceInfo {
  deviceId: string;
  displayName: string;
  lastSeenTs: number | null;
  current: boolean;
  verified: boolean;
}

export interface MatrixTimelineReply {
  eventId: string;
  senderUserId: string;
  senderMxid: string;
  body: string;
  msgtype: "m.text" | "m.notice" | "m.file";
}

export interface MatrixTimelineMessage {
  eventId: string;
  senderUserId: string;
  senderMxid: string;
  body: string;
  timestamp: number;
  msgtype: "m.text" | "m.notice" | "m.file";
  readByOther: boolean;
  readByCount: number;
  recipientCount: number;
  replyToEventId?: string;
  replyTo?: MatrixTimelineReply;
  mentionUserIds?: string[];
  mimeType?: string;
  fileSize?: number;
  encryptedFile?: IEncryptedFile & { url: string };
}

export interface MatrixTimelineResult {
  messages: MatrixTimelineMessage[];
  undecryptableCount: number;
}

/**
 * Identifies the *device session*, i.e. everything the Matrix client and its
 * IndexedDB crypto store are bound to.
 *
 * The access token is deliberately excluded: tokens rotate (refresh flow, a
 * recovery re-login), and keying the cache on them used to tear down the
 * client and re-open the Rust crypto store on every rotation. `getMatrixClient`
 * now adopts a rotated token in place instead.
 */
function sessionKey(session: MatrixSession): string {
  return `${session.baseUrl}|${session.userId}|${session.deviceId}`;
}

function matrixOutboxStorageKey(appUserId: number): string {
  return `chata_matrix_outbox_v1_${appUserId}`;
}

function readEncryptedOutbox(appUserId: number): EncryptedOutboxMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const serialized = window.sessionStorage.getItem(matrixOutboxStorageKey(appUserId));
    if (!serialized) return [];
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is EncryptedOutboxMessage => Boolean(
      item &&
      typeof item === "object" &&
      typeof (item as EncryptedOutboxMessage).id === "string" &&
      typeof (item as EncryptedOutboxMessage).transactionId === "string" &&
      Number.isInteger((item as EncryptedOutboxMessage).chatId) &&
      typeof (item as EncryptedOutboxMessage).roomId === "string" &&
      typeof (item as EncryptedOutboxMessage).isDirect === "boolean" &&
      typeof (item as EncryptedOutboxMessage).body === "string" &&
      ((item as EncryptedOutboxMessage).replyTo === undefined || Boolean(
        (item as EncryptedOutboxMessage).replyTo &&
        typeof (item as EncryptedOutboxMessage).replyTo?.eventId === "string" &&
        typeof (item as EncryptedOutboxMessage).replyTo?.senderMxid === "string" &&
        typeof (item as EncryptedOutboxMessage).replyTo?.senderUserId === "string" &&
        typeof (item as EncryptedOutboxMessage).replyTo?.senderDisplayName === "string" &&
        typeof (item as EncryptedOutboxMessage).replyTo?.senderUsername === "string" &&
        typeof (item as EncryptedOutboxMessage).replyTo?.body === "string" &&
        typeof (item as EncryptedOutboxMessage).replyTo?.messageType === "string"
      )) &&
      ((item as EncryptedOutboxMessage).mentionUserIds === undefined || (
        Array.isArray((item as EncryptedOutboxMessage).mentionUserIds) &&
        (item as EncryptedOutboxMessage).mentionUserIds?.every((id) => typeof id === "string")
      )) &&
      typeof (item as EncryptedOutboxMessage).createdAt === "string" &&
      ["queued", "sending", "error"].includes((item as EncryptedOutboxMessage).status)
    ));
  } catch {
    return [];
  }
}

function writeEncryptedOutbox(appUserId: number, messages: EncryptedOutboxMessage[]): void {
  if (typeof window === "undefined") throw new Error("Очередь E2EE доступна только в браузере");
  try {
    window.sessionStorage.setItem(matrixOutboxStorageKey(appUserId), JSON.stringify(messages));
  } catch {
    throw new Error("Не удалось сохранить сообщение в локальной очереди. Освободите место в хранилище браузера и повторите попытку.");
  }
}

export function getPendingEncryptedMessages(
  appUserId: number,
  chatId?: number,
): EncryptedOutboxMessage[] {
  const messages = readEncryptedOutbox(appUserId);
  return chatId === undefined ? messages : messages.filter((message) => message.chatId === chatId);
}

/** Remove this app user's Matrix crypto databases and any legacy SDK stores. */
export async function clearLocalMatrixCryptoStores(appUserId: number): Promise<void> {
  if (typeof window === "undefined" || !window.indexedDB) {
    throw new Error("В этом браузере IndexedDB недоступна; Matrix-хранилище не очищено.");
  }

  const userDbId = `@chata_u${appUserId}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const currentPrefix = `secret-chat-${userDbId}-`;
  const databaseNames = new Set<string>([
    "matrix-js-sdk:crypto",
    "matrix-js-sdk:default",
    `${currentPrefix}::matrix-sdk-crypto`,
    `${currentPrefix}::matrix-sdk-crypto-meta`,
  ]);

  if (typeof window.indexedDB.databases === "function") {
    const databases = await window.indexedDB.databases();
    for (const database of databases) {
      const name = database.name;
      if (!name) continue;
      if (
        name.startsWith("matrix-js-sdk:") ||
        name.startsWith("matrix-crypto-") ||
        name.includes(currentPrefix) ||
        name.includes(`secret-chat-${userDbId}`)
      ) {
        databaseNames.add(name);
      }
    }
  }

  await Promise.all([...databaseNames].map((name) => new Promise<void>((resolve, reject) => {
    const request = window.indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error("Не удалось удалить Matrix IndexedDB"));
    request.onblocked = () => reject(new Error("Закройте другие вкладки приложения и повторите Matrix-сброс."));
  })));

  try {
    clearMatrixSession(appUserId);
  } catch {
    throw new Error("Не удалось очистить Matrix-сессию браузера.");
  }
}

function emitOutboxUpdate(update: MatrixOutboxUpdate): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<MatrixOutboxUpdate>(MATRIX_OUTBOX_EVENT, { detail: update }));
  }
}

function setAutomaticRecoveryNotice(userId: string, notice: MatrixRecoveryNotice): void {
  automaticRecoveryNotices.set(userId, notice);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<MatrixRecoveryNotice & { userId: string }>(
      MATRIX_RECOVERY_EVENT,
      { detail: { ...notice, userId } },
    ));
  }
}

export function getAutomaticRecoveryNotice(userId: string): MatrixRecoveryNotice | null {
  return automaticRecoveryNotices.get(userId) || null;
}

export function createEncryptedOutboxMessage(input: {
  appUserId: number;
  chatId: number;
  roomId: string;
  isDirect: boolean;
  body: string;
  replyTo?: MatrixReplyReference;
  mentionUserIds?: string[];
  createdAt?: string;
}): EncryptedOutboxMessage {
  const message: EncryptedOutboxMessage = {
    id: crypto.randomUUID(),
    transactionId: `chata_${crypto.randomUUID().replaceAll("-", "")}`,
    chatId: input.chatId,
    roomId: input.roomId,
    isDirect: input.isDirect,
    body: input.body,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.mentionUserIds?.length ? { mentionUserIds: input.mentionUserIds } : {}),
    createdAt: input.createdAt || new Date().toISOString(),
    status: "queued",
  };
  const messages = readEncryptedOutbox(input.appUserId);
  writeEncryptedOutbox(input.appUserId, [...messages, message]);
  return message;
}

function updateEncryptedOutboxMessage(
  appUserId: number,
  messageId: string,
  patch: Partial<EncryptedOutboxMessage>,
): EncryptedOutboxMessage | null {
  const messages = readEncryptedOutbox(appUserId);
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  const updated = { ...messages[index], ...patch };
  messages[index] = updated;
  writeEncryptedOutbox(appUserId, messages);
  return updated;
}

function removeEncryptedOutboxMessage(appUserId: number, messageId: string): void {
  const messages = readEncryptedOutbox(appUserId).filter((message) => message.id !== messageId);
  writeEncryptedOutbox(appUserId, messages);
}

function clearSecretStorageKey(key: string): void {
  const cached = secretStorageKeyCache.get(key);
  cached?.key.fill(0);
  secretStorageKeyCache.delete(key);
}

function isEncryptedAttachmentInfo(
  value: unknown,
  baseUrl: string,
  chatId: number,
): value is IEncryptedFile & { url: string } {
  if (!value || typeof value !== "object") return false;
  const file = value as IEncryptedFile & { url?: unknown };
  const key = file.key;
  const hash = file.hashes?.sha256;
  if (
    typeof file.url !== "string" ||
    typeof file.iv !== "string" ||
    file.v !== "v2" ||
    !key ||
    key.alg !== "A256CTR" ||
    key.kty !== "oct" ||
    key.ext !== true ||
    typeof key.k !== "string" ||
    !Array.isArray(key.key_ops) ||
    !key.key_ops.includes("decrypt") ||
    typeof hash !== "string"
  ) {
    return false;
  }

  try {
    const fileUrl = new URL(file.url, baseUrl);
    return fileUrl.origin === window.location.origin &&
      fileUrl.pathname === "/api/file/telegram" &&
      fileUrl.searchParams.get("chatId") === String(chatId) &&
      Boolean(fileUrl.searchParams.get("fileId"));
  } catch {
    return false;
  }
}

/**
 * Start the Matrix Rust crypto client in the browser. The SDK owns the Olm /
 * Megolm implementation and persistent IndexedDB crypto store; this app does
 * not implement its own message-encryption protocol.
 */
export async function getMatrixClient(session: MatrixSession): Promise<MatrixClient> {
  if (typeof window === "undefined") {
    throw new Error("The Matrix crypto client can only run in a browser");
  }

  const key = sessionKey(session);
  if (clientPromise && currentSessionKey === key) {
    // Same device, possibly a rotated access token (refresh, recovery re-login,
    // another tab). Hand the new token to the running client instead of
    // rebuilding it, which would interrupt sync and re-open the crypto store.
    if (currentSessionToken !== session.accessToken) {
      const pending = clientPromise;
      currentSessionToken = session.accessToken;
      void pending.then((existing) => {
        if (existing.getAccessToken() !== session.accessToken) {
          existing.setAccessToken(session.accessToken);
        }
      }).catch(() => undefined);
    }
    return clientPromise;
  }

  if (clientPromise) {
    const oldKey = currentSessionKey;
    const oldClient = await clientPromise.catch(() => null);
    if (oldClient) {
      const oldListener = toDeviceEventListeners.get(oldClient);
      if (oldListener) oldClient.removeListener(ClientEvent.ToDeviceEvent, oldListener);
      oldClient.stopClient();
    }
    if (oldKey) clearSecretStorageKey(oldKey);
    backfilledRoomIds.clear();
    roomPreparationPromises.clear();
    directHistoryVisibilityPromises.clear();
  }

  currentSessionKey = key;
  currentSessionToken = session.accessToken;
  clientPromise = (async () => {
    const cryptoCallbacks: CryptoCallbacks = {
      getSecretStorageKey: async ({ keys }) => {
        const cached = secretStorageKeyCache.get(key);
        if (!cached) return null;
        const keyId = cached.keyId && keys[cached.keyId]
          ? cached.keyId
          : Object.keys(keys)[0];
        if (!keyId) return null;
        return [keyId, new Uint8Array(cached.key)];
      },
      cacheSecretStorageKey: (keyId, _keyInfo, secretKey) => {
        secretStorageKeyCache.get(key)?.key.fill(0);
        secretStorageKeyCache.set(key, {
          keyId,
          key: new Uint8Array(secretKey),
        });
      },
    };
    const client = createClient({
      baseUrl: session.baseUrl,
      userId: session.userId,
      accessToken: session.accessToken,
      deviceId: session.deviceId,
      cryptoCallbacks,
      ...(session.refreshToken
        ? {
            refreshToken: session.refreshToken,
            // The SDK's token manager refreshes *before* the access token
            // expires, so sync never enters the terminal M_UNKNOWN_TOKEN state.
            // Rotated tokens are single-use, so they must land in browser
            // storage immediately - including for the other tabs.
            onTokenRefresh: (tokens: { accessToken: string; refreshToken?: string; expiry?: Date }) => {
              currentSessionToken = tokens.accessToken;
              const nextSession: MatrixSession = {
                baseUrl: session.baseUrl,
                userId: session.userId,
                accessToken: tokens.accessToken,
                deviceId: session.deviceId,
                ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
                ...(tokens.expiry ? { expiresAt: tokens.expiry.getTime() } : {}),
              };
              const appUserId = appUserIdFromMatrixUserId(session.userId);
              if (appUserId !== null) saveMatrixSession(appUserId, nextSession);
            },
          }
        : {}),
    });

    const cryptoDatabasePrefix = `secret-chat-${session.userId}-${session.deviceId}`
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 180);
    await client.initRustCrypto({
      useIndexedDB: true,
      cryptoDatabasePrefix,
    });

    // Register the initial-sync gate and diagnostics before starting sync so a
    // fast PREPARED event cannot be missed by callers.
    const initialSyncReady = createInitialSyncPromise(client);
    matrixSyncReadyPromises.set(client, initialSyncReady);
    void initialSyncReady.catch(() => {
      if (matrixSyncReadyPromises.get(client) === initialSyncReady) {
        matrixSyncReadyPromises.delete(client);
      }
    });
    const onToDeviceEvent = (event: MatrixEvent) => {
      // Keep production diagnostics useful without logging event payloads,
      // which may contain secret keys or other sensitive crypto material.
      console.debug("[Matrix E2EE] received to-device event", {
        type: event.getType(),
        sender: event.getSender(),
      });
    };
    toDeviceEventListeners.set(client, onToDeviceEvent);
    client.on(ClientEvent.ToDeviceEvent, onToDeviceEvent);

    await client.startClient({ initialSyncLimit: 50 });
    return client;
  })();

  try {
    return await clientPromise;
  } catch (error) {
    clientPromise = null;
    currentSessionKey = null;
    currentSessionToken = null;
    throw error;
  }
}

/** Recreate a failed Matrix sync client while preserving the same crypto device store. */
export async function restartMatrixClient(session: MatrixSession): Promise<MatrixClient> {
  if (clientPromise && currentSessionKey === sessionKey(session)) {
    const current = await clientPromise.catch(() => null);
    const state = current?.getSyncState();
    if (current && state !== SyncState.Error && state !== SyncState.Stopped) {
      // Reuse the running client, but still adopt a rotated token.
      if (currentSessionToken !== session.accessToken) {
        currentSessionToken = session.accessToken;
        if (current.getAccessToken() !== session.accessToken) current.setAccessToken(session.accessToken);
      }
      return current;
    }
    await stopMatrixClient(false);
  }
  return getMatrixClient(session);
}

/**
 * Errors that genuinely mean the local crypto store is unusable and must be
 * rebuilt. Deliberately narrow: the previous pattern also matched "decryption"
 * and "invalid session", both of which appear during normal operation (history
 * keys still restoring, an expired access token) and must NOT wipe the device
 * identity, which is what turned a bad reload into a permanent Matrix outage.
 */
export function isFatalMatrixCryptoError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /corrupt|unreadable|version conflict|database is not open|cannot open database|InvalidStateError|Storage is not initialized|indexeddb.*(?:blocked|closed|denied)/i
    .test(error.message);
}

const MATRIX_INITIAL_SYNC_TIMEOUT_MS = 45_000;

function createInitialSyncPromise(client: MatrixClient): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let hasPrepared = false;
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(new Error("Matrix не синхронизировался вовремя. Сообщение не отправлено."));
    }, MATRIX_INITIAL_SYNC_TIMEOUT_MS);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      client.removeListener(ClientEvent.Sync, onSync);
      if (error) reject(error);
      else resolve();
    };

    const onSync = (state: SyncState) => {
      if (state === SyncState.Prepared) {
        hasPrepared = true;
        finish();
      } else if (
        (state === SyncState.Syncing && hasPrepared) ||
        state === SyncState.Catchup
      ) {
        finish();
      } else if (state === SyncState.Error || state === SyncState.Stopped) {
        finish(new Error(`Matrix не синхронизирован (${state}). Сообщение не отправлено.`));
      }
    };

    client.on(ClientEvent.Sync, onSync);
    const state = client.getSyncState();
    if (state === SyncState.Prepared || state === SyncState.Catchup || client.isInitialSyncComplete()) {
      finish();
    }
  });
}

function waitForMatrixReconnect(client: MatrixClient): Promise<void> {
  if (client.getSyncState() !== SyncState.Reconnecting) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      finish(new Error("Matrix не восстановил синхронизацию вовремя. Сообщение не отправлено."));
    }, MATRIX_INITIAL_SYNC_TIMEOUT_MS);

    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      client.removeListener(ClientEvent.Sync, onSync);
      if (error) reject(error);
      else resolve();
    };

    const onSync = (nextState: SyncState) => {
      if (
        nextState === SyncState.Prepared ||
        nextState === SyncState.Syncing ||
        nextState === SyncState.Catchup
      ) {
        finish();
      } else if (nextState === SyncState.Error || nextState === SyncState.Stopped) {
        finish(new Error(`Matrix не синхронизирован (${nextState}). Сообщение не отправлено.`));
      }
    };

    client.on(ClientEvent.Sync, onSync);
    const currentState = client.getSyncState();
    if (currentState && currentState !== SyncState.Reconnecting) onSync(currentState);
  });
}

export async function waitForMatrixSync(client: MatrixClient): Promise<void> {
  const state = client.getSyncState();
  if (state === SyncState.Error || state === SyncState.Stopped) {
    throw new Error(`Matrix не синхронизирован (${state}). Сообщение не отправлено.`);
  }

  let prepared = matrixSyncReadyPromises.get(client);
  if (!prepared) {
    prepared = createInitialSyncPromise(client);
    matrixSyncReadyPromises.set(client, prepared);
    void prepared.catch(() => {
      if (matrixSyncReadyPromises.get(client) === prepared) matrixSyncReadyPromises.delete(client);
    });
  }

  await prepared;
  let currentState = client.getSyncState();
  if (currentState === SyncState.Error || currentState === SyncState.Stopped) {
    throw new Error(`Matrix не синхронизирован (${currentState}). Сообщение не отправлено.`);
  }
  if (currentState === SyncState.Reconnecting) {
    await waitForMatrixReconnect(client);
    currentState = client.getSyncState();
    if (currentState === SyncState.Error || currentState === SyncState.Stopped) {
      throw new Error(`Matrix не синхронизирован (${currentState}). Сообщение не отправлено.`);
    }
  }
}

const MATRIX_ROOM_READY_TIMEOUT_MS = 10_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForRoomMembership(
  client: MatrixClient,
  roomId: string,
  allowedMemberships: Array<"invite" | "join">,
): Promise<"invite" | "join"> {
  const deadline = Date.now() + MATRIX_ROOM_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const membership = client.getRoom(roomId)?.getMyMembership();
    if (membership === "invite" || membership === "join") {
      if (allowedMemberships.includes(membership)) return membership;
    }
    await wait(200);
  }

  throw new Error("Матрикс-комната ещё не синхронизирована на этом устройстве. Подождите и повторите попытку.");
}

async function waitForInvitedMembers(
  client: MatrixClient,
  roomId: string,
  inviteeIds: string[],
): Promise<void> {
  const deadline = Date.now() + MATRIX_ROOM_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const room = client.getRoom(roomId);
    const allInvited = inviteeIds.every((userId) => {
      const membership = room
        ?.currentState.getStateEvents(EventType.RoomMember, userId)
        ?.getContent<Record<string, unknown>>().membership;
      return membership === "invite" || membership === "join";
    });
    if (allInvited) return;
    await wait(200);
  }

  throw new Error("Приглашения участников Matrix ещё не синхронизировались. Подождите и повторите попытку.");
}

async function waitForOtherRoomMember(
  client: MatrixClient,
  roomId: string,
  currentUserId: string,
): Promise<void> {
  const deadline = Date.now() + MATRIX_ROOM_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const room = client.getRoom(roomId);
    const otherActiveMemberExists = room?.currentState
      .getStateEvents(EventType.RoomMember)
      .some((event) => {
        const membership = event.getContent<Record<string, unknown>>().membership;
        return event.getStateKey() !== currentUserId &&
          (membership === "invite" || membership === "join");
      });
    if (otherActiveMemberExists) return;
    await wait(200);
  }

  throw new Error("Участник Matrix-чата ещё не синхронизирован или не приглашён. Сообщение не отправлено.");
}

async function waitForRoomEncryption(client: MatrixClient, roomId: string): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Matrix Rust crypto is unavailable");

  const deadline = Date.now() + MATRIX_ROOM_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const room = client.getRoom(roomId);
    const encryptionEvent = room?.currentState.getStateEvents(EventType.RoomEncryption, "");
    if (encryptionEvent) {
      const content = encryptionEvent.getContent<Record<string, unknown>>();
      if (content.algorithm !== "m.megolm.v1.aes-sha2") {
        throw new Error("В Matrix-комнате отсутствует поддерживаемое E2EE-шифрование.");
      }
    }
    const clientEncryptionState = client.isRoomEncrypted(roomId);
    const cryptoEncryptionState = await crypto.isEncryptionEnabledInRoom(roomId);
    if (clientEncryptionState && cryptoEncryptionState) return;
    await wait(200);
  }

  throw new Error("Matrix ещё не подтвердил E2EE в этой комнате. Сообщение и файл не отправлены; обновите чат и попробуйте снова.");
}

async function ensureRoomDeviceListsAreDownloaded(client: MatrixClient, roomId: string): Promise<void> {
  const crypto = client.getCrypto();
  const room = client.getRoom(roomId);
  if (!crypto || !room) throw new Error("Matrix-комната ещё не загружена на этом устройстве");

  const recipientIds = [...new Set(
    room.currentState.getStateEvents(EventType.RoomMember)
      .filter((event) => {
        const membership = event.getContent<Record<string, unknown>>().membership;
        return membership === "join" || membership === "invite";
      })
      .map((event) => event.getStateKey())
      .filter((userId): userId is string => Boolean(userId)),
  )];
  if (recipientIds.length === 0) {
    throw new Error("В Matrix-комнате пока нет участников для доставки E2EE-ключа");
  }

  // In Rust crypto v43 this is the supported equivalent of manually calling
  // /keys/query: it downloads uncached device lists before Megolm shares its
  // outbound room key via Olm. The SDK manages Olm sessions and key sharing.
  const devices = await crypto.getUserDeviceInfo(recipientIds, true);
  if (process.env.NODE_ENV !== "production") {
    const usersWithoutDevices = recipientIds.filter((userId) => !devices.get(userId)?.size);
    if (usersWithoutDevices.length > 0) {
      console.debug("[Matrix E2EE] no currently known devices for invited/offline users", {
        count: usersWithoutDevices.length,
      });
    }
  }
}

async function prepareEncryptedRoom(client: MatrixClient, roomId: string): Promise<void> {
  await waitForMatrixSync(client);
  const membership = await waitForRoomMembership(client, roomId, ["invite", "join"]);
  if (membership === "invite") {
    await client.joinRoom(roomId);
    await waitForRoomMembership(client, roomId, ["join"]);
  }
  await waitForRoomEncryption(client, roomId);
}

/** Wait for an invite to sync, join if necessary, and verify Rust crypto has loaded the room encryption state. */
export async function ensureEncryptedRoomReady(
  session: MatrixSession,
  roomId: string,
): Promise<MatrixClient> {
  const key = `${sessionKey(session)}|${roomId}`;
  let preparation = roomPreparationPromises.get(key);
  if (!preparation) {
    preparation = (async () => {
      const client = await getMatrixClient(session);
      await prepareEncryptedRoom(client, roomId);
      return client;
    })();
    roomPreparationPromises.set(key, preparation);
  }

  try {
    return await preparation;
  } finally {
    if (roomPreparationPromises.get(key) === preparation) {
      roomPreparationPromises.delete(key);
    }
  }
}

export async function ensureDirectRoomHistoryVisibility(
  session: MatrixSession,
  roomId: string,
): Promise<void> {
  const key = `${sessionKey(session)}|${roomId}`;
  const pending = directHistoryVisibilityPromises.get(key);
  if (pending) return pending;

  const update = (async () => {
    const client = await ensureEncryptedRoomReady(session, roomId);
    await waitForOtherRoomMember(client, roomId, session.userId);
    const room = client.getRoom(roomId);
    if (!room) throw new Error("Matrix room is not available on this device");

    const createEvent = room.currentState.getStateEvents(EventType.RoomCreate, "");
    const createContent = createEvent?.getContent<Record<string, unknown>>();
    const additionalCreators = createContent?.additional_creators;
    const isCreator = createEvent?.getSender() === session.userId ||
      (Array.isArray(additionalCreators) && additionalCreators.includes(session.userId));
    const visibilityEvent = room.currentState.getStateEvents(EventType.RoomHistoryVisibility, "");
    const visibility = visibilityEvent?.getContent<Record<string, unknown>>().history_visibility;
    if (visibility === "invited") return;
    if (!isCreator) {
      throw new Error("Личный Matrix-чат ещё не разрешает приглашённым участникам читать историю.");
    }
    if (visibility !== "joined") {
      throw new Error("Личный Matrix-чат имеет неподдерживаемые настройки видимости истории.");
    }

    await client.sendStateEvent(
      roomId,
      EventType.RoomHistoryVisibility,
      { history_visibility: HistoryVisibility.Invited },
      "",
    );

    const deadline = Date.now() + MATRIX_ROOM_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const currentVisibility = client
        .getRoom(roomId)
        ?.currentState.getStateEvents(EventType.RoomHistoryVisibility, "")
        ?.getContent<Record<string, unknown>>().history_visibility;
      if (currentVisibility === "invited") break;
      await wait(200);
    }

    const currentVisibility = client
      .getRoom(roomId)
      ?.currentState.getStateEvents(EventType.RoomHistoryVisibility, "")
      ?.getContent<Record<string, unknown>>().history_visibility;
    if (currentVisibility !== "invited") {
      throw new Error("Не удалось синхронизировать настройки личного Matrix-чата.");
    }

    const crypto = client.getCrypto();
    if (!crypto) throw new Error("Matrix Rust crypto is unavailable");
    await crypto.forceDiscardSession(roomId);
  })();

  directHistoryVisibilityPromises.set(key, update);
  try {
    await update;
  } finally {
    if (directHistoryVisibilityPromises.get(key) === update) {
      directHistoryVisibilityPromises.delete(key);
    }
  }
}

export interface MatrixSecurityStatus {
  crossSigningReady: boolean;
  crossSigningPrivateKeysCached: boolean;
  crossSigningPrivateKeysStored: boolean;
  secretStorageKeyId: string | null;
  secretStorageReady: boolean;
  backupVersion: string | null;
  keyBackupAvailable: boolean;
  devices: MatrixDeviceInfo[];
}

export async function getMatrixSecurityStatus(
  session: MatrixSession,
): Promise<MatrixSecurityStatus> {
  const client = await getMatrixClient(session);
  await waitForMatrixSync(client);
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Matrix Rust crypto is unavailable");

  const [crossSigning, secretStorage, backupInfo, backupVersion, hasCrossSigning, deviceResponse] = await Promise.all([
    crypto.getCrossSigningStatus(),
    crypto.getSecretStorageStatus(),
    crypto.getKeyBackupInfo(),
    crypto.getActiveSessionBackupVersion(),
    crypto.userHasCrossSigningKeys(session.userId, true),
    client.getDevices(),
  ]);
  await crypto.getUserDeviceInfo([session.userId], true);
  const cachedKeys = crossSigning.privateKeysCachedLocally;
  const privateKeysCached = Boolean(
    cachedKeys.masterKey && cachedKeys.selfSigningKey && cachedKeys.userSigningKey,
  );
  const devices = await Promise.all(deviceResponse.devices.map(async (device) => {
    const verification = await crypto.getDeviceVerificationStatus(session.userId, device.device_id);
    return {
      deviceId: device.device_id,
      displayName: device.display_name || `Устройство ${device.device_id}`,
      lastSeenTs: typeof device.last_seen_ts === "number" ? device.last_seen_ts : null,
      current: device.device_id === session.deviceId,
      verified: verification?.isVerified() || false,
    } satisfies MatrixDeviceInfo;
  }));

  return {
    crossSigningReady: crossSigning.publicKeysOnDevice || hasCrossSigning,
    crossSigningPrivateKeysCached: privateKeysCached,
    crossSigningPrivateKeysStored: crossSigning.privateKeysInSecretStorage,
    secretStorageKeyId: secretStorage.defaultKeyId,
    secretStorageReady: secretStorage.ready,
    backupVersion,
    keyBackupAvailable: Boolean(backupInfo),
    devices,
  };
}

function passwordUiaCallback(userId: string, password: string): UIAuthCallback<void> {
  return async (makeRequest) => {
    try {
      return await makeRequest(null);
    } catch (error) {
      if (!(error instanceof MatrixError) || error.httpStatus !== 401) throw error;
      const sessionId = error.data.session;
      const separator = userId.indexOf(":");
      if (typeof sessionId !== "string" || !userId.startsWith("@") || separator < 2) {
        throw error;
      }

      return await makeRequest({
        type: "m.login.password",
        identifier: {
          type: "m.id.user",
          user: userId.slice(1, separator),
        },
        password,
        session: sessionId,
      });
    }
  };
}

async function createSecretStorageAndBackup(
  crypto: CryptoApi,
  options: { setupNewSecretStorage?: boolean; setupNewKeyBackup: boolean },
): Promise<string> {
  const generatedKey: {
    value: Awaited<ReturnType<typeof crypto.createRecoveryKeyFromPassphrase>> | null;
  } = { value: null };
  await crypto.bootstrapSecretStorage({
    setupNewSecretStorage: options.setupNewSecretStorage,
    setupNewKeyBackup: options.setupNewKeyBackup,
    createSecretStorageKey: async () => {
      generatedKey.value = await crypto.createRecoveryKeyFromPassphrase();
      return generatedKey.value;
    },
  });

  const createdKey = generatedKey.value;
  if (!createdKey) throw new Error("Matrix did not create a recovery key");
  const encodedKey = createdKey.encodedPrivateKey || encodeRecoveryKey(createdKey.privateKey);
  if (!encodedKey) throw new Error("Matrix could not encode the recovery key");
  return encodedKey;
}

const cryptoLoginInitializations = new Map<string, Promise<MatrixLoginCryptoResult>>();

/**
 * Run after a successful Matrix login. A first-time account gets cross-signing,
 * secret storage, and a key backup automatically. Existing accounts try the
 * profile-encrypted recovery key in the background; failure never blocks new
 * E2EE messages.
 */
export async function initializeMatrixCryptoAfterLogin(
  session: MatrixSession,
  password: string,
): Promise<MatrixLoginCryptoResult> {
  const lockKey = `${session.userId}|${session.deviceId}`;
  const existing = cryptoLoginInitializations.get(lockKey);
  if (existing) return existing;

  const initialization = (async (): Promise<MatrixLoginCryptoResult> => {
    const client = await getMatrixClient(session);
    await waitForMatrixSync(client);
    const crypto = client.getCrypto();
    if (!crypto) throw new Error("Matrix Rust crypto is unavailable");

    const [crossSigning, secretStorage, backupInfo, backupVersion, remoteCrossSigning] = await Promise.all([
      crypto.getCrossSigningStatus(),
      crypto.getSecretStorageStatus(),
      crypto.getKeyBackupInfo(),
      crypto.getActiveSessionBackupVersion(),
      crypto.userHasCrossSigningKeys(session.userId, true),
    ]);
    const cachedKeys = crossSigning.privateKeysCachedLocally;
    const allPrivateKeysCached = Boolean(
      cachedKeys.masterKey && cachedKeys.selfSigningKey && cachedKeys.userSigningKey,
    );
    const isNewMatrixAccount =
      !remoteCrossSigning &&
      !crossSigning.publicKeysOnDevice &&
      !secretStorage.defaultKeyId &&
      !backupInfo;

    if (isNewMatrixAccount) {
      await crypto.bootstrapCrossSigning({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys: passwordUiaCallback(session.userId, password),
      });
      const recoveryKey = await createSecretStorageAndBackup(crypto, { setupNewKeyBackup: true });
      let recoveryKeySaved = false;
      let notice: string | undefined;
      try {
        await saveRecoveryKeyToProfile(recoveryKey, password);
        recoveryKeySaved = true;
      } catch {
        notice = "Matrix E2EE настроено, но recovery key не удалось сохранить в профиле. Сохраните его на следующем экране.";
      }
      return { recoveryKey, recoveryKeySaved, notice };
    }

    // If signing keys already exist locally but this account has no secret
    // storage yet, it is safe to create storage/backup without replacing them.
    if (!secretStorage.defaultKeyId && allPrivateKeysCached) {
      const recoveryKey = await createSecretStorageAndBackup(crypto, {
        setupNewKeyBackup: !backupInfo,
      });
      let recoveryKeySaved = false;
      let notice: string | undefined;
      try {
        await saveRecoveryKeyToProfile(recoveryKey, password);
        recoveryKeySaved = true;
      } catch {
        notice = "Matrix ключи настроены, но recovery key не удалось сохранить в профиле. Сохраните его на следующем экране.";
      }
      return { recoveryKey, recoveryKeySaved, notice };
    }

    const localBackupIsReady = !backupInfo || backupVersion === backupInfo.version;
    if (allPrivateKeysCached && localBackupIsReady) {
      automaticRecoveryNotices.delete(session.userId);
      return {};
    }

    let storedRecoveryKey;
    try {
      storedRecoveryKey = await fetchStoredRecoveryKey();
    } catch {
      storedRecoveryKey = null;
    }

    if (storedRecoveryKey) {
      try {
        const recoveryKey = await decryptRecoveryKeyFromProfile(storedRecoveryKey, password);
        setAutomaticRecoveryNotice(session.userId, {
          status: "restoring",
          message: "Восстанавливаем старые ключи Matrix в фоне. Новые E2EE-сообщения уже доступны.",
        });
        void restoreMatrixRecoveryKey(session, recoveryKey)
          .then(() => setAutomaticRecoveryNotice(session.userId, {
            status: "restored",
            message: "Старые ключи Matrix восстановлены из резервной копии.",
          }))
          .catch(() => setAutomaticRecoveryNotice(session.userId, {
            status: "needs-recovery",
            message: "Не удалось автоматически расшифровать старые сообщения. Подтвердите вход с другого устройства или введите recovery key в настройках. Новые сообщения можно отправлять.",
          }));
        return { notice: "Идёт автоматическое восстановление ключей Matrix." };
      } catch {
        // A password change or a damaged profile envelope requires an explicit
        // recovery key/QR flow. Never replace existing cross-signing keys.
      }
    }

    const needsRecovery = Boolean(
      backupInfo || remoteCrossSigning || crossSigning.publicKeysOnDevice || secretStorage.defaultKeyId,
    );
    if (needsRecovery) {
      const notice = "Для расшифровки старых сообщений подтвердите вход с другого устройства или введите ключ восстановления в настройках. Новые сообщения можно отправлять.";
      setAutomaticRecoveryNotice(session.userId, { status: "needs-recovery", message: notice });
      return { notice };
    }

    return {};
  })();

  cryptoLoginInitializations.set(lockKey, initialization);
  try {
    return await initialization;
  } finally {
    if (cryptoLoginInitializations.get(lockKey) === initialization) {
      cryptoLoginInitializations.delete(lockKey);
    }
  }
}

/**
 * Set up Matrix cross-signing, secret storage, and an encrypted room-key backup.
 * The recovery key is returned for an optional one-time save screen and is
 * encrypted in the profile by the caller before it is sent to the server.
 */
export async function setupMatrixRecovery(
  session: MatrixSession,
  password: string,
): Promise<string> {
  if (!password) throw new Error("Enter your account password to confirm Matrix key setup");

  const client = await getMatrixClient(session);
  await waitForMatrixSync(client);
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Matrix Rust crypto is unavailable");

  const [secretStorage, crossSigning, backupInfo, remoteCrossSigning] = await Promise.all([
    crypto.getSecretStorageStatus(),
    crypto.getCrossSigningStatus(),
    crypto.getKeyBackupInfo(),
    crypto.userHasCrossSigningKeys(session.userId, true),
  ]);
  if (secretStorage.defaultKeyId) {
    throw new Error("Matrix secret storage already exists. Use your recovery key or pair a trusted device instead.");
  }

  const cachedKeyCount = Object.values(crossSigning.privateKeysCachedLocally).filter(Boolean).length;
  if (
    ((remoteCrossSigning || crossSigning.publicKeysOnDevice) && cachedKeyCount !== 3) ||
    (cachedKeyCount > 0 && cachedKeyCount < 3)
  ) {
    throw new Error("This account already has cross-signing keys. Pair a trusted device or restore with its recovery key; refusing to replace them.");
  }

  await crypto.bootstrapCrossSigning({
    authUploadDeviceSigningKeys: passwordUiaCallback(session.userId, password),
  });

  const recoveryKey = await createSecretStorageAndBackup(crypto, { setupNewKeyBackup: !backupInfo });
  setAutomaticRecoveryNotice(session.userId, {
    status: "restored",
    message: "Matrix cross-signing и резервная копия настроены на этом устройстве.",
  });
  return recoveryKey;
}

/** Replace the current secret-storage/recovery key and rotate the room-key backup. */
export async function rotateMatrixRecoveryKey(
  session: MatrixSession,
  password: string,
): Promise<string> {
  if (!password) throw new Error("Введите пароль аккаунта для создания нового recovery key");
  const client = await getMatrixClient(session);
  await waitForMatrixSync(client);
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Matrix Rust crypto is unavailable");

  const [secretStorage, crossSigning] = await Promise.all([
    crypto.getSecretStorageStatus(),
    crypto.getCrossSigningStatus(),
  ]);
  const cachedKeys = crossSigning.privateKeysCachedLocally;
  if (!secretStorage.defaultKeyId || !(
    cachedKeys.masterKey && cachedKeys.selfSigningKey && cachedKeys.userSigningKey
  )) {
    throw new Error("Сначала восстановите существующие cross-signing ключи на этом устройстве; новый ключ вместо них не создавался.");
  }

  const recoveryKey = await createSecretStorageAndBackup(crypto, {
    setupNewSecretStorage: true,
    setupNewKeyBackup: true,
  });
  setAutomaticRecoveryNotice(session.userId, {
    status: "restored",
    message: "Recovery key и Matrix backup обновлены.",
  });
  return recoveryKey;
}

export interface MatrixRecoveryResult {
  crossSigningRestored: boolean;
  backup: KeyBackupRestoreResult | null;
}

/** Restore trusted cross-signing secrets and, when present, the room-key backup. */
export async function restoreMatrixRecoveryKey(
  session: MatrixSession,
  recoveryKey: string,
  onProgress?: (progress: ImportRoomKeyProgressData) => void,
): Promise<MatrixRecoveryResult> {
  const client = await getMatrixClient(session);
  await waitForMatrixSync(client);
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Matrix Rust crypto is unavailable");

  const decodedKey = decodeRecoveryKey(recoveryKey.trim());
  const cacheKey = sessionKey(session);
  try {
    const secretStorage = await crypto.getSecretStorageStatus();
    clearSecretStorageKey(cacheKey);
    secretStorageKeyCache.set(cacheKey, {
      keyId: secretStorage.defaultKeyId || undefined,
      key: decodedKey,
    });
    const backupInfo = await crypto.getKeyBackupInfo();
    const hasCrossSigningSecrets =
      secretStorage.secretStorageKeyValidityMap["m.cross_signing.master"] &&
      secretStorage.secretStorageKeyValidityMap["m.cross_signing.self_signing"] &&
      secretStorage.secretStorageKeyValidityMap["m.cross_signing.user_signing"];
    let crossSigningRestored = false;

    if (hasCrossSigningSecrets) {
      await crypto.bootstrapCrossSigning({});
      crossSigningRestored = true;
    }

    let backup: KeyBackupRestoreResult | null = null;
    if (backupInfo) {
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      const backupCheck = await crypto.checkKeyBackupAndEnable();
      if (!backupCheck?.trustInfo.trusted || !backupCheck.trustInfo.matchesDecryptionKey) {
        throw new Error("The Matrix backup is not trusted or the recovery key does not match it");
      }
      backup = await crypto.restoreKeyBackup({ progressCallback: onProgress });
    }

    if (!crossSigningRestored && !backup) {
      throw new Error("No recoverable Matrix keys were found for this account");
    }
    setAutomaticRecoveryNotice(session.userId, {
      status: "restored",
      message: backup
        ? "Старые ключи Matrix восстановлены из резервной копии."
        : "Ключи проверки Matrix восстановлены.",
    });
    return { crossSigningRestored, backup };
  } finally {
    clearSecretStorageKey(cacheKey);
    decodedKey.fill(0);
  }
}

/** Restore a trusted backup after an existing device has shared its keys over QR verification. */
export async function restoreMatrixHistoryFromVerifiedDevice(
  session: MatrixSession,
  onProgress?: (progress: ImportRoomKeyProgressData) => void,
): Promise<KeyBackupRestoreResult> {
  const client = await getMatrixClient(session);
  await waitForMatrixSync(client);
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Matrix Rust crypto is unavailable");

  const backupInfo = await crypto.getKeyBackupInfo();
  if (!backupInfo) throw new Error("No encrypted Matrix key backup exists for this account");
  const backupCheck = await crypto.checkKeyBackupAndEnable();
  if (!backupCheck?.trustInfo.trusted || !backupCheck.trustInfo.matchesDecryptionKey) {
    throw new Error("The trusted device has not shared a valid Matrix backup key yet");
  }
  if (!(await crypto.getActiveSessionBackupVersion())) {
    throw new Error("Matrix backup key is not available on this device yet");
  }

  const result = await crypto.restoreKeyBackup({ progressCallback: onProgress });
  setAutomaticRecoveryNotice(session.userId, {
    status: "restored",
    message: "Устройство подтверждено; зашифрованная история Matrix восстановлена.",
  });
  return result;
}

export async function createEncryptedRoom(
  session: MatrixSession,
  options: { name?: string; inviteUserIds: string[]; isDirect: boolean },
): Promise<string> {
  const client = await getMatrixClient(session);
  await waitForMatrixSync(client);

  const { room_id: roomId } = await client.createRoom({
    name: options.name,
    visibility: Visibility.Private,
    preset: Preset.PrivateChat,
    is_direct: options.isDirect,
    invite: options.inviteUserIds,
    initial_state: [
      {
        type: EventType.RoomEncryption,
        state_key: "",
        content: {
          algorithm: "m.megolm.v1.aes-sha2",
          rotation_period_ms: 7 * 24 * 60 * 60 * 1000,
          rotation_period_msgs: 100,
        },
      },
      {
        type: EventType.RoomJoinRules,
        state_key: "",
        content: { join_rule: "invite" },
      },
      {
        type: EventType.RoomHistoryVisibility,
        state_key: "",
        // Direct invitees need access to messages sent while they are still
        // offline/invited. Groups stay joined-only so later members cannot
        // decrypt pre-join history.
        content: {
          history_visibility: options.isDirect ? HistoryVisibility.Invited : HistoryVisibility.Joined,
        },
      },
    ],
    power_level_content_override: {
      // The homeserver grants the creator the default power in older room
      // versions, and room version 12+ makes creator power implicit. Never put
      // the creator in `users`: Synapse rejects that for room version 12.
      users_default: 0,
      invite: 50,
      kick: 50,
      ban: 50,
      redact: 50,
      state_default: 50,
      events_default: 0,
    },
  });

  if (!roomId) throw new Error("Matrix did not return a room ID");
  const readyClient = await ensureEncryptedRoomReady(session, roomId);
  await waitForInvitedMembers(readyClient, roomId, options.inviteUserIds);
  return roomId;
}

function formatMatrixReplyBody(body: string, reply: MatrixReplyReference): string {
  const quotedLines = reply.body.replace(/\r/g, "").split("\n").slice(0, 5);
  const fallback = quotedLines.map((line, index) =>
    `> ${index === 0 ? `<${reply.senderMxid}> ` : ""}${line.slice(0, 300)}`,
  ).join("\n");
  return `${fallback}\n\n${body}`;
}

function logPrivatePushResult(result: unknown, chatId: number): void {
  if (!result || typeof result !== "object") return;
  const data = result as Record<string, unknown>;
  if (typeof data.sent !== "number" || data.sent > 0) return;
  const safeNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  console.warn("Private chat push accepted without a successful delivery", {
    chatId,
    configured: data.configured === true,
    recipients: safeNumber(data.recipients),
    mutedRecipients: safeNumber(data.mutedRecipients),
    failed: safeNumber(data.failed),
  });
}

async function relayEncryptedMessagePush(
  session: MatrixSession,
  chatId: number,
  roomId: string,
  eventId: string,
): Promise<boolean> {
  // A push relay failure must never fail a send that already succeeded - the
  // encrypted message is on the homeserver. But it used to be a single
  // fire-and-forget request, so any 401/403 from an access token that a reload
  // or another tab rotated meant "no notifications for this chat", silently.
  const appUserId = appUserIdFromMatrixUserId(session.userId);
  let activeSession = session;
  let attemptedRefresh = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stored = appUserId === null ? null : loadMatrixSession(appUserId);
    if (stored?.accessToken) activeSession = stored;

    try {
      const response = await fetch("/api/messages/matrix-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          roomId,
          eventId,
          accessToken: activeSession.accessToken,
          deviceId: activeSession.deviceId,
        }),
        cache: "no-store",
      });
      if (response.ok) {
        const result: unknown = await response.json().catch(() => null);
        logPrivatePushResult(result, chatId);
        return true;
      }

      const statusCode = response.status;
      if ((statusCode === 401 || statusCode === 403) && !attemptedRefresh) {
        attemptedRefresh = true;
        try {
          const refreshed = await refreshMatrixSessionFromServer(activeSession);
          if (refreshed) {
            activeSession = refreshed;
            await delay(250);
            continue;
          }
        } catch {
          // Refresh is best effort too; fall through to the generic warning.
        }
      }
      console.warn("Encrypted message push relay failed", { statusCode, chatId });
    } catch {
      console.warn("Encrypted message push relay failed", { reason: "network", chatId });
    }

    if (attempt < 2) await delay(1_000 * (attempt + 1));
  }
  return false;
}

async function notifyPrivateMessagePush(
  session: MatrixSession,
  chatId: number,
  roomId: string,
  eventId: string,
): Promise<void> {
  // Prefer the relay that proves the event with Synapse. If that check fails
  // (for example, because the sender's Matrix token just expired or the room
  // metadata changed), use the authenticated membership-only ping as a fallback
  // so a successfully sent E2EE message can still notify its recipient.
  if (await relayEncryptedMessagePush(session, chatId, roomId, eventId)) return;

  try {
    const response = await fetch("/api/messages/private-ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, eventId }),
      cache: "no-store",
    });
    if (response.ok) {
      const result: unknown = await response.json().catch(() => null);
      logPrivatePushResult(result, chatId);
      return;
    }
    if (response.status === 429) {
      console.warn("Private chat push fallback was throttled", { chatId });
      return;
    }
    console.warn("Private chat push fallback failed", {
      statusCode: response.status,
      chatId,
    });
  } catch {
    console.warn("Private chat push fallback failed", {
      reason: "network",
      chatId,
    });
  }
}

export async function sendEncryptedText(
  session: MatrixSession,
  roomId: string,
  body: string,
  transactionId?: string,
  replyTo?: MatrixReplyReference,
  mentionUserIds: string[] = [],
): Promise<string> {
  const client = await ensureEncryptedRoomReady(session, roomId);
  const crypto = client.getCrypto();
  if (!crypto || !client.isRoomEncrypted(roomId) || !(await crypto.isEncryptionEnabledInRoom(roomId))) {
    throw new Error("Refusing to send: this Matrix room is not encrypted");
  }

  await ensureRoomDeviceListsAreDownloaded(client, roomId);
  const response = replyTo || mentionUserIds.length > 0
    ? await client.sendMessage(roomId, {
        msgtype: MsgType.Text,
        body: replyTo ? formatMatrixReplyBody(body, replyTo) : body,
        ...(replyTo ? { "m.relates_to": { "m.in_reply_to": { event_id: replyTo.eventId } } } : {}),
        ...(mentionUserIds.length ? { "m.mentions": { user_ids: mentionUserIds } } : {}),
      } satisfies RoomMessageEventContent, transactionId)
    : await client.sendTextMessage(roomId, body, transactionId);
  return response.event_id;
}

const OUTBOX_RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;

function isRetryableMatrixSendError(error: unknown): boolean {
  const transientMessage = error instanceof Error &&
    /network|fetch|timeout|timed out|connection|reconnect|unknown device|olm session|sync/i.test(error.message);
  if (error instanceof MatrixError) {
    const status = error.httpStatus;
    return status === 0 || status === 408 || status === 429 ||
      (typeof status === "number" && status >= 500) ||
      transientMessage;
  }
  if (!(error instanceof Error)) return true;
  if (error.name === "TypeError") return true;
  return Boolean(transientMessage);
}

function matrixSendErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Не удалось отправить E2EE-сообщение. Проверьте соединение и повторите попытку.";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function runEncryptedOutboxMessage(
  session: MatrixSession,
  item: EncryptedOutboxMessage,
): Promise<string> {
  const operationKey = `${sessionKey(session)}|${item.id}`;
  const active = outboxSendPromises.get(operationKey);
  if (active) return active;

  const operation = (async () => {
    const appUserId = getAppUserIdFromMatrixSession(session);
    let lastError: unknown;
    try {
      updateEncryptedOutboxMessage(appUserId, item.id, {
        status: "sending",
        error: undefined,
      });
    } catch {
      // The item was persisted before its first send. UI status events are still
      // delivered if browser storage becomes unavailable mid-flight.
    }
    emitOutboxUpdate({ id: item.id, chatId: item.chatId, roomId: item.roomId, status: "sending" });

    for (let attempt = 0; attempt <= OUTBOX_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        if (item.isDirect) {
          await ensureDirectRoomHistoryVisibility(session, item.roomId);
        }
        const eventId = await sendEncryptedText(
          session,
          item.roomId,
          item.body,
          item.transactionId,
          item.replyTo,
          item.mentionUserIds,
        );
        await notifyPrivateMessagePush(session, item.chatId, item.roomId, eventId);
        try {
          removeEncryptedOutboxMessage(appUserId, item.id);
        } catch {
            // A fixed Matrix transaction ID makes a later drain idempotent even
            // if browser storage could not remove an already-sent item.
        }
        emitOutboxUpdate({
          id: item.id,
          chatId: item.chatId,
          roomId: item.roomId,
          status: "sent",
          eventId,
        });
        return eventId;
      } catch (error) {
        lastError = error;
        const message = matrixSendErrorMessage(error);
        try {
          updateEncryptedOutboxMessage(appUserId, item.id, {
            status: attempt < OUTBOX_RETRY_DELAYS_MS.length && isRetryableMatrixSendError(error) ? "queued" : "error",
            error: message,
          });
        } catch {
          // Keep the in-memory error visible if sessionStorage is unavailable.
        }
        emitOutboxUpdate({
          id: item.id,
          chatId: item.chatId,
          roomId: item.roomId,
          status: "sending",
          error: message,
        });
        if (attempt >= OUTBOX_RETRY_DELAYS_MS.length || !isRetryableMatrixSendError(error)) break;
        await delay(OUTBOX_RETRY_DELAYS_MS[attempt]);
      }
    }

    const errorMessage = matrixSendErrorMessage(lastError);
    try {
      updateEncryptedOutboxMessage(appUserId, item.id, {
        status: "error",
        error: errorMessage,
      });
    } catch {
      // The chat UI still displays the final error and preserves its retry action.
    }
    emitOutboxUpdate({
      id: item.id,
      chatId: item.chatId,
      roomId: item.roomId,
      status: "error",
      error: errorMessage,
    });
    throw lastError instanceof Error ? lastError : new Error(errorMessage);
  })();

  outboxSendPromises.set(operationKey, operation);
  try {
    return await operation;
  } finally {
    if (outboxSendPromises.get(operationKey) === operation) {
      outboxSendPromises.delete(operationKey);
    }
  }
}

function getAppUserIdFromMatrixSession(session: MatrixSession): number {
  const match = session.userId.match(/^@chata_u(\d+):/);
  if (!match) throw new Error("Matrix user does not match this application");
  return Number(match[1]);
}

export async function sendQueuedEncryptedMessage(
  session: MatrixSession,
  messageId: string,
): Promise<string> {
  const appUserId = getAppUserIdFromMatrixSession(session);
  const item = readEncryptedOutbox(appUserId).find((message) => message.id === messageId);
  if (!item) throw new Error("Сообщение уже отправлено или отсутствует в очереди");
  return runEncryptedOutboxMessage(session, item);
}

export async function retryQueuedEncryptedMessage(
  session: MatrixSession,
  messageId: string,
): Promise<string> {
  return sendQueuedEncryptedMessage(session, messageId);
}

export async function drainEncryptedOutbox(session: MatrixSession): Promise<void> {
  const appUserId = getAppUserIdFromMatrixSession(session);
  await waitForMatrixSync(await getMatrixClient(session));
  const items = readEncryptedOutbox(appUserId);
  for (const item of items) {
    try {
      await runEncryptedOutboxMessage(session, item);
    } catch {
      // The item remains in sessionStorage with an explicit error state.
    }
  }
}

export async function sendEncryptedAttachment(
  session: MatrixSession,
  roomId: string,
  input: {
    chatId: number;
    fileName: string;
    mimeType: string;
    fileSize: number;
    encryptedFile: IEncryptedFile & { url: string };
    replyTo?: MatrixReplyReference;
    mentionUserIds?: string[];
  },
): Promise<void> {
  const client = await ensureEncryptedRoomReady(session, roomId);
  const crypto = client.getCrypto();
  if (!crypto || !client.isRoomEncrypted(roomId) || !(await crypto.isEncryptionEnabledInRoom(roomId))) {
    throw new Error("Refusing to send: this Matrix room is not encrypted");
  }

  await ensureRoomDeviceListsAreDownloaded(client, roomId);
  const sha256 = input.encryptedFile.hashes?.sha256;
  if (!sha256 || !input.encryptedFile.v) {
    throw new Error("Matrix encrypted attachment metadata is incomplete");
  }

  const response = await client.sendMessage(roomId, {
    msgtype: MsgType.File,
    body: input.replyTo ? formatMatrixReplyBody(input.fileName, input.replyTo) : input.fileName,
    filename: input.fileName,
    file: {
      url: input.encryptedFile.url,
      key: input.encryptedFile.key,
      iv: input.encryptedFile.iv,
      hashes: { sha256 },
      v: input.encryptedFile.v,
    },
    info: {
      mimetype: input.mimeType || "application/octet-stream",
      size: input.fileSize,
    },
    ...(input.replyTo ? { "m.relates_to": { "m.in_reply_to": { event_id: input.replyTo.eventId } } } : {}),
    ...(input.mentionUserIds?.length ? { "m.mentions": { user_ids: input.mentionUserIds } } : {}),
  } satisfies RoomMessageEventContent);
  await notifyPrivateMessagePush(session, input.chatId, roomId, response.event_id);
}

export async function joinRoomIfInvited(
  session: MatrixSession,
  roomId: string,
): Promise<void> {
  await ensureEncryptedRoomReady(session, roomId);
}

export async function hasMatrixInvitePermission(
  session: MatrixSession,
  roomId: string,
): Promise<boolean> {
  const client = await ensureEncryptedRoomReady(session, roomId);
  const room = client.getRoom(roomId);
  if (!room || room.getMyMembership() !== "join") return false;

  const powerEvent = room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
  const power = powerEvent?.getContent<Record<string, unknown>>();
  if (!power) return false;

  const users = (power.users as Record<string, number> | undefined) || {};
  const userLevelFromEvent = users[session.userId] ?? Number(power.users_default || 0);
  const inviteLevel = Number(power.invite ?? 0);
  const createEvent = room.currentState.getStateEvents("m.room.create", "");
  const createContent = createEvent?.getContent<Record<string, unknown>>();
  const roomVersionValue = createContent?.room_version;
  const roomVersion = typeof roomVersionValue === "string" && /^\d+$/.test(roomVersionValue)
    ? Number(roomVersionValue)
    : Number.NaN;
  const additionalCreators = createContent?.additional_creators;
  const isImplicitRoomCreator =
    Number.isInteger(roomVersion) &&
    roomVersion >= 12 &&
    (
      createEvent?.getSender() === session.userId ||
      (Array.isArray(additionalCreators) && additionalCreators.includes(session.userId))
    );

  // In room version 12 and later, creators have infinite power and are
  // intentionally absent from m.room.power_levels.users.
  const userLevel = isImplicitRoomCreator ? inviteLevel : userLevelFromEvent;
  return inviteLevel >= 50 && userLevel >= inviteLevel;
}

function getMatrixReplyEventId(content: Record<string, unknown>): string | undefined {
  const relatesTo = content["m.relates_to"];
  if (!relatesTo || typeof relatesTo !== "object") return undefined;
  const inReplyTo = (relatesTo as Record<string, unknown>)["m.in_reply_to"];
  if (!inReplyTo || typeof inReplyTo !== "object") return undefined;
  const eventId = (inReplyTo as Record<string, unknown>).event_id;
  return typeof eventId === "string" ? eventId : undefined;
}

function stripMatrixReplyFallback(body: string, replyToEventId?: string): string {
  if (!replyToEventId) return body;
  const separator = body.indexOf("\n\n");
  if (separator < 0) return body;
  const fallback = body.slice(0, separator).split("\n");
  if (!fallback.length || fallback.some((line) => !line.startsWith(">"))) return body;
  return body.slice(separator + 2);
}

export async function getEncryptedRoomMessages(
  session: MatrixSession,
  roomId: string,
  chatId: number,
): Promise<MatrixTimelineResult> {
  const client = await ensureEncryptedRoomReady(session, roomId);
  const room = client.getRoom(roomId);
  if (!room || room.getMyMembership() !== "join") {
    throw new Error("Authenticated Matrix user has not joined the encrypted room");
  }

  if (!backfilledRoomIds.has(roomId)) {
    await client.scrollback(room, 100);
    backfilledRoomIds.add(roomId);
  }

  const timelineEvents = room.getLiveTimeline().getEvents();
  const encryptedEvents = timelineEvents.filter(
    (event) => event.getType() === EventType.RoomMessageEncrypted,
  );
  await Promise.allSettled(encryptedEvents.map((event) => client.decryptEventIfNeeded(event)));
  const undecryptableCount = encryptedEvents.filter(
    (event) => event.getType() === EventType.RoomMessageEncrypted,
  ).length;
  const otherJoinedUserIds = room
    .getMembers()
    .filter((member) => member.membership === "join" && member.userId !== session.userId)
    .map((member) => member.userId);

  const messageEvents = timelineEvents.filter((event) => event.getType() === EventType.RoomMessage);
  const messageEventById = new Map(
    messageEvents
      .map((event) => [event.getId(), event] as const)
      .filter((entry): entry is readonly [string, typeof messageEvents[number]] => Boolean(entry[0])),
  );

  const messages = messageEvents
    .map<MatrixTimelineMessage | null>((event) => {
      const content = event.getContent<Record<string, unknown>>();
      const sender = event.getSender();
      const eventId = event.getId();
      const rawBody = content.body;
      const senderMatch = sender?.match(/^@chata_u(\d+):/);
      if (typeof rawBody !== "string" || !sender || !eventId || !senderMatch) return null;

      const replyToEventId = getMatrixReplyEventId(content);
      const body = stripMatrixReplyFallback(rawBody, replyToEventId);
      const replyEvent = replyToEventId ? messageEventById.get(replyToEventId) : undefined;
      const replyContent = replyEvent?.getContent<Record<string, unknown>>();
      const replySender = replyEvent?.getSender();
      const replySenderMatch = replySender?.match(/^@chata_u(\d+):/);
      const replyBody = typeof replyContent?.body === "string"
        ? stripMatrixReplyFallback(replyContent.body, getMatrixReplyEventId(replyContent))
        : "";
      const replyMsgType = replyContent?.msgtype === "m.file" ? "m.file" : "m.text";
      const replyTo = replyEvent && replyToEventId && replySender && replySenderMatch
        ? {
            eventId: replyToEventId,
            senderUserId: replySenderMatch[1],
            senderMxid: replySender,
            body: replyBody,
            msgtype: replyMsgType,
          } satisfies MatrixTimelineReply
        : undefined;
      const readByCount = otherJoinedUserIds.filter((userId) => room.hasUserReadEvent(userId, eventId)).length;
      const mentionContent = content["m.mentions"] && typeof content["m.mentions"] === "object"
        ? (content["m.mentions"] as Record<string, unknown>).user_ids
        : undefined;
      const mentionUserIds = Array.isArray(mentionContent)
        ? mentionContent.filter((userId): userId is string => typeof userId === "string")
        : undefined;
      const common = {
        eventId,
        senderUserId: senderMatch[1],
        senderMxid: sender,
        body,
        timestamp: event.getTs(),
        readByOther: readByCount > 0,
        readByCount,
        recipientCount: otherJoinedUserIds.length,
        ...(replyToEventId ? { replyToEventId } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(mentionUserIds?.length ? { mentionUserIds } : {}),
      };

      if (content.msgtype === "m.text" || content.msgtype === "m.notice") {
        return {
          ...common,
          msgtype: content.msgtype as "m.text" | "m.notice",
        } satisfies MatrixTimelineMessage;
      }

      const info = content.info && typeof content.info === "object"
        ? content.info as Record<string, unknown>
        : {};
      if (content.msgtype === "m.file" && isEncryptedAttachmentInfo(content.file, session.baseUrl, chatId)) {
        return {
          ...common,
          msgtype: "m.file",
          mimeType: typeof info.mimetype === "string" ? info.mimetype : "application/octet-stream",
          fileSize: typeof info.size === "number" ? info.size : undefined,
          encryptedFile: content.file,
        } satisfies MatrixTimelineMessage;
      }

      return null;
    })
    .filter((event): event is MatrixTimelineMessage => event !== null)
    .sort((a, b) => a.timestamp - b.timestamp);

  return { messages, undecryptableCount };
}

/** Send a standard Matrix read receipt for the latest visible event in an E2EE room. */
export async function sendMatrixReadReceipt(
  session: MatrixSession,
  roomId: string,
  eventId: string,
): Promise<void> {
  const client = await ensureEncryptedRoomReady(session, roomId);
  const room = client.getRoom(roomId);
  if (!room || room.getMyMembership() !== "join") {
    throw new Error("Matrix room is not joined on this device");
  }
  const event = room.findEventById(eventId);
  if (!event) throw new Error("Matrix event is not available in the local timeline");
  await client.sendReadReceipt(event);
}

export async function stopMatrixClient(logout = false): Promise<void> {
  const stoppedSessionKey = currentSessionKey;
  if (!clientPromise) {
    currentSessionToken = null;
    if (stoppedSessionKey) clearSecretStorageKey(stoppedSessionKey);
    roomPreparationPromises.clear();
    directHistoryVisibilityPromises.clear();
    backfilledRoomIds.clear();
    return;
  }
  const client = await clientPromise.catch(() => null);
  if (client) {
    const listener = toDeviceEventListeners.get(client);
    if (listener) client.removeListener(ClientEvent.ToDeviceEvent, listener);
    client.stopClient();
  }
  if (logout && client) {
    await client.logout().catch(() => undefined);
  }
  clientPromise = null;
  currentSessionKey = null;
  currentSessionToken = null;
  if (stoppedSessionKey) clearSecretStorageKey(stoppedSessionKey);
  backfilledRoomIds.clear();
  roomPreparationPromises.clear();
  directHistoryVisibilityPromises.clear();
}

export { EventType };
