"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { User, Chat, ChatMessage } from "./ChatApp";

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
  const renderFileContent = () => {
    const hasFile = msg.telegramFileId;
    const fileUrl = `/api/file/${msg.id}`;

    if (msg.messageType === "image") {
      return (
        <div className="mb-1">
          {hasFile ? (
            <a href={fileUrl} target="_blank" rel="noopener noreferrer">
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
          {msg.messageType !== "text" && renderFileContent()}
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevMsgCountRef = useRef(0);

  const scrollToBottom = useCallback((force = false) => {
    if (force || true) {
      messagesEndRef.current?.scrollIntoView({ behavior: force ? "smooth" : "auto" });
    }
  }, []);

  const loadMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/messages?chatId=${chat.id}`);
      const data = await res.json();
      if (data.messages) {
        setMessages(data.messages);
        if (data.messages.length !== prevMsgCountRef.current) {
          prevMsgCountRef.current = data.messages.length;
          setTimeout(() => scrollToBottom(true), 50);
        }
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }, [chat.id, scrollToBottom]);

  useEffect(() => {
    prevMsgCountRef.current = 0;
    loadMessages();
    const interval = setInterval(loadMessages, 2000);
    return () => clearInterval(interval);
  }, [loadMessages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || sending) return;

    const msgText = newMessage;
    setNewMessage("");
    setSending(true);

    try {
      await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: chat.id, content: msgText }),
      });
      await loadMessages();
      onMessageSent();
      scrollToBottom(true);
    } catch (err) {
      console.error("Failed to send:", err);
      setNewMessage(msgText);
    } finally {
      setSending(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("chatId", String(chat.id));

      await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      await loadMessages();
      onMessageSent();
      scrollToBottom(true);
    } catch (err) {
      console.error("Failed to upload:", err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const otherMember = chat.members.find((m) => m.id !== currentUser.id);

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
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-4xl mb-3">🔐</div>
              <p className="text-gray-500 text-sm">Начните разговор!</p>
              <p className="text-gray-600 text-xs mt-1">Сообщения видны только участникам чата</p>
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
            title="Прикрепить файл"
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
            className="flex-1 px-4 py-2.5 bg-dark-700 border border-dark-500 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-colors"
            placeholder="Введите сообщение..."
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
    </div>
  );
}

function isOnline(lastSeen?: string | null): boolean {
  if (!lastSeen) return false;
  const diff = Date.now() - new Date(lastSeen).getTime();
  return diff < 60000; // 1 minute
}
