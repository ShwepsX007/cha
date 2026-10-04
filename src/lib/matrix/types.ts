export interface MatrixSession {
  baseUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
}

export type MatrixAvailability = "ready" | "not_configured" | "unavailable";
