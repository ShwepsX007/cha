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

function getLastMessagePreview(msg: Chat["lastMessage"], securityMode: Chat["securityMode"]) {
  if (!msg) return "";
  const preview = msg.messageType === "text"
    ? msg.content || ""
    : msg.messageType === "image"
      ? "📷 Фото"
      : msg.messageType === "video"
        ? "🎬 Видео"
        : `📎 ${msg.fileName || "Файл"}`;
  if (securityMode === "e2ee") return "🔒 Новые сообщения Matrix E2EE";
  return securityMode === "public" ? preview : `Legacy · ${preview}`;
}

export default function ChatSidebar({
  user,
  chats,
  selectedChatId,
  onSelectChat,
  onLogout,
  onChatsUpdated,
  matrixState,
  matrixNotice,
  onOpenDeviceSecurity,
  onOpenProfileSettings,
}: {
  user: User;
  chats: Chat[];
  selectedChatId: number | null;
  onSelectChat: (chatId: number) => void;
  onLogout: () => void;
  onChatsUpdated: () => void;
  matrixState: "checking" | "connected" | "not_configured" | "unavailable";
  matrixNotice?: string;
  onOpenDeviceSecurity: () => void;
  onOpenProfileSettings: () => void;
}) {
  const [showNewChat, setShowNewChat] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredChats = chats.filter((c) =>
    c.name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      {/* Header */}
      <div className="p-4 border-b border-dark-600">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Avatar src={user.avatarUrl} name={user.displayName} color={user.avatarColor} size={44} cacheKey={user.avatarUpdatedAt} />
            <div>
              <div className="font-semibold text-sm">{user.displayName}</div>
              <div className="text-xs text-gray-500">@{user.username}</div>
              <div
                className={`mt-1 text-[10px] leading-tight ${
                  matrixState === "connected" ? "text-amber-400" : "text-gray-500"
                }`}
                title={
                  matrixState === "unavailable"
                    ? user.matrixSession
                      ? "Matrix-сессия есть, но синхронизация не прошла. Проверьте подключение; если не поможет, выйдите и войдите снова. Не очищайте данные сайта: там хранятся ключи устройства."
                      : "В этой вкладке нет Matrix-сессии. Выйдите из аккаунта и войдите снова, чтобы восстановить её. Не очищайте данные сайта: там хранятся ключи устройства."
                    : matrixState === "not_configured"
                      ? "На сервере не настроен Matrix; личные чаты E2EE недоступны."
                      : "E2EE пока не включено для отправки новых личных сообщений"
                }
              >
                {matrixState === "connected"
                  ? "Matrix подключён · E2EE активно в личных чатах"
                  : matrixState === "checking"
                    ? "Проверка Matrix…"
                    : matrixState === "not_configured"
                      ? "E2EE не настроено на сервере"
                      : !user.matrixSession
                        ? "Нет Matrix-сессии · выйдите и войдите снова"
                        : "Matrix не синхронизируется · выйдите и войдите снова"}
              </div>
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
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onOpenDeviceSecurity}
              disabled={!user.matrixSession}
              className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-dark-600 hover:text-purple-300 disabled:cursor-not-allowed disabled:opacity-40"
              title="Ключи и устройства Matrix"
              aria-label="Ключи и устройства Matrix"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
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
        {matrixNotice && (
          <div role="status" className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            {matrixNotice}
          </div>
        )}

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
            return (
              <button
                key={chat.id}
                onClick={() => onSelectChat(chat.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-dark-700 transition-colors text-left ${
                  selectedChatId === chat.id ? "bg-dark-700 border-l-2 border-purple-500" : ""
                }`}
              >
                <Avatar
                  src={chat.isGroup ? null : otherMember?.avatarUrl || null}
                  name={chat.name || "?"}
                  color={otherMember?.avatarColor || "#6C5CE7"}
                  size={44}
                  cacheKey={chat.isGroup ? null : otherMember?.avatarUpdatedAt || null}
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
                    {getLastMessagePreview(chat.lastMessage, chat.securityMode)}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* New Chat Modal */}
      {showNewChat && (
        <NewChatModal
          currentUser={user}
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
