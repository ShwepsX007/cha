export interface MatrixSession {
  baseUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  /** Present only when the homeserver issues Matrix refresh tokens. */
  refreshToken?: string;
  /** Unix timestamp in milliseconds; absent when the homeserver token does not expire. */
  expiresAt?: number;
}

export type MatrixAvailability = "ready" | "not_configured" | "unavailable";
