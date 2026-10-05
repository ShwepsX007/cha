"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { MouseEvent } from "react";
import type { User, Chat, ChatMessage, ChatMessageReply } from "./ChatApp";
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
  sendMatrixReadReceipt,
  type EncryptedOutboxMessage,
  type MatrixOutboxUpdate,
  type MatrixReplyReference,
} from "@/lib/matrix/client";
import AddGroupMembersModal from "./AddGroupMembersModal";
import Avatar from "./Avatar";
import MessageStatus from "./MessageStatus";

type ReceiptMap = Record<number, {
  status: "sent" | "delivered" | "read";
  readByCount: number;
  deliveredToCount: number;
  recipientCount: number;
}>;

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

function getReplyPreviewText(message: Pick<ChatMessageReply, "content" | "messageType" | "fileName">): string {
  if (message.messageType === "image") return `📷 ${message.fileName || "Фото"}`;
  if (message.messageType === "video") return `🎬 ${message.fileName || "Видео"}`;
  if (message.messageType !== "text") return `📎 ${message.fileName || message.content || "Файл"}`;
  return message.content?.trim() || "Сообщение";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderMessageText(text: string, members: User[]) {
  const handles = [...new Set(members.map((member) => `@${member.username}`).filter((name) => name.length > 1))]
    .sort((a, b) => b.length - a.length);
  if (handles.length === 0) return text;
  const matcher = new RegExp(`(${handles.map(escapeRegExp).join("|")})`, "gi");
  return text.split(matcher).map((part, index) => {
    const isMention = handles.some((handle) => handle.toLowerCase() === part.toLowerCase());
    return isMention
      ? <span key={`${index}-${part}`} className="rounded bg-sky-400/15 px-0.5 font-medium text-sky-200">{part}</span>
      : part;
  });
}

function getMatrixMentionUserIds(text: string, members: User[], session: NonNullable<User["matrixSession"]>): string[] {
  const separator = session.userId.indexOf(":");
  const serverName = separator >= 0 ? session.userId.slice(separator + 1) : "";
  if (!serverName) return [];
  return members
    .filter((member) => {
      const mentionPattern = new RegExp(`(^|[^A-Za-z0-9_])@${escapeRegExp(member.username)}(?=$|[^A-Za-z0-9_])`, "i");
      return mentionPattern.test(text);
    })
    .map((member) => `@chata_u${member.id}:${serverName}`);
}

function createMatrixReplyReference(
  message: ChatMessage,
  session: NonNullable<User["matrixSession"]>,
): MatrixReplyReference | undefined {
  if (message.isLegacy || typeof message.id !== "string" || message.id.startsWith("outbox:")) return undefined;
  const senderId = Number(message.senderId);
  const separator = session.userId.indexOf(":");
  const serverName = separator >= 0 ? session.userId.slice(separator + 1) : "";
  if (!Number.isInteger(senderId) || senderId <= 0 || !serverName) return undefined;
  return {
    eventId: message.id,
    senderMxid: `@chata_u${senderId}:${serverName}`,
    senderUserId: String(senderId),
    senderDisplayName: message.senderDisplayName,
    senderUsername: message.senderUsername,
    body: getReplyPreviewText(message),
    messageType: message.messageType,
  };
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
    replyTo: item.replyTo ? {
      id: item.replyTo.eventId,
      senderId: item.replyTo.senderUserId,
      senderDisplayName: item.replyTo.senderDisplayName,
      senderUsername: item.replyTo.senderUsername,
      content: item.replyTo.body,
      messageType: item.replyTo.messageType,
    } : null,
    mentionUserIds: item.mentionUserIds,
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
  statusTitle,
  members,
  canReply,
  onReply,
  onMention,
  onJumpToMessage,
}: {
  msg: ChatMessage;
  isOwn: boolean;
  onRetry?: (message: ChatMessage) => void;
  registerRef?: (id: number | string, el: HTMLDivElement | null) => void;
  status?: ChatMessage["deliveryStatus"];
  statusTitle?: string;
  members: User[];
  canReply: boolean;
  onReply: (message: ChatMessage) => void;
  onMention?: (message: ChatMessage) => void;
  onJumpToMessage: (id: number | string) => void;
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
            {onMention ? (
              <button
                type="button"
                onClick={() => onMention(msg)}
                className="text-xs font-medium hover:underline"
                style={{ color: msg.senderAvatarColor }}
                title={`Упомянуть @${msg.senderUsername} в этом чате`}
              >
                {msg.senderDisplayName}<span className="ml-1 text-[10px] opacity-60">@</span>
              </button>
            ) : (
              <span className="text-xs font-medium" style={{ color: msg.senderAvatarColor }}>
                {msg.senderDisplayName}
              </span>
            )}
          </div>
        )}
        <div
          className={`rounded-2xl px-4 py-2.5 ${
            isOwn
              ? "bg-purple-500 text-white rounded-br-md"
              : "bg-dark-600 text-gray-100 rounded-bl-md"
          }`}
        >
          {msg.replyTo && (
            <button
              type="button"
              onClick={() => onJumpToMessage(msg.replyTo!.id)}
              className={`mb-2 block w-full rounded-lg border-l-2 px-2 py-1 text-left ${isOwn ? "border-purple-200/70 bg-purple-700/30" : "border-sky-400/70 bg-dark-700/70"}`}
              title="Перейти к исходному сообщению"
            >
              <span className="block truncate text-[10px] font-semibold opacity-90">
                {msg.replyTo.senderDisplayName || "Исходное сообщение"}
              </span>
              <span className="block max-w-full truncate text-[11px] opacity-80">
                {getReplyPreviewText(msg.replyTo)}
              </span>
            </button>
          )}
          {msg.isLegacy && (
            <div className="mb-1 text-[9px] uppercase tracking-wide text-amber-300/80">
              Legacy · не зашифровано
            </div>
          )}
          {msg.messageType !== "text" && renderFileContent()}
          {downloading && <div className="text-xs text-gray-400">Скачиваем и расшифровываем…</div>}
          {downloadError && <div className="text-xs text-red-300">{downloadError}</div>}
          {msg.messageType === "text" && msg.content && (
            <p className="text-sm whitespace-pre-wrap break-words">{renderMessageText(msg.content, members)}</p>
          )}
          <div
            className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${
              isOwn ? "text-purple-200" : "text-gray-500"
            }`}
          >
            {canReply && (
              <button
                type="button"
                onClick={() => onReply(msg)}
                className="mr-1 rounded px-1 text-[12px] opacity-70 transition hover:bg-black/10 hover:opacity-100"
                title="Ответить на сообщение"
                aria-label="Ответить на сообщение"
              >
                ↩
              </button>
            )}
            {formatTime(msg.createdAt)}
            {isOwn && <MessageStatus status={status} title={statusTitle} />}
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
  onChatUpdated,
}: {
  chat: Chat;
  currentUser: User;
  onBack: () => void;
  onMessageSent: () => void;
  onChatUpdated?: (patch: Partial<Chat>) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const localMessagesRef = useRef<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sendError, setSendError] = useState("");
  const [messageReadError, setMessageReadError] = useState("");
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [invitePermissionRoomId, setInvitePermissionRoomId] = useState<string | null>(null);
  const [notificationsMuted, setNotificationsMuted] = useState(Boolean(chat.notificationsMuted));
  const [muteBusy, setMuteBusy] = useState(false);

  useEffect(() => {
    setNotificationsMuted(Boolean(chat.notificationsMuted));
  }, [chat.id, chat.notificationsMuted]);

  const toggleChatMute = async () => {
    if (muteBusy) return;
    const next = !notificationsMuted;
    setNotificationsMuted(next);
    setMuteBusy(true);
    try {
      const res = await fetch(`/api/chats/${chat.id}/notifications`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ muted: next }),
      });
      if (!res.ok) {
        setNotificationsMuted(!next);
        return;
      }
      onChatUpdated?.({ notificationsMuted: next });
    } catch {
      setNotificationsMuted(!next);
    } finally {
      setMuteBusy(false);
    }
  };
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);
  const prevMsgCountRef = useRef(0);
  const initialLoadRef = useRef(true);
  const reportedReadRef = useRef<Set<number | string>>(new Set());
  const reportedDeliveredRef = useRef<Set<number | string>>(new Set());
  const [receipts, setReceipts] = useState<ReceiptMap>({});
  const messageElsRef = useRef<Map<number | string, HTMLElement>>(new Map());
  const readObserverRef = useRef<IntersectionObserver | null>(null);
  const [banUntil, setBanUntil] = useState<string | null>(currentUser.bannedUntil ?? null);
  const [banReason, setBanReason] = useState<string | null>(currentUser.banReason ?? null);
  const [banNow, setBanNow] = useState(() => Date.now());
  const banExpiresAt = banUntil ? Date.parse(banUntil) : Number.NaN;
  const isPublicBanActive = chat.securityMode === "public" && Number.isFinite(banExpiresAt) && banExpiresAt > banNow;

  useEffect(() => {
    if (chat.securityMode !== "public") return;
    let cancelled = false;
    const refreshBan = async () => {
      if (document.visibilityState !== "visible") return;
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
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshBan();
    };
    void refreshBan();
    const interval = window.setInterval(() => void refreshBan(), 5_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
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
    setReplyingTo(null);
    reportedReadRef.current = new Set();
    reportedDeliveredRef.current = new Set();
    setReceipts({});
    messageElsRef.current = new Map();
  }, [chat.id]);

  const sendReceipts = useCallback(async (
    messageIds: Array<number | string>,
    status: "delivered" | "read",
  ): Promise<boolean> => {
    if (chat.securityMode === "public") {
      const numericIds = messageIds.filter(
        (id): id is number => typeof id === "number" && Number.isInteger(id),
      );
      if (!numericIds.length) return true;
      try {
        const response = await fetch(`/api/messages/${chat.id}/receipts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageIds: numericIds, status }),
        });
        if (!response.ok) {
          console.warn(`Message receipt update failed (${response.status})`);
          return false;
        }
        return true;
      } catch (error) {
        console.warn("Message receipt request failed", error);
        return false;
      }
    }

    // Private encrypted messages live only in Matrix. Send a standard Matrix
    // read receipt for the newest visible incoming event; the remote sender
    // reads that receipt from the encrypted room timeline state.
    if (
      chat.securityMode === "e2ee" && status === "read" && chat.matrixRoomId &&
      currentUser.matrixSession
    ) {
      const requestedIds = new Set(messageIds.map(String));
      const incoming = messages
        .filter((message) =>
          requestedIds.has(String(message.id)) &&
          message.senderId !== currentUser.id &&
          typeof message.id === "string" &&
          !message.id.startsWith("outbox:"),
        )
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const latest = incoming.at(-1);
      if (!latest || typeof latest.id !== "string") return true;
      try {
        await sendMatrixReadReceipt(currentUser.matrixSession, chat.matrixRoomId, latest.id);
        return true;
      } catch (error) {
        console.warn("Matrix read receipt failed", error);
        return false;
      }
    }

    return true;
  }, [chat.id, chat.matrixRoomId, chat.securityMode, currentUser.id, currentUser.matrixSession, messages]);

  const queueReadReceipts = useCallback((messageIds: Array<number | string>) => {
    const pending = messageIds.filter((id) => !reportedReadRef.current.has(id));
    if (!pending.length) return;
    pending.forEach((id) => reportedReadRef.current.add(id));
    void sendReceipts(pending, "read").then((sent) => {
      if (!sent) pending.forEach((id) => reportedReadRef.current.delete(id));
    });
  }, [sendReceipts]);

  // On initial messages load, mark other users' public-chat messages delivered.
  useEffect(() => {
    if (chat.securityMode !== "public" || messages.length === 0) return;
    const pending: number[] = [];
    for (const msg of messages) {
      if (msg.senderId === currentUser.id) continue;
      if (typeof msg.id !== "number") continue;
      if (reportedDeliveredRef.current.has(msg.id)) continue;
      reportedDeliveredRef.current.add(msg.id);
      pending.push(msg.id);
    }
    if (pending.length) {
      void sendReceipts(pending, "delivered").then((sent) => {
        if (!sent) pending.forEach((id) => reportedDeliveredRef.current.delete(id));
      });
    }
  }, [chat.securityMode, messages, currentUser.id, sendReceipts]);

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

  // Build (or rebuild) the IntersectionObserver once the container exists, and
  // keep a stable instance in a ref so we can observe nodes as they register.
  useEffect(() => {
    if (chat.securityMode !== "public" && chat.securityMode !== "e2ee") return;
    const container = messagesContainerRef.current;
    if (!container) return;

    readObserverRef.current?.disconnect();
    const observer = new IntersectionObserver((entries) => {
      if (document.visibilityState !== "visible") return;
      const visibleIds: Array<number | string> = [];
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idAttr = (entry.target as HTMLElement).dataset.messageId;
        if (!idAttr) continue;
        const message = messages.find((candidate) => String(candidate.id) === idAttr);
        if (!message || message.senderId === currentUser.id) continue;
        if (reportedReadRef.current.has(message.id)) continue;
        visibleIds.push(message.id);
      }
      if (visibleIds.length) queueReadReceipts(visibleIds);
    }, { root: container, threshold: [0.5], rootMargin: "0px" });
    readObserverRef.current = observer;

    // Observe all currently-mounted message nodes.
    messageElsRef.current.forEach((el) => observer.observe(el));

    // Some messages are visible on first paint and never cross the observer
    // threshold. Also re-check after a hidden tab becomes visible so background
    // layout does not falsely mark messages as read.
    const markCurrentlyVisible = () => {
      if (document.visibilityState !== "visible") return;
      const queue: Array<number | string> = [];
      messageElsRef.current.forEach((el, id) => {
        if (reportedReadRef.current.has(id)) return;
        const rect = el.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        const visible = rect.bottom > cRect.top && rect.top < cRect.bottom;
        if (!visible) return;
        const msg = messages.find((m) => String(m.id) === String(id));
        if (!msg || msg.senderId === currentUser.id) return;
        queue.push(msg.id);
      });
      if (queue.length) queueReadReceipts(queue);
    };
    const initialTimer = window.setTimeout(markCurrentlyVisible, 400);
    document.addEventListener("visibilitychange", markCurrentlyVisible);

    return () => {
      window.clearTimeout(initialTimer);
      document.removeEventListener("visibilitychange", markCurrentlyVisible);
      observer.disconnect();
      readObserverRef.current = null;
    };
  }, [chat.id, chat.securityMode, queueReadReceipts, messages, currentUser.id]);

  const registerMessageEl = useCallback((id: number | string, el: HTMLElement | null) => {
    if (!el) {
      messageElsRef.current.delete(id);
      return;
    }
    el.dataset.messageId = String(id);
    messageElsRef.current.set(id, el);
    readObserverRef.current?.observe(el);
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

  const handleReplyToMessage = useCallback((message: ChatMessage) => {
    if (
      chat.securityMode === "e2ee" &&
      (message.isLegacy || typeof message.id !== "string" || message.id.startsWith("outbox:"))
    ) return;
    setReplyingTo(message);
    window.setTimeout(() => messageInputRef.current?.focus(), 0);
  }, [chat.securityMode]);

  const handleMentionMessageAuthor = useCallback((message: ChatMessage) => {
    const member = chat.members.find((candidate) => candidate.id === Number(message.senderId));
    if (!member) return;
    setNewMessage((current) => {
      const prefix = current.replace(/\s+$/u, "");
      return `${prefix ? `${prefix} ` : ""}@${member.username} `;
    });
    window.setTimeout(() => messageInputRef.current?.focus(), 0);
  }, [chat.members]);

  const jumpToMessage = useCallback((messageId: number | string) => {
    const element = messageElsRef.current.get(messageId);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.classList.add("ring-2", "ring-sky-400/70");
    window.setTimeout(() => element.classList.remove("ring-2", "ring-sky-400/70"), 1200);
  }, []);

  const getMessageReceiptTitle = useCallback((message: ChatMessage): string | undefined => {
    if (message.senderId !== currentUser.id) return undefined;
    const summary = typeof message.id === "number" ? receipts[message.id] : undefined;
    const readByCount = summary?.readByCount ?? message.readByCount;
    const deliveredToCount = summary?.deliveredToCount ?? message.deliveredToCount;
    const recipientCount = summary?.recipientCount ?? message.recipientCount;
    if (message.deliveryStatus === "read" && readByCount !== undefined && recipientCount !== undefined) {
      return `Прочитано: ${readByCount} из ${recipientCount}`;
    }
    if (message.deliveryStatus === "delivered" && deliveredToCount !== undefined && recipientCount !== undefined) {
      return `Доставлено: ${deliveredToCount} из ${recipientCount}`;
    }
    if (summary?.status === "read") return `Прочитано: ${summary.readByCount} из ${summary.recipientCount}`;
    if (summary?.status === "delivered") return `Доставлено: ${summary.deliveredToCount} из ${summary.recipientCount}`;
    return undefined;
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
      const isVisible = document.visibilityState === "visible";
      const res = await fetch(`/api/messages?chatId=${chat.id}`, {
        headers: { "X-Chat-Visible": isVisible ? "1" : "0" },
      });
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
            const replySenderId = message.replyTo ? Number(message.replyTo.senderUserId) : Number.NaN;
            const replySender = Number.isFinite(replySenderId)
              ? chat.members.find((member) => member.id === replySenderId)
              : undefined;
            const replyIsFile = message.replyTo?.msgtype === "m.file";
            const replyTo: ChatMessageReply | null = message.replyToEventId ? {
              id: message.replyToEventId,
              senderId: Number.isFinite(replySenderId) ? replySenderId : "",
              senderDisplayName: replySender?.displayName || "Исходное сообщение",
              senderUsername: replySender?.username,
              content: replyIsFile ? null : message.replyTo?.body || null,
              messageType: replyIsFile ? "file" : "text",
              fileName: replyIsFile ? message.replyTo?.body || "Файл" : null,
            } : null;
            return {
              id: message.eventId,
              chatId: chat.id,
              senderId,
              content: isFile ? null : message.body,
              replyTo,
              readByCount: message.readByCount,
              recipientCount: message.recipientCount,
              mentionUserIds: message.mentionUserIds,
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
              deliveryStatus: message.readByOther ? "read" : "sent",
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
        setMessageReadError("На этой вкладке нет Matrix-сессии. Восстановите её в боковой панели; локальные ключи E2EE сохранятся.");
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
    const pollIfVisible = () => {
      if (document.visibilityState === "visible") void loadMessages();
    };
    pollIfVisible();
    const interval = window.setInterval(pollIfVisible, 2000);
    document.addEventListener("visibilitychange", pollIfVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", pollIfVisible);
    };
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
          replyTo: replyingTo ? createMatrixReplyReference(replyingTo, currentUser.matrixSession) : undefined,
          mentionUserIds: getMatrixMentionUserIds(msgText, chat.members, currentUser.matrixSession),
        });
        const optimisticMessage: ChatMessage = {
          ...outboxItemToChatMessage(item, { id: currentUser.id, username: currentUser.username, displayName: currentUser.displayName, avatarColor: currentUser.avatarColor, avatarUrl: currentUser.avatarUrl }, chat.id),
          id: `outbox:${item.id}`,
          deliveryStatus: "sending",
          deliveryError: undefined,
        };
        updateLocalMessages((current) => [...current, optimisticMessage]);
        setNewMessage("");
        setReplyingTo(null);
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
          body: JSON.stringify({
            chatId: chat.id,
            content: msgText,
            replyToMessageId: typeof replyingTo?.id === "number" ? replyingTo.id : null,
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Не удалось отправить сообщение");
      } else {
        throw new Error("Новые сообщения в legacy-чатах заблокированы до настройки E2EE.");
      }

      await loadMessages();
      setReplyingTo(null);
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
        if (typeof replyingTo?.id === "number") {
          formData.append("replyToMessageId", String(replyingTo.id));
        }

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
          chatId: chat.id,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          fileSize: file.size,
          encryptedFile: { ...encrypted.info, url: fileUrl.toString() },
          replyTo: replyingTo ? createMatrixReplyReference(replyingTo, currentUser.matrixSession) : undefined,
        });
      } else {
        throw new Error("Этот чат не готов к безопасной загрузке файлов");
      }

      await loadMessages();
      setReplyingTo(null);
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
        <button
          type="button"
          onClick={toggleChatMute}
          disabled={muteBusy}
          className={`rounded-lg p-2 transition touch-manipulation ${notificationsMuted ? "text-amber-300 hover:bg-amber-500/10" : "text-gray-400 hover:bg-dark-600 hover:text-white"} disabled:opacity-50`}
          title={notificationsMuted ? "Уведомления отключены" : "Включить уведомления"}
          aria-label={notificationsMuted ? "Включить уведомления чата" : "Отключить уведомления чата"}
        >
          {notificationsMuted ? (
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0a3 3 0 11-6 0m6 0H9M3 3l18 18" />
            </svg>
          ) : (
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0a3 3 0 11-6 0m6 0H9" />
            </svg>
          )}
        </button>
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
              statusTitle={getMessageReceiptTitle(msg)}
              members={chat.members}
              canReply={chat.securityMode === "public" || (!msg.isLegacy && typeof msg.id === "string" && !msg.id.startsWith("outbox:"))}
              onReply={handleReplyToMessage}
              onMention={chat.isGroup ? handleMentionMessageAuthor : undefined}
              onJumpToMessage={jumpToMessage}
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
        {replyingTo && (
          <div className="mb-2 flex items-center gap-3 rounded-xl border border-sky-400/20 bg-sky-400/5 px-3 py-2">
            <div className="min-w-0 flex-1 border-l-2 border-sky-400 pl-2">
              <div className="truncate text-[11px] font-semibold text-sky-200">
                Ответ: {replyingTo.senderDisplayName}
              </div>
              <div className="truncate text-xs text-gray-400">{getReplyPreviewText(replyingTo)}</div>
            </div>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              className="rounded-lg p-1 text-gray-400 hover:bg-dark-600 hover:text-white"
              aria-label="Отменить ответ"
              title="Отменить ответ"
            >
              ×
            </button>
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
            ref={messageInputRef}
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
