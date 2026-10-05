"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Avatar from "@/components/Avatar";
import type { User } from "./ChatApp";
import {
  arePushNotificationsSupported,
  getPushPermissionState,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push-client";

interface Props {
  user: User;
  onClose: () => void;
  onProfileUpdated: (patch: Partial<User>) => void;
}

type Tab = "profile" | "password" | "notifications";

function initialsColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 65% 58%)`;
}

export default function ProfileSettingsModal({ user, onClose, onProfileUpdated }: Props) {
  const [tab, setTab] = useState<Tab>("profile");
  const [displayName, setDisplayName] = useState(user.displayName);
  const [displayNameError, setDisplayNameError] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameNotice, setNameNotice] = useState("");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordNotice, setPasswordNotice] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl || null);
  const [avatarVersion, setAvatarVersion] = useState(1);
  const [uploadError, setUploadError] = useState("");
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [pushSupported, setPushSupported] = useState(false);
  const [pushStatus, setPushStatus] = useState<"loading" | "granted" | "denied" | "prompt" | "unsupported">("loading");
  const [pushBusy, setPushBusy] = useState(false);
  const [testingPush, setTestingPush] = useState(false);
  const [pushSubscriptionCount, setPushSubscriptionCount] = useState<number | null>(null);
  const [pushNotice, setPushNotice] = useState("");

  const refreshPushSubscriptionCount = useCallback(async () => {
    try {
      const response = await fetch("/api/push/status", { cache: "no-store" });
      const data = await response.json();
      setPushSubscriptionCount(
        response.ok && Number.isInteger(data.subscriptionCount) ? data.subscriptionCount as number : null,
      );
    } catch {
      setPushSubscriptionCount(null);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!arePushNotificationsSupported()) {
        if (mounted) {
          setPushSupported(false);
          setPushStatus("unsupported");
        }
        return;
      }
      setPushSupported(true);
      const permission = await getPushPermissionState();
      if (!mounted) return;
      if (permission === "granted") setPushStatus("granted");
      else if (permission === "denied") setPushStatus("denied");
      else setPushStatus("prompt");
      await refreshPushSubscriptionCount();
    })();
    return () => { mounted = false; };
  }, [refreshPushSubscriptionCount]);

  const handleEnablePush = async () => {
    setPushBusy(true);
    setPushNotice("");
    const result = await subscribeToPush();
    setPushBusy(false);
    if (result.ok) {
      setPushStatus("granted");
      setPushNotice(result.iosHint
        ? "Push включены. На iOS уведомления приходят только после «Добавить на главный экран»."
        : "Push-уведомления включены");
      onProfileUpdated({ pushEnabled: true });
      void refreshPushSubscriptionCount();
    } else {
      if (result.denied) setPushStatus("denied");
      else setPushStatus("prompt");
      setPushNotice(result.error || "Не удалось включить уведомления");
    }
  };

  const handleDisablePush = async () => {
    setPushBusy(true);
    setPushNotice("");
    await unsubscribeFromPush();
    setPushBusy(false);
    setPushStatus((await getPushPermissionState()) === "denied" ? "denied" : "prompt");
    setPushNotice("Push-уведомления отключены");
    onProfileUpdated({ pushEnabled: false });
    void refreshPushSubscriptionCount();
  };

  const handleTestPush = async () => {
    setTestingPush(true);
    setPushNotice("");
    try {
      const response = await fetch("/api/push/test", { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Не удалось отправить тестовое уведомление");
      setPushNotice(`Тестовое уведомление отправлено на устройств: ${String(data.sent ?? 0)}`);
    } catch (error) {
      setPushNotice(error instanceof Error ? error.message : "Не удалось отправить тестовое уведомление");
    } finally {
      setTestingPush(false);
      void refreshPushSubscriptionCount();
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const refreshProfile = async () => {
    const response = await fetch("/api/profile/me", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.user) throw new Error("Не удалось обновить профиль");
    setAvatarUrl(data.user.avatarUrl || null);
    setAvatarVersion((v) => v + 1);
    setDisplayName(data.user.displayName);
    onProfileUpdated(data.user);
  };

  const saveDisplayName = async (event: React.FormEvent) => {
    event.preventDefault();
    setDisplayNameError("");
    setNameNotice("");
    const trimmed = displayName.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (!trimmed || trimmed.length > 50) {
      setDisplayNameError("Имя должно быть от 1 до 50 символов");
      return;
    }
    if (/[<>]|[\u0000-\u001f\u007f]/.test(trimmed)) {
      setDisplayNameError("Имя содержит недопустимые символы");
      return;
    }
    setSavingName(true);
    try {
      const response = await fetch("/api/profile/display-name", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: trimmed }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось сохранить имя");
      await refreshProfile();
      setNameNotice("Имя обновлено");
    } catch (error) {
      setDisplayNameError(error instanceof Error ? error.message : "Не удалось сохранить имя");
    } finally {
      setSavingName(false);
    }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordError("");
    setPasswordNotice("");
    if (!newPassword || !confirmPassword) {
      setPasswordError("Введите новый пароль и подтвердите его");
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError("Новый пароль должен быть не короче 6 символов");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Пароли не совпадают");
      return;
    }
    setSavingPassword(true);
    try {
      const response = await fetch("/api/profile/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword, confirmPassword }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось сменить пароль");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordNotice("Пароль изменён.");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Не удалось сменить пароль");
    } finally {
      setSavingPassword(false);
    }
  };

  const handleAvatarChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setUploadError("");
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setUploadError("Поддерживаются только JPG, PNG и WebP");
      event.target.value = "";
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setUploadError("Файл слишком большой. Максимум 2 МБ");
      event.target.value = "";
      return;
    }
    setUploadingAvatar(true);
    try {
      const formData = new FormData();
      formData.append("avatar", file);
      const response = await fetch("/api/profile/avatar", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось загрузить аватарку");
      setAvatarUrl(data.avatarUrl || null);
      setAvatarVersion((v) => v + 1);
      await refreshProfile();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Не удалось загрузить аватарку");
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeAvatar = async () => {
    setUploadError("");
    try {
      const response = await fetch("/api/profile/avatar", { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Не удалось удалить аватарку");
      }
      setAvatarUrl(null);
      setAvatarVersion((v) => v + 1);
      await refreshProfile();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Не удалось удалить аватарку");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6" role="dialog" aria-modal="true" aria-label="Настройки профиля">
      <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-dark-600 bg-dark-800 shadow-2xl">
        <div className="flex items-center justify-between border-b border-dark-600 px-5 py-4">
          <h2 className="text-lg font-semibold text-white">Настройки профиля</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 transition hover:bg-dark-700 hover:text-white" aria-label="Закрыть">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex gap-2 border-b border-dark-600 px-5 py-3">
          {[
            { id: "profile" as const, label: "Профиль" },
            { id: "password" as const, label: "Пароль" },
            { id: "notifications" as const, label: "Уведомления" },
          ].map((item) => (
            <button key={item.id} type="button" onClick={() => setTab(item.id)} className={`rounded-lg px-4 py-2 text-sm font-medium transition ${tab === item.id ? "bg-purple-500 text-white" : "text-gray-400 hover:bg-dark-700 hover:text-white"}`}>
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {tab === "profile" && (
            <div className="grid gap-6 md:grid-cols-[1fr_220px]">
              <form onSubmit={saveDisplayName} className="space-y-5">
                <div>
                  <label htmlFor="username-field" className="block text-sm font-medium text-gray-300">Логин</label>
                  <input id="username-field" value={user.username} disabled className="mt-1.5 w-full cursor-not-allowed rounded-xl border border-dark-600 bg-dark-900 px-4 py-3 text-sm text-gray-500" />
                  <p className="mt-1 text-xs text-gray-500">Логин нельзя изменить</p>
                </div>

                <div>
                  <label htmlFor="display-name-field" className="block text-sm font-medium text-gray-300">Отображаемое имя</label>
                  <input
                    id="display-name-field"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    maxLength={50}
                    className="mt-1.5 w-full rounded-xl border border-dark-500 bg-dark-900 px-4 py-3 text-sm text-white outline-none transition focus:border-purple-500"
                  />
                  {displayNameError && <p className="mt-1.5 text-xs text-red-300">{displayNameError}</p>}
                  {nameNotice && <p className="mt-1.5 text-xs text-emerald-300">{nameNotice}</p>}
                </div>

                <button type="submit" disabled={savingName} className="rounded-xl bg-purple-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-purple-600 disabled:opacity-50">
                  {savingName ? "Сохраняем…" : "Сохранить имя"}
                </button>
              </form>

              <div className="space-y-3">
                <div className="rounded-2xl border border-dark-600 bg-dark-900 p-4">
                  <p className="text-sm font-medium text-gray-300">Аватарка</p>
                  <div className="mt-4 flex items-center gap-4">
                    <Avatar src={avatarUrl} name={displayName || user.username} color={user.avatarColor || initialsColor(user.displayName || user.username)} size={64} cacheKey={avatarVersion} />
                    <div className="text-xs text-gray-500">JPG/PNG/WebP, до 2 МБ, серверное сжатие до 256×256</div>
                  </div>
                  <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleAvatarChange} />
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" disabled={uploadingAvatar} onClick={() => fileInputRef.current?.click()} className="rounded-lg bg-purple-500/15 px-4 py-2 text-xs font-semibold text-purple-200 hover:bg-purple-500/25 disabled:opacity-50">
                      {uploadingAvatar ? "Загружаем…" : "Загрузить фото"}
                    </button>
                    {avatarUrl && (
                      <button type="button" onClick={removeAvatar} className="rounded-lg border border-red-500/30 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/10">
                        Удалить фото
                      </button>
                    )}
                  </div>
                  {uploadError && <p className="mt-3 text-xs text-red-300">{uploadError}</p>}
                </div>
              </div>
            </div>
          )}

          {tab === "password" && (
            <form onSubmit={changePassword} className="max-w-xl space-y-4">
              <p className="text-sm text-gray-400">Укажите новый пароль и повторите его для подтверждения.</p>
              <div>
                <label htmlFor="new-password" className="block text-sm font-medium text-gray-300">Новый пароль</label>
                <input id="new-password" type={showPassword ? "text" : "password"} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={6} autoComplete="new-password" className="mt-1.5 w-full rounded-xl border border-dark-500 bg-dark-900 px-4 py-3 text-sm text-white outline-none focus:border-purple-500" />
              </div>
              <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-300">Подтверждение пароля</label>
                <input id="confirm-password" type={showPassword ? "text" : "password"} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={6} autoComplete="new-password" className="mt-1.5 w-full rounded-xl border border-dark-500 bg-dark-900 px-4 py-3 text-sm text-white outline-none focus:border-purple-500" />
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-400">
                <input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} className="accent-purple-500" />
                Показать пароли
              </label>
              {passwordError && <p className="text-sm text-red-300">{passwordError}</p>}
              {passwordNotice && <p className="text-sm text-emerald-300">{passwordNotice}</p>}
              <button type="submit" disabled={savingPassword} className="rounded-xl bg-purple-500 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-purple-600 disabled:opacity-50">
                {savingPassword ? "Меняем…" : "Сменить пароль"}
              </button>
            </form>
          )}

          {tab === "notifications" && (
            <div className="max-w-xl space-y-5">
              <div className="rounded-2xl border border-dark-600 bg-dark-900 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-white">Push-уведомления о сообщениях</p>
                    <p className="mt-1 text-xs leading-relaxed text-gray-400">
                      Push приходит для всех чатов: общих, личных и групп. Нужны HTTPS, разрешение браузера и подписка на этом устройстве (она обновляется автоматически при каждом входе). Уведомление не отправляется самому отправителю и в заглушённый чат; если нужный чат открыт в фокусированном окне, уведомление не показывается. На iOS добавьте приложение на главный экран.
                    </p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {!pushSupported ? (
                    <span className="rounded-lg bg-dark-700 px-3 py-2 text-xs text-gray-400">
                      Этот браузер не поддерживает push-уведомления
                    </span>
                  ) : pushStatus === "denied" ? (
                    <>
                      <span className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">
                        Уведомления заблокированы в настройках браузера
                      </span>
                    </>
                  ) : pushStatus === "granted" ? (
                    <>
                      <button
                        type="button"
                        disabled={pushBusy}
                        onClick={handleEnablePush}
                        className="rounded-lg bg-purple-500 px-4 py-2 text-xs font-semibold text-white hover:bg-purple-600 disabled:opacity-50"
                      >
                        {pushBusy ? "Подключаем…" : "Переподключить push"}
                      </button>
                      <button
                        type="button"
                        disabled={pushBusy}
                        onClick={handleDisablePush}
                        className="rounded-lg border border-red-500/30 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/10 disabled:opacity-50"
                      >
                        {pushBusy ? "Отключаем…" : "Отключить уведомления"}
                      </button>
                      <button
                        type="button"
                        disabled={testingPush}
                        onClick={handleTestPush}
                        className="rounded-lg border border-dark-500 px-4 py-2 text-xs font-semibold text-gray-200 hover:bg-dark-700 disabled:opacity-50"
                      >
                        {testingPush ? "Отправляем тест…" : "Тестовое уведомление"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={pushBusy}
                      onClick={handleEnablePush}
                      className="rounded-lg bg-purple-500 px-4 py-2 text-xs font-semibold text-white hover:bg-purple-600 disabled:opacity-50"
                    >
                      {pushBusy ? "Включаем…" : "Включить уведомления"}
                    </button>
                  )}
                </div>
                {pushSubscriptionCount !== null && (
                  <p className="mt-3 text-xs text-gray-400">
                    Сохранённых подписок браузера: {pushSubscriptionCount}
                  </p>
                )}
                {pushNotice && (
                  <p className={`mt-3 text-xs ${pushNotice.includes("Не") || pushNotice.includes("не ") || pushNotice.includes("Нет") || pushNotice.includes("заблок") || pushNotice.includes("ошиб") ? "text-red-300" : "text-emerald-300"}`}>
                    {pushNotice}
                  </p>
                )}
                {pushStatus === "denied" && (
                  <p className="mt-2 text-[11px] leading-relaxed text-amber-300/80">
                    Нажмите на иконку замочка/настроек слева от адресной строки браузера, разрешите уведомления для этого сайта, затем вернитесь сюда.
                  </p>
                )}
              </div>

              <p className="text-xs leading-relaxed text-gray-500">
                Уведомления не отправляются, если вы были активны в приложении за последнюю минуту. Сервер не хранит текст сообщений дольше, чем нужно для отправки.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
