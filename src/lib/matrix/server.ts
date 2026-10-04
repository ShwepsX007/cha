import { randomBytes, randomUUID } from "node:crypto";
import type { MatrixAvailability, MatrixSession } from "./types";

interface MatrixConfig {
  internalUrl: string;
  publicUrl: string;
  serverName: string;
  adminAccessToken: string;
}

interface MatrixLoginOptions {
  appUserId: number;
  username: string;
  displayName: string;
  password: string;
  deviceId?: string | null;
}

export interface MatrixLoginResult {
  availability: MatrixAvailability;
  session: MatrixSession | null;
}

function getMatrixConfig(): MatrixConfig | null {
  const internalUrl = process.env.MATRIX_INTERNAL_URL?.trim();
  const publicUrl = process.env.MATRIX_PUBLIC_URL?.trim();
  const serverName = process.env.MATRIX_SERVER_NAME?.trim();
  const adminAccessToken = process.env.MATRIX_ADMIN_ACCESS_TOKEN?.trim();

  if (!internalUrl && !publicUrl && !serverName && !adminAccessToken) {
    return null;
  }

  if (!internalUrl || !publicUrl || !serverName || !adminAccessToken) {
    throw new Error("Matrix is only partially configured");
  }

  let publicUrlObject: URL;
  try {
    publicUrlObject = new URL(publicUrl);
  } catch {
    throw new Error("MATRIX_PUBLIC_URL must be an absolute URL");
  }
  if (
    (publicUrlObject.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(publicUrlObject.hostname)) ||
    publicUrlObject.username ||
    publicUrlObject.password ||
    publicUrlObject.search ||
    publicUrlObject.hash
  ) {
    throw new Error("MATRIX_PUBLIC_URL must use HTTPS and contain no embedded credentials");
  }

  return {
    internalUrl: internalUrl.replace(/\/+$/, ""),
    publicUrl: publicUrl.replace(/\/+$/, ""),
    serverName,
    adminAccessToken,
  };
}

export function isMatrixConfigured(): boolean {
  try {
    return getMatrixConfig() !== null;
  } catch {
    return false;
  }
}

/** A secret-free probe for the app host's configured Synapse client API. */
export async function getMatrixHealthStatus(): Promise<"ok" | "not_configured" | "unavailable"> {
  let config: MatrixConfig | null;
  try {
    config = getMatrixConfig();
  } catch {
    return "unavailable";
  }
  if (!config) return "not_configured";

  try {
    const response = await fetch(`${config.internalUrl}/_matrix/client/versions`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok ? "ok" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function getMatrixUserId(appUserId: number): string | null {
  try {
    const config = getMatrixConfig();
    return config ? `@chata_u${appUserId}:${config.serverName}` : null;
  } catch {
    return null;
  }
}

export function createMatrixDeviceId(candidate?: string | null): string {
  if (candidate && /^[A-Za-z0-9._=-]{1,255}$/.test(candidate)) {
    return candidate;
  }
  return randomUUID().replaceAll("-", "").toUpperCase();
}

function matrixUserId(config: MatrixConfig, appUserId: number): string {
  return `@chata_u${appUserId}:${config.serverName}`;
}

function adminHeaders(config: MatrixConfig): HeadersInit {
  return {
    Authorization: `Bearer ${config.adminAccessToken}`,
    "Content-Type": "application/json",
  };
}

interface SynapseDeviceList {
  devices?: Array<{ device_id?: unknown }>;
}

async function listSynapseDevices(config: MatrixConfig, appUserId: number): Promise<string[]> {
  const mxid = matrixUserId(config, appUserId);
  const response = await fetch(
    `${config.internalUrl}/_synapse/admin/v2/users/${encodeURIComponent(mxid)}/devices`,
    { headers: adminHeaders(config), cache: "no-store" },
  );
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Matrix device lookup failed (${response.status})`);
  const payload = await response.json() as SynapseDeviceList;
  return (payload.devices || [])
    .map((device) => device.device_id)
    .filter((deviceId): deviceId is string => typeof deviceId === "string");
}

/** Revoke every Synapse access token/device for one app user. Never returns the admin token. */
export async function resetMatrixDevicesForAppUser(
  appUserId: number,
): Promise<{ configured: boolean; revokedDevices: number }> {
  const config = getMatrixConfig();
  if (!config) return { configured: false, revokedDevices: 0 };

  const devices = await listSynapseDevices(config, appUserId);
  if (devices.length === 0) return { configured: true, revokedDevices: 0 };

  const mxid = matrixUserId(config, appUserId);
  const response = await fetch(
    `${config.internalUrl}/_synapse/admin/v2/users/${encodeURIComponent(mxid)}/delete_devices`,
    {
      method: "POST",
      headers: adminHeaders(config),
      body: JSON.stringify({ devices }),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error(`Matrix device reset failed (${response.status})`);
  return { configured: true, revokedDevices: devices.length };
}

/** Deactivate and erase a user's dedicated Synapse identity. */
export async function deactivateMatrixIdentityForAppUser(
  appUserId: number,
): Promise<{ configured: boolean }> {
  const config = getMatrixConfig();
  if (!config) return { configured: false };

  const mxid = matrixUserId(config, appUserId);
  const response = await fetch(
    `${config.internalUrl}/_synapse/admin/v1/deactivate/${encodeURIComponent(mxid)}`,
    {
      method: "POST",
      headers: adminHeaders(config),
      body: JSON.stringify({ erase: true }),
      cache: "no-store",
    },
  );
  if (response.status === 404) return { configured: true };
  if (!response.ok) throw new Error(`Matrix account deactivation failed (${response.status})`);
  return { configured: true };
}

/** Synchronize the dedicated Matrix identity's password with the app password. */
export async function synchronizeMatrixAppUserPassword(
  appUserId: number,
  displayName: string,
  password: string,
): Promise<{ configured: boolean }> {
  const config = getMatrixConfig();
  if (!config) return { configured: false };
  await putMatrixUser(config, appUserId, displayName, password);
  return { configured: true };
}

/** Confirm that a freshly authenticated Matrix device has been provisioned. */
export async function matrixDeviceExistsForAppUser(
  appUserId: number,
  deviceId: string,
): Promise<boolean> {
  const config = getMatrixConfig();
  if (!config) return false;
  const devices = await listSynapseDevices(config, appUserId);
  return devices.includes(deviceId);
}

async function putMatrixUser(
  config: MatrixConfig,
  appUserId: number,
  displayName: string,
  password: string,
): Promise<void> {
  const mxid = matrixUserId(config, appUserId);
  const response = await fetch(
    `${config.internalUrl}/_synapse/admin/v2/users/${encodeURIComponent(mxid)}`,
    {
      method: "PUT",
      headers: adminHeaders(config),
      body: JSON.stringify({
        password,
        logout_devices: false,
        displayname: displayName,
        admin: false,
        deactivated: false,
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`Matrix account provisioning failed (${response.status})`);
  }
}

/** Create or synchronize the dedicated Matrix identity used by an app account. */
async function synchronizeMatrixPassword(
  config: MatrixConfig,
  options: MatrixLoginOptions,
): Promise<void> {
  // The account namespace is reserved for this app. Updating its password here
  // keeps Matrix authentication aligned with the already-verified app password.
  await putMatrixUser(config, options.appUserId, options.displayName, options.password);
}

/** Ensure an app account has a Matrix identity without knowing its password.
 * Existing identities are left untouched; the user password is synchronized
 * only after that user successfully authenticates to the app.
 */
export async function ensureMatrixIdentity(
  appUserId: number,
  displayName: string,
): Promise<void> {
  const config = getMatrixConfig();
  if (!config) return;

  const mxid = matrixUserId(config, appUserId);
  const getResponse = await fetch(
    `${config.internalUrl}/_synapse/admin/v2/users/${encodeURIComponent(mxid)}`,
    {
      headers: { Authorization: `Bearer ${config.adminAccessToken}` },
      cache: "no-store",
    },
  );

  if (getResponse.ok) return;
  if (getResponse.status !== 404) {
    throw new Error(`Matrix account lookup failed (${getResponse.status})`);
  }

  // This temporary credential is never returned or logged. On the account's
  // next successful app login, it is replaced with the user's app password.
  const temporaryPassword = randomBytes(48).toString("base64url");
  await putMatrixUser(config, appUserId, displayName, temporaryPassword);
}

interface MatrixStateEvent {
  type?: string;
  state_key?: string;
  sender?: string;
  content?: Record<string, unknown>;
}

function hasImplicitCreatorPower(event: MatrixStateEvent | undefined, userId: string): boolean {
  const roomVersion = event?.content?.room_version;
  if (typeof roomVersion !== "string" || !/^\d+$/.test(roomVersion) || Number(roomVersion) < 12) {
    return false;
  }

  const additionalCreators = event?.content?.additional_creators;
  return event?.sender === userId ||
    (Array.isArray(additionalCreators) && additionalCreators.includes(userId));
}

function isValidMatrixRoomId(roomId: string): boolean {
  if (roomId.length > 255) return false;

  // Room versions 1–11 use !opaque:server IDs; v12+ uses the create-event
  // hash with a ! sigil and no server-name suffix.
  return /^![^:]+:.+$/.test(roomId) || /^![A-Za-z0-9_-]+$/.test(roomId);
}

export async function verifyEncryptedRoom(input: {
  roomId: string;
  accessToken: string;
  appUserIds: number[];
  authenticatedAppUserId: number;
  creatorAppUserId: number;
  expectedHistoryVisibility: "invited" | "joined";
}): Promise<void> {
  const config = getMatrixConfig();
  if (!config) throw new Error("Matrix is not configured");
  if (!isValidMatrixRoomId(input.roomId)) {
    throw new Error("Invalid Matrix room ID");
  }
  if (!input.accessToken || input.accessToken.length > 8192) {
    throw new Error("Missing Matrix access token");
  }

  const headers = { Authorization: `Bearer ${input.accessToken}` };
  const whoamiResponse = await fetch(`${config.internalUrl}/_matrix/client/v3/account/whoami`, {
    headers,
    cache: "no-store",
  });
  if (!whoamiResponse.ok) throw new Error("Matrix session could not be verified");

  const whoami = (await whoamiResponse.json()) as { user_id?: string };
  const authenticatedMxid = matrixUserId(config, input.authenticatedAppUserId);
  const creatorMxid = matrixUserId(config, input.creatorAppUserId);
  if (whoami.user_id !== authenticatedMxid) {
    throw new Error("Matrix session does not match the authenticated app user");
  }

  const stateResponse = await fetch(
    `${config.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/state`,
    { headers, cache: "no-store" },
  );
  if (!stateResponse.ok) throw new Error("Matrix room state could not be verified");

  const state = (await stateResponse.json()) as MatrixStateEvent[];
  const findState = (type: string) => state.find((event) => event.type === type && (event.state_key || "") === "");
  const createEvent = findState("m.room.create");
  const encryption = findState("m.room.encryption")?.content;
  const joinRules = findState("m.room.join_rules")?.content;
  const historyVisibility = findState("m.room.history_visibility")?.content;
  const powerLevels = findState("m.room.power_levels")?.content;

  if (!createEvent || createEvent.sender !== creatorMxid) {
    throw new Error("Matrix room creator does not match the app chat creator");
  }
  if (encryption?.algorithm !== "m.megolm.v1.aes-sha2") {
    throw new Error("Matrix room is not end-to-end encrypted");
  }
  if (
    joinRules?.join_rule !== "invite" ||
    historyVisibility?.history_visibility !== input.expectedHistoryVisibility
  ) {
    throw new Error("Matrix room privacy settings are not strict enough");
  }
  if (!powerLevels) throw new Error("Matrix room permissions are missing");

  const users = (powerLevels.users as Record<string, number> | undefined) || {};
  const eventLevels = (powerLevels.events as Record<string, number> | undefined) || {};
  const usersDefault = Number(powerLevels.users_default ?? 0);
  const inviteLevel = Number(powerLevels.invite ?? 0);
  const creatorLevel = hasImplicitCreatorPower(createEvent, creatorMxid)
    ? inviteLevel
    : Number(users[creatorMxid] ?? usersDefault);
  const authenticatedLevel = hasImplicitCreatorPower(createEvent, authenticatedMxid)
    ? inviteLevel
    : Number(users[authenticatedMxid] ?? usersDefault);
  const stateDefault = Number(powerLevels.state_default ?? 50);
  const powerLevelsStateLevel = Number(eventLevels["m.room.power_levels"] ?? stateDefault);
  if (
    !Number.isFinite(usersDefault) ||
    !Number.isFinite(creatorLevel) ||
    !Number.isFinite(authenticatedLevel) ||
    !Number.isFinite(inviteLevel) ||
    !Number.isFinite(stateDefault) ||
    !Number.isFinite(powerLevelsStateLevel) ||
    inviteLevel < 50 ||
    creatorLevel < inviteLevel ||
    authenticatedLevel < inviteLevel ||
    usersDefault >= inviteLevel ||
    stateDefault < inviteLevel ||
    powerLevelsStateLevel < inviteLevel
  ) {
    throw new Error("Matrix room does not restrict invitations to its admins");
  }

  const expectedMxids = new Set(input.appUserIds.map((id) => matrixUserId(config, id)));
  if (!expectedMxids.has(creatorMxid)) {
    throw new Error("Matrix room participant list is invalid");
  }

  const activeMembers = state
    .filter((event) => event.type === "m.room.member")
    .filter((event) => event.content?.membership === "join" || event.content?.membership === "invite")
    .map((event) => event.state_key)
    .filter((mxid): mxid is string => Boolean(mxid));

  if (
    activeMembers.length !== expectedMxids.size ||
    activeMembers.some((mxid) => !expectedMxids.has(mxid)) ||
    [...expectedMxids].some((mxid) => !activeMembers.includes(mxid))
  ) {
    throw new Error("Matrix room members do not match the app chat members");
  }

  const ownMembership = state.find(
    (event) => event.type === "m.room.member" && event.state_key === authenticatedMxid,
  );
  if (ownMembership?.content?.membership !== "join") {
    throw new Error("Authenticated Matrix user has not joined the room");
  }
}

export async function inviteMatrixUserToRoom(
  roomId: string,
  accessToken: string,
  targetAppUserId: number,
): Promise<void> {
  const config = getMatrixConfig();
  if (!config) throw new Error("Matrix is not configured");
  if (!isValidMatrixRoomId(roomId)) {
    throw new Error("Invalid Matrix room ID");
  }

  const response = await fetch(
    `${config.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: matrixUserId(config, targetAppUserId) }),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error(`Matrix invite rejected (${response.status})`);
}

export async function createMatrixSession(
  options: MatrixLoginOptions,
): Promise<MatrixLoginResult> {
  const config = getMatrixConfig();
  if (!config) {
    return { availability: "not_configured", session: null };
  }

  const deviceId = createMatrixDeviceId(options.deviceId);
  await synchronizeMatrixPassword(config, options);

  const response = await fetch(`${config.internalUrl}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: {
        type: "m.id.user",
        user: `chata_u${options.appUserId}`,
      },
      password: options.password,
      device_id: deviceId,
      initial_device_display_name: `Secret Chat — ${options.username}`,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Matrix login failed (${response.status})`);
  }

  const data = (await response.json()) as {
    user_id?: string;
    access_token?: string;
    device_id?: string;
  };
  const expectedUserId = matrixUserId(config, options.appUserId);

  if (
    data.user_id !== expectedUserId ||
    !data.access_token ||
    !data.device_id
  ) {
    throw new Error("Matrix returned an incomplete or unexpected login session");
  }

  return {
    availability: "ready",
    session: {
      baseUrl: config.publicUrl,
      userId: data.user_id,
      accessToken: data.access_token,
      deviceId: data.device_id,
    },
  };
}
