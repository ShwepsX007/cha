"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import ChatSidebar from "./ChatSidebar";
import ChatWindow from "./ChatWindow";
import { ensurePushSubscription, registerServiceWorker } from "@/lib/push-client";

const ProfileSettingsModal = dynamic(() => import("./ProfileSettingsModal"), { ssr: false });

export interface User {
  id: number;
  username: string;
  displayName: string;
  avatarColor?: string;
  avatarUrl?: string | null;
  avatarUpdatedAt?: string | null;
  lastSeen?: string;
  role?: "user" | "admin";
  bannedUntil?: string | null;
  banReason?: string | null;
  pushEnabled?: boolean;
}

export interface ChatMessageReply {
  id: number | string;
  senderId: number | string;
  senderDisplayName: string;
  senderUsername?: string;
  content: string | null;
  messageType: string;
  fileName?: string | null;
}

export interface ChatMessage {
  id: number | string;
  chatId: number;
  senderId: number | string;
  content: string | null;
  messageType: string;
  telegramFileId: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: string;
  deliveryStatus?: "sent" | "delivered" | "read";
  replyTo?: ChatMessageReply | null;
  readByCount?: number;
  deliveredToCount?: number;
  recipientCount?: number;
  senderUsername: string;
  senderDisplayName: string;
  senderAvatarColor: string;
  senderAvatarUrl?: string | null;
}

export interface Chat {
  id: number;
  name: string;
  isGroup: boolean;
  isGeneralChat: boolean;
  createdBy: number | null;
  avatarUrl?: string | null;
  avatarUpdatedAt?: string | null;
  members: User[];
  notificationsMuted?: boolean;
  lastMessage: {
    id: number;
    content: string | null;
    messageType: string;
    fileName: string | null;
    senderId: number;
    senderDisplayName: string;
    senderAvatarColor: string;
    senderAvatarUrl: string | null;
    createdAt: string;
  } | null;
  messageCount: number;
}

export default function ChatApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  const [currentUserState, setCurrentUserState] = useState<User>(user);

  useEffect(() => {
    setCurrentUserState(user);
  }, [user]);

  useEffect(() => {
    void registerServiceWorker();
    // Refresh the browser↔server push pairing on every start. Endpoints rotate
    // in the browser and the server prunes them after a `410 Gone`; without
    // this, notifications silently die days after they last worked.
    void ensurePushSubscription();
    // Listen for SW-triggered navigation from push notifications.
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      const onMessage = (event: MessageEvent) => {
        const data = event?.data;
        if (data && data.type === "chata-open-chat") {
          // The chat ID query opens the conversation even if another chat is active.
          window.location.href = data.url || "/";
        }
      };
      navigator.serviceWorker.addEventListener("message", onMessage);
      return () => navigator.serviceWorker.removeEventListener("message", onMessage);
    }
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* fall through to the local logout regardless */
    }
    onLogout();
  }, [onLogout]);

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
    const initialLoad = window.setTimeout(loadChats, 0);
    const interval = window.setInterval(loadChats, 3000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadChats]);

  useEffect(() => {
    if (chats.length === 0) return;
    const url = new URL(window.location.href);
    const requestedChatId = Number(url.searchParams.get("chatId"));
    if (!Number.isInteger(requestedChatId) || requestedChatId <= 0) return;
    if (!chats.some((chat) => chat.id === requestedChatId)) return;
    setSelectedChatId(requestedChatId);
  }, [chats]);

  const handleSelectChat = (chatId: number) => {
    setSelectedChatId(chatId);
    const url = new URL(window.location.href);
    url.searchParams.set("chatId", String(chatId));
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    if (window.innerWidth < 768) {
      setShowSidebar(false);
    }
  };

  const handleBack = () => {
    setShowSidebar(true);
    setSelectedChatId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("chatId");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const selectedChat = chats.find((c) => c.id === selectedChatId) || null;

  return (
    <>
    <div className="flex h-[100dvh] min-h-0 overflow-hidden bg-dark-900">
      {/* Sidebar */}
      <div
        className={`${
          showSidebar ? "flex" : "hidden"
        } md:flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden border-r border-dark-600 bg-dark-800 md:h-auto md:w-80 lg:w-96`}
      >
        <ChatSidebar
          user={currentUserState}
          chats={chats}
          selectedChatId={selectedChatId}
          onSelectChat={handleSelectChat}
          onLogout={handleLogout}
          onChatsUpdated={loadChats}
          onOpenProfileSettings={() => setShowProfileSettings(true)}
        />
      </div>

      {/* Chat Window */}
      <div className={`${!showSidebar || selectedChatId ? "flex" : "hidden"} md:flex h-[100dvh] min-h-0 flex-1 flex-col overflow-hidden md:h-auto`}>
        {selectedChat ? (
          <ChatWindow
            chat={selectedChat}
            currentUser={currentUserState}
            onBack={handleBack}
            onMessageSent={loadChats}
            onDeleteChat={() => {
              // The chat row is gone server-side; drop the local selection and
              // the sidebar poll will remove it from the list.
              setChats((prev) => prev.filter((c) => c.id !== selectedChat.id));
              setSelectedChatId(null);
              const url = new URL(window.location.href);
              url.searchParams.delete("chatId");
              window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
              void loadChats();
            }}
            onChatUpdated={(patch) => {
              if (!selectedChat) return;
              setChats((prev) => prev.map((c) => c.id === selectedChat.id ? { ...c, ...patch } : c));
            }}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-dark-900">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-24 h-24 bg-dark-700 rounded-full mb-4">
                <svg className="w-12 h-12 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-gray-400">Chata</h3>
              <p className="text-gray-600 mt-2">Выберите чат или начните новый разговор</p>
            </div>
          </div>
        )}
      </div>
    </div>
    {showProfileSettings && (
      <ProfileSettingsModal
        user={currentUserState}
        onClose={() => setShowProfileSettings(false)}
        onProfileUpdated={(updated) => {
          setCurrentUserState((prev) => ({ ...prev, ...updated }));
        }}
      />
    )}
    </>
  );
}
