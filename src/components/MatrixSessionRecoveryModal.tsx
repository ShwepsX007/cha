"use client";

import { useState } from "react";

export default function MatrixSessionRecoveryModal({
  username,
  onClose,
  onRecover,
}: {
  username: string;
  onClose: () => void;
  onRecover: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError("");
    try {
      await onRecover(password);
      onClose();
    } catch (recoveryError) {
      setError(recoveryError instanceof Error ? recoveryError.message : "Не удалось восстановить Matrix-сессию");
    } finally {
      setBusy(false);
      setPassword("");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-dark-600 bg-dark-800 p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Восстановить Matrix-сессию</h2>
            <p className="mt-1 text-xs text-gray-400">Для @{username} на этом устройстве</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1 text-gray-400 hover:bg-dark-600 hover:text-white disabled:opacity-50"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
        <p className="mb-4 text-sm leading-relaxed text-gray-300">
          Введите пароль аккаунта. Будет создана новая сессия для уже зарегистрированного Matrix-устройства;
          локальные ключи E2EE не удаляются.
        </p>
        <label className="mb-1.5 block text-sm text-gray-400" htmlFor="matrix-recovery-password">Пароль аккаунта</label>
        <input
          id="matrix-recovery-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          autoFocus
          required
          maxLength={1024}
          disabled={busy}
          className="w-full rounded-xl border border-dark-500 bg-dark-700 px-4 py-3 text-sm text-white outline-none focus:border-purple-500 disabled:opacity-50"
        />
        {error && <div role="alert" className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-xl px-4 py-2 text-sm text-gray-300 hover:bg-dark-700 disabled:opacity-50">
            Отмена
          </button>
          <button type="submit" disabled={busy || !password} className="rounded-xl bg-purple-500 px-4 py-2 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50">
            {busy ? "Подключаем…" : "Восстановить"}
          </button>
        </div>
      </form>
    </div>
  );
}
