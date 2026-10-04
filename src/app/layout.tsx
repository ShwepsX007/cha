import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Secret Chat — Приватный мессенджер",
  description: "Секретный веб-мессенджер с хранением файлов через Telegram",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0f",
  userScalable: false,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <style>{`
          html, body, #__next { height: 100%; overscroll-behavior-y: none; }
          body { -webkit-tap-highlight-color: transparent; }
        `}</style>
      </head>
      <body className="bg-[#0a0a0f] text-white antialiased">{children}</body>
    </html>
  );
}
