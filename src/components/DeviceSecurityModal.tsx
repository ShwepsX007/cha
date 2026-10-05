"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";
import Image from "next/image";
import QRCode from "qrcode";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent";
import {
  VerificationPhase,
  VerificationRequestEvent,
  type ShowQrCodeCallbacks,
  type VerificationRequest,
} from "matrix-js-sdk/lib/crypto-api/verification";
import {
  getAutomaticRecoveryNotice,
  getMatrixClient,
  getMatrixSecurityStatus,
  restoreMatrixHistoryFromVerifiedDevice,
  restoreMatrixRecoveryKey,
  rotateMatrixRecoveryKey,
  setupMatrixRecovery,
  waitForMatrixSync,
  MATRIX_RECOVERY_EVENT,
  type MatrixRecoveryNotice,
  type MatrixRecoveryResult,
  type MatrixSecurityStatus,
} from "@/lib/matrix/client";
import {
  decryptRecoveryKeyFromProfile,
  fetchStoredRecoveryKey,
  saveRecoveryKeyToProfile,
  type EncryptedRecoveryKeyRecord,
} from "@/lib/matrix/recovery-key-storage";
import type { ImportRoomKeyProgressData } from "matrix-js-sdk/lib/crypto-api/index";
import type { MatrixSession } from "@/lib/matrix/types";

type VerificationRole = "new-device" | "trusted-device";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Не удалось выполнить действие. Проверьте соединение с Matrix и попробуйте ещё раз.";
}

function isIncomingSelfVerification(request: VerificationRequest, userId: string): boolean {
  try {
    return request.isSelfVerification &&
      request.otherUserId === userId &&
      Boolean(request.otherDeviceId) &&
      request.pending &&
      request.phase === VerificationPhase.Requested;
  } catch {
    return false;
  }
}

function waitForReady(request: VerificationRequest): Promise<void> {
  if (request.phase === VerificationPhase.Ready) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      request.removeListener(VerificationRequestEvent.Change, onChange);
      reject(new Error("Старое устройство не подтвердило запрос вовремя. Повторите привязку."));
    }, 30_000);

    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      request.removeListener(VerificationRequestEvent.Change, onChange);
      if (error) reject(error);
      else resolve();
    };

    const onChange = () => {
      if (request.phase === VerificationPhase.Ready) finish();
      else if (
        request.phase === VerificationPhase.Cancelled ||
        request.phase === VerificationPhase.Done
      ) {
        finish(new Error("Запрос подтверждения был отменён или завершён."));
      }
    };

    request.on(VerificationRequestEvent.Change, onChange);
    onChange();
  });
}

function describeRestoreProgress(progress: ImportRoomKeyProgressData): string {
  if (progress.stage === "fetch") return "Загружаем зашифрованную копию ключей Matrix…";
  return `Восстановлено ключей: ${progress.successes} из ${progress.total}`;
}

export default function DeviceSecurityModal({
  session,
  onClose,
  initialRecoveryKey,
  initialRecoveryKeySaved = false,
}: {
  session: MatrixSession;
  onClose: () => void;
  initialRecoveryKey?: string | null;
  initialRecoveryKeySaved?: boolean;
}) {
  const [securityStatus, setSecurityStatus] = useState<MatrixSecurityStatus | null>(null);
  const [incomingRequests, setIncomingRequests] = useState<VerificationRequest[]>([]);
  const [activeRequest, setActiveRequest] = useState<VerificationRequest | null>(null);
  const [requestRole, setRequestRole] = useState<VerificationRole | null>(null);
  const [requestPhase, setRequestPhase] = useState<VerificationPhase | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [qrConfirmation, setQrConfirmation] = useState<ShowQrCodeCallbacks | null>(null);
  const [verificationMessage, setVerificationMessage] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [scannerError, setScannerError] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryKeyInput, setRecoveryKeyInput] = useState("");
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState<string | null>(initialRecoveryKey || null);
  const [recoveryKeySaved, setRecoveryKeySaved] = useState(initialRecoveryKeySaved);
  const [storedRecoveryRecord, setStoredRecoveryRecord] = useState<EncryptedRecoveryKeyRecord | null>(null);
  const [recoveryRevealPassword, setRecoveryRevealPassword] = useState("");
  const [revealedRecoveryKey, setRevealedRecoveryKey] = useState<string | null>(null);
  const [autoRecoveryNotice, setAutoRecoveryNotice] = useState<MatrixRecoveryNotice | null>(
    () => getAutomaticRecoveryNotice(session.userId),
  );
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState("");
  const [restoreResult, setRestoreResult] = useState<MatrixRecoveryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const activeRequestRef = useRef<VerificationRequest | null>(null);
  const activeRequestListenerRef = useRef<(() => void) | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerControlsRef = useRef<{ stop: () => void } | null>(null);
  const scanHandledRef = useRef(false);
  const qrAutoRestoreRequestRef = useRef<string | null>(null);

  const refreshSecurityStatus = useCallback(async () => {
    const next = await getMatrixSecurityStatus(session);
    setSecurityStatus(next);
    try {
      setStoredRecoveryRecord(await fetchStoredRecoveryKey());
    } catch {
      // Keep device status visible if the profile endpoint is temporarily unavailable.
    }
  }, [session]);

  const addIncomingRequest = useCallback((request: VerificationRequest) => {
    if (!isIncomingSelfVerification(request, session.userId)) return;
    setIncomingRequests((current) => {
      if (current.some((item) => item === request || (
        item.transactionId && item.transactionId === request.transactionId
      ))) return current;
      return [...current, request];
    });
  }, [session.userId]);

  const attachActiveRequest = useCallback((
    request: VerificationRequest,
    role: VerificationRole,
  ) => {
    const previous = activeRequestRef.current;
    const previousListener = activeRequestListenerRef.current;
    if (previous && previousListener) {
      previous.removeListener(VerificationRequestEvent.Change, previousListener);
    }

    activeRequestRef.current = request;
    setActiveRequest(request);
    setRequestRole(role);
    setQrImage(null);
    setQrConfirmation(null);
    setRequestPhase(request.phase);

    const onChange = () => {
      const phase = request.phase;
      setRequestPhase(phase);
      const confirmation = request.verifier?.getReciprocateQrCodeCallbacks() || null;
      if (confirmation) setQrConfirmation(() => confirmation);

      if (phase === VerificationPhase.Done) {
        setVerificationMessage("Устройство подтверждено. Matrix завершил проверку доверия.");
        setQrImage(null);
        void refreshSecurityStatus().catch(() => undefined);
      } else if (phase === VerificationPhase.Cancelled) {
        setVerificationMessage("Проверка устройства отменена. Можно начать заново.");
        setQrImage(null);
      }
    };
    activeRequestListenerRef.current = onChange;
    request.on(VerificationRequestEvent.Change, onChange);
    onChange();
  }, [refreshSecurityStatus]);

  const clearActiveRequest = useCallback(() => {
    const request = activeRequestRef.current;
    const listener = activeRequestListenerRef.current;
    if (request && listener) request.removeListener(VerificationRequestEvent.Change, listener);
    activeRequestRef.current = null;
    activeRequestListenerRef.current = null;
    setActiveRequest(null);
    setRequestRole(null);
    setRequestPhase(null);
    setQrImage(null);
    setQrConfirmation(null);
  }, []);

  useEffect(() => {
    let live = true;
    let matrixClient: Awaited<ReturnType<typeof getMatrixClient>> | null = null;
    const onVerificationRequest = (request: VerificationRequest) => addIncomingRequest(request);
    const onAutomaticRecoveryUpdate = (event: Event) => {
      const detail = (event as CustomEvent<MatrixRecoveryNotice & { userId: string }>).detail;
      if (detail?.userId === session.userId) {
        setAutoRecoveryNotice({ status: detail.status, message: detail.message });
      }
    };
    window.addEventListener(MATRIX_RECOVERY_EVENT, onAutomaticRecoveryUpdate);

    void getMatrixClient(session)
      .then(async (client) => {
        if (!live) return;
        matrixClient = client;
        client.on(CryptoEvent.VerificationRequestReceived, onVerificationRequest);

        const crypto = client.getCrypto();
        const pending = crypto?.getVerificationRequestsToDeviceInProgress(session.userId) || [];
        pending.forEach(addIncomingRequest);
        await waitForMatrixSync(client);
        if (live) await refreshSecurityStatus();
      })
      .catch((statusError: unknown) => {
        if (live) setError(errorMessage(statusError));
      });

    return () => {
      live = false;
      window.removeEventListener(MATRIX_RECOVERY_EVENT, onAutomaticRecoveryUpdate);
      if (matrixClient) {
        matrixClient.removeListener(CryptoEvent.VerificationRequestReceived, onVerificationRequest);
      }
      const active = activeRequestRef.current;
      const listener = activeRequestListenerRef.current;
      if (active && listener) active.removeListener(VerificationRequestEvent.Change, listener);
      scannerControlsRef.current?.stop();
    };
  }, [addIncomingRequest, refreshSecurityStatus, session]);

  const handleClose = async () => {
    if (busy || restoring) return;
    const current = activeRequestRef.current;
    if (current?.pending) await current.cancel({ reason: "Пользователь закрыл окно проверки" }).catch(() => undefined);
    onClose();
  };

  const handleSetupRecovery = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError("");
    try {
      const key = await setupMatrixRecovery(session, password);
      setGeneratedRecoveryKey(key);
      setRecoveryKeySaved(false);
      try {
        await saveRecoveryKeyToProfile(key, password);
        setRecoveryKeySaved(true);
      } catch (saveError) {
        setError(`${errorMessage(saveError)} Скопируйте или скачайте ключ до закрытия этого окна.`);
      }
      setPassword("");
      await refreshSecurityStatus();
    } catch (setupError) {
      setError(errorMessage(setupError));
    } finally {
      setBusy(false);
    }
  };

  const handleRotateRecoveryKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError("");
    try {
      const key = await rotateMatrixRecoveryKey(session, password);
      setGeneratedRecoveryKey(key);
      setRecoveryKeySaved(false);
      setRevealedRecoveryKey(null);
      setPassword("");
      try {
        await saveRecoveryKeyToProfile(key, password);
        setRecoveryKeySaved(true);
      } catch (saveError) {
        setError(`${errorMessage(saveError)} Скопируйте или скачайте новый ключ до закрытия этого окна.`);
      }
      await refreshSecurityStatus();
    } catch (rotateError) {
      setError(errorMessage(rotateError));
    } finally {
      setBusy(false);
    }
  };

  const handleRevealStoredRecoveryKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!storedRecoveryRecord || !recoveryRevealPassword) return;
    setError("");
    try {
      const key = await decryptRecoveryKeyFromProfile(storedRecoveryRecord, recoveryRevealPassword);
      setRevealedRecoveryKey(key);
      setRecoveryRevealPassword("");
    } catch (revealError) {
      setError(errorMessage(revealError));
    }
  };

  const handleSaveDisplayedRecoveryKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!generatedRecoveryKey || !password || busy) return;
    setBusy(true);
    setError("");
    try {
      await saveRecoveryKeyToProfile(generatedRecoveryKey, password);
      setRecoveryKeySaved(true);
      setPassword("");
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyRecoveryKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setError("");
    } catch {
      setError("Не удалось скопировать recovery key. Скачайте его в файл или выделите вручную.");
    }
  };

  const handleDownloadRecoveryKey = (key: string) => {
    const file = new Blob([
      "Matrix recovery key. Храните отдельно и никому не отправляйте.\n\n",
      key,
      "\n",
    ], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = "matrix-recovery-key.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const handleStartVerification = async (targetDeviceId?: string) => {
    if (busy) return;
    qrAutoRestoreRequestRef.current = null;
    setBusy(true);
    setError("");
    setVerificationMessage("");
    try {
      const client = await getMatrixClient(session);
      await waitForMatrixSync(client);
      const crypto = client.getCrypto();
      if (!crypto) throw new Error("Matrix Rust crypto is unavailable");
      const request = targetDeviceId
        ? await crypto.requestDeviceVerification(session.userId, targetDeviceId)
        : await crypto.requestOwnUserVerification();
      attachActiveRequest(request, "new-device");
      setVerificationMessage(targetDeviceId
        ? `Запрос отправлен устройству ${targetDeviceId}. Откройте QR на этом устройстве и отсканируйте его здесь.`
        : "Запрос отправлен. Откройте этот раздел на старом доверенном устройстве и примите запрос.");
    } catch (verificationError) {
      setError(errorMessage(verificationError));
    } finally {
      setBusy(false);
    }
  };

  const handleAcceptVerification = async (request: VerificationRequest) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setIncomingRequests((current) => current.filter((item) => item !== request));
    attachActiveRequest(request, "trusted-device");
    try {
      await request.accept();
      await waitForReady(request);
      const qrBytes = await request.generateQRCode();
      if (!qrBytes) {
        throw new Error("Новое устройство не поддержало QR-проверку. Обновите клиент Matrix и повторите попытку.");
      }
      const qrText = new TextDecoder("utf-8", { fatal: true }).decode(qrBytes);
      const image = await QRCode.toDataURL(qrText, {
        width: 280,
        margin: 2,
        errorCorrectionLevel: "M",
        color: { dark: "#111827", light: "#ffffff" },
      });
      setQrImage(image);
      setVerificationMessage("Покажите этот QR-код новому устройству. Не отправляйте его в чат и не делайте публичный снимок экрана.");
    } catch (verificationError) {
      setError(errorMessage(verificationError));
      await request.cancel({ reason: "QR verification could not be started" }).catch(() => undefined);
      clearActiveRequest();
    } finally {
      setBusy(false);
    }
  };

  const handleDecodedQRCode = useCallback(async (qrText: string) => {
    const request = activeRequestRef.current;
    if (!request || requestRole !== "new-device") return;

    setScannerError("");
    setError("");
    setVerificationMessage("QR считан. Подтвердите сканирование на старом доверенном устройстве…");
    try {
      const qrBytes = new TextEncoder().encode(qrText);
      const verifier = await request.scanQRCode(new Uint8ClampedArray(qrBytes));
      await verifier.verify();
      setVerificationMessage("Новое устройство подтверждено. Теперь можно восстановить историю Matrix E2EE.");
      setRequestPhase(VerificationPhase.Done);
      await refreshSecurityStatus().catch(() => undefined);
    } catch (verificationError) {
      setScannerError(errorMessage(verificationError));
      setVerificationMessage("");
    }
  }, [refreshSecurityStatus, requestRole]);

  useEffect(() => {
    if (!isScanning || !videoRef.current) return;
    let stopped = false;
    scanHandledRef.current = false;
    const reader = new BrowserQRCodeReader();
    const video = videoRef.current;

    void reader.decodeFromVideoDevice(undefined, video, (result) => {
      if (!result || stopped || scanHandledRef.current) return;
      scanHandledRef.current = true;
      scannerControlsRef.current?.stop();
      setIsScanning(false);
      void handleDecodedQRCode(result.getText());
    }).then((controls) => {
      scannerControlsRef.current = controls;
      if (stopped) controls.stop();
    }).catch(() => {
      if (!stopped) {
        setScannerError("Не удалось открыть камеру. Разрешите доступ к камере в браузере и проверьте, что страница открыта по HTTPS.");
        setIsScanning(false);
      }
    });

    return () => {
      stopped = true;
      scannerControlsRef.current?.stop();
      scannerControlsRef.current = null;
    };
  }, [handleDecodedQRCode, isScanning]);

  const handleConfirmScannedQr = () => {
    if (!qrConfirmation) return;
    qrConfirmation.confirm();
    setQrConfirmation(null);
    setVerificationMessage("Подтверждение отправлено. Ожидаем завершения проверки на новом устройстве…");
  };

  const reportRestoreProgress = useCallback((progress: ImportRoomKeyProgressData) => {
    setRestoreProgress(describeRestoreProgress(progress));
  }, []);

  const handleRestoreWithRecoveryKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (restoring || !recoveryKeyInput.trim()) return;
    setRestoring(true);
    setError("");
    setRestoreResult(null);
    setRestoreProgress("Проверяем recovery key Matrix…");
    try {
      const result = await restoreMatrixRecoveryKey(session, recoveryKeyInput, reportRestoreProgress);
      setRestoreResult(result);
      setRecoveryKeyInput("");
      setRestoreProgress(
        result.backup
          ? `Восстановлено ключей: ${result.backup.imported} из ${result.backup.total}.`
          : "Ключи проверки Matrix восстановлены; серверная копия истории не настроена.",
      );
      await refreshSecurityStatus();
    } catch (restoreError) {
      setError(errorMessage(restoreError));
      setRestoreProgress("");
    } finally {
      setRestoring(false);
    }
  };

  const handleRestoreAfterQr = useCallback(async () => {
    if (restoring) return;
    setRestoring(true);
    setError("");
    setRestoreResult(null);
    setRestoreProgress("Подготавливаем доверенную копию Matrix…");
    try {
      const retryDelays = [0, 1_000, 3_000, 9_000];
      let backup: Awaited<ReturnType<typeof restoreMatrixHistoryFromVerifiedDevice>> | null = null;
      let lastError: unknown;
      for (const delay of retryDelays) {
        if (delay > 0) {
          setRestoreProgress("Ожидаем передачи ключа backup от доверенного устройства…");
          await new Promise((resolve) => window.setTimeout(resolve, delay));
        }
        try {
          backup = await restoreMatrixHistoryFromVerifiedDevice(session, reportRestoreProgress);
          break;
        } catch (restoreError) {
          lastError = restoreError;
          const message = errorMessage(restoreError);
          if (!/not shared|not available|not yet|backup key/i.test(message)) throw restoreError;
        }
      }
      if (!backup) throw lastError || new Error("Не удалось получить ключ Matrix backup.");
      setRestoreResult({ crossSigningRestored: false, backup });
      setRestoreProgress(`Восстановлено ключей: ${backup.imported} из ${backup.total}.`);
      setAutoRecoveryNotice({
        status: "restored",
        message: "Устройство подтверждено; зашифрованная история Matrix восстановлена.",
      });
    } catch (restoreError) {
      setError(errorMessage(restoreError));
      setRestoreProgress("");
    } finally {
      setRestoring(false);
      await refreshSecurityStatus().catch(() => undefined);
    }
  }, [refreshSecurityStatus, reportRestoreProgress, restoring, session]);

  useEffect(() => {
    if (
      requestRole !== "new-device" ||
      requestPhase !== VerificationPhase.Done ||
      !securityStatus?.keyBackupAvailable ||
      !activeRequest
    ) return;

    const requestId = activeRequest.transactionId || activeRequest.otherDeviceId;
    if (!requestId || qrAutoRestoreRequestRef.current === requestId) return;
    qrAutoRestoreRequestRef.current = requestId;
    void handleRestoreAfterQr();
  }, [activeRequest, handleRestoreAfterQr, requestPhase, requestRole, securityStatus?.keyBackupAvailable]);

  const recoverySetupAvailable = Boolean(securityStatus && !securityStatus.secretStorageKeyId);
  const recoveryInputAvailable = Boolean(
    securityStatus?.secretStorageKeyId &&
    (!securityStatus.crossSigningPrivateKeysCached ||
      (securityStatus.keyBackupAvailable && !securityStatus.backupVersion)),
  );
  const recoveryRotationAvailable = Boolean(
    securityStatus?.secretStorageKeyId && securityStatus.crossSigningPrivateKeysCached,
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6">
      <section
        aria-modal="true"
        aria-labelledby="device-security-title"
        role="dialog"
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-dark-500 bg-dark-800 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-dark-600 px-5 py-4">
          <div>
            <h2 id="device-security-title" className="text-lg font-semibold text-white">Устройства и ключи E2EE</h2>
            <p className="mt-1 text-xs text-gray-500">Matrix · {session.deviceId}</p>
          </div>
          <button
            type="button"
            onClick={() => void handleClose()}
            disabled={busy || restoring}
            aria-label="Закрыть"
            title="Закрыть"
            className="rounded-lg p-2 text-gray-400 hover:bg-dark-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="space-y-5 overflow-y-auto px-5 py-4 text-sm">
          {error && (
            <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}
          {autoRecoveryNotice && (
            <div
              role={autoRecoveryNotice.status === "needs-recovery" || autoRecoveryNotice.status === "error" ? "alert" : "status"}
              className={`rounded-xl border px-4 py-3 text-sm ${
                autoRecoveryNotice.status === "needs-recovery" || autoRecoveryNotice.status === "error"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              }`}
            >
              {autoRecoveryNotice.message}
            </div>
          )}

          <section className="rounded-xl border border-dark-500 bg-dark-700/60 p-4">
            <h3 className="font-medium text-white">Состояние ключей на этом устройстве</h3>
            {securityStatus ? (
              <dl className="mt-3 grid gap-2 text-xs text-gray-400 sm:grid-cols-2">
                <div>
                  <dt className="text-gray-500">Cross-signing Matrix</dt>
                  <dd className={securityStatus.crossSigningReady ? "text-emerald-300" : "text-amber-300"}>
                    {securityStatus.crossSigningReady ? "публичные ключи настроены" : "ещё не настроен"}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500">Приватные ключи</dt>
                  <dd className={securityStatus.crossSigningPrivateKeysCached ? "text-emerald-300" : "text-amber-300"}>
                    {securityStatus.crossSigningPrivateKeysCached ? "доступны на этом устройстве" : "не загружены на этом устройстве"}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500">Recovery key / secret storage</dt>
                  <dd className={securityStatus.secretStorageKeyId ? "text-emerald-300" : "text-amber-300"}>
                    {securityStatus.secretStorageKeyId ? "настроен для аккаунта" : "не настроен"}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500">Резервная копия ключей сообщений</dt>
                  <dd className={securityStatus.keyBackupAvailable ? "text-emerald-300" : "text-gray-400"}>
                    {securityStatus.keyBackupAvailable
                      ? securityStatus.backupVersion ? "доступна на этом устройстве" : "есть на сервере; нужен QR или recovery key"
                      : "ещё не создана"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-2 text-xs text-gray-400">Подключаемся к Matrix и проверяем состояние…</p>
            )}
            {securityStatus && !securityStatus.crossSigningReady && (
              <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
                Первая настройка Matrix выполняется автоматически после входа. Если у аккаунта уже есть ключи, запросите QR с доверенного устройства или восстановите их по recovery key — не создавайте новую пару ключей.
              </p>
            )}
            {securityStatus?.crossSigningReady && !securityStatus.crossSigningPrivateKeysCached && (
              <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
                Публичные ключи уже есть, но приватные ключи не загружены на это устройство. Сначала восстановите их своим recovery key или выполните QR-перенос со старого доверенного устройства.
              </p>
            )}
            <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
              Recovery и QR относятся только к новым зашифрованным сообщениям Matrix. Старая история приложения остаётся legacy и не шифруется задним числом.
            </p>
          </section>

          <section className="rounded-xl border border-dark-500 p-4">
            <h3 className="font-medium text-white">Устройства Matrix</h3>
            <p className="mt-1 text-xs text-gray-400">Подтверждённые устройства могут безопасно передавать ключи этому устройству.</p>
            {securityStatus?.devices.length ? (
              <ul className="mt-3 space-y-2">
                {securityStatus.devices.map((device) => (
                  <li key={device.deviceId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-dark-700 p-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm text-white">
                        <span aria-hidden="true">{device.verified ? "✅" : "⚠️"}</span>
                        <span className="truncate">{device.displayName}</span>
                        {device.current && <span className="shrink-0 rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-200">это устройство</span>}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-gray-500">{device.deviceId}</div>
                      {device.lastSeenTs && (
                        <div className="mt-1 text-[10px] text-gray-500">
                          Последняя активность: {new Date(device.lastSeenTs).toLocaleString("ru-RU")}
                        </div>
                      )}
                    </div>
                    {!device.verified && !device.current && (
                      <button
                        type="button"
                        onClick={() => void handleStartVerification(device.deviceId)}
                        disabled={busy || restoring || Boolean(activeRequest)}
                        className="rounded-lg bg-purple-500 px-3 py-2 text-xs font-medium text-white hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Подтвердить устройство
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-gray-500">Список устройств Matrix ещё загружается или устройств нет.</p>
            )}
          </section>

          {generatedRecoveryKey ? (
            <section className="rounded-xl border border-amber-400/50 bg-amber-400/10 p-4">
              <h3 className="font-semibold text-amber-100">
                {initialRecoveryKey ? "Ваш чат зашифрован" : "Ключ восстановления"}
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-amber-100/80">
                {recoveryKeySaved
                  ? "Ключ показан только на этом устройстве. Его зашифрованная копия сохранена в профиле и может быть открыта здесь после ввода пароля аккаунта."
                  : "Зашифрованную копию не удалось сохранить в профиле. Скопируйте или скачайте ключ сейчас, если хотите восстановить историю на новом устройстве."}
                {" "}Не отправляйте ключ в чат, Telegram или поддержку.
              </p>
              <code className="mt-3 block select-all break-all rounded-lg bg-black/40 p-3 text-center font-mono text-sm tracking-wide text-white">
                {generatedRecoveryKey}
              </code>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => void handleCopyRecoveryKey(generatedRecoveryKey)} className="rounded-lg bg-dark-500 px-3 py-2 text-xs text-white hover:bg-dark-400">
                  Скопировать ключ
                </button>
                <button type="button" onClick={() => handleDownloadRecoveryKey(generatedRecoveryKey)} className="rounded-lg bg-dark-500 px-3 py-2 text-xs text-white hover:bg-dark-400">
                  Скачать .txt
                </button>
              </div>
              {!recoveryKeySaved && (
                <form onSubmit={handleSaveDisplayedRecoveryKey} className="mt-4 flex flex-wrap gap-2">
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-dark-500 bg-dark-700 px-3 py-2 text-sm text-white outline-none focus:border-purple-400"
                    placeholder="Пароль аккаунта для сохранения в профиле"
                    required
                  />
                  <button type="submit" disabled={busy || !password} className="rounded-lg bg-purple-500 px-3 py-2 text-xs font-medium text-white hover:bg-purple-600 disabled:opacity-50">
                    {busy ? "Сохраняем…" : "Сохранить в профиле"}
                  </button>
                </form>
              )}
              <button
                type="button"
                onClick={() => {
                  setGeneratedRecoveryKey(null);
                  if (initialRecoveryKey) void handleClose();
                }}
                className="mt-4 rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-dark-900 hover:bg-amber-300"
              >
                {recoveryKeySaved ? "Продолжить" : "Продолжить без сохранения"}
              </button>
            </section>
          ) : null}

          {storedRecoveryRecord && !generatedRecoveryKey && (
            <section className="rounded-xl border border-dark-500 p-4">
              <h3 className="font-medium text-white">Ключ восстановления</h3>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">
                Ключ хранится в профиле только в зашифрованном виде. Для просмотра введите пароль аккаунта; расшифровка выполняется в браузере.
              </p>
              {revealedRecoveryKey ? (
                <>
                  <code className="mt-3 block select-all break-all rounded-lg bg-black/40 p-3 text-center font-mono text-sm text-white">
                    {revealedRecoveryKey}
                  </code>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void handleCopyRecoveryKey(revealedRecoveryKey)} className="rounded-lg bg-dark-500 px-3 py-2 text-xs text-white hover:bg-dark-400">
                      Скопировать
                    </button>
                    <button type="button" onClick={() => handleDownloadRecoveryKey(revealedRecoveryKey)} className="rounded-lg bg-dark-500 px-3 py-2 text-xs text-white hover:bg-dark-400">
                      Скачать .txt
                    </button>
                    <button type="button" onClick={() => setRevealedRecoveryKey(null)} className="rounded-lg bg-dark-500 px-3 py-2 text-xs text-white hover:bg-dark-400">
                      Скрыть
                    </button>
                  </div>
                </>
              ) : (
                <form onSubmit={handleRevealStoredRecoveryKey} className="mt-3 flex flex-wrap gap-2">
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={recoveryRevealPassword}
                    onChange={(event) => setRecoveryRevealPassword(event.target.value)}
                    className="min-w-0 flex-1 rounded-lg border border-dark-500 bg-dark-700 px-3 py-2 text-sm text-white outline-none focus:border-purple-400"
                    placeholder="Пароль аккаунта"
                    required
                  />
                  <button type="submit" disabled={!recoveryRevealPassword} className="rounded-lg bg-purple-500 px-3 py-2 text-xs font-medium text-white hover:bg-purple-600 disabled:opacity-50">
                    Показать ключ
                  </button>
                </form>
              )}
            </section>
          )}

          {recoverySetupAvailable && !generatedRecoveryKey && (
            <section className="rounded-xl border border-dark-500 p-4">
              <h3 className="font-medium text-white">Настроить восстановление</h3>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">
                Обычно Matrix recovery настраивается автоматически при первом входе. Если автоматическая настройка не удалась, создайте cross-signing и резервную копию здесь.
              </p>
              <form onSubmit={handleSetupRecovery} className="mt-3 space-y-3">
                <label className="block text-xs text-gray-400">
                  Пароль аккаунта
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-dark-500 bg-dark-700 px-3 py-2.5 text-sm text-white outline-none focus:border-purple-400"
                    placeholder="Введите пароль для подтверждения"
                    required
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy || !password || !securityStatus}
                  className="rounded-lg bg-purple-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? "Настраиваем Matrix…" : "Создать recovery key и backup"}
                </button>
              </form>
            </section>
          )}

          {recoveryRotationAvailable && !generatedRecoveryKey && (
            <section className="rounded-xl border border-dark-500 p-4">
              <h3 className="font-medium text-white">Сгенерировать новый ключ</h3>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">
                Будет создан новый recovery key и новая серверная копия ключей сообщений. Ключ подтвердится паролем и сохранится в профиле в зашифрованном виде.
              </p>
              <form onSubmit={handleRotateRecoveryKey} className="mt-3 flex flex-wrap gap-2">
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-dark-500 bg-dark-700 px-3 py-2 text-sm text-white outline-none focus:border-purple-400"
                  placeholder="Пароль аккаунта"
                  required
                />
                <button type="submit" disabled={busy || !password} className="rounded-lg bg-dark-500 px-3 py-2 text-xs font-medium text-white hover:bg-dark-400 disabled:opacity-50">
                  {busy ? "Создаём…" : "Сгенерировать новый ключ"}
                </button>
              </form>
            </section>
          )}

          {recoveryInputAvailable && (
            <section className="rounded-xl border border-dark-500 p-4">
              <h3 className="font-medium text-white">Восстановить ключи по recovery key</h3>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">
                Введите Matrix recovery key. Он используется только в памяти браузера для восстановления и не отправляется приложению.
              </p>
              <form onSubmit={handleRestoreWithRecoveryKey} className="mt-3 space-y-3">
                <label className="block text-xs text-gray-400">
                  Recovery key
                  <input
                    type="password"
                    autoComplete="off"
                    value={recoveryKeyInput}
                    onChange={(event) => setRecoveryKeyInput(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-dark-500 bg-dark-700 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-purple-400"
                    placeholder="Es..."
                  />
                </label>
                <button
                  type="submit"
                  disabled={restoring || !recoveryKeyInput.trim()}
                  className="rounded-lg bg-purple-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {restoring ? "Восстанавливаем…" : "Проверить и восстановить"}
                </button>
              </form>
            </section>
          )}

          <section className="rounded-xl border border-dark-500 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-medium text-white">Перенос доверия на новое устройство</h3>
                <p className="mt-1 max-w-lg text-xs leading-relaxed text-gray-400">
                  На новом устройстве запросите проверку. На старом доверенном устройстве примите запрос, покажите QR и подтвердите, что его отсканировали.
                </p>
              </div>
              {!activeRequest && (
                <button
                  type="button"
                  onClick={() => void handleStartVerification()}
                  disabled={busy || restoring || Boolean(generatedRecoveryKey)}
                  className="rounded-lg bg-purple-500 px-3 py-2 text-xs font-medium text-white hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Запросить QR
                </button>
              )}
            </div>

            {incomingRequests.length > 0 && !activeRequest && (
              <div className="mt-4 space-y-2">
                <p className="text-xs font-medium text-amber-200">Запрос с нового устройства</p>
                {incomingRequests.map((request, index) => (
                  <div key={request.transactionId || `verification-${index}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-dark-700 p-3">
                    <div className="min-w-0 text-xs text-gray-300">
                      <div>Устройство: <span className="font-mono">{request.otherDeviceId}</span></div>
                      <div className="mt-1 text-gray-500">Показывайте QR только своему новому устройству.</div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void handleAcceptVerification(request)}
                        disabled={busy || restoring || Boolean(generatedRecoveryKey)}
                        className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        Принять и показать QR
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIncomingRequests((current) => current.filter((item) => item !== request));
                          void request.cancel({ reason: "Пользователь отклонил запрос" }).catch(() => undefined);
                        }}
                        disabled={busy}
                        className="rounded-lg bg-dark-500 px-3 py-2 text-xs text-gray-300 hover:bg-dark-400 disabled:opacity-50"
                      >
                        Отклонить
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeRequest && requestRole === "new-device" && requestPhase !== VerificationPhase.Done && (
              <div className="mt-4 rounded-lg bg-dark-700 p-3">
                {requestPhase === VerificationPhase.Ready ? (
                  <>
                    <p className="text-xs text-emerald-200">Старое устройство приняло запрос. Теперь отсканируйте показанный там QR-код этой камерой.</p>
                    {!isScanning ? (
                      <button
                        type="button"
                        onClick={() => {
                          setScannerError("");
                          setIsScanning(true);
                        }}
                        className="mt-3 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500"
                      >
                        Открыть камеру и сканировать QR
                      </button>
                    ) : (
                      <div className="mt-3">
                        <video ref={videoRef} className="w-full max-h-64 rounded-lg bg-black object-cover" muted playsInline />
                        <button type="button" onClick={() => setIsScanning(false)} className="mt-2 rounded-lg bg-dark-500 px-3 py-2 text-xs text-gray-200 hover:bg-dark-400">
                          Остановить камеру
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-gray-300">На старом доверенном устройстве откройте этот раздел и примите запрос. После этого появится камера для сканирования QR.</p>
                )}
              </div>
            )}

            {activeRequest && requestRole === "trusted-device" && qrImage && requestPhase !== VerificationPhase.Done && (
              <div className="mt-4 flex flex-col items-center rounded-lg bg-white p-4 text-center">
                {/* The QR payload is generated by Matrix Rust crypto and shown only on the trusted device. */}
                <Image
                  src={qrImage}
                  alt="QR-код Matrix для подтверждения нового устройства"
                  width={256}
                  height={256}
                  unoptimized
                  className="h-64 w-64 max-w-full"
                />
                <p className="mt-3 max-w-md text-xs text-gray-700">Сканируйте этот код камерой нового устройства. Не передавайте QR третьим лицам.</p>
                {qrConfirmation && (
                  <div className="mt-4 w-full max-w-md rounded-xl border border-amber-500/50 bg-amber-50 p-3 text-left">
                    <p className="text-xs leading-relaxed text-amber-950">
                      Новое устройство отсканировало QR. Продолжайте только если вы сами начали привязку и сканировали код своим новым устройством.
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button type="button" onClick={handleConfirmScannedQr} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600">
                        Подтвердить своё устройство
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          qrConfirmation.cancel();
                          setQrConfirmation(null);
                        }}
                        className="rounded-lg bg-red-700 px-3 py-2 text-xs font-medium text-white hover:bg-red-600"
                      >
                        Это не моё устройство
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {verificationMessage && (
              <p role="status" className="mt-3 text-xs leading-relaxed text-emerald-200">{verificationMessage}</p>
            )}
            {scannerError && (
              <p role="alert" className="mt-3 text-xs leading-relaxed text-red-300">{scannerError}</p>
            )}
            {activeRequest && requestPhase === VerificationPhase.Done && (
              <button type="button" onClick={clearActiveRequest} className="mt-3 rounded-lg bg-dark-500 px-3 py-2 text-xs text-white hover:bg-dark-400">
                Готово
              </button>
            )}
            {activeRequest && requestPhase !== VerificationPhase.Done && (
              <button
                type="button"
                onClick={() => void handleClose()}
                className="mt-3 rounded-lg px-2 py-1 text-xs text-gray-500 hover:text-red-300"
              >
                Отменить проверку
              </button>
            )}
          </section>

          {securityStatus?.keyBackupAvailable && securityStatus.backupVersion && (
            <section className="rounded-xl border border-dark-500 p-4">
              <h3 className="font-medium text-white">Зашифрованная история Matrix</h3>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">
                После QR-проверки Matrix может передать ключ backup со старого устройства. Recovery key также подходит для восстановления. Старая plaintext/legacy-история приложения сюда не входит.
              </p>
              <button
                type="button"
                onClick={() => void handleRestoreAfterQr()}
                disabled={restoring}
                className="mt-3 rounded-lg bg-dark-500 px-3 py-2 text-xs font-medium text-white hover:bg-dark-400 disabled:opacity-50"
              >
                {restoring ? "Восстанавливаем…" : "Восстановить сообщения Matrix E2EE"}
              </button>
            </section>
          )}

          {(restoring || restoreProgress) && (
            <p role="status" className="rounded-lg bg-dark-700 px-3 py-2 text-xs text-gray-300">
              {restoreProgress || "Восстановление…"}
            </p>
          )}
          {restoreResult?.backup && !restoring && (
            <p className="text-xs text-emerald-300">Восстановлено {restoreResult.backup.imported} ключей Matrix из {restoreResult.backup.total}.</p>
          )}
        </div>

        <footer className="flex justify-end border-t border-dark-600 px-5 py-3">
          <button
            type="button"
            onClick={() => void handleClose()}
            disabled={busy || restoring}
            className="rounded-lg bg-dark-500 px-4 py-2 text-sm text-white hover:bg-dark-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Закрыть
          </button>
        </footer>
      </section>
    </div>
  );
}
