"use client";

import { useState, useEffect } from "react";

interface AvailableUser {
  id: number;
  username: string;
  displayName: string;
  avatarColor: string;
  lastSeen: string | null;
}

export default function NewChatModal({
  onClose,
  onChatCreated,
}: {
  onClose: () => void;
  onChatCreated: (chatId: number) => void;
}) {
  const [users, setUsers] = useState<AvailableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetch("/api/users")
      .then((r) => r.json())
      .then((data) => {
        if (data.users) setUsers(data.users);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filteredUsers = users.filter(
    (u) =>
      u.username.toLowerCase().includes(search.toLowerCase()) ||
      u.displayName.toLowerCase().includes(search.toLowerCase())
  );

  const startChat = async (targetUserId: number) => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId }),
      });
      const data = await res.json();
      if (data.chat) {
        onChatCreated(data.chat.id);
      }
    } catch (err) {
      console.error("Failed to create chat:", err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-800 rounded-2xl border border-dark-600 w-full max-w-md max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-dark-600 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Новый чат</h3>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white rounded-lg hover:bg-dark-600"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="p-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-4 py-2.5 bg-dark-700 border border-dark-500 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
            placeholder="Найти пользователя..."
            autoFocus
          />
        </div>

        {/* User List */}
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="p-6 text-center text-gray-500">Загрузка...</div>
          ) : filteredUsers.length === 0 ? (
            <div className="p-6 text-center text-gray-500">
              {users.length === 0
                ? "Пока нет других пользователей"
                : "Никого не найдено"}
            </div>
          ) : (
            filteredUsers.map((u) => (
              <button
                key={u.id}
                onClick={() => startChat(u.id)}
                disabled={creating}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-dark-700 transition-colors text-left disabled:opacity-50"
              >
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-white text-sm shrink-0"
                  style={{ backgroundColor: u.avatarColor }}
                >
                  {u.displayName.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{u.displayName}</div>
                  <div className="text-xs text-gray-500">@{u.username}</div>
                </div>
                <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
