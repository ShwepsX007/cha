"use client";

import { useState, useEffect, useCallback } from "react";
import ChatSidebar from "./ChatSidebar";
import ChatWindow from "./ChatWindow";

export interface User {
  id: number;
  username: string;
  displayName: string;
  avatarColor?: string;
  lastSeen?: string;
}

export interface ChatMessage {
  id: number;
  chatId: number;
  senderId: number;
  content: string | null;
  messageType: string;
  telegramFileId: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: string;
  senderUsername: string;
  senderDisplayName: string;
  senderAvatarColor: string;
}

export interface Chat {
  id: number;
  name: string;
  isGroup: boolean;
  members: User[];
  lastMessage: {
    id: number;
    content: string | null;
    messageType: string;
    fileName: string | null;
    senderId: number;
    createdAt: string;
  } | null;
  messageCount: number;
}

export default function ChatApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);

  const loadChats = useCallback(async () => {
    try {
      const res = await fetch("/api/chats");
      const data = await res.json();
      if (data.chats) setChats(data.chats);
    } catch (err) {
      console.error("Failed to load chats:", err);
    }
  }, []);

  useEffect(() => {
    loadChats();
    const interval = setInterval(loadChats, 3000);
    return () => clearInterval(interval);
  }, [loadChats]);

  const handleSelectChat = (chatId: number) => {
    setSelectedChatId(chatId);
    if (window.innerWidth < 768) {
      setShowSidebar(false);
    }
  };

  const handleBack = () => {
    setShowSidebar(true);
    setSelectedChatId(null);
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    onLogout();
  };

  const selectedChat = chats.find((c) => c.id === selectedChatId) || null;

  return (
    <div className="h-screen flex bg-dark-900 overflow-hidden">
      {/* Sidebar */}
      <div
        className={`${
          showSidebar ? "flex" : "hidden"
        } md:flex flex-col w-full md:w-80 lg:w-96 border-r border-dark-600 bg-dark-800 shrink-0`}
      >
        <ChatSidebar
          user={user}
          chats={chats}
          selectedChatId={selectedChatId}
          onSelectChat={handleSelectChat}
          onLogout={handleLogout}
          onChatsUpdated={loadChats}
        />
      </div>

      {/* Chat Window */}
      <div className={`${!showSidebar || selectedChatId ? "flex" : "hidden"} md:flex flex-col flex-1 min-w-0`}>
        {selectedChat ? (
          <ChatWindow
            chat={selectedChat}
            currentUser={user}
            onBack={handleBack}
            onMessageSent={loadChats}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-dark-900">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-24 h-24 bg-dark-700 rounded-full mb-4">
                <svg className="w-12 h-12 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-gray-400">Secret Chat</h3>
              <p className="text-gray-600 mt-2">Выберите чат или начните новый разговор</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
