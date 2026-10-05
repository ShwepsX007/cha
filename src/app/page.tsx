"use client";

import { useCallback, useEffect, useState } from "react";
import AuthScreen from "@/components/AuthScreen";
import ChatApp from "@/components/ChatApp";
import type { MatrixAvailability, MatrixSession } from "@/lib/matrix/types";
import {
  clearMatrixSession,
  loadMatrixAvailability,
  loadUsableMatrixSession,
} from "@/lib/matrix/session-store";

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

  // Stable identity: ChatApp keys its Matrix client effect on the user object,
  // so a fresh inline callback here would tear the Matrix client down and
  // rebuild it whenever this component re-rendered.
  const handleLogout = useCallback(() => setUser(null), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (cancelled || !data.user) return;

        let matrixNotice: string | undefined;

        // A pending Matrix reset means the *homeserver* revoked this device; the
        // stored session and crypto device belong to that revoked device and must
        // not be reused. The app session is still valid, so instead of logging the
        // user out (which used to repeat on every reload until a full re-login
        // succeeded) the client is handed the flag and opens the recovery flow.
        if (data.user.matrixResetRequired) {
          clearMatrixSession(data.user.id);
          matrixNotice =
            "Текущее Matrix-устройство отозвано. Введите пароль один раз в «Восстановить Matrix-сессию» — локальные ключи будут переиспользованы.";
        }

        let matrixSession: MatrixSession | null = null;
        if (!data.user.matrixResetRequired) {
          try {
            const usable = await loadUsableMatrixSession(data.user.id);
            matrixSession = usable.session;
            if (usable.refreshFailed) {
              matrixNotice = usable.error
                || "Matrix-сессия истекла и не обновилась автоматически. Нажмите «Восстановить Matrix-сессию».";
            }
          } catch {
            matrixSession = null;
          }
        }

        const storedAvailability = loadMatrixAvailability();
        const matrixAvailability: MatrixAvailability = matrixSession
          ? "ready"
          : storedAvailability === "not_configured"
            ? "not_configured"
            : "unavailable";

        // Order matters: publishing the user before clearing `loading` avoids a
        // one-frame flash of the login screen on every reload.
        if (!cancelled) {
          setUser({
            ...data.user,
            matrixSession,
            matrixAvailability,
            matrixNotice: matrixNotice || data.user.matrixNotice || undefined,
          });
        }
      } catch {
        // A failed session check must not log the user out: the app falls back
        // to the login screen only when the server really says 401.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
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

  return <ChatApp user={user} onLogout={handleLogout} />;
}
