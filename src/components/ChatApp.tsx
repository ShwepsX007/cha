"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import ChatSidebar from "./ChatSidebar";
import ChatWindow from "./ChatWindow";

const DeviceSecurityModal = dynamic(() => import("./DeviceSecurityModal"), { ssr: false });
const ProfileSettingsModal = dynamic(() => import("./ProfileSettingsModal"), { ssr: false });
import { ClientEvent, SyncState } from "matrix-js-sdk";
import {
  clearLocalMatrixCryptoStores,
  drainEncryptedOutbox,
  getAutomaticRecoveryNotice,
  getMatrixClient,
  joinRoomIfInvited,
  MATRIX_RECOVERY_EVENT,
  stopMatrixClient,
  waitForMatrixSync,
  type MatrixRecoveryNotice,
} from "@/lib/matrix/client";
import type { IEncryptedFile } from "matrix-encrypt-attachment";
import type { MatrixAvailability, MatrixSession } from "@/lib/matrix/types";

export interface User {
  id: number;
  username: string;
  displayName: string;
  avatarColor?: string;
  avatarUrl?: string | null;
  lastSeen?: string;
  role?: "user" | "admin";
  bannedUntil?: string | null;
  banReason?: string | null;
  matrixResetRequired?: boolean;
  matrixAvailability?: MatrixAvailability;
  matrixSession?: MatrixSession | null;
  initialRecoveryKey?: string | null;
  initialRecoveryKeySaved?: boolean;
  matrixNotice?: string;
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
  deliveryStatus?: "sending" | "sent" | "error";
  deliveryError?: string;
  outboxId?: string;
  matrixEventId?: string;
  senderUsername: string;
  senderDisplayName: string;
  senderAvatarColor: string;
  senderAvatarUrl?: string | null;
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
    senderDisplayName: string;
    senderAvatarColor: string;
    senderAvatarUrl: string | null;
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
  const [showDeviceSecurity, setShowDeviceSecurity] = useState(Boolean(user.initialRecoveryKey));
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  const [initialRecoveryKey, setInitialRecoveryKey] = useState(user.initialRecoveryKey || null);
  const [initialRecoveryKeySaved, setInitialRecoveryKeySaved] = useState(Boolean(user.initialRecoveryKeySaved));
  const [currentUserState, setCurrentUserState] = useState<User>(user);

  useEffect(() => {
    setCurrentUserState(user);
  }, [user]);
  const [automaticRecoveryNotice, setAutomaticRecoveryNotice] = useState<MatrixRecoveryNotice | null>(
    () => user.matrixSession ? getAutomaticRecoveryNotice(user.matrixSession.userId) : null,
  );

  const handleLogout = useCallback(async () => {
    try {
      await stopMatrixClient(true);
    } catch {
      console.error("Matrix logout failed");
    }
    sessionStorage.removeItem("chata_matrix_session");
    sessionStorage.removeItem("chata_matrix_availability");
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  }, [onLogout]);

  const handleFatalMatrixReset = useCallback(async () => {
    try {
      await stopMatrixClient(true);
      await clearLocalMatrixCryptoStores(currentUserState.id);
      await fetch("/api/auth/matrix-reset", { method: "POST", cache: "no-store" }).catch(() => undefined);
    } catch {
      console.error("Fatal matrix reset failed");
    }
    sessionStorage.removeItem("chata_matrix_session");
    sessionStorage.removeItem("chata_matrix_availability");
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  }, [onLogout, currentUserState.id]);

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
    if (!currentUserState.matrixSession) return;
    const session = currentUserState.matrixSession;
    const onRecoveryUpdate = (event: Event) => {
      const detail = (event as CustomEvent<MatrixRecoveryNotice & { userId: string }>).detail;
      if (detail?.userId === session.userId) {
        setAutomaticRecoveryNotice({ status: detail.status, message: detail.message });
      }
    };
    window.addEventListener(MATRIX_RECOVERY_EVENT, onRecoveryUpdate);
    return () => window.removeEventListener(MATRIX_RECOVERY_EVENT, onRecoveryUpdate);
  }, [currentUserState.matrixSession]);

  useEffect(() => {
    if (!currentUserState.matrixSession) return;
    const session = currentUserState.matrixSession;
    let cancelled = false;
    let matrixClient: Awaited<ReturnType<typeof getMatrixClient>> | null = null;
    const onSync = (state: SyncState, previousState: SyncState | null) => {
      if (cancelled) return;
      if (state === SyncState.Error || state === SyncState.Stopped) {
        setMatrixState("unavailable");
        return;
      }
      if (state === SyncState.Prepared || state === SyncState.Syncing || state === SyncState.Catchup) {
        setMatrixState("connected");
      }
      if (
        state === SyncState.Prepared ||
        state === SyncState.Catchup ||
        (state === SyncState.Syncing && (previousState === SyncState.Reconnecting || previousState === SyncState.Error))
      ) {
        void drainEncryptedOutbox(session).catch(() => undefined);
      }
    };

    void getMatrixClient(session)
      .then(async (client) => {
        if (cancelled) return;
        matrixClient = client;
        client.on(ClientEvent.Sync, onSync);
        await waitForMatrixSync(client);
        if (cancelled) return;
        setMatrixState("connected");
        void drainEncryptedOutbox(session).catch(() => undefined);
      })
      .catch((error) => {
        const errorType = error instanceof Error ? error.name : "Unknown Matrix sync error";
        const fatalCryptoError = error instanceof Error && /unknown device|corrupted|indexeddb|crypto store|decryption|key error|invalid session/i.test(error.message);
        console.error("Matrix client unavailable:", errorType);
        if (cancelled) return;
        setMatrixState("unavailable");
        if (fatalCryptoError) void handleFatalMatrixReset();
      });

    return () => {
      cancelled = true;
      if (matrixClient) matrixClient.removeListener(ClientEvent.Sync, onSync);
    };
  }, [handleFatalMatrixReset, currentUserState.matrixSession]);

  useEffect(() => {
    if (!currentUserState.matrixSession) return;

    let cancelled = false;
    const roomIds = chats
      .filter((chat) => chat.securityMode === "e2ee" && chat.matrixRoomId)
      .map((chat) => chat.matrixRoomId as string);

    for (const roomId of roomIds) {
      joinRoomIfInvited(currentUserState.matrixSession, roomId).catch((error) => {
        if (!cancelled) console.error("Failed to accept Matrix room invitation:", error);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [chats, currentUserState.matrixSession]);

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
          matrixState={matrixState}
          matrixNotice={automaticRecoveryNotice?.message || currentUserState.matrixNotice}
          onOpenDeviceSecurity={() => setShowDeviceSecurity(true)}
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
    {showDeviceSecurity && currentUserState.matrixSession && (
      <DeviceSecurityModal
        session={currentUserState.matrixSession}
        initialRecoveryKey={initialRecoveryKey}
        initialRecoveryKeySaved={initialRecoveryKeySaved}
        onClose={() => {
          setShowDeviceSecurity(false);
          setInitialRecoveryKey(null);
          setInitialRecoveryKeySaved(false);
        }}
      />
    )}
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
