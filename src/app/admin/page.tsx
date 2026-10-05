"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AdminDashboard from "@/components/AdminDashboard";

interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: "user" | "admin";
}

export default function AdminPage() {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok || !data.user || data.user.role !== "admin") {
          setError("Доступ запрещён");
          window.location.replace("/");
          return;
        }
        setUser(data.user);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Не удалось проверить доступ");
          window.location.replace("/");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <main className="min-h-screen bg-[#0a0a0f] text-white">
        <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">
          Проверяем права администратора…
        </div>
      </main>
    );
  }

  if (!user || error) {
    return (
      <main className="min-h-screen bg-[#0a0a0f] px-6 py-20 text-white">
        <div className="mx-auto max-w-lg rounded-2xl border border-dark-600 bg-dark-800 p-8 text-center">
          <h1 className="text-2xl font-bold">Доступ запрещён</h1>
          <p className="mt-3 text-sm text-gray-400">Эта страница доступна только администраторам.</p>
          <Link href="/" className="mt-5 inline-block rounded-xl bg-purple-500 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-600">
            Вернуться в чат
          </Link>
        </div>
      </main>
    );
  }

  return <AdminDashboard admin={{ id: user.id, username: user.username, displayName: user.displayName }} />;
}
