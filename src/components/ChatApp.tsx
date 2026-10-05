"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import ChatSidebar from "./ChatSidebar";
import ChatWindow from "./ChatWindow";
import { ensurePushSubscription, registerServiceWorker } from "@/lib/push-client";

const DeviceSecurityModal = dynamic(() => import("./DeviceSecurityModal"), { ssr: false });
const ProfileSettingsModal = dynamic(() => import("./ProfileSettingsModal"), { ssr: false });
const MatrixSessionRecoveryModal = dynamic(() => import("./MatrixSessionRecoveryModal"), { ssr: false });
import { ClientEvent, SyncState } from "matrix-js-sdk";
import {
  clearLocalMatrixCryptoStores,
  drainEncryptedOutbox,
  getAutomaticRecoveryNotice,
  getMatrixClient,
  isFatalMatrixCryptoError,
  joinRoomIfInvited,
  MATRIX_RECOVERY_EVENT,
  restartMatrixClient,
  stopMatrixClient,
  waitForMatrixSync,
  type MatrixRecoveryNotice,
} from "@/lib/matrix/client";
import type { IEncryptedFile } from "matrix-encrypt-attachment";
import type { MatrixAvailability, MatrixSession } from "@/lib/matrix/types";
import { recoverMatrixSession } from "@/lib/matrix/recover-session";
import {
  clearMatrixSession,
  loadMatrixSession,
  refreshMatrixSessionFromServer,
  subscribeToMatrixSessionChanges,
} from "@/lib/matrix/session-store";

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
  matrixResetRequired?: boolean;
  pushEnabled?: boolean;
  matrixAvailability?: MatrixAvailability;
  matrixSession?: MatrixSession | null;
  initialRecoveryKey?: string | null;
  initialRecoveryKeySaved?: boolean;
  matrixNotice?: string;
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
  isLegacy?: boolean;
  content: string | null;
  messageType: string;
  telegramFileId: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  encryptedAttachment?: IEncryptedFile & { url: string };
  createdAt: string;
  deliveryStatus?: "sending" | "sent" | "delivered" | "read" | "error";
  deliveryError?: string;
  replyTo?: ChatMessageReply | null;
  readByCount?: number;
  deliveredToCount?: number;
  recipientCount?: number;
  mentionUserIds?: string[];
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
  const [showMatrixRecovery, setShowMatrixRecovery] = useState(false);
  // Set only when the *local* crypto store itself is unusable; it unlocks the
  // manual "reset Matrix identity" action instead of running it automatically.
  const [matrixIdentityResetNeeded, setMatrixIdentityResetNeeded] = useState(false);
  const [initialRecoveryKey, setInitialRecoveryKey] = useState(user.initialRecoveryKey || null);
  const [initialRecoveryKeySaved, setInitialRecoveryKeySaved] = useState(Boolean(user.initialRecoveryKeySaved));
  const [currentUserState, setCurrentUserState] = useState<User>(user);

  useEffect(() => {
    setCurrentUserState(user);
  }, [user]);
  const [automaticRecoveryNotice, setAutomaticRecoveryNotice] = useState<MatrixRecoveryNotice | null>(
    () => user.matrixSession ? getAutomaticRecoveryNotice(user.matrixSession.userId) : null,
  );

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
      await stopMatrixClient(true);
    } catch {
      console.error("Matrix logout failed");
    }
    clearMatrixSession();
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  }, [onLogout]);

  /**
   * Destroys the E2EE identity of this app account on purpose: it is the last
   * resort when the local crypto store is genuinely unreadable. It used to run
   * automatically from a broad error pattern, which turned ordinary reloads into
   * a permanent Matrix outage (revoked devices + deleted keys + a sticky reset
   * flag). It is now only reachable from the sidebar button.
   */
  const handleResetMatrixIdentity = useCallback(async () => {
    try {
      await stopMatrixClient(true);
      await clearLocalMatrixCryptoStores(currentUserState.id);
      await fetch("/api/auth/matrix-reset", { method: "POST", cache: "no-store" }).catch(() => undefined);
    } catch {
      console.error("Matrix identity reset failed");
    }
    clearMatrixSession(currentUserState.id);
    setMatrixIdentityResetNeeded(false);
    setCurrentUserState((current) => ({ ...current, matrixSession: null, matrixResetRequired: true }));
    setMatrixState("unavailable");
    setShowMatrixRecovery(true);
  }, [currentUserState.id]);

  const handleRecoverMatrixSession = useCallback(async (password: string) => {
    // Stop the old SDK instance before re-authenticating this same device so
    // Rust crypto can reopen its existing IndexedDB without losing keys.
    await stopMatrixClient(false);
    const recovered = await recoverMatrixSession({
      username: currentUserState.username,
      appUserId: currentUserState.id,
      password,
      resetRequired: Boolean(currentUserState.matrixResetRequired),
    });

    setCurrentUserState((current) => ({
      ...current,
      matrixSession: recovered.session,
      matrixAvailability: "ready",
      matrixResetRequired: false,
      matrixNotice: undefined,
    }));
    setMatrixState("checking");
    try {
      await waitForMatrixSync(await getMatrixClient(recovered.session));
      setMatrixState("connected");
      setAutomaticRecoveryNotice({
        status: "restored",
        message: recovered.notice
          || "Matrix-сессия восстановлена на прежнем устройстве. Локальные ключи E2EE сохранены.",
      });
    } catch (error) {
      setMatrixState("unavailable");
      throw new Error(error instanceof Error ? error.message : "Matrix пока не синхронизируется");
    }
  }, [currentUserState.username, currentUserState.id, currentUserState.matrixResetRequired]);

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

  // Other tabs rotate the single-use refresh token; adopt their result so this
  // tab keeps a valid session (and a valid token for the E2EE push relay).
  useEffect(() => {
    return subscribeToMatrixSessionChanges(() => {
      const next = loadMatrixSession(user.id);
      if (!next) return;
      setCurrentUserState((current) => current.id === user.id && current.matrixSession?.accessToken !== next.accessToken
        ? { ...current, matrixSession: next, matrixAvailability: "ready" }
        : current);
    });
  }, [user.id]);

  // A revoked device still leaves a valid app session: open the one-field
  // recovery dialog instead of pushing the user back to the login screen.
  useEffect(() => {
    if (currentUserState.matrixResetRequired && !currentUserState.matrixSession) {
      setShowMatrixRecovery(true);
    }
  }, [currentUserState.matrixResetRequired, currentUserState.matrixSession]);

  useEffect(() => {
    if (!currentUserState.matrixSession) return;
    const session = currentUserState.matrixSession;
    let cancelled = false;
    let matrixClient: Awaited<ReturnType<typeof getMatrixClient>> | null = null;
    let recoveryTimer: number | null = null;
    let recoveryAttempts = 0;
    let recoveryInFlight = false;
    let refreshInFlight = false;
    // A rotation that the homeserver immediately rejects must not loop: two
    // silent attempts, then the user is asked for the password exactly once.
    let refreshAttempts = 0;

    const clearRecoveryTimer = () => {
      if (recoveryTimer !== null) {
        window.clearTimeout(recoveryTimer);
        recoveryTimer = null;
      }
    };

    const scheduleRestart = () => {
      if (cancelled || recoveryTimer !== null || recoveryInFlight || recoveryAttempts >= 4) return;
      const waitMs = Math.min(2_000 * (2 ** recoveryAttempts), 20_000);
      recoveryTimer = window.setTimeout(() => {
        recoveryTimer = null;
        recoveryInFlight = true;
        recoveryAttempts += 1;
        let restartFailed = false;
        void (async () => {
          const previousClient = matrixClient;
          if (previousClient) previousClient.removeListener(ClientEvent.Sync, onSync);
          const nextClient = await restartMatrixClient(session);
          if (cancelled) return;
          matrixClient = nextClient;
          nextClient.on(ClientEvent.Sync, onSync);
          await waitForMatrixSync(nextClient);
          if (cancelled) return;
          recoveryAttempts = 0;
          setMatrixState("connected");
          setAutomaticRecoveryNotice({ status: "restored", message: "Matrix-синхронизация восстановлена." });
          void drainEncryptedOutbox(session).catch(() => undefined);
        })().catch(() => {
          restartFailed = true;
          if (!cancelled) setMatrixState("unavailable");
        }).finally(() => {
          recoveryInFlight = false;
          if (restartFailed) scheduleRestart();
        });
      }, waitMs);
    };

    const handleUnknownToken = async () => {
      if (refreshInFlight || cancelled) return;
      if (refreshAttempts >= 2) {
        setMatrixState("unavailable");
        setAutomaticRecoveryNotice({
          status: "needs-recovery",
          message: "Matrix отказывается обновлять токен этого устройства. Введите пароль аккаунта в «Восстановить Matrix-сессию» — ключи E2EE останутся на месте.",
        });
        setShowMatrixRecovery(true);
        return;
      }
      refreshInFlight = true;
      refreshAttempts += 1;
      setMatrixState("checking");
      setAutomaticRecoveryNotice({ status: "restoring", message: "Обновляем Matrix-сессию…" });
      try {
        // Rotating through the app server (not the browser's own /refresh call)
        // keeps one authoritative copy of the single-use refresh token: it is
        // written to storage before the client restarts and broadcast to tabs.
        const nextSession = await refreshMatrixSessionFromServer(session);
        if (cancelled) return;
        if (!nextSession) {
          setMatrixState("unavailable");
          setAutomaticRecoveryNotice({
            status: "needs-recovery",
            message: "Matrix-сессия истекла, а сервер не выдал refresh token. Нажмите «Восстановить Matrix-сессию»; выходить из аккаунта не нужно, ключи сохранятся.",
          });
          setShowMatrixRecovery(true);
          return;
        }
        setCurrentUserState((current) => current.id === user.id
          ? { ...current, matrixSession: nextSession, matrixAvailability: "ready", matrixNotice: undefined }
          : current);
        // The SDK stops its sync loop on M_UNKNOWN_TOKEN, so the new token needs
        // an explicit restart; reusing the client keeps the crypto store open.
        try {
          await restartMatrixClient(nextSession);
          if (cancelled) return;
          setMatrixState("connected");
          setAutomaticRecoveryNotice({ status: "restored", message: "Matrix-сессия автоматически обновлена." });
        } catch {
          if (cancelled) return;
          setMatrixState("unavailable");
          setAutomaticRecoveryNotice({
            status: "needs-recovery",
            message: "Токен обновлён, но синхронизация Matrix ещё не восстановилась. Обновите страницу или нажмите «Восстановить Matrix-сессию».",
          });
        }
      } catch (error) {
        if (!cancelled) {
          setMatrixState("unavailable");
          setAutomaticRecoveryNotice({
            status: "needs-recovery",
            message: error instanceof Error
              ? `${error.message} Нажмите «Восстановить Matrix-сессию»; локальные ключи сохранятся.`
              : "Не удалось обновить Matrix-сессию. Нажмите «Восстановить Matrix-сессию»; локальные ключи сохранятся.",
          });
          setShowMatrixRecovery(true);
        }
      } finally {
        refreshInFlight = false;
      }
    };

    const onSync = (
      state: SyncState,
      previousState: SyncState | null,
      data?: { error?: unknown },
    ) => {
      if (cancelled) return;
      if (state === SyncState.Error || state === SyncState.Stopped) {
        setMatrixState("unavailable");
        const error = data?.error;
        const errcode = error && typeof error === "object" && "errcode" in error
          ? (error as { errcode?: unknown }).errcode
          : undefined;
        if (errcode === "M_UNKNOWN_TOKEN") {
          void handleUnknownToken();
        } else if (isFatalMatrixCryptoError(error)) {
          // Surface it and let the user decide; never wipe keys by itself.
          const detail = error instanceof Error ? error.message : "crypto store error";
          setMatrixIdentityResetNeeded(true);
          setAutomaticRecoveryNotice({
            status: "needs-recovery",
            message: `Локальное хранилище ключей Matrix недоступно (${detail}). Закройте другие вкладки `
              + "с приложением и нажмите «Восстановить Matrix-сессию». Полный сброс идентичности нужен "
              + "только если ключи действительно повреждены.",
          });
        } else {
          scheduleRestart();
        }
        return;
      }
      if (state === SyncState.Prepared || state === SyncState.Syncing || state === SyncState.Catchup) {
        clearRecoveryTimer();
        recoveryAttempts = 0;
        refreshAttempts = 0;
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
      .catch(async (error) => {
        const errorType = error instanceof Error ? error.name : "Unknown Matrix sync error";
        console.error("Matrix client unavailable:", errorType);
        if (cancelled) return;
        setMatrixState("unavailable");
        if (isFatalMatrixCryptoError(error)) {
          setMatrixIdentityResetNeeded(true);
        } else if (matrixClient?.getSyncState() === SyncState.Error) {
          // Most common case after a reload: the stored access token is no
          // longer accepted. Refresh it silently instead of waiting for a human.
          const stateData = matrixClient.getSyncStateData() as { error?: { errcode?: string } } | undefined;
          if (stateData?.error?.errcode === "M_UNKNOWN_TOKEN") {
            await handleUnknownToken();
            return;
          }
          onSync(SyncState.Error, null, stateData || undefined);
        } else if (matrixClient) {
          const currentState = matrixClient.getSyncState();
          if (currentState === SyncState.Error || currentState === SyncState.Stopped) {
            onSync(currentState, null, matrixClient.getSyncStateData() || undefined);
          }
        }
      });

    return () => {
      cancelled = true;
      clearRecoveryTimer();
      if (matrixClient) matrixClient.removeListener(ClientEvent.Sync, onSync);
    };
  }, [currentUserState.matrixSession, user.id]);

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
          matrixState={matrixState}
          matrixNotice={automaticRecoveryNotice?.message || currentUserState.matrixNotice}
          onOpenDeviceSecurity={() => setShowDeviceSecurity(true)}
          onOpenProfileSettings={() => setShowProfileSettings(true)}
          onRecoverMatrixSession={() => setShowMatrixRecovery(true)}
          matrixIdentityResetNeeded={matrixIdentityResetNeeded}
          onResetMatrixIdentity={handleResetMatrixIdentity}
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
    {showMatrixRecovery && (
      <MatrixSessionRecoveryModal
        username={currentUserState.username}
        onClose={() => setShowMatrixRecovery(false)}
        onRecover={handleRecoverMatrixSession}
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
