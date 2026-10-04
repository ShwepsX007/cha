"use client";

import { useState, useEffect } from "react";
import AuthScreen from "@/components/AuthScreen";
import ChatApp from "@/components/ChatApp";
import type { MatrixAvailability, MatrixSession } from "@/lib/matrix/types";

interface User {
  id: number;
  username: string;
  displayName: string;
  avatarColor?: string;
  avatarUrl?: string | null;
  avatarUpdatedAt?: string | null;
  role?: "user" | "admin";
  bannedUntil?: string | null;
  banReason?: string | null;
  matrixResetRequired?: boolean;
  pushEnabled?: boolean;
  matrixAvailability?: MatrixAvailability;
  matrixSession?: MatrixSession | null;
  initialRecoveryKey?: string | null;
  initialRecoveryKeySaved?: boolean;
  matrixNotice?: string;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => {
        if (data.user) {
          if (data.user.matrixResetRequired) {
            sessionStorage.removeItem("chata_matrix_session");
            sessionStorage.removeItem("chata_matrix_availability");
            setUser(null);
            return;
          }

          let matrixSession: MatrixSession | null = null;
          try {
            const stored = sessionStorage.getItem("chata_matrix_session");
            const candidate = stored ? JSON.parse(stored) as MatrixSession : null;
            if (
              candidate &&
              typeof candidate.baseUrl === "string" &&
              typeof candidate.accessToken === "string" &&
              typeof candidate.deviceId === "string" &&
              typeof candidate.userId === "string" &&
              candidate.userId.startsWith(`@chata_u${data.user.id}:`)
            ) {
              matrixSession = candidate;
            } else {
              sessionStorage.removeItem("chata_matrix_session");
            }
          } catch {
            sessionStorage.removeItem("chata_matrix_session");
          }

          const storedAvailability = sessionStorage.getItem("chata_matrix_availability");
          const matrixAvailability = storedAvailability === "not_configured"
            ? "not_configured"
            : matrixSession && storedAvailability === "ready"
              ? "ready"
              : "unavailable";
          setUser({ ...data.user, matrixSession, matrixAvailability });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-900">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-gray-400">Загрузка...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen onAuth={setUser} />;
  }

  return <ChatApp user={user} onLogout={() => setUser(null)} />;
}
