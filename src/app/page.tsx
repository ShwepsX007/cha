"use client";

import { useEffect, useState } from "react";
import AuthScreen from "@/components/AuthScreen";
import ChatApp from "@/components/ChatApp";

export interface User {
  id: number;
  username: string;
  displayName: string;
  avatarColor?: string;
  avatarUrl?: string | null;
  avatarUpdatedAt?: string | null;
  role?: "user" | "admin";
  bannedUntil?: string | null;
  banReason?: string | null;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (cancelled || !data.user) return;
        // Order matters: publishing the user before clearing `loading` avoids
        // a one-frame flash of the login screen on every reload.
        setUser(data.user);
      } catch {
        // A failed session check must not log the user out: the app falls
        // back to the login screen only when the server really says 401.
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

  return (
    <ChatApp
      user={user}
      onLogout={() => setUser(null)}
    />
  );
}
