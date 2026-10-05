"use client";

import { useEffect, useState } from "react";
import type { MatrixSession } from "@/lib/matrix/types";
import Avatar from "./Avatar";

interface CandidateUser {
  id: number;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  matrixUserId: string | null;
}

export default function AddGroupMembersModal({
  chatId,
  memberIds,
  matrixSession,
  onClose,
  onAdded,
}: {
  chatId: number;
  memberIds: number[];
  matrixSession?: MatrixSession | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [users, setUsers] = useState<CandidateUser[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/users")
      .then((response) => response.json())
      .then((data) => {
        if (Array.isArray(data.users)) setUsers(data.users);
      })
      .catch(() => setError("Не удалось загрузить пользователей"))
      .finally(() => setLoading(false));
  }, []);

  const candidates = users.filter((user) => !memberIds.includes(user.id));

  const addMembers = async () => {
    if (!matrixSession || selectedIds.length === 0 || saving) return;
    setSaving(true);
    setError("");

    try {
      for (const userId of selectedIds) {
        const response = await fetch(`/api/chats/${chatId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, matrixAccessToken: matrixSession.accessToken }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "Не удалось добавить участника");
        }
      }
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось добавить участников");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl border border-dark-600 bg-dark-800">
        <div className="flex items-center justify-between border-b border-dark-600 p-4">
          <div>
            <h3 className="text-lg font-semibold">Добавить в группу</h3>
            <p className="mt-1 text-xs text-gray-500">Приглашать может только создатель или администратор</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-dark-600 hover:text-white" aria-label="Закрыть">
            ✕
          </button>
        </div>

        {error && <div className="mx-3 mt-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
        {!matrixSession && (
          <div className="mx-3 mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">
            Matrix E2EE не подключён — участника добавить нельзя.
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="p-6 text-center text-gray-500">Загрузка...</div>
          ) : candidates.length === 0 ? (
            <div className="p-6 text-center text-gray-500">Нет доступных пользователей</div>
          ) : (
            candidates.map((user) => {
              const selected = selectedIds.includes(user.id);
              return (
                <button
                  key={user.id}
                  disabled={!matrixSession || !user.matrixUserId || saving}
                  onClick={() => setSelectedIds((current) => selected
                    ? current.filter((id) => id !== user.id)
                    : [...current, user.id])}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-dark-700 disabled:opacity-50 ${selected ? "bg-purple-500/20" : ""}`}
                >
                  <Avatar src={user.avatarUrl} name={user.displayName} color={user.avatarColor} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{user.displayName}</div>
                    <div className="text-xs text-gray-500">@{user.username}</div>
                  </div>
                  <span className="text-purple-300">{selected ? "✓" : "+"}</span>
                </button>
              );
            })
          )}
        </div>

        <div className="border-t border-dark-600 p-3">
          <button
            onClick={() => void addMembers()}
            disabled={!matrixSession || selectedIds.length === 0 || saving}
            className="w-full rounded-xl bg-purple-500 py-2.5 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-40"
          >
            {saving ? "Отправляем приглашения…" : `Добавить (${selectedIds.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
