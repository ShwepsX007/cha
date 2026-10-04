"use client";

import { useState, useEffect } from "react";
import { createEncryptedRoom } from "@/lib/matrix/client";
import type { MatrixSession } from "@/lib/matrix/types";
import Avatar from "./Avatar";

interface AvailableUser {
  id: number;
  username: string;
  displayName: string;
  avatarColor: string;
  avatarUrl: string | null;
  lastSeen: string | null;
  matrixUserId: string | null;
}

interface CurrentUser {
  id: number;
  matrixSession?: MatrixSession | null;
}

export default function NewChatModal({
  currentUser,
  onClose,
  onChatCreated,
}: {
  currentUser: CurrentUser;
  onClose: () => void;
  onChatCreated: (chatId: number) => void;
}) {
  const [users, setUsers] = useState<AvailableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [groupMode, setGroupMode] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [groupName, setGroupName] = useState("");

  useEffect(() => {
    fetch("/api/users")
      .then((r) => r.json())
      .then((data) => {
        if (data.users) setUsers(data.users);
      })
      .catch(() => setError("Не удалось загрузить пользователей"))
      .finally(() => setLoading(false));
  }, []);

  const filteredUsers = users.filter(
    (u) =>
      u.username.toLowerCase().includes(search.toLowerCase()) ||
      u.displayName.toLowerCase().includes(search.toLowerCase()),
  );

  const createChat = async (memberUserIds: number[], isGroup: boolean) => {
    if (creating) return;
    setError("");

    const session = currentUser.matrixSession;
    if (!session) {
      setError("Matrix не подключён. Зашифрованные чаты пока недоступны.");
      return;
    }

    const targetUsers = memberUserIds
      .map((userId) => users.find((user) => user.id === userId))
      .filter((user): user is AvailableUser => Boolean(user));
    if (targetUsers.length !== memberUserIds.length || targetUsers.some((user) => !user.matrixUserId)) {
      setError("Не удалось подготовить Matrix-аккаунты участников. Попробуйте позже.");
      return;
    }

    const request = isGroup
      ? { isGroup: true, memberUserIds, name: groupName.trim() || "Приватная группа" }
      : { targetUserId: memberUserIds[0] };

    setCreating(true);
    try {
      const firstResponse = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const firstData = await firstResponse.json();
      if (!firstResponse.ok) {
        throw new Error(firstData.error || "Не удалось проверить чат");
      }

      if (firstData.chat && !firstData.requiresEncryptedRoom) {
        onChatCreated(firstData.chat.id);
        return;
      }

      const matrixRoomId = await createEncryptedRoom(session, {
        name: isGroup ? (groupName.trim() || "Приватная группа") : targetUsers[0].displayName,
        inviteUserIds: targetUsers.map((user) => user.matrixUserId as string),
        isDirect: !isGroup,
      });

      const response = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...request,
          matrixRoomId,
          matrixAccessToken: session.accessToken,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.chat) {
        throw new Error(data.error || "Не удалось сохранить зашифрованный чат");
      }
      onChatCreated(data.chat.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать зашифрованный чат");
    } finally {
      setCreating(false);
    }
  };

  const startChat = (targetUserId: number) => {
    if (groupMode) {
      setSelectedUserIds((current) =>
        current.includes(targetUserId)
          ? current.filter((userId) => userId !== targetUserId)
          : [...current, targetUserId],
      );
      return;
    }
    void createChat([targetUserId], false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-dark-800 rounded-2xl border border-dark-600 w-full max-w-md max-h-[80vh] flex flex-col">
        <div className="p-4 border-b border-dark-600 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">{groupMode ? "Новая приватная группа" : "Новый личный чат"}</h3>
            <p className="text-xs text-gray-500 mt-1">Комната Matrix создаётся с E2EE до первого сообщения</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-white rounded-lg hover:bg-dark-600"
            aria-label="Закрыть"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 p-3 border-b border-dark-600">
          <button
            onClick={() => {
              setGroupMode(false);
              setSelectedUserIds([]);
              setError("");
            }}
            className={`py-2 rounded-lg text-sm ${!groupMode ? "bg-purple-500 text-white" : "bg-dark-700 text-gray-400"}`}
          >
            Личный чат
          </button>
          <button
            onClick={() => {
              setGroupMode(true);
              setError("");
            }}
            className={`py-2 rounded-lg text-sm ${groupMode ? "bg-purple-500 text-white" : "bg-dark-700 text-gray-400"}`}
          >
            Группа
          </button>
        </div>

        {groupMode && (
          <div className="px-3 pt-3">
            <input
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              maxLength={100}
              className="w-full px-4 py-2.5 bg-dark-700 border border-dark-500 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
              placeholder="Название группы"
            />
            <p className="text-xs text-gray-500 mt-1">Выберите не менее двух участников</p>
          </div>
        )}

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

        {error && (
          <div className="mx-3 mb-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-300 text-sm">
            {error}
          </div>
        )}

        {!currentUser.matrixSession && (
          <div className="mx-3 mb-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-200 text-sm">
            Matrix E2EE ещё не настроено или недоступно. Личные сообщения не будут отправляться открытым текстом.
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="p-6 text-center text-gray-500">Загрузка...</div>
          ) : filteredUsers.length === 0 ? (
            <div className="p-6 text-center text-gray-500">
              {users.length === 0 ? "Пока нет других пользователей" : "Никого не найдено"}
            </div>
          ) : (
            filteredUsers.map((user) => (
              <button
                key={user.id}
                onClick={() => startChat(user.id)}
                disabled={creating || !currentUser.matrixSession || !user.matrixUserId}
                className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-dark-700 transition-colors text-left disabled:opacity-50 ${groupMode && selectedUserIds.includes(user.id) ? "bg-purple-500/20" : ""}`}
              >
                <Avatar src={user.avatarUrl} name={user.displayName} color={user.avatarColor} size={40} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{user.displayName}</div>
                  <div className="text-xs text-gray-500">@{user.username}</div>
                </div>
                {creating ? (
                  <div className="w-5 h-5 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                ) : groupMode ? (
                  <span className="w-6 h-6 rounded-full border border-purple-400 text-purple-300 flex items-center justify-center">
                    {selectedUserIds.includes(user.id) ? "✓" : "+"}
                  </span>
                ) : (
                  <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8s-9-3.582-9-8 4.03-8 9-8 9 3.582 9 8z" />
                  </svg>
                )}
              </button>
            ))
          )}
        </div>

        {groupMode && (
          <div className="p-3 border-t border-dark-600">
            <button
              onClick={() => void createChat(selectedUserIds, true)}
              disabled={creating || selectedUserIds.length < 2 || !currentUser.matrixSession}
              className="w-full py-2.5 bg-purple-500 hover:bg-purple-600 disabled:opacity-40 text-white rounded-xl font-medium text-sm"
            >
              {creating ? "Создаём зашифрованную группу…" : `Создать группу (${selectedUserIds.length})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
