"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { User, Chat, ChatMessage } from "./ChatApp";
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

function getReplyPreviewText(message: ChatMessage["replyTo"]): string {
  if (!message) return "Сообщение";
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

function MessageBubble({
  msg,
  isOwn,
  registerRef,
  status,
  statusTitle,
  members,
  onReply,
  onMention,
  onJumpToMessage,
  onDelete,
  deleteBusy,
}: {
  msg: ChatMessage;
  isOwn: boolean;
  registerRef?: (id: number | string, el: HTMLDivElement | null) => void;
  status?: ChatMessage["deliveryStatus"];
  statusTitle?: string;
  members: User[];
  onReply: (message: ChatMessage) => void;
  onMention?: (message: ChatMessage) => void;
  onJumpToMessage: (id: number | string) => void;
  onDelete?: (message: ChatMessage) => void;
  deleteBusy?: boolean;
}) {
  const renderFileContent = () => {
    const hasFile = Boolean(msg.telegramFileId);
    const fileUrl = `/api/file/${msg.id}`;

    if (msg.messageType === "image") {
      return (
        <div className="mb-1">
          {hasFile ? (
            <a href={fileUrl} target="_blank" rel="noopener noreferrer" className="block">
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
                <div className="text-xs text-gray-500">Хранилище файлов недоступно</div>
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
            <a href={fileUrl} target="_blank" rel="noopener noreferrer">
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
                <div className="text-xs text-gray-500">Хранилище файлов недоступно</div>
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
            <a href={fileUrl} target="_blank" rel="noopener noreferrer">
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
                <div className="text-xs text-gray-500">Хранилище файлов недоступно</div>
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
          {msg.messageType !== "text" && renderFileContent()}
          {msg.messageType === "text" && msg.content && (
            <p className="text-sm whitespace-pre-wrap break-words">{renderMessageText(msg.content, members)}</p>
          )}
          <div
            className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${
              isOwn ? "text-purple-200" : "text-gray-500"
            }`}
          >
            <button
              type="button"
              onClick={() => onReply(msg)}
              className="mr-1 rounded px-1 text-[12px] opacity-70 transition hover:bg-black/10 hover:opacity-100"
              title="Ответить на сообщение"
              aria-label="Ответить на сообщение"
            >
              ↩
            </button>
            {isOwn && onDelete && (
              <button
                type="button"
                onClick={() => onDelete(msg)}
                disabled={deleteBusy}
                className="mr-1 rounded px-1 text-[12px] opacity-70 transition hover:bg-black/10 hover:opacity-100 disabled:opacity-30"
                title="Удалить сообщение у всех"
                aria-label="Удалить сообщение"
              >
                🗑
              </button>
            )}
            {formatTime(String(msg.createdAt))}
            {isOwn && <MessageStatus status={status} title={statusTitle} />}
          </div>
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
  onDeleteChat,
}: {
  chat: Chat;
  currentUser: User;
  onBack: () => void;
  onMessageSent: () => void;
  onChatUpdated?: (patch: Partial<Chat>) => void;
  /** Called after the whole chat was deleted (creator/admin action). */
  onDeleteChat?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sendError, setSendError] = useState("");
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [notificationsMuted, setNotificationsMuted] = useState(Boolean(chat.notificationsMuted));
  const [muteBusy, setMuteBusy] = useState(false);
  const [deletingMessageId, setDeletingMessageId] = useState<number | null>(null);
  const [deletingChat, setDeletingChat] = useState(false);

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
  // The timed ban is a moderation tool for the open general chat only; DMs
  // and private groups are never affected by it.
  const isPublicBanActive = chat.isGeneralChat && Number.isFinite(banExpiresAt) && banExpiresAt > banNow;

  useEffect(() => {
    if (!chat.isGeneralChat) return;
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
  }, [chat.isGeneralChat]);

  useEffect(() => {
    if (!banUntil) return;
    const interval = window.setInterval(() => setBanNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [banUntil]);

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
  }, [chat.id]);

  const queueReadReceipts = useCallback((messageIds: Array<number | string>) => {
    const pending = messageIds.filter((id) => !reportedReadRef.current.has(id));
    if (!pending.length) return;
    pending.forEach((id) => reportedReadRef.current.add(id));
    void sendReceipts(pending, "read").then((sent) => {
      if (!sent) pending.forEach((id) => reportedReadRef.current.delete(id));
    });
  }, [sendReceipts]);

  // On messages load, mark other users' messages delivered.
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
    if (pending.length) {
      void sendReceipts(pending, "delivered").then((sent) => {
        if (!sent) pending.forEach((id) => reportedDeliveredRef.current.delete(id));
      });
    }
  }, [messages, currentUser.id, sendReceipts]);

  // Poll receipts every few seconds so we can upgrade sent→delivered→read.
  useEffect(() => {
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
  }, [chat.id]);

  // Build (or rebuild) the IntersectionObserver once the container exists, and
  // keep a stable instance in a ref so we can observe nodes as they register.
  useEffect(() => {
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
  }, [chat.id, queueReadReceipts, messages, currentUser.id]);

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
    if (msg.senderId !== currentUser.id) return undefined;
    if (typeof msg.id === "number") {
      const r = receipts[msg.id];
      if (r) return r.status;
    }
    return "sent";
  }, [currentUser.id, receipts]);

  const handleReplyToMessage = useCallback((message: ChatMessage) => {
    setReplyingTo(message);
    window.setTimeout(() => messageInputRef.current?.focus(), 0);
  }, []);

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
    if (summary?.status === "read" && readByCount !== undefined && recipientCount !== undefined) {
      return `Прочитано: ${summary.readByCount} из ${summary.recipientCount}`;
    }
    if (summary?.status === "delivered" && deliveredToCount !== undefined && recipientCount !== undefined) {
      return `Доставлено: ${summary.deliveredToCount} из ${summary.recipientCount}`;
    }
    return undefined;
  }, [currentUser.id, receipts]);

  const loadMessages = useCallback(async () => {
    try {
      const isVisible = document.visibilityState === "visible";
      const res = await fetch(`/api/messages?chatId=${chat.id}`, {
        headers: { "X-Chat-Visible": isVisible ? "1" : "0" },
      });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.messages)) return;
      const nextMessages: ChatMessage[] = data.messages;
      setMessages(nextMessages);
      if (nextMessages.length !== prevMsgCountRef.current) {
        prevMsgCountRef.current = nextMessages.length;
        const wasNearBottom = isNearBottom();
        window.requestAnimationFrame(() => {
          if (initialLoadRef.current || wasNearBottom) scrollToBottom(initialLoadRef.current ? "auto" : "smooth");
        });
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }, [chat.id, isNearBottom, scrollToBottom]);

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
      window.removeEventListener("visibilitychange", pollIfVisible);
    };
  }, [loadMessages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || sending) return;
    if (isPublicBanActive) {
      setSendError("Отправка в общий чат заблокирована на время действия бана.");
      return;
    }

    const msgText = newMessage.trim();
    setSendError("");
    setNewMessage("");
    setSending(true);
    try {
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
      const formData = new FormData();
      formData.append("file", file);
      formData.append("chatId", String(chat.id));
      if (typeof replyingTo?.id === "number") {
        formData.append("replyToMessageId", String(replyingTo.id));
      }

      const response = await fetch("/api/upload", { method: "POST", body: formData });
      const uploadResult = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(uploadResult.error || "Не удалось загрузить файл");

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
  const canManageMembers = chat.isGroup
    && (chat.createdBy === currentUser.id || currentUser.role === "admin");
  // Deleting a chat is the creator's (or an admin's) decision and it wipes the
  // conversation for everybody; the general chat is protected on the server.
  const canDeleteChat = !chat.isGeneralChat
    && (chat.createdBy === currentUser.id || currentUser.role === "admin");

  const handleDeleteMessage = useCallback(async (message: ChatMessage) => {
    if (deletingMessageId !== null || typeof message.id !== "number") return;
    if (!window.confirm("Удалить это сообщение у всех участников? Файл-вложение тоже будет удалён.")) return;
    setDeletingMessageId(message.id);
    setSendError("");
    try {
      const response = await fetch(`/api/messages?messageId=${message.id}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "Не удалось удалить сообщение");
      await loadMessages();
      onMessageSent();
    } catch (err) {
      console.error("Failed to delete message", err);
      setSendError(err instanceof Error ? err.message : "Не удалось удалить сообщение");
    } finally {
      setDeletingMessageId(null);
    }
  }, [deletingMessageId, loadMessages, onMessageSent]);

  const handleDeleteChat = useCallback(async () => {
    if (deletingChat) return;
    const what = chat.isGroup ? "группу" : "чат";
    if (!window.confirm(`Удалить ${what} «${chat.name}» со всеми сообщениями и файлами? Это необратимо и для остальных участников.`)) return;
    setDeletingChat(true);
    try {
      const response = await fetch(`/api/chats/${chat.id}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "Не удалось удалить чат");
      onDeleteChat?.();
    } catch (err) {
      console.error("Failed to delete chat", err);
      setSendError(err instanceof Error ? err.message : "Не удалось удалить чат");
    } finally {
      setDeletingChat(false);
    }
  }, [chat.id, chat.isGroup, chat.name, deletingChat, onDeleteChat]);

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
        {canManageMembers && (
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
        {canDeleteChat && (
          <button
            type="button"
            onClick={() => void handleDeleteChat()}
            disabled={deletingChat}
            className="rounded-lg p-2 text-gray-400 hover:bg-red-500/10 hover:text-red-300 touch-manipulation disabled:opacity-50"
            title={chat.isGroup ? "Удалить группу (создатель)" : "Удалить чат (создатель)"}
            aria-label="Удалить чат"
          >
            {deletingChat ? (
              <span className="block h-5 w-5 animate-spin rounded-full border-2 border-red-300 border-t-transparent" />
            ) : (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            )}
          </button>
        )}
        </div>
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} className="flex min-h-0 flex-1 flex-col justify-end overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] [-webkit-overflow-scrolling:touch]">
        {messages.length === 0 ? (
          <div className="flex min-h-[60dvh] flex-col items-center justify-center text-center">
            <div className="text-4xl mb-3">💬</div>
            <p className="text-gray-500 text-sm">Начните разговор!</p>
            <p className="text-gray-600 text-xs mt-1">
              {chat.isGeneralChat ? "Общий чат доступен всем участникам" : "Сообщения и файлы видят только участники чата"}
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              isOwn={msg.senderId === currentUser.id}
              registerRef={registerMessageEl}
              status={getMessageStatus(msg)}
              statusTitle={getMessageReceiptTitle(msg)}
              members={chat.members}
              onReply={handleReplyToMessage}
              onMention={chat.isGroup ? handleMentionMessageAuthor : undefined}
              onJumpToMessage={jumpToMessage}
              onDelete={msg.senderId === currentUser.id ? handleDeleteMessage : undefined}
              deleteBusy={deletingMessageId !== null}
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
            disabled={uploading}
            className="p-2.5 text-gray-400 hover:text-purple-400 rounded-xl hover:bg-dark-700 transition-colors disabled:opacity-50"
            title={isPublicBanActive ? "Загрузка заблокирована на время бана" : "Прикрепить файл"}
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
            disabled={sending}
            className="flex-1 px-4 py-2.5 bg-dark-700 border border-dark-500 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50"
            placeholder={isPublicBanActive ? "Отправка заблокирована до окончания бана" : "Введите сообщение..."}
            autoComplete="off"
          />

          <button
            type="submit"
            disabled={!newMessage.trim() || sending}
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
