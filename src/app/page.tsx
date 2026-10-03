"use client";

import { useState, useEffect } from "react";
import AuthScreen from "@/components/AuthScreen";
import ChatApp from "@/components/ChatApp";

interface User {
  id: number;
  username: string;
  displayName: string;
  avatarColor?: string;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => {
        if (data.user) setUser(data.user);
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
