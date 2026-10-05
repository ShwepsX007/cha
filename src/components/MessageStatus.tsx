interface MessageStatusProps {
  status?: "sending" | "sent" | "delivered" | "read" | "error" | null;
  className?: string;
  title?: string;
}

export default function MessageStatus({ status, className = "", title }: MessageStatusProps) {
  if (!status || status === "sent") {
    return (
      <svg className={`h-3.5 w-3.5 ${className || "text-gray-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-label={title || "Отправлено"} >
        <title>{title || "Отправлено"}</title>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (status === "sending") {
    return (
      <span className={`inline-flex h-3.5 w-3.5 items-center justify-center text-[11px] ${className || "text-gray-400"}`} title="Отправка" aria-label="Отправка">
        ◷
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white ${className}`}
        title="Ошибка отправки"
        aria-label="Ошибка отправки"
      >
        !
      </span>
    );
  }
  if (status === "read") {
    return (
      <svg className={`h-4 w-4 ${className || "text-sky-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-label={title || "Прочитано"} >
        <title>{title || "Прочитано"}</title>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M4 12l4 4L16 6" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 16l1-1 7-9" />
      </svg>
    );
  }
  // delivered
  return (
    <svg className={`h-4 w-4 ${className || "text-gray-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-label={title || "Доставлено"} >
      <title>{title || "Доставлено"}</title>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M4 12l4 4L16 6" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 16l1-1 7-9" />
    </svg>
  );
}
