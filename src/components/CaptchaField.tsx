"use client";

import { useCallback, useEffect, useState } from "react";

export interface CaptchaChallenge {
  token: string;
  image: string;
}

/**
 * Self-hosted captcha box for the registration form. The challenge comes from
 * POST /api/auth/captcha (a signed token + a distorted SVG); the answer field
 * is what the user types. Parent can call refresh() via `refreshSignal`.
 */
export default function CaptchaField({
  value,
  onChange,
  onChallengeChange,
  refreshSignal = 0,
  disabled,
}: {
  value: string;
  onChange: (answer: string) => void;
  onChallengeChange: (challenge: CaptchaChallenge | null) => void;
  refreshSignal?: number;
  disabled?: boolean;
}) {
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/auth/captcha", { method: "POST", cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.token || !data?.image) throw new Error("bad challenge");
      setChallenge(data);
      onChallengeChange({ token: data.token, image: data.image });
    } catch {
      setChallenge(null);
      onChallengeChange(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  return (
    <div>
      <label className="block text-sm text-gray-400 mb-1.5">Защита от ботов</label>
      <div className="rounded-xl border border-dark-500 bg-dark-900 p-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void load()}
          className="shrink-0 rounded-lg overflow-hidden border border-dark-500 focus:outline-none focus:border-purple-500"
          title="Обновить картинку"
          aria-label="Обновить картинку капчи"
          disabled={disabled}
        >
          {challenge ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={challenge.image} alt="Капча — введите символы с картинки" className="h-10 w-auto" />
          ) : (
            <span className="flex h-10 w-[120px] items-center justify-center text-xs text-gray-500">
              {loading ? "…" : "нет картинки"}
            </span>
          )}
        </button>
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          maxLength={8}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className="min-w-0 flex-1 px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 uppercase"
          placeholder="Символы с картинки"
          aria-label="Ответ капчи"
        />
      </div>
      <p className="mt-1.5 text-xs text-gray-500">
        Картинка обновляется по клику; не совпало — попробуйте ещё раз.
      </p>
    </div>
  );
}
