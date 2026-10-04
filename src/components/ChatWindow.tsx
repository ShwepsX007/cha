"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { MouseEvent } from "react";
import type { User, Chat, ChatMessage } from "./ChatApp";
import { decryptAttachment, encryptAttachment } from "matrix-encrypt-attachment";
import {
  ensureDirectRoomHistoryVisibility,
  ensureEncryptedRoomReady,
  getEncryptedRoomMessages,
  createEncryptedOutboxMessage,
  getPendingEncryptedMessages,
  hasMatrixInvitePermission,
  MATRIX_OUTBOX_EVENT,
  retryQueuedEncryptedMessage,
  sendEncryptedAttachment,
  sendQueuedEncryptedMessage,
  type EncryptedOutboxMessage,
  type MatrixOutboxUpdate,
} from "@/lib/matrix/client";
import AddGroupMembersModal from "./AddGroupMembersModal";
import Avatar from "./Avatar";
import MessageStatus from "./MessageStatus";

type ReceiptMap = Record<number | string, { status: "sent" | "delivered" | "read" }>;

function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatFileSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatBanRemaining(milliseconds: number): string {
  if (milliseconds > 50 * 365 * 24 * 60 * 60 * 1000) return "длительный срок";
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин ${seconds} сек`;
  return `${seconds} сек`;
}

function outboxItemToChatMessage(
  item: EncryptedOutboxMessage,
  user: Pick<User, "id" | "username" | "displayName" | "avatarColor" | "avatarUrl">,
  chatId: number,
): ChatMessage {
  return {
    id: `outbox:${item.id}`,
    outboxId: item.id,
    chatId,
    senderId: user.id,
    content: item.body,
    messageType: "text",
    telegramFileId: null,
    fileName: null,
    fileSize: null,
    mimeType: null,
    createdAt: item.createdAt,
    deliveryStatus: item.status === "error" ? "error" : "sending",
    deliveryError: item.status === "error" ? item.error || "Сообщение не отправлено. Нажмите «Повторить»." : undefined,
    senderUsername: user.username,
    senderDisplayName: user.displayName,
    senderAvatarColor: user.avatarColor || "#6C5CE7",
    senderAvatarUrl: user.avatarUrl || null,
  };
}

function MessageBubble({
  msg,
  isOwn,
  onRetry,
  registerRef,
  status,
}: {
  msg: ChatMessage;
  isOwn: boolean;
  onRetry?: (message: ChatMessage) => void;
  registerRef?: (id: number | string, el: HTMLDivElement | null) => void;
  status?: ChatMessage["deliveryStatus"];
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  const downloadEncryptedFile = async () => {
    if (!msg.encryptedAttachment || downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      const response = await fetch(msg.encryptedAttachment.url);
      if (!response.ok) throw new Error("Ciphertext download failed");
      const ciphertext = await response.arrayBuffer();
      const plaintext = await decryptAttachment(ciphertext, msg.encryptedAttachment);
      const blob = new Blob([plaintext], { type: msg.mimeType || "application/octet-stream" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = msg.fileName || "attachment";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
      console.error("Encrypted attachment download failed");
      setDownloadError("Не удалось скачать или расшифровать файл на этом устройстве.");
    } finally {
      setDownloading(false);
    }
  };

  const handleAttachmentClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!msg.encryptedAttachment) return;
    event.preventDefault();
    void downloadEncryptedFile();
  };

  const renderFileContent = () => {
    const hasFile = Boolean(msg.telegramFileId || msg.encryptedAttachment);
    const fileUrl = msg.encryptedAttachment?.url || `/api/file/${msg.id}`;

    if (msg.messageType === "image") {
      return (
        <div className="mb-1">
          {hasFile ? (
            <a href={fileUrl} onClick={handleAttachmentClick} target="_blank" rel="noopener noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={fileUrl}
                alt={msg.fileName || "Изображение"}
                className="max-h-72 w-auto max-w-full rounded-xl border border-dark-500/60 object-cover"
                loading="lazy"
              />
              <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-400">
                <span className="truncate">{msg.fileName}</span>
                <span>·</span>
                <span>{formatFileSize(msg.fileSize)}</span>
              </div>
            </a>
          ) : (
            <div className="bg-dark-600 rounded-lg p-3 flex items-center gap-3">
              <span className="text-xl">📷</span>
              <div>
                <div className="text-sm font-medium">{msg.fileName}</div>
                <div className="text-xs text-gray-500">Telegram не настроен</div>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (msg.messageType === "video") {
      return (
        <div className="mb-1">
          {hasFile ? (
            <a href={fileUrl} onClick={handleAttachmentClick} target="_blank" rel="noopener noreferrer">
              <div className="bg-dark-600 rounded-lg p-3 flex items-center gap-3 hover:bg-dark-500 transition-colors">
                <div className="w-10 h-10 bg-blue-500/20 rounded-lg flex items-center justify-center">
                  <span className="text-xl">🎬</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{msg.fileName}</div>
                  <div className="text-xs text-gray-400">{formatFileSize(msg.fileSize)}</div>
                </div>
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </div>
            </a>
          ) : (
            <div className="bg-dark-600 rounded-lg p-3 flex items-center gap-3">
              <span className="text-xl">🎬</span>
              <div>
                <div className="text-sm font-medium">{msg.fileName}</div>
                <div className="text-xs text-gray-500">Telegram не настроен</div>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (msg.messageType === "file") {
      return (
        <div className="mb-1">
          {hasFile ? (
            <a href={fileUrl} onClick={handleAttachmentClick} target="_blank" rel="noopener noreferrer">
              <div className="bg-dark-600 rounded-lg p-3 flex items-center gap-3 hover:bg-dark-500 transition-colors">
                <div className="w-10 h-10 bg-green-500/20 rounded-lg flex items-center justify-center">
                  <span className="text-xl">📎</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{msg.fileName}</div>
                  <div className="text-xs text-gray-400">{formatFileSize(msg.fileSize)}</div>
                </div>
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </div>
            </a>
          ) : (
            <div className="bg-dark-600 rounded-lg p-3 flex items-center gap-3">
              <span className="text-xl">📎</span>
              <div>
                <div className="text-sm font-medium">{msg.fileName}</div>
                <div className="text-xs text-gray-500">Telegram не настроен</div>
              </div>
            </div>
          )}
        </div>
      );
    }

    return null;
  };

  return (
    <div
      className={`mb-3 flex ${isOwn ? "justify-end" : "justify-start"}`}
      ref={(el) => registerRef?.(msg.id, el)}
    >
      <div className={`max-w-[75%] ${isOwn ? "order-1" : ""}`}>
        {!isOwn && (
          <div className="mb-1 flex items-center gap-2">
            <Avatar src={msg.senderAvatarUrl} name={msg.senderDisplayName} color={msg.senderAvatarColor} size={24} initialsClassName="text-[10px]" />
            <span className="text-xs font-medium" style={{ color: msg.senderAvatarColor }}>
              {msg.senderDisplayName}
            </span>
          </div>
        )}
        <div
          className={`rounded-2xl px-4 py-2.5 ${
            isOwn
              ? "bg-purple-500 text-white rounded-br-md"
              : "bg-dark-600 text-gray-100 rounded-bl-md"
          }`}
        >
          {msg.isLegacy && (
            <div className="mb-1 text-[9px] uppercase tracking-wide text-amber-300/80">
              Legacy · не зашифровано
            </div>
          )}
          {msg.messageType !== "text" && renderFileContent()}
          {downloading && <div className="text-xs text-gray-400">Скачиваем и расшифровываем…</div>}
          {downloadError && <div className="text-xs text-red-300">{downloadError}</div>}
          {msg.messageType === "text" && msg.content && (
            <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
          )}
          <div
            className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${
              isOwn ? "text-purple-200" : "text-gray-500"
            }`}
          >
            {formatTime(msg.createdAt)}
            {isOwn && <MessageStatus status={status} />}
          </div>
          {isOwn && status === "error" && (
            <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-[10px]">
              <span className="max-w-56 truncate text-red-200" title={msg.deliveryError}>{msg.deliveryError || "Не отправлено"}</span>
              {onRetry && msg.outboxId && (
                <button type="button" onClick={() => onRetry(msg)} className="font-semibold text-red-100 underline underline-offset-2 hover:text-white">
                  Повторить
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ChatWindow({
  chat,
  currentUser,
  onBack,
  onMessageSent,
}: {
  chat: Chat;
  currentUser: User;
  onBack: () => void;
  onMessageSent: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const localMessagesRef = useRef<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sendError, setSendError] = useState("");
  const [messageReadError, setMessageReadError] = useState("");
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [invitePermissionRoomId, setInvitePermissionRoomId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevMsgCountRef = useRef(0);
  const initialLoadRef = useRef(true);
  const reportedReadRef = useRef<Set<number | string>>(new Set());
  const reportedDeliveredRef = useRef<Set<number | string>>(new Set());
  const [receipts, setReceipts] = useState<ReceiptMap>({});
  const messageElsRef = useRef<Map<number | string, HTMLElement>>(new Map());
  const [banUntil, setBanUntil] = useState<string | null>(currentUser.bannedUntil ?? null);
  const [banReason, setBanReason] = useState<string | null>(currentUser.banReason ?? null);
  const [banNow, setBanNow] = useState(() => Date.now());
  const banExpiresAt = banUntil ? Date.parse(banUntil) : Number.NaN;
  const isPublicBanActive = chat.securityMode === "public" && Number.isFinite(banExpiresAt) && banExpiresAt > banNow;

  useEffect(() => {
    if (chat.securityMode !== "public") return;
    let cancelled = false;
    const refreshBan = async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const data = await response.json();
        if (!cancelled && response.ok && data.user) {
          setBanUntil(typeof data.user.bannedUntil === "string" ? data.user.bannedUntil : null);
          setBanReason(typeof data.user.banReason === "string" ? data.user.banReason : null);
          setBanNow(Date.now());
        }
      } catch {
        // The server enforces bans even if this UI refresh is temporarily unavailable.
      }
    };
    void refreshBan();
    const interval = window.setInterval(() => void refreshBan(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [chat.securityMode]);

  useEffect(() => {
    if (!banUntil) return;
    const interval = window.setInterval(() => setBanNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [banUntil]);

  const updateLocalMessages = useCallback((update: (current: ChatMessage[]) => ChatMessage[]) => {
    const next = update(localMessagesRef.current);
    localMessagesRef.current = next;
    const visibleLocalMessages = next.filter((message) => message.chatId === chat.id);
    setMessages((current) => {
      const byOutboxId = new Map(
        visibleLocalMessages.filter((message) => message.outboxId)
          .map((message) => [message.outboxId as string, message]),
      );
      const visibleOutboxIds = new Set<string>();
      const merged = current.map((message) => {
        if (!message.outboxId) return message;
        const replacement = byOutboxId.get(message.outboxId);
        if (!replacement) return message;
        visibleOutboxIds.add(message.outboxId);
        return replacement;
      });
      const additions = visibleLocalMessages.filter((message) =>
        message.outboxId && !visibleOutboxIds.has(message.outboxId),
      );
      return [...merged, ...additions].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
    });
  }, [chat.id]);

  useEffect(() => {
    if (
      !chat.isGroup ||
      chat.securityMode !== "e2ee" ||
      !chat.matrixRoomId ||
      !currentUser.matrixSession
    ) {
      return;
    }

    let cancelled = false;
    hasMatrixInvitePermission(currentUser.matrixSession, chat.matrixRoomId)
      .then((allowed) => {
        if (!cancelled) setInvitePermissionRoomId(allowed ? chat.matrixRoomId : null);
      })
      .catch(() => {
        if (!cancelled) setInvitePermissionRoomId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [chat.isGroup, chat.matrixRoomId, chat.securityMode, currentUser.matrixSession]);

  const isNearBottom = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = messagesContainerRef.current;
    if (!el) {
      messagesEndRef.current?.scrollIntoView({ behavior });
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (initialLoadRef.current && messages.length > 0) {
      window.requestAnimationFrame(() => {
        scrollToBottom("auto");
        initialLoadRef.current = false;
      });
    }
  }, [messages, scrollToBottom]);

  useEffect(() => {
    initialLoadRef.current = true;
    reportedReadRef.current = new Set();
    reportedDeliveredRef.current = new Set();
    setReceipts({});
    messageElsRef.current = new Map();
  }, [chat.id]);

  const sendReceipts = useCallback(async (messageIds: Array<number | string>, status: "delivered" | "read") => {
    if (chat.securityMode !== "public") return; // receipts for E2EE chats come from Matrix natively
    const numericIds = messageIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id));
    if (!numericIds.length) return;
    try {
      await fetch(`/api/messages/${chat.id}/receipts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageIds: numericIds, status }),
      });
    } catch {
      /* ignore */
    }
  }, [chat.id, chat.securityMode]);

  // On initial messages load, mark other users' messages as delivered.
  useEffect(() => {
    if (messages.length === 0) return;
    const pending: number[] = [];
    for (const msg of messages) {
      if (msg.senderId === currentUser.id) continue;
      if (typeof msg.id !== "number") continue;
      if (reportedDeliveredRef.current.has(msg.id)) continue;
      reportedDeliveredRef.current.add(msg.id);
      pending.push(msg.id);
    }
    if (pending.length) void sendReceipts(pending, "delivered");
  }, [messages, currentUser.id, sendReceipts]);

  // Poll receipts every few seconds so we can upgrade sent→delivered→read.
  useEffect(() => {
    if (chat.securityMode !== "public") return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/messages/${chat.id}/receipts`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data.receipts) return;
        setReceipts((prev) => ({ ...prev, ...data.receipts }));
      } catch {
        /* ignore */
      }
    };
    void load();
    const interval = window.setInterval(load, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [chat.id, chat.securityMode]);

  // IntersectionObserver: when a message becomes > 60% visible for 400ms, mark it read.
  useEffect(() => {
    if (chat.securityMode !== "public") return;
    const observer = new IntersectionObserver((entries) => {
      const visibleIds: number[] = [];
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idAttr = (entry.target as HTMLElement).dataset.messageId;
        if (!idAttr) continue;
        const id = Number(idAttr);
        if (!Number.isInteger(id)) continue;
        if (reportedReadRef.current.has(id)) continue;
        reportedReadRef.current.add(id);
        visibleIds.push(id);
      }
      if (visibleIds.length) void sendReceipts(visibleIds, "read");
    }, { root: messagesContainerRef.current, threshold: [0.6] });

    const nodes = messageElsRef.current;
    // Observe all currently registered messages.
    nodes.forEach((el) => observer.observe(el));

    // Use a MutationObserver to attach to freshly rendered message nodes.
    const container = messagesContainerRef.current;
    if (!container) return () => observer.disconnect();
    const mo = new MutationObserver(() => {
      nodes.forEach((el, id) => {
        if (!el.isConnected) { nodes.delete(id); return; }
        // IntersectionObserver ignores duplicates safely.
        observer.observe(el);
      });
    });
    mo.observe(container, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      observer.disconnect();
    };
  }, [chat.id, chat.securityMode, messages.length, sendReceipts]);

  const registerMessageEl = useCallback((id: number | string, el: HTMLElement | null) => {
    if (!el) {
      messageElsRef.current.delete(id);
      return;
    }
    el.dataset.messageId = String(id);
    messageElsRef.current.set(id, el);
  }, []);

  const getMessageStatus = useCallback((msg: ChatMessage): ChatMessage["deliveryStatus"] => {
    if (msg.deliveryStatus === "sending" || msg.deliveryStatus === "error") return msg.deliveryStatus;
    if (msg.senderId !== currentUser.id) return undefined;
    // For own messages, look up aggregated receipt state.
    if (typeof msg.id === "number") {
      const r = receipts[msg.id];
      if (r) return r.status;
    }
    return msg.deliveryStatus || "sent";
  }, [currentUser.id, receipts]);

  const prepareEncryptedChat = useCallback(async () => {
    if (chat.securityMode !== "e2ee" || !chat.matrixRoomId || !currentUser.matrixSession) return;

    if (!chat.isGroup) {
      await ensureDirectRoomHistoryVisibility(currentUser.matrixSession, chat.matrixRoomId);
    } else {
      await ensureEncryptedRoomReady(currentUser.matrixSession, chat.matrixRoomId);
    }
  }, [
    chat.isGroup,
    chat.matrixRoomId,
    chat.securityMode,
    currentUser.matrixSession,
  ]);

  const loadMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/messages?chatId=${chat.id}`);
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.messages)) return;

      const legacyMessages: ChatMessage[] = data.messages.map((message: ChatMessage) => ({
        ...message,
        isLegacy: chat.securityMode !== "public",
      }));
      let visibleMessages = legacyMessages;

      if (chat.securityMode === "e2ee" && chat.matrixRoomId && currentUser.matrixSession) {
        try {
          await prepareEncryptedChat();
          const matrixResult = await getEncryptedRoomMessages(
            currentUser.matrixSession,
            chat.matrixRoomId,
            chat.id,
          );
          setMessageReadError(
            matrixResult.undecryptableCount > 0
              ? `${matrixResult.undecryptableCount} зашифрованных сообщений пока нельзя расшифровать на этом устройстве. Проверьте подключение или восстановление ключей.`
              : "",
          );
          const liveMessages: ChatMessage[] = matrixResult.messages.map((message) => {
            const senderId = Number(message.senderUserId);
            const sender = chat.members.find((member) => member.id === senderId);
            const isFile = message.msgtype === "m.file";
            const mimeType = message.mimeType || null;
            return {
              id: message.eventId,
              chatId: chat.id,
              senderId,
              content: isFile ? null : message.body,
              messageType: isFile
                ? mimeType?.startsWith("image/")
                  ? "image"
                  : mimeType?.startsWith("video/")
                    ? "video"
                    : "file"
                : "text",
              telegramFileId: null,
              fileName: isFile ? message.body : null,
              fileSize: isFile ? message.fileSize || null : null,
              mimeType,
              encryptedAttachment: message.encryptedFile,
              createdAt: new Date(message.timestamp).toISOString(),
              senderUsername: sender?.username || message.senderMxid,
              senderDisplayName: sender?.displayName || "Пользователь",
              senderAvatarColor: sender?.avatarColor || "#6C5CE7",
              senderAvatarUrl: sender?.avatarUrl || null,
              isLegacy: false,
            };
          });
          visibleMessages = [...legacyMessages, ...liveMessages].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          );
        } catch (err) {
          console.error("Failed to read encrypted Matrix messages");
          setMessageReadError("Не удалось загрузить зашифрованные сообщения на этом устройстве.");
        }
      } else if (chat.securityMode === "e2ee" && chat.matrixRoomId) {
        setMessageReadError("На этой вкладке нет активной Matrix-сессии. Войдите снова, чтобы читать новые сообщения.");
      } else {
        setMessageReadError("");
      }

      if (chat.securityMode === "e2ee" && currentUser.matrixSession) {
        const queuedItems = getPendingEncryptedMessages(currentUser.id, chat.id);
        const queuedIds = new Set(queuedItems.map((item) => item.id));
        const allLocalMessages = localMessagesRef.current;
        const currentLocalMessages = allLocalMessages.filter((message) => message.chatId === chat.id);
        const localByOutboxId = new Map(
          currentLocalMessages
            .filter((message) => message.outboxId)
            .map((message) => [message.outboxId as string, message]),
        );
        const optimisticMessages = queuedItems.map((item) =>
          localByOutboxId.get(item.id) || outboxItemToChatMessage(item, { id: currentUser.id, username: currentUser.username, displayName: currentUser.displayName, avatarColor: currentUser.avatarColor, avatarUrl: currentUser.avatarUrl }, chat.id),
        );
        const liveIds = new Set(visibleMessages.map((message) => String(message.id)));
        const sentButNotSynced = currentLocalMessages.filter((message) =>
          message.deliveryStatus === "sent" &&
          (!message.outboxId || !queuedIds.has(message.outboxId)) &&
          (!message.matrixEventId || !liveIds.has(message.matrixEventId)),
        );
        const nextLocalMessages = [...optimisticMessages, ...sentButNotSynced];
        const hasLocalChanges = nextLocalMessages.length !== currentLocalMessages.length ||
          nextLocalMessages.some((message, index) => {
            const current = currentLocalMessages[index];
            return !current || current.id !== message.id ||
              current.deliveryStatus !== message.deliveryStatus ||
              current.deliveryError !== message.deliveryError;
          });
        if (hasLocalChanges) {
          localMessagesRef.current = [
            ...allLocalMessages.filter((message) => message.chatId !== chat.id),
            ...nextLocalMessages,
          ];
        }
        visibleMessages = [...visibleMessages, ...nextLocalMessages].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
      }

      setMessages(visibleMessages);
      if (visibleMessages.length !== prevMsgCountRef.current) {
        prevMsgCountRef.current = visibleMessages.length;
        const wasNearBottom = isNearBottom();
        window.requestAnimationFrame(() => {
          if (initialLoadRef.current || wasNearBottom) scrollToBottom(initialLoadRef.current ? "auto" : "smooth");
        });
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }, [
    chat.id,
    chat.matrixRoomId,
    chat.members,
    chat.securityMode,
    currentUser.id,
    currentUser.username,
    currentUser.displayName,
    currentUser.avatarColor,
    currentUser.avatarUrl,
    currentUser.matrixSession,
    isNearBottom,
    prepareEncryptedChat,
    scrollToBottom,
  ]);

  useEffect(() => {
    prevMsgCountRef.current = 0;
    loadMessages();
    const interval = setInterval(loadMessages, 2000);
    return () => clearInterval(interval);
  }, [loadMessages]);

  useEffect(() => {
    const onOutboxUpdate = (event: Event) => {
      const update = (event as CustomEvent<MatrixOutboxUpdate>).detail;
      if (!update) return;
      const isActiveChat = update.chatId === chat.id;

      updateLocalMessages((current) => {
        let message = current.find((item) => item.outboxId === update.id);
        if (!message && update.status !== "sent") {
          const queued = getPendingEncryptedMessages(currentUser.id, update.chatId)
            .find((item) => item.id === update.id);
          if (queued) message = outboxItemToChatMessage(queued, { id: currentUser.id, username: currentUser.username, displayName: currentUser.displayName, avatarColor: currentUser.avatarColor, avatarUrl: currentUser.avatarUrl }, update.chatId);
        }
        if (!message) return current;

        const updated: ChatMessage = {
          ...message,
          id: update.status === "sent" && update.eventId ? update.eventId : message.id,
          matrixEventId: update.status === "sent" ? update.eventId : message.matrixEventId,
          deliveryStatus: update.status,
          deliveryError: update.error,
        };
        const found = current.some((item) => item.outboxId === update.id);
        return found
          ? current.map((item) => item.outboxId === update.id ? updated : item)
          : [...current, updated];
      });

      if (update.status === "sent") {
        if (isActiveChat) void loadMessages();
        onMessageSent();
      }
    };

    window.addEventListener(MATRIX_OUTBOX_EVENT, onOutboxUpdate);
    return () => window.removeEventListener(MATRIX_OUTBOX_EVENT, onOutboxUpdate);
  }, [chat, currentUser, loadMessages, onMessageSent, updateLocalMessages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || sending) return;
    if (isPublicBanActive) {
      setSendError("Отправка в общий чат заблокирована на время действия бана.");
      return;
    }

    const msgText = newMessage.trim();
    setSendError("");

    if (chat.securityMode === "e2ee") {
      if (!chat.matrixRoomId || !currentUser.matrixSession) {
        setSendError("Matrix E2EE не подключён. Сообщение не отправлено открытым текстом.");
        return;
      }

      try {
        const item = createEncryptedOutboxMessage({
          appUserId: currentUser.id,
          chatId: chat.id,
          roomId: chat.matrixRoomId,
          isDirect: !chat.isGroup,
          body: msgText,
        });
        const optimisticMessage: ChatMessage = {
          ...outboxItemToChatMessage(item, { id: currentUser.id, username: currentUser.username, displayName: currentUser.displayName, avatarColor: currentUser.avatarColor, avatarUrl: currentUser.avatarUrl }, chat.id),
          id: `outbox:${item.id}`,
          deliveryStatus: "sending",
          deliveryError: undefined,
        };
        updateLocalMessages((current) => [...current, optimisticMessage]);
        setNewMessage("");
        setSending(false);
        scrollToBottom("smooth");
        void sendQueuedEncryptedMessage(currentUser.matrixSession, item.id).catch(() => undefined);
      } catch (queueError) {
        setSendError(queueError instanceof Error
          ? queueError.message
          : "Не удалось сохранить сообщение в очереди. Повторите попытку.");
      }
      return;
    }

    setNewMessage("");
    setSending(true);
    try {
      if (chat.securityMode === "public") {
        const response = await fetch("/api/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: chat.id, content: msgText }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Не удалось отправить сообщение");
      } else {
        throw new Error("Новые сообщения в legacy-чатах заблокированы до настройки E2EE.");
      }

      await loadMessages();
      onMessageSent();
      scrollToBottom("smooth");
    } catch (err) {
      console.error("Failed to send message");
      setNewMessage(msgText);
      setSendError(err instanceof Error ? err.message : "Не удалось отправить сообщение");
    } finally {
      setSending(false);
    }
  };

  const handleRetryMessage = (message: ChatMessage) => {
    if (!message.outboxId || !currentUser.matrixSession) return;
    updateLocalMessages((current) => current.map((item) => item.outboxId === message.outboxId
      ? { ...item, deliveryStatus: "sending", deliveryError: undefined }
      : item));
    void retryQueuedEncryptedMessage(currentUser.matrixSession, message.outboxId).catch(() => undefined);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (isPublicBanActive) {
      setSendError("Загрузка файлов в общий чат заблокирована на время действия бана.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setSendError("");
    setUploading(true);
    try {
      if (chat.securityMode === "public") {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("chatId", String(chat.id));

        const response = await fetch("/api/upload", { method: "POST", body: formData });
        const uploadResult = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(uploadResult.error || "Не удалось загрузить файл");
      } else if (chat.securityMode === "e2ee" && chat.matrixRoomId && currentUser.matrixSession) {
        await prepareEncryptedChat();
        if (file.size > 45 * 1024 * 1024) {
          throw new Error("Размер файла для E2EE не должен превышать 45 МБ");
        }

        // Matrix.org's attachment library encrypts the bytes in the browser
        // using the Matrix encrypted-attachment format. Only ciphertext and a
        // random filename are sent to the Telegram upload endpoint.
        const encrypted = await encryptAttachment(await file.arrayBuffer());
        const ciphertext = new Blob([encrypted.data], { type: "application/octet-stream" });
        const formData = new FormData();
        formData.append("file", ciphertext, `ciphertext-${crypto.randomUUID()}.bin`);
        formData.append("chatId", String(chat.id));
        formData.append("encrypted", "true");

        const response = await fetch("/api/upload", { method: "POST", body: formData });
        const uploadResult = await response.json();
        if (!response.ok || typeof uploadResult.telegramFileId !== "string") {
          throw new Error(uploadResult.error || "Не удалось сохранить зашифрованный файл в Telegram");
        }

        const fileUrl = new URL("/api/file/telegram", window.location.origin);
        fileUrl.searchParams.set("chatId", String(chat.id));
        fileUrl.searchParams.set("fileId", uploadResult.telegramFileId);
        await sendEncryptedAttachment(currentUser.matrixSession, chat.matrixRoomId, {
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          fileSize: file.size,
          encryptedFile: { ...encrypted.info, url: fileUrl.toString() },
        });
      } else {
        throw new Error("Этот чат не готов к безопасной загрузке файлов");
      }

      await loadMessages();
      onMessageSent();
      scrollToBottom("smooth");
    } catch (err) {
      console.error("Failed to upload attachment");
      setSendError(err instanceof Error ? err.message : "Не удалось загрузить файл");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const otherMember = chat.isGroup ? undefined : chat.members.find((m) => m.id !== currentUser.id);
  const canSendMessage =
    (chat.securityMode === "public" && !isPublicBanActive) ||
    (chat.securityMode === "e2ee" && Boolean(chat.matrixRoomId && currentUser.matrixSession));
  const canAttachFile = canSendMessage;

  return (
    <div className="flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-dark-900 md:h-full">
      {/* Chat Header */}
      <div className="sticky top-0 z-20 shrink-0 border-b border-dark-600 bg-dark-800/95 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="md:hidden p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-dark-600"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <Avatar
          src={chat.isGroup ? null : otherMember?.avatarUrl || null}
          name={chat.name || "?"}
          color={otherMember?.avatarColor || "#6C5CE7"}
          size={40}
          cacheKey={chat.isGroup ? null : otherMember?.avatarUpdatedAt || null}
        />

        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate">{chat.name}</div>
          <div className="text-xs text-gray-500">
            {otherMember
              ? isOnline(otherMember.lastSeen)
                ? "● в сети"
                : "был(а) недавно"
              : `${chat.members.length} участников`}
          </div>
          <div className={`text-[10px] mt-0.5 ${chat.securityMode === "e2ee" ? "text-emerald-400" : "text-amber-400"}`}>
            {chat.securityMode === "public"
              ? "Открытый чат · без E2EE"
              : chat.securityMode === "e2ee"
                ? currentUser.matrixSession
                  ? "Matrix E2EE · старая история помечена как legacy"
                  : "E2EE-комната · Matrix-сессия на этой вкладке недоступна"
                : "Legacy-чат · новые сообщения заблокированы до E2EE"}
          </div>
        </div>
        {chat.isGroup && chat.securityMode === "e2ee" && chat.matrixRoomId === invitePermissionRoomId && (
          <button
            onClick={() => setShowAddMembers(true)}
            className="rounded-lg p-2 text-gray-400 hover:bg-dark-600 hover:text-white touch-manipulation"
            title="Добавить участников (создатель/админ)"
            aria-label="Добавить участников"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9a3 3 0 11-6 0 3 3 0 016 0zM3 20a6 6 0 0112 0M19 8v6m3-3h-6" />
            </svg>
          </button>
        )}
        </div>
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} className="flex min-h-0 flex-1 flex-col justify-end overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] [-webkit-overflow-scrolling:touch]">
        {messageReadError && (
          <div className="mb-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
            {messageReadError} Legacy-история при этом остаётся доступна ниже.
          </div>
        )}
        {messages.length === 0 ? (
          <div className="flex min-h-[60dvh] flex-col items-center justify-center text-center">
            <div className="text-4xl mb-3">🔐</div>
            <p className="text-gray-500 text-sm">{chat.securityMode === "legacy" ? "История чата сохранена как legacy" : "Начните разговор!"}</p>
            <p className="text-gray-600 text-xs mt-1">
              {chat.securityMode === "public"
                ? "Этот общий чат не шифруется"
                : chat.securityMode === "e2ee"
                  ? "Новые сообщения шифруются Matrix на устройствах участников"
                  : "Новые сообщения не отправляются открытым текстом"}
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              isOwn={msg.senderId === currentUser.id}
              onRetry={handleRetryMessage}
              registerRef={registerMessageEl}
              status={getMessageStatus(msg)}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="sticky bottom-0 z-20 shrink-0 border-t border-dark-600 bg-dark-800/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        {isPublicBanActive && (
          <div role="alert" className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs leading-relaxed text-red-200">
            <div className="font-semibold">Отправка сообщений и файлов в общий чат временно заблокирована.</div>
            <div className="mt-1">
              Осталось: {formatBanRemaining(banExpiresAt - banNow)} · доступ восстановится {new Date(banExpiresAt).toLocaleString("ru-RU")}.
            </div>
            {banReason && <div className="mt-1">Причина: {banReason}</div>}
          </div>
        )}
        {sendError && (
          <div className="mb-2 text-xs text-amber-300" role="status">
            {sendError}
          </div>
        )}
        <form onSubmit={handleSend} className="flex items-center gap-2">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            accept="image/*,video/*,.pdf,.doc,.docx,.txt,.zip,.rar,.7z,.mp3,.wav"
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || !canAttachFile}
            className="p-2.5 text-gray-400 hover:text-purple-400 rounded-xl hover:bg-dark-700 transition-colors disabled:opacity-50"
            title={isPublicBanActive ? "Загрузка заблокирована на время бана" : canAttachFile ? "Прикрепить файл" : "Новые файлы доступны после настройки Matrix E2EE"}
          >
            {uploading ? (
              <div className="w-5 h-5 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
            )}
          </button>

          <input
            type="text"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            disabled={!canSendMessage || sending}
            className="flex-1 px-4 py-2.5 bg-dark-700 border border-dark-500 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50"
            placeholder={isPublicBanActive ? "Отправка заблокирована до окончания бана" : canSendMessage ? "Введите сообщение..." : "Новые сообщения заблокированы до подключения E2EE"}
            autoComplete="off"
          />

          <button
            type="submit"
            disabled={!newMessage.trim() || sending || !canSendMessage}
            className="p-2.5 bg-purple-500 hover:bg-purple-600 disabled:opacity-30 disabled:hover:bg-purple-500 text-white rounded-xl transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </form>
      </div>
      {showAddMembers && (
        <AddGroupMembersModal
          chatId={chat.id}
          memberIds={chat.members.map((member) => member.id)}
          matrixSession={currentUser.matrixSession}
          onClose={() => setShowAddMembers(false)}
          onAdded={onMessageSent}
        />
      )}
    </div>
  );
}

function isOnline(lastSeen?: string | null): boolean {
  if (!lastSeen) return false;
  const diff = Date.now() - new Date(lastSeen).getTime();
  return diff < 60000; // 1 minute
}
