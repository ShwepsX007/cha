"use client";

import { useState } from "react";
import { initializeMatrixCryptoAfterLogin } from "@/lib/matrix/client";
import type { MatrixAvailability, MatrixSession } from "@/lib/matrix/types";
import { getMatrixDeviceId } from "@/lib/matrix/device-id";
import { recoverMatrixSession } from "@/lib/matrix/recover-session";
import {
  normalizeMatrixSession,
  saveMatrixAvailability,
  saveMatrixSession,
} from "@/lib/matrix/session-store";

interface User {
  id: number;
  username: string;
  displayName: string;
  avatarColor?: string;
  avatarUrl?: string | null;
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

export default function AuthScreen({ onAuth }: { onAuth: (user: User) => void }) {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const endpoint = isLogin ? "/api/auth/login" : "/api/auth/register";
      const matrixDeviceId = getMatrixDeviceId(username);
      const body = isLogin
        ? { username, password, matrixDeviceId }
        : { username, password, displayName: displayName || username, matrixDeviceId };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Произошла ошибка");
        return;
      }

      let matrixSession: MatrixSession | null = normalizeMatrixSession(data.matrixSession);
      let matrixAvailability: MatrixAvailability = matrixSession
        ? (data.matrixAvailability || "ready")
        : (data.matrixAvailability || "unavailable");
      let matrixResetRequired = Boolean(data.matrixResetRequired || data.user?.matrixResetRequired);
      let initialRecoveryKey: string | null = null;
      let initialRecoveryKeySaved = false;
      let matrixNotice = "";

      if (matrixResetRequired) {
        // The device was revoked on the homeserver. Re-authenticate the device
        // this browser already owns (that keeps the local E2EE keys usable) and
        // only fall back to a brand-new device when the server insists.
        try {
          const recovered = await recoverMatrixSession({
            username,
            appUserId: data.user.id,
            password,
            resetRequired: true,
          });
          matrixSession = recovered.session;
          matrixAvailability = "ready";
          matrixResetRequired = false;
          matrixNotice = recovered.notice || "";
        } catch (resetError) {
          matrixSession = null;
          matrixAvailability = "unavailable";
          matrixNotice = resetError instanceof Error
            ? `Не удалось завершить восстановление Matrix: ${resetError.message}`
            : "Не удалось завершить восстановление Matrix. Общий чат доступен, приватные чаты - после восстановления.";
          console.error("Matrix reset completion failed");
        }
      }

      if (matrixSession && matrixAvailability === "ready") {
        try {
          const initialization = await initializeMatrixCryptoAfterLogin(matrixSession, password);
          initialRecoveryKey = initialization.recoveryKey || null;
          initialRecoveryKeySaved = initialization.recoveryKeySaved || false;
          matrixNotice = initialization.notice || matrixNotice;
        } catch (matrixError) {
          matrixNotice = matrixError instanceof Error
            ? matrixError.message
            : "Matrix не синхронизирован. Приватные сообщения пока не отправляются.";
          console.error("Matrix crypto initialization failed");
        }
      } else if (matrixAvailability === "unavailable" && !matrixNotice) {
        matrixNotice = "Matrix недоступен. Общий чат остаётся доступен, приватные сообщения не отправляются.";
      }

      const authenticatedUser: User = {
        ...data.user,
        matrixAvailability,
        matrixSession,
        matrixResetRequired,
        initialRecoveryKey,
        initialRecoveryKeySaved,
        matrixNotice,
      };

      saveMatrixSession(authenticatedUser.id, authenticatedUser.matrixSession ?? null);
      saveMatrixAvailability(authenticatedUser.matrixAvailability || "unavailable");
      setPassword("");
      onAuth(authenticatedUser);
    } catch {
      setError("Ошибка соединения");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-900 p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-dark-700 rounded-2xl mb-4 border border-dark-500">
            <svg className="w-10 h-10 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">Secret Chat</h1>
          <p className="text-gray-500 mt-1">Приватный мессенджер</p>
        </div>

        {/* Form */}
        <div className="bg-dark-800 rounded-2xl border border-dark-600 p-6">
          <h2 className="text-xl font-semibold mb-6 text-center">
            {isLogin ? "Вход" : "Регистрация"}
          </h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Логин</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-3 bg-dark-700 border border-dark-500 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-colors"
                placeholder="Введите логин"
                required
                autoComplete="username"
              />
            </div>

            {!isLogin && (
              <div>
                <label className="block text-sm text-gray-400 mb-1.5">Отображаемое имя</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full px-4 py-3 bg-dark-700 border border-dark-500 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-colors"
                  placeholder="Как вас называть?"
                />
              </div>
            )}

            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Пароль</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-3 bg-dark-700 border border-dark-500 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-colors pr-12"
                  placeholder="Введите пароль"
                  required
                  autoComplete={isLogin ? "current-password" : "new-password"}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                >
                  {showPassword ? (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.5 6.5m7.378 7.378L17.5 17.5M3 3l18 18" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-purple-500 hover:bg-purple-600 disabled:opacity-50 text-white font-medium rounded-xl transition-colors"
            >
              {loading ? "Подключаем Matrix и шифрование…" : isLogin ? "Войти" : "Зарегистрироваться"}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-gray-400">
            {isLogin ? "Нет аккаунта?" : "Уже есть аккаунт?"}{" "}
            <button
              onClick={() => {
                setIsLogin(!isLogin);
                setError("");
              }}
              className="text-purple-400 hover:text-purple-300 font-medium"
            >
              {isLogin ? "Регистрация" : "Войти"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
