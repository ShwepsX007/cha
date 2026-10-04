"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import ChatSidebar from "./ChatSidebar";
import ChatWindow from "./ChatWindow";

const DeviceSecurityModal = dynamic(() => import("./DeviceSecurityModal"), { ssr: false });
import { getMatrixClient, joinRoomIfInvited, stopMatrixClient, waitForMatrixSync } from "@/lib/matrix/client";
import type { IEncryptedFile } from "matrix-encrypt-attachment";
import type { MatrixAvailability, MatrixSession } from "@/lib/matrix/types";

export interface User {
  id: number;
  username: string;
  displayName: string;
  avatarColor?: string;
  lastSeen?: string;
  matrixAvailability?: MatrixAvailability;
  matrixSession?: MatrixSession | null;
}

export interface ChatMessage {
  id: number | string;
  chatId: number;
  senderId: number | string;
  isLegacy?: boolean;
  content: string | null;
  messageType: string;
  telegramFileId: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  encryptedAttachment?: IEncryptedFile & { url: string };
  createdAt: string;
  senderUsername: string;
  senderDisplayName: string;
  senderAvatarColor: string;
}

export interface Chat {
  id: number;
  name: string;
  isGroup: boolean;
  securityMode: "public" | "legacy" | "e2ee";
  matrixRoomId: string | null;
  e2eeEnabledAt: string | null;
  createdBy: number | null;
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
  const [matrixState, setMatrixState] = useState<"checking" | "connected" | "not_configured" | "unavailable">(
    user.matrixSession
      ? "checking"
      : user.matrixAvailability === "not_configured"
        ? "not_configured"
        : "unavailable",
  );
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showDeviceSecurity, setShowDeviceSecurity] = useState(false);

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
    if (!user.matrixSession) return;

    let cancelled = false;
    getMatrixClient(user.matrixSession)
      .then(waitForMatrixSync)
      .then(() => {
        if (!cancelled) setMatrixState("connected");
      })
      .catch((error) => {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown Matrix sync error";
        console.error("Matrix client unavailable:", detail);
        if (!cancelled) setMatrixState("unavailable");
      });

    return () => {
      cancelled = true;
    };
  }, [user.matrixAvailability, user.matrixSession]);

  useEffect(() => {
    if (!user.matrixSession) return;

    let cancelled = false;
    const roomIds = chats
      .filter((chat) => chat.securityMode === "e2ee" && chat.matrixRoomId)
      .map((chat) => chat.matrixRoomId as string);

    for (const roomId of roomIds) {
      joinRoomIfInvited(user.matrixSession, roomId).catch((error) => {
        if (!cancelled) console.error("Failed to accept Matrix room invitation:", error);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [chats, user.matrixSession]);

  useEffect(() => {
    const initialLoad = window.setTimeout(loadChats, 0);
    const interval = window.setInterval(loadChats, 3000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
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
    try {
      await stopMatrixClient(true);
    } catch {
      console.error("Matrix logout failed");
    }
    sessionStorage.removeItem("chata_matrix_session");
    sessionStorage.removeItem("chata_matrix_availability");
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  };

  const selectedChat = chats.find((c) => c.id === selectedChatId) || null;

  return (
    <>
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
          matrixState={matrixState}
          onOpenDeviceSecurity={() => setShowDeviceSecurity(true)}
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
    {showDeviceSecurity && user.matrixSession && (
      <DeviceSecurityModal
        session={user.matrixSession}
        onClose={() => setShowDeviceSecurity(false)}
      />
    )}
    </>
  );
}
