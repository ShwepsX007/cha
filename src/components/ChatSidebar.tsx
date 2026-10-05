"use client";

import { useState } from "react";
import Link from "next/link";
import type { User, Chat } from "./ChatApp";
import Avatar from "./Avatar";
import NewChatModal from "./NewChatModal";

function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const dayMs = 86400000;

  if (diff < dayMs) {
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  if (diff < dayMs * 2) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function getLastMessagePreview(msg: Chat["lastMessage"]) {
  if (!msg) return "";
  if (msg.messageType === "text") return msg.content || "";
  if (msg.messageType === "image") return "📷 Фото";
  if (msg.messageType === "video") return "🎬 Видео";
  return `📎 ${msg.fileName || "Файл"}`;
}

export default function ChatSidebar({
  user,
  chats,
  selectedChatId,
  onSelectChat,
  onLogout,
  onChatsUpdated,
  onOpenProfileSettings,
}: {
  user: User;
  chats: Chat[];
  selectedChatId: number | null;
  onSelectChat: (chatId: number) => void;
  onLogout: () => void;
  onChatsUpdated: () => void;
  onOpenProfileSettings: () => void;
}) {
  const [showNewChat, setShowNewChat] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [deletingChatId, setDeletingChatId] = useState<number | null>(null);

  // Deleting is only offered for chats the user created (checked again on the
  // server); the general chat has no button at all.
  const deleteChat = async (chat: Chat) => {
    if (deletingChatId !== null) return;
    const what = chat.isGroup ? "группу" : "чат";
    if (!window.confirm(`Удалить ${what} «${chat.name}» со всеми сообщениями и файлами? Это необратимо и для остальных участников.`)) return;
    setDeletingChatId(chat.id);
    try {
      const response = await fetch(`/api/chats/${chat.id}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "Не удалось удалить чат");
      onChatsUpdated();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Не удалось удалить чат");
    } finally {
      setDeletingChatId(null);
    }
  };

  const filteredChats = chats.filter((c) =>
    c.name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      {/* Header */}
      <div className="p-4 border-b border-dark-600">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <Avatar src={user.avatarUrl} name={user.displayName} color={user.avatarColor} size={44} cacheKey={user.avatarUpdatedAt} />
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">{user.displayName}</div>
              <div className="text-xs text-gray-500 truncate">@{user.username}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onOpenProfileSettings}
              className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-dark-600 hover:text-purple-300"
              title="Настройки профиля"
              aria-label="Настройки профиля"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c1.756-.426 1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            {user.role === "admin" && (
              <Link
                href="/admin"
                className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-dark-600 hover:text-purple-300"
                title="Панель администратора"
                aria-label="Панель администратора"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3 4.5 6v5c0 4.9 3.2 8.1 7.5 10 4.3-1.9 7.5-5.1 7.5-10V6L12 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m9 12 2 2 4-4" />
                </svg>
              </Link>
            )}
            <button
              type="button"
              onClick={onLogout}
              className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-dark-600 hover:text-red-400"
              title="Выйти"
              aria-label="Выйти"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-dark-700 border border-dark-500 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-colors"
            placeholder="Поиск чатов..."
          />
        </div>
      </div>

      {/* New Chat Button */}
      <div className="p-3">
        <button
          onClick={() => setShowNewChat(true)}
          className="w-full py-2.5 bg-purple-500 hover:bg-purple-600 text-white font-medium rounded-xl transition-colors flex items-center justify-center gap-2 text-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Новый чат
        </button>
      </div>

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto">
        {filteredChats.length === 0 ? (
          <div className="p-6 text-center text-gray-500 text-sm">
            {chats.length === 0 ? "У вас пока нет чатов" : "Ничего не найдено"}
          </div>
        ) : (
          filteredChats.map((chat) => {
            const otherMember = chat.members.find((m) => m.id !== user.id);
            const canDelete = !chat.isGeneralChat
              && (chat.createdBy === user.id || user.role === "admin");
            return (
              <div
                key={chat.id}
                className={`group/chat relative w-full flex items-center gap-3 px-4 py-3 hover:bg-dark-700 transition-colors cursor-pointer ${
                  selectedChatId === chat.id ? "bg-dark-700 border-l-2 border-purple-500" : ""
                }`}
                onClick={() => onSelectChat(chat.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectChat(chat.id);
                  }
                }}
              >
                <Avatar
                  src={chat.isGroup ? chat.avatarUrl || null : otherMember?.avatarUrl || chat.avatarUrl || null}
                  name={chat.name || "?"}
                  color={otherMember?.avatarColor || "#6C5CE7"}
                  size={44}
                  cacheKey={chat.isGroup ? chat.avatarUpdatedAt || null : otherMember?.avatarUpdatedAt || chat.avatarUpdatedAt || null}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm truncate">{chat.name}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {chat.notificationsMuted && (
                        <svg className="h-3.5 w-3.5 text-amber-400/70" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-label="Уведомления отключены">
                          <title>Уведомления отключены</title>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0a3 3 0 11-6 0M3 3l18 18" />
                        </svg>
                      )}
                      {chat.lastMessage && (
                        <span className="text-xs text-gray-500">
                          {formatTime(chat.lastMessage.createdAt)}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 truncate mt-0.5">
                    {getLastMessagePreview(chat.lastMessage)}
                  </div>
                </div>
                {canDelete && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void deleteChat(chat);
                    }}
                    disabled={deletingChatId === chat.id}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-gray-500 opacity-0 transition group-hover/chat:opacity-100 hover:bg-red-500/15 hover:text-red-300 focus:opacity-100 disabled:opacity-40"
                    title={chat.isGroup ? "Удалить группу и все сообщения" : "Удалить чат и все сообщения"}
                    aria-label={`Удалить чат ${chat.name ?? chat.id}`}
                  >
                    {deletingChatId === chat.id ? (
                      <span className="block h-4 w-4 animate-spin rounded-full border-2 border-red-300 border-t-transparent" />
                    ) : (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* New Chat Modal */}
      {showNewChat && (
        <NewChatModal
          onClose={() => setShowNewChat(false)}
          onChatCreated={(chatId) => {
            setShowNewChat(false);
            onChatsUpdated();
            onSelectChat(chatId);
          }}
        />
      )}
    </>
  );
}
