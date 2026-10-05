"use client";

import { useEffect, useRef, useState } from "react";
import Avatar from "./Avatar";

interface CandidateUser {
  id: number;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
}

const MIN_SEARCH_LENGTH = 2;

export default function AddGroupMembersModal({
  chatId,
  memberIds,
  onClose,
  onAdded,
}: {
  chatId: number;
  memberIds: number[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [users, setUsers] = useState<CandidateUser[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // The full user directory no longer exists: search the server for a name
  // or @login, same rule as when starting a new chat.
  const requestSeqRef = useRef(0);
  useEffect(() => {
    const query = search.trim();
    if (query.length < MIN_SEARCH_LENGTH) {
      setUsers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++requestSeqRef.current;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/users?q=${encodeURIComponent(query)}`, { cache: "no-store" });
        const data = await response.json();
        if (seq !== requestSeqRef.current) return;
        if (response.ok && Array.isArray(data.users)) setUsers(data.users);
        else setError(typeof data?.error === "string" ? data.error : "Не удалось выполнить поиск");
      } catch {
        if (seq === requestSeqRef.current) setError("Не удалось выполнить поиск");
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [search]);

  const candidates = users.filter((user) => !memberIds.includes(user.id));

  const addMembers = async () => {
    if (selectedIds.length === 0 || saving) return;
    setSaving(true);
    setError("");

    try {
      for (const userId of selectedIds) {
        const response = await fetch(`/api/chats/${chatId}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
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
            <p className="mt-1 text-xs text-gray-500">Добавлять может только создатель группы или администратор</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-dark-600 hover:text-white" aria-label="Закрыть">
            ✕
          </button>
        </div>

        {error && <div className="mx-3 mt-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}

        <div className="p-3 pb-0">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full px-4 py-2.5 bg-dark-700 border border-dark-500 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
            placeholder="Найти пользователя по @логину или имени…"
            autoFocus
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="p-6 text-center text-gray-500">Ищем…</div>
          ) : candidates.length === 0 && search.trim().length < MIN_SEARCH_LENGTH ? (
            <div className="p-6 text-center text-gray-500 text-sm leading-relaxed">
              Введите @логин или имя (от {MIN_SEARCH_LENGTH} символов) —
              <br />
              список всех пользователей намеренно скрыт.
            </div>
          ) : candidates.length === 0 ? (
            <div className="p-6 text-center text-gray-500">Никого не найдено</div>
          ) : (
            candidates.map((user) => {
              const selected = selectedIds.includes(user.id);
              return (
                <button
                  key={user.id}
                  disabled={saving}
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
            disabled={selectedIds.length === 0 || saving}
            className="w-full rounded-xl bg-purple-500 py-2.5 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-40"
          >
            {saving ? "Добавляем…" : `Добавить (${selectedIds.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
