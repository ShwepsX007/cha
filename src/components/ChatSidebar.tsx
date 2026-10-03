"use client";

import { useState } from "react";
import type { User, Chat } from "./ChatApp";
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

function Avatar({ name, color, size = "md" }: { name: string; color?: string; size?: "sm" | "md" | "lg" }) {
  const sizes = { sm: "w-8 h-8 text-xs", md: "w-11 h-11 text-sm", lg: "w-14 h-14 text-lg" };
  const initial = name.charAt(0).toUpperCase();
  return (
    <div
      className={`${sizes[size]} rounded-full flex items-center justify-center font-bold text-white shrink-0`}
      style={{ backgroundColor: color || "#6C5CE7" }}
    >
      {initial}
    </div>
  );
}

export default function ChatSidebar({
  user,
  chats,
  selectedChatId,
  onSelectChat,
  onLogout,
  onChatsUpdated,
}: {
  user: User;
  chats: Chat[];
  selectedChatId: number | null;
  onSelectChat: (chatId: number) => void;
  onLogout: () => void;
  onChatsUpdated: () => void;
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
            <Avatar name={user.displayName} color={user.avatarColor} />
            <div>
              <div className="font-semibold text-sm">{user.displayName}</div>
              <div className="text-xs text-gray-500">@{user.username}</div>
            </div>
          </div>
          <button
            onClick={onLogout}
            className="p-2 text-gray-500 hover:text-red-400 rounded-lg hover:bg-dark-600 transition-colors"
            title="Выйти"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
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
            return (
              <button
                key={chat.id}
                onClick={() => onSelectChat(chat.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-dark-700 transition-colors text-left ${
                  selectedChatId === chat.id ? "bg-dark-700 border-l-2 border-purple-500" : ""
                }`}
              >
                <Avatar
                  name={chat.name || "?"}
                  color={otherMember?.avatarColor || "#6C5CE7"}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm truncate">{chat.name}</span>
                    {chat.lastMessage && (
                      <span className="text-xs text-gray-500 shrink-0 ml-2">
                        {formatTime(chat.lastMessage.createdAt)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 truncate mt-0.5">
                    {getLastMessagePreview(chat.lastMessage)}
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
