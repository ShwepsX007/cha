"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { MouseEvent } from "react";
import type { User, Chat, ChatMessage } from "./ChatApp";
import { decryptAttachment, encryptAttachment } from "matrix-encrypt-attachment";
import {
  ensureDirectRoomHistoryVisibility,
  ensureEncryptedRoomReady,
  getEncryptedRoomMessages,
  hasMatrixInvitePermission,
  sendEncryptedAttachment,
  sendEncryptedText,
} from "@/lib/matrix/client";
import AddGroupMembersModal from "./AddGroupMembersModal";

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

function MessageBubble({
  msg,
  isOwn,
}: {
  msg: ChatMessage;
  isOwn: boolean;
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
            <a href={fileUrl} onClick={handleAttachmentClick} target="_blank" rel="noopener noreferrer">
              <div className="bg-dark-600 rounded-lg p-3 flex items-center gap-3 hover:bg-dark-500 transition-colors">
                <div className="w-10 h-10 bg-purple-500/20 rounded-lg flex items-center justify-center">
                  <span className="text-xl">📷</span>
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
    <div className={`flex ${isOwn ? "justify-end" : "justify-start"} mb-3`}>
      <div className={`max-w-[75%] ${isOwn ? "order-1" : ""}`}>
        {!isOwn && (
          <div className="flex items-center gap-2 mb-1">
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
              style={{ backgroundColor: msg.senderAvatarColor }}
            >
              {msg.senderDisplayName.charAt(0).toUpperCase()}
            </div>
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
            <div className="text-[9px] uppercase tracking-wide text-amber-300/80 mb-1">
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
            className={`text-[10px] mt-1 flex items-center gap-1 justify-end ${
              isOwn ? "text-purple-200" : "text-gray-500"
            }`}
          >
            {formatTime(msg.createdAt)}
            {isOwn && (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
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
}: {
  chat: Chat;
  currentUser: User;
  onBack: () => void;
  onMessageSent: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sendError, setSendError] = useState("");
  const [messageReadError, setMessageReadError] = useState("");
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [invitePermissionRoomId, setInvitePermissionRoomId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevMsgCountRef = useRef(0);

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

  const scrollToBottom = useCallback((force = false) => {
    if (force || true) {
      messagesEndRef.current?.scrollIntoView({ behavior: force ? "smooth" : "auto" });
    }
  }, []);

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

      setMessages(visibleMessages);
      if (visibleMessages.length !== prevMsgCountRef.current) {
        prevMsgCountRef.current = visibleMessages.length;
        setTimeout(() => scrollToBottom(true), 50);
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }, [
    chat.id,
    chat.matrixRoomId,
    chat.members,
    chat.securityMode,
    currentUser.matrixSession,
    prepareEncryptedChat,
    scrollToBottom,
  ]);

  useEffect(() => {
    prevMsgCountRef.current = 0;
    loadMessages();
    const interval = setInterval(loadMessages, 2000);
    return () => clearInterval(interval);
  }, [loadMessages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || sending) return;

    const msgText = newMessage.trim();
    setNewMessage("");
    setSendError("");
    setSending(true);

    try {
      if (chat.securityMode === "public") {
        const response = await fetch("/api/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: chat.id, content: msgText }),
        });
        if (!response.ok) throw new Error("Не удалось отправить сообщение");
      } else if (chat.securityMode === "e2ee" && chat.matrixRoomId && currentUser.matrixSession) {
        await prepareEncryptedChat();
        await sendEncryptedText(currentUser.matrixSession, chat.matrixRoomId, msgText);
      } else {
        throw new Error("Matrix E2EE не подключён. Сообщение не отправлено открытым текстом.");
      }

      await loadMessages();
      onMessageSent();
      scrollToBottom(true);
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

    setSendError("");
    setUploading(true);
    try {
      if (chat.securityMode === "public") {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("chatId", String(chat.id));

        const response = await fetch("/api/upload", { method: "POST", body: formData });
        if (!response.ok) throw new Error("Не удалось загрузить файл");
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
      scrollToBottom(true);
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
    chat.securityMode === "public" ||
    (chat.securityMode === "e2ee" && Boolean(chat.matrixRoomId && currentUser.matrixSession));
  const canAttachFile = canSendMessage;

  return (
    <div className="flex flex-col h-full bg-dark-900">
      {/* Chat Header */}
      <div className="px-4 py-3 bg-dark-800 border-b border-dark-600 flex items-center gap-3">
        <button
          onClick={onBack}
          className="md:hidden p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-dark-600"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <div
          className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-white text-sm shrink-0"
          style={{ backgroundColor: otherMember?.avatarColor || "#6C5CE7" }}
        >
          {(chat.name || "?").charAt(0).toUpperCase()}
        </div>

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
            className="rounded-lg p-2 text-gray-400 hover:bg-dark-600 hover:text-white"
            title="Добавить участников (создатель/админ)"
            aria-label="Добавить участников"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9a3 3 0 11-6 0 3 3 0 016 0zM3 20a6 6 0 0112 0M19 8v6m3-3h-6" />
            </svg>
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messageReadError && (
          <div className="mb-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">
            {messageReadError} Legacy-история при этом остаётся доступна ниже.
          </div>
        )}
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
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
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              isOwn={msg.senderId === currentUser.id}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 bg-dark-800 border-t border-dark-600">
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
            title={canAttachFile ? "Прикрепить файл" : "Новые файлы доступны после настройки Matrix E2EE"}
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
            placeholder={canSendMessage ? "Введите сообщение..." : "Новые сообщения заблокированы до подключения E2EE"}
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
