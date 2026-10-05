"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type AdminUser = {
  id: number;
  username: string;
  displayName: string;
  avatarColor: string;
  role: "user" | "admin";
  bannedUntil: string | null;
  banReason: string | null;
  createdAt: string;
  lastSeen: string | null;
};

type AdminChat = {
  id: number;
  name: string | null;
  isGroup: boolean;
  createdAt: string;
};

type AdminMessage = {
  id: number;
  chatId: number;
  chatName: string | null;
  senderId: number;
  senderUsername: string;
  senderDisplayName: string;
  content: string | null;
  messageType: string;
  fileName: string | null;
  createdAt: string;
};

type AuditEntry = {
  id: number;
  adminId: number | null;
  adminUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: unknown;
  createdAt: string;
};

type SystemStatus = {
  counts: { users: number; chats: number; messages: number; auditLogs: number };
};

type Tab = "users" | "moderation" | "system" | "audit";

const BAN_OPTIONS = [
  { value: "15m", label: "15 минут" },
  { value: "1h", label: "1 час" },
  { value: "24h", label: "24 часа" },
  { value: "7d", label: "7 дней" },
  { value: "100y", label: "Навсегда · 100 лет" },
];

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "users", label: "Пользователи" },
  { id: "moderation", label: "Модерация" },
  { id: "system", label: "Система" },
  { id: "audit", label: "Аудит" },
];

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({}));
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ru-RU");
}

function isBanActive(user: AdminUser): boolean {
  return Boolean(user.bannedUntil && new Date(user.bannedUntil).getTime() > Date.now());
}

export default function AdminDashboard({ admin }: { admin: { id: number; username: string; displayName: string } }) {
  const [tab, setTab] = useState<Tab>("users");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState("");
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  const [banDurations, setBanDurations] = useState<Record<number, string>>({});
  const [banReasons, setBanReasons] = useState<Record<number, string>>({});

  const [chats, setChats] = useState<AdminChat[]>([]);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [selectedChat, setSelectedChat] = useState("");
  const [selectedSender, setSelectedSender] = useState("");
  const [selectedMessages, setSelectedMessages] = useState<number[]>([]);
  const [moderationLoading, setModerationLoading] = useState(false);

  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [wipeConfirmation, setWipeConfirmation] = useState("");
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);

  useEffect(() => {
    if (tab !== "users" && tab !== "moderation") return;
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      if (tab === "users") setUserSearchLoading(true);
      try {
        const params = new URLSearchParams();
        if (tab === "users" && search.trim()) params.set("q", search.trim());
        const response = await fetch(`/api/admin/users${params.size ? `?${params}` : ""}`, { cache: "no-store" });
        const data = await readJson(response);
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Не удалось загрузить пользователей");
        if (!cancelled) setUsers(Array.isArray(data.users) ? data.users as AdminUser[] : []);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить пользователей");
      } finally {
        if (!cancelled) setUserSearchLoading(false);
      }
    }, tab === "users" ? 200 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [tab, search]);

  useEffect(() => {
    if (tab !== "moderation") return;
    let cancelled = false;
    const loadModeration = async () => {
      setModerationLoading(true);
      try {
        const params = new URLSearchParams();
        if (selectedChat) params.set("chatId", selectedChat);
        if (selectedSender) params.set("senderId", selectedSender);
        const response = await fetch(`/api/admin/moderation${params.size ? `?${params}` : ""}`, { cache: "no-store" });
        const data = await readJson(response);
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Не удалось загрузить модерацию");
        if (!cancelled) {
          setChats(Array.isArray(data.chats) ? data.chats as AdminChat[] : []);
          setMessages(Array.isArray(data.messages) ? data.messages as AdminMessage[] : []);
          setSelectedMessages([]);
        }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить модерацию");
      } finally {
        if (!cancelled) setModerationLoading(false);
      }
    };
    void loadModeration();
    return () => { cancelled = true; };
  }, [tab, selectedChat, selectedSender]);

  useEffect(() => {
    if (tab !== "system") return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/admin/system", { cache: "no-store" });
        const data = await readJson(response);
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Не удалось загрузить состояние системы");
        if (!cancelled) setSystemStatus(data as unknown as SystemStatus);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить состояние системы");
      }
    })();
    return () => { cancelled = true; };
  }, [tab]);

  useEffect(() => {
    if (tab !== "audit") return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/admin/audit?limit=200", { cache: "no-store" });
        const data = await readJson(response);
        if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Не удалось загрузить журнал");
        if (!cancelled) setAuditEntries(Array.isArray(data.logs) ? data.logs as AuditEntry[] : []);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить журнал");
      }
    })();
    return () => { cancelled = true; };
  }, [tab]);

  const clearFeedback = () => {
    setError("");
    setNotice("");
  };

  const refreshUsers = async () => {
    const params = new URLSearchParams();
    if (tab === "users" && search.trim()) params.set("q", search.trim());
    const response = await fetch(`/api/admin/users${params.size ? `?${params}` : ""}`, { cache: "no-store" });
    const data = await readJson(response);
    if (response.ok && Array.isArray(data.users)) setUsers(data.users as AdminUser[]);
  };

  const runUserAction = async (userId: number, action: string, extra: Record<string, unknown> = {}) => {
    clearFeedback();
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await readJson(response);
      if (!response.ok && response.status !== 202) throw new Error(typeof data.error === "string" ? data.error : "Действие не выполнено");
      setNotice(typeof data.warning === "string" ? data.warning : "Действие выполнено.");
      await refreshUsers();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Действие не выполнено");
    } finally {
      setBusy(false);
    }
  };

  const deleteUser = async (user: AdminUser) => {
    if (user.id === admin.id) return;
    if (!window.confirm(`Удалить аккаунт @${user.username}? Его сообщения, чаты и файлы в PostgreSQL будут удалены каскадно.`)) return;
    clearFeedback();
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
      const data = await readJson(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Не удалось удалить пользователя");
      setNotice("Пользователь удалён.");
      await refreshUsers();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Не удалось удалить пользователя");
    } finally {
      setBusy(false);
    }
  };

  const loadModerationAgain = async () => {
    const params = new URLSearchParams();
    if (selectedChat) params.set("chatId", selectedChat);
    if (selectedSender) params.set("senderId", selectedSender);
    const response = await fetch(`/api/admin/moderation${params.size ? `?${params}` : ""}`, { cache: "no-store" });
    const data = await readJson(response);
    if (response.ok) {
      setMessages(Array.isArray(data.messages) ? data.messages as AdminMessage[] : []);
      setSelectedMessages([]);
    }
  };

  const moderationAction = async (action: string, extra: Record<string, unknown> = {}) => {
    clearFeedback();
    setBusy(true);
    try {
      const response = await fetch("/api/admin/moderation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Действие модерации не выполнено");
      setNotice(`Готово. Удалено сообщений: ${String(data.deletedMessages ?? 0)}.`);
      await loadModerationAgain();
      if (tab === "system") setSystemStatus(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Действие модерации не выполнено");
    } finally {
      setBusy(false);
    }
  };

  const runSystemAction = async (action: string, confirmation?: string) => {
    clearFeedback();
    setBusy(true);
    try {
      const response = await fetch("/api/admin/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(confirmation !== undefined ? { confirmation } : {}) }),
      });
      const data = await readJson(response);
      if (!response.ok && response.status !== 202) throw new Error(typeof data.error === "string" ? data.error : "Системное действие не выполнено");
      setNotice(typeof data.warning === "string" ? data.warning : "Системное действие выполнено.");
      setWipeConfirmation("");
      const statusResponse = await fetch("/api/admin/system", { cache: "no-store" });
      const statusData = await readJson(statusResponse);
      if (statusResponse.ok) setSystemStatus(statusData as unknown as SystemStatus);
      if (tab === "users") await refreshUsers();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Системное действие не выполнено");
    } finally {
      setBusy(false);
    }
  };

  const tabButtonClass = (selected: boolean) =>
    `rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${selected ? "bg-purple-500 text-white" : "text-gray-400 hover:bg-dark-700 hover:text-white"}`;

  return (
    <main className="min-h-screen bg-[#0a0a0f] px-4 py-6 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <Link href="/" className="mb-2 inline-flex items-center gap-2 text-xs text-gray-500 hover:text-purple-300">
              <span aria-hidden="true">←</span> Вернуться в чат
            </Link>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Панель администратора</h1>
            <p className="mt-1 text-sm text-gray-400">Вход выполнен как @{admin.username} · ID {admin.id}</p>
          </div>
          <div className="rounded-xl border border-dark-600 bg-dark-800 px-4 py-3 text-xs text-gray-400">
            Администратор: <span className="font-semibold text-purple-200">{admin.displayName}</span>
          </div>
        </header>

        <nav className="mb-5 flex flex-wrap gap-2 rounded-2xl border border-dark-600 bg-dark-800 p-2" aria-label="Разделы админ-панели">
          {TABS.map((item) => (
            <button key={item.id} type="button" onClick={() => { clearFeedback(); setTab(item.id); }} className={tabButtonClass(tab === item.id)}>
              {item.label}
            </button>
          ))}
        </nav>

        {(error || notice) && (
          <div className={`mb-5 rounded-xl border px-4 py-3 text-sm ${error ? "border-red-500/30 bg-red-500/10 text-red-200" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"}`} role={error ? "alert" : "status"}>
            {error || notice}
          </div>
        )}

        {tab === "users" && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-dark-600 bg-dark-800 p-4 sm:p-5">
              <label htmlFor="user-search" className="mb-2 block text-sm font-semibold">Найти пользователя</label>
              <input
                id="user-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Имя, username или ID"
                className="w-full rounded-xl border border-dark-500 bg-dark-900 px-4 py-3 text-sm outline-none transition focus:border-purple-500 sm:max-w-xl"
              />
              <p className="mt-2 text-xs text-gray-500">Поиск работает по username, отображаемому имени и ID. Email в схеме аккаунтов не хранится.</p>
            </div>
            {userSearchLoading ? <p className="px-2 py-8 text-center text-sm text-gray-500">Загрузка пользователей…</p> : users.length === 0 ? (
              <div className="rounded-2xl border border-dark-600 bg-dark-800 p-8 text-center text-sm text-gray-500">Пользователи не найдены.</div>
            ) : users.map((user) => {
              const banActive = isBanActive(user);
              return (
                <article key={user.id} className="rounded-2xl border border-dark-600 bg-dark-800 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold" style={{ backgroundColor: user.avatarColor || "#6C5CE7" }}>
                        {(user.displayName || user.username).slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="truncate font-semibold">{user.displayName}</h2>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${user.role === "admin" ? "bg-purple-500/20 text-purple-200" : "bg-dark-600 text-gray-400"}`}>
                            {user.role === "admin" ? "Администратор" : "Пользователь"}
                          </span>
                          {banActive && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-300">Бан активен</span>}
                        </div>
                        <p className="mt-0.5 truncate text-sm text-gray-400">@{user.username} · ID {user.id}</p>
                        <p className="mt-1 text-xs text-gray-500">Создан: {dateLabel(user.createdAt)} · Был(а): {dateLabel(user.lastSeen)}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="sr-only" htmlFor={`role-${user.id}`}>Роль пользователя {user.username}</label>
                      <select
                        id={`role-${user.id}`}
                        value={user.role}
                        disabled={busy}
                        onChange={(event) => void runUserAction(user.id, "role", { role: event.target.value })}
                        className="rounded-lg border border-dark-500 bg-dark-900 px-3 py-2 text-xs text-gray-200 outline-none focus:border-purple-500 disabled:opacity-50"
                      >
                        <option value="user">Пользователь</option>
                        <option value="admin">Администратор</option>
                      </select>
                      <button
                        type="button"
                        disabled={busy || user.id === admin.id}
                        onClick={() => void deleteUser(user)}
                        className="rounded-lg border border-red-500/30 px-3 py-2 text-xs text-red-200 transition hover:bg-red-500/10 disabled:opacity-40"
                      >Удалить</button>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 border-t border-dark-600 pt-4 md:grid-cols-[1fr_auto] md:items-end">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-xs text-gray-400">
                        Срок бана в общем чате
                        <select
                          value={banDurations[user.id] || "1h"}
                          onChange={(event) => setBanDurations((state) => ({ ...state, [user.id]: event.target.value }))}
                          className="mt-1.5 w-full rounded-lg border border-dark-500 bg-dark-900 px-3 py-2.5 text-sm text-gray-200 outline-none focus:border-purple-500"
                        >
                          {BAN_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </label>
                      <label className="text-xs text-gray-400">
                        Причина (необязательно)
                        <input
                          value={banReasons[user.id] ?? user.banReason ?? ""}
                          onChange={(event) => setBanReasons((state) => ({ ...state, [user.id]: event.target.value }))}
                          maxLength={500}
                          placeholder="Причина блокировки"
                          className="mt-1.5 w-full rounded-lg border border-dark-500 bg-dark-900 px-3 py-2.5 text-sm text-gray-200 outline-none focus:border-purple-500"
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={busy || user.id === admin.id}
                        onClick={() => void runUserAction(user.id, "ban", { duration: banDurations[user.id] || "1h", reason: banReasons[user.id] ?? user.banReason ?? "" })}
                        className="rounded-lg bg-red-500/15 px-4 py-2.5 text-xs font-semibold text-red-200 transition hover:bg-red-500/25 disabled:opacity-40"
                        title={user.id === admin.id ? "Нельзя забанить себя" : "Запретить отправку в общий чат"}
                      >{banActive ? "Изменить бан" : "Забанить"}</button>
                      {user.bannedUntil && (
                        <button type="button" disabled={busy} onClick={() => void runUserAction(user.id, "unban")} className="rounded-lg border border-emerald-500/30 px-4 py-2.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-50">
                          Разбанить
                        </button>
                      )}
                    </div>
                  </div>
                  {user.bannedUntil && (
                    <p className="mt-3 text-xs text-gray-500">
                      {banActive ? "Доступ восстановится автоматически: " : "Последний срок бана: "}{dateLabel(user.bannedUntil)}
                      {user.banReason && <span> · Причина: {user.banReason}</span>}
                    </p>
                  )}
                </article>
              );
            })}
          </section>
        )}

        {tab === "moderation" && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-relaxed text-amber-100/80">
              Модерация работает с записями PostgreSQL: все чаты (общие, личные и группы) хранятся здесь же. Telegram-файлы вложений хранятся отдельно.
            </div>
            <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-dark-600 bg-dark-800 p-4">
              <label className="min-w-52 flex-1 text-xs text-gray-400">
                Чат
                <select value={selectedChat} onChange={(event) => setSelectedChat(event.target.value)} className="mt-1.5 w-full rounded-lg border border-dark-500 bg-dark-900 px-3 py-2.5 text-sm text-gray-200">
                  <option value="">Все чаты</option>
                  {chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.name || `Чат #${chat.id}`}</option>)}
                </select>
              </label>
              <label className="w-48 text-xs text-gray-400">
                ID автора
                <input value={selectedSender} onChange={(event) => setSelectedSender(event.target.value.replace(/\D/g, ""))} placeholder="Все авторы" inputMode="numeric" className="mt-1.5 w-full rounded-lg border border-dark-500 bg-dark-900 px-3 py-2.5 text-sm text-gray-200" />
              </label>
              <button
                type="button"
                disabled={busy || !selectedChat}
                onClick={() => {
                  const chat = chats.find((item) => item.id === Number(selectedChat));
                  if (chat && window.confirm(`Удалить все сообщения из «${chat.name || `чата #${chat.id}`}»?`)) {
                    void moderationAction("clear_chat", { chatId: chat.id });
                  }
                }}
                className="rounded-lg border border-red-500/30 px-4 py-2.5 text-xs font-semibold text-red-200 hover:bg-red-500/10 disabled:opacity-40"
              >Очистить выбранный чат</button>
              <button
                type="button"
                disabled={busy || !selectedSender}
                onClick={() => {
                  if (window.confirm(`Удалить все сообщения PostgreSQL пользователя ID ${selectedSender}?`)) {
                    void moderationAction("delete_user_messages", { senderId: Number(selectedSender) });
                  }
                }}
                className="rounded-lg border border-red-500/30 px-4 py-2.5 text-xs font-semibold text-red-200 hover:bg-red-500/10 disabled:opacity-40"
              >Удалить сообщения автора</button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-gray-500">Показаны последние 200 записей. Удалено отмеченных: выборочные сообщения удаляются только из PostgreSQL.</p>
              <button
                type="button"
                disabled={busy || selectedMessages.length === 0}
                onClick={() => {
                  if (window.confirm(`Удалить ${selectedMessages.length} выбранных записей?`)) {
                    void moderationAction("delete_messages", { messageIds: selectedMessages });
                  }
                }}
                className="rounded-lg bg-red-500/15 px-4 py-2.5 text-xs font-semibold text-red-200 hover:bg-red-500/25 disabled:opacity-40"
              >Удалить выбранные ({selectedMessages.length})</button>
            </div>

            {moderationLoading ? <p className="py-8 text-center text-sm text-gray-500">Загрузка сообщений…</p> : messages.length === 0 ? (
              <div className="rounded-2xl border border-dark-600 bg-dark-800 p-8 text-center text-sm text-gray-500">Сообщений PostgreSQL не найдено.</div>
            ) : (
              <div className="space-y-2">
                {messages.map((message) => (
                  <label key={message.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-dark-600 bg-dark-800 p-3 transition hover:border-dark-500">
                    <input
                      type="checkbox"
                      checked={selectedMessages.includes(message.id)}
                      onChange={(event) => setSelectedMessages((state) => event.target.checked ? [...state, message.id] : state.filter((id) => id !== message.id))}
                      className="mt-1 accent-purple-500"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span className="font-semibold text-purple-200">{message.senderDisplayName} · @{message.senderUsername}</span>
                        <span className="text-gray-600">ID {message.senderId}</span>
                        <span className="text-gray-500">{message.chatName || `Чат #${message.chatId}`}</span>
                        <time className="text-gray-600">{dateLabel(message.createdAt)}</time>
                      </div>
                      <p className="mt-1 break-words text-sm text-gray-200">{message.content || message.fileName || `[${message.messageType}]`}</p>
                      {message.fileName && <p className="mt-1 text-xs text-gray-500">Вложение: {message.fileName}</p>}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "system" && (
          <section className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ["Пользователи", systemStatus?.counts.users],
                ["Чаты", systemStatus?.counts.chats],
                ["Записи сообщений", systemStatus?.counts.messages],
                ["Записи аудита", systemStatus?.counts.auditLogs],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-2xl border border-dark-600 bg-dark-800 p-4">
                  <p className="text-xs text-gray-500">{label}</p>
                  <p className="mt-2 text-2xl font-bold">{typeof value === "number" ? value : "—"}</p>
                </div>
              ))}
            </div>
            <div className="rounded-2xl border border-red-500/30 bg-red-950/20 p-5 sm:p-6">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-red-300">Опасная зона</p>
              <h2 className="mt-2 text-xl font-bold">Nuclear wipe</h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-gray-300">
                Удалит чаты, сообщения и все аккаунты, кроме текущего администратора. Журнал аудита сохранится.
              </p>
              <label htmlFor="wipe-confirmation" className="mt-5 block text-xs font-semibold text-red-200">Для подтверждения введите ровно: УДАЛИТЬ ВСЁ</label>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                <input
                  id="wipe-confirmation"
                  value={wipeConfirmation}
                  onChange={(event) => setWipeConfirmation(event.target.value)}
                  placeholder="УДАЛИТЬ ВСЁ"
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-xl border border-red-500/30 bg-dark-900 px-4 py-3 text-sm outline-none focus:border-red-400"
                />
                <button
                  type="button"
                  disabled={busy || wipeConfirmation !== "УДАЛИТЬ ВСЁ"}
                  onClick={() => void runSystemAction("nuclear_wipe", wipeConfirmation)}
                  className="rounded-xl bg-red-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-30"
                >Удалить всё</button>
              </div>
            </div>
          </section>
        )}

        {tab === "audit" && (
          <section className="space-y-3">
            <div className="rounded-xl border border-dark-600 bg-dark-800 px-4 py-3 text-xs text-gray-400">Последние {auditEntries.length} действий. Журнал хранится отдельно и переживает nuclear wipe.</div>
            {auditEntries.length === 0 ? <div className="rounded-2xl border border-dark-600 bg-dark-800 p-8 text-center text-sm text-gray-500">Записей аудита пока нет.</div> : auditEntries.map((entry) => (
              <article key={entry.id} className="rounded-xl border border-dark-600 bg-dark-800 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-semibold text-purple-200">{entry.action}</span>
                    <span className="ml-2 text-xs text-gray-500">{entry.targetType || "system"}{entry.targetId ? ` · ${entry.targetId}` : ""}</span>
                  </div>
                  <time className="text-xs text-gray-500">{dateLabel(entry.createdAt)}</time>
                </div>
                <p className="mt-1 text-xs text-gray-400">Администратор: {entry.adminUsername ? `@${entry.adminUsername}` : `ID ${entry.adminId ?? "удалён"}`}</p>
                {entry.details != null && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-dark-900 p-3 text-[11px] leading-relaxed text-gray-500">{JSON.stringify(entry.details, null, 2)}</pre>}
              </article>
            ))}
          </section>
        )}

        <footer className="mt-8 border-t border-dark-700 py-4 text-center text-[11px] text-gray-600">
          Административные запросы повторно проверяют сессию и роль на сервере; скрытая ссылка не является защитой.
        </footer>
      </div>
    </main>
  );
}
