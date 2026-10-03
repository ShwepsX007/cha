import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Secret Chat — Приватный мессенджер",
  description: "Секретный веб-мессенджер с хранением файлов через Telegram",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="bg-[#0a0a0f] text-white antialiased">{children}</body>
    </html>
  );
}
