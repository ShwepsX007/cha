"use client";

import {
  ClientEvent,
  EventType,
  MsgType,
  Preset,
  Visibility,
  MatrixError,
  createClient,
  type MatrixClient,
  type UIAuthCallback,
} from "matrix-js-sdk";
import type {
  CryptoCallbacks,
  ImportRoomKeyProgressData,
  KeyBackupRestoreResult,
} from "matrix-js-sdk/lib/crypto-api/index";
import { decodeRecoveryKey, encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import type { IEncryptedFile } from "matrix-encrypt-attachment";
import type { MatrixSession } from "./types";

let clientPromise: Promise<MatrixClient> | null = null;
let currentSessionKey: string | null = null;
const backfilledRoomIds = new Set<string>();
const secretStorageKeyCache = new Map<
  string,
  { keyId?: string; key: Uint8Array<ArrayBuffer> }
>();

export interface MatrixTimelineMessage {
  eventId: string;
  senderUserId: string;
  senderMxid: string;
  body: string;
  timestamp: number;
  msgtype: "m.text" | "m.notice" | "m.file";
  mimeType?: string;
  fileSize?: number;
  encryptedFile?: IEncryptedFile & { url: string };
}

function sessionKey(session: MatrixSession): string {
  return `${session.baseUrl}|${session.userId}|${session.deviceId}|${session.accessToken}`;
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
    return clientPromise;
  }

  if (clientPromise) {
    const oldKey = currentSessionKey;
    const oldClient = await clientPromise.catch(() => null);
    oldClient?.stopClient();
    if (oldKey) clearSecretStorageKey(oldKey);
    backfilledRoomIds.clear();
  }

  currentSessionKey = key;
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
    });

    const cryptoDatabasePrefix = `secret-chat-${session.userId}-${session.deviceId}`
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 180);
    await client.initRustCrypto({
      useIndexedDB: true,
      cryptoDatabasePrefix,
    });
    client.startClient({ initialSyncLimit: 20 });
    return client;
  })();

  try {
    return await clientPromise;
  } catch (error) {
    clientPromise = null;
    currentSessionKey = null;
    throw error;
  }
}

export async function waitForMatrixSync(client: MatrixClient): Promise<void> {
  if (client.getSyncState() === "SYNCING") return;

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      client.removeListener(ClientEvent.Sync, onSync);
      reject(new Error("Matrix sync timed out"));
    }, 30_000);

    const onSync = (state: string) => {
      if (state === "SYNCING") {
        window.clearTimeout(timeout);
        client.removeListener(ClientEvent.Sync, onSync);
        resolve();
      } else if (state === "ERROR" || state === "STOPPED") {
        window.clearTimeout(timeout);
        client.removeListener(ClientEvent.Sync, onSync);
        reject(new Error(`Matrix sync stopped: ${state}`));
      }
    };

    client.on(ClientEvent.Sync, onSync);
  });
}

export interface MatrixSecurityStatus {
  crossSigningReady: boolean;
  crossSigningPrivateKeysCached: boolean;
  crossSigningPrivateKeysStored: boolean;
  secretStorageKeyId: string | null;
  secretStorageReady: boolean;
  backupVersion: string | null;
  keyBackupAvailable: boolean;
}

export async function getMatrixSecurityStatus(
  session: MatrixSession,
): Promise<MatrixSecurityStatus> {
  const client = await getMatrixClient(session);
  await waitForMatrixSync(client);
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("Matrix Rust crypto is unavailable");

  const [crossSigning, secretStorage, backupInfo, backupVersion] = await Promise.all([
    crypto.getCrossSigningStatus(),
    crypto.getSecretStorageStatus(),
    crypto.getKeyBackupInfo(),
    crypto.getActiveSessionBackupVersion(),
  ]);
  const cachedKeys = crossSigning.privateKeysCachedLocally;
  const privateKeysCached =
    cachedKeys.masterKey && cachedKeys.selfSigningKey && cachedKeys.userSigningKey;

  return {
    crossSigningReady: crossSigning.publicKeysOnDevice,
    crossSigningPrivateKeysCached: privateKeysCached,
    crossSigningPrivateKeysStored: crossSigning.privateKeysInSecretStorage,
    secretStorageKeyId: secretStorage.defaultKeyId,
    secretStorageReady: secretStorage.ready,
    backupVersion,
    keyBackupAvailable: Boolean(backupInfo),
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

/**
 * Set up Matrix cross-signing, secret storage, and an encrypted room-key backup.
 * The recovery key is returned once for the user to save; it is never persisted
 * in app storage or sent to the application server.
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

  const [secretStorage, crossSigning, backupInfo] = await Promise.all([
    crypto.getSecretStorageStatus(),
    crypto.getCrossSigningStatus(),
    crypto.getKeyBackupInfo(),
  ]);
  if (secretStorage.defaultKeyId) {
    throw new Error("Matrix secret storage already exists. Use your recovery key or pair a trusted device instead.");
  }

  const cachedKeyCount = Object.values(crossSigning.privateKeysCachedLocally).filter(Boolean).length;
  if (
    (crossSigning.publicKeysOnDevice && cachedKeyCount !== 3) ||
    (cachedKeyCount > 0 && cachedKeyCount < 3)
  ) {
    throw new Error("This account already has cross-signing keys. Pair a trusted device or restore with its recovery key; refusing to replace them.");
  }

  await crypto.bootstrapCrossSigning({
    authUploadDeviceSigningKeys: passwordUiaCallback(session.userId, password),
  });

  const generatedKey: {
    value: Awaited<ReturnType<typeof crypto.createRecoveryKeyFromPassphrase>> | null;
  } = { value: null };
  await crypto.bootstrapSecretStorage({
    setupNewKeyBackup: !backupInfo,
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
  const secretStorage = await crypto.getSecretStorageStatus();
  secretStorageKeyCache.set(cacheKey, {
    keyId: secretStorage.defaultKeyId || undefined,
    key: decodedKey,
  });

  try {
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

  return await crypto.restoreKeyBackup({ progressCallback: onProgress });
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
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      },
      {
        type: EventType.RoomJoinRules,
        state_key: "",
        content: { join_rule: "invite" },
      },
      {
        type: EventType.RoomHistoryVisibility,
        state_key: "",
        content: { history_visibility: "joined" },
      },
    ],
    power_level_content_override: {
      users: { [session.userId]: 100 },
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
  return roomId;
}

export async function sendEncryptedText(
  session: MatrixSession,
  roomId: string,
  body: string,
): Promise<void> {
  const client = await getMatrixClient(session);
  const crypto = client.getCrypto();
  if (!crypto || !(await crypto.isEncryptionEnabledInRoom(roomId))) {
    throw new Error("Refusing to send: this Matrix room is not encrypted");
  }

  await client.sendTextMessage(roomId, body);
}

export async function sendEncryptedAttachment(
  session: MatrixSession,
  roomId: string,
  input: {
    fileName: string;
    mimeType: string;
    fileSize: number;
    encryptedFile: IEncryptedFile & { url: string };
  },
): Promise<void> {
  const client = await getMatrixClient(session);
  const crypto = client.getCrypto();
  if (!crypto || !(await crypto.isEncryptionEnabledInRoom(roomId))) {
    throw new Error("Refusing to send: this Matrix room is not encrypted");
  }

  const sha256 = input.encryptedFile.hashes?.sha256;
  if (!sha256 || !input.encryptedFile.v) {
    throw new Error("Matrix encrypted attachment metadata is incomplete");
  }

  await client.sendMessage(roomId, {
    msgtype: MsgType.File,
    body: input.fileName,
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
  });
}

export async function joinRoomIfInvited(
  session: MatrixSession,
  roomId: string,
): Promise<void> {
  const client = await getMatrixClient(session);
  await waitForMatrixSync(client);
  const room = client.getRoom(roomId);
  if (room?.getMyMembership() === "invite") {
    await client.joinRoom(roomId);
  }
}

export async function hasMatrixInvitePermission(
  session: MatrixSession,
  roomId: string,
): Promise<boolean> {
  const client = await getMatrixClient(session);
  await waitForMatrixSync(client);
  let room = client.getRoom(roomId);
  if (room?.getMyMembership() === "invite") {
    room = await client.joinRoom(roomId);
  }
  if (!room || room.getMyMembership() !== "join") return false;

  const powerEvent = room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
  const power = powerEvent?.getContent<Record<string, unknown>>();
  if (!power) return false;
  const users = (power.users as Record<string, number> | undefined) || {};
  const userLevel = users[session.userId] ?? Number(power.users_default || 0);
  const inviteLevel = Number(power.invite ?? 0);
  return inviteLevel >= 50 && userLevel >= inviteLevel;
}

export async function getEncryptedRoomMessages(
  session: MatrixSession,
  roomId: string,
  chatId: number,
): Promise<MatrixTimelineMessage[]> {
  const client = await getMatrixClient(session);
  await waitForMatrixSync(client);

  let room = client.getRoom(roomId);
  if (room?.getMyMembership() === "invite") {
    room = await client.joinRoom(roomId);
  }
  if (!room || room.getMyMembership() !== "join") return [];

  if (!backfilledRoomIds.has(roomId)) {
    await client.scrollback(room, 100);
    backfilledRoomIds.add(roomId);
  }

  return room
    .getLiveTimeline()
    .getEvents()
    .filter((event) => event.getType() === EventType.RoomMessage)
    .map<MatrixTimelineMessage | null>((event) => {
      const content = event.getContent<Record<string, unknown>>();
      const sender = event.getSender();
      const eventId = event.getId();
      const body = content.body;
      const senderMatch = sender?.match(/^@chata_u(\d+):/);
      if (typeof body !== "string" || !sender || !eventId || !senderMatch) return null;

      if (content.msgtype === "m.text" || content.msgtype === "m.notice") {
        return {
          eventId,
          senderUserId: senderMatch[1],
          senderMxid: sender,
          body,
          timestamp: event.getTs(),
          msgtype: content.msgtype as "m.text" | "m.notice",
        } satisfies MatrixTimelineMessage;
      }

      const info = content.info && typeof content.info === "object"
        ? content.info as Record<string, unknown>
        : {};
      if (content.msgtype === "m.file" && isEncryptedAttachmentInfo(content.file, session.baseUrl, chatId)) {
        return {
          eventId,
          senderUserId: senderMatch[1],
          senderMxid: sender,
          body,
          timestamp: event.getTs(),
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
}

export async function stopMatrixClient(logout = false): Promise<void> {
  const stoppedSessionKey = currentSessionKey;
  if (!clientPromise) {
    if (stoppedSessionKey) clearSecretStorageKey(stoppedSessionKey);
    return;
  }
  const client = await clientPromise.catch(() => null);
  client?.stopClient();
  if (logout && client) {
    await client.logout().catch(() => undefined);
  }
  clientPromise = null;
  currentSessionKey = null;
  if (stoppedSessionKey) clearSecretStorageKey(stoppedSessionKey);
  backfilledRoomIds.clear();
}

export { EventType };
