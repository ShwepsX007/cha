"use client";

import { useMemo } from "react";
import Image from "next/image";

interface AvatarProps {
  src?: string | null;
  name?: string | null;
  color?: string | null;
  size?: number;
  className?: string;
  initialsClassName?: string;
  cacheKey?: string | number | null;
}

function getInitials(name: string) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

export default function Avatar({ src, name, color, size = 40, className = "", initialsClassName = "", cacheKey }: AvatarProps) {
  const url = useMemo(() => {
    if (typeof src !== "string" || !src) return null;
    const separator = src.includes("?") ? "&" : "?";
    return cacheKey != null && cacheKey !== "" ? `${src}${separator}v=${encodeURIComponent(String(cacheKey))}` : `${src}${separator}v=1`;
  }, [src, cacheKey]);
  const dimension = Math.max(16, Math.min(128, Math.round(size)));
  const style = { width: dimension, height: dimension, backgroundColor: color || "#6C5CE7" } as const;

  if (url) {
    return (
      <div
        className={`relative overflow-hidden rounded-full object-cover ${className}`}
        style={style}
        aria-label={name ? `Аватар пользователя ${name}` : "Аватар пользователя"}
      >
        <Image
          src={url}
          alt={name ? `Аватар ${name}` : "Аватар"}
          width={dimension * 2}
          height={dimension * 2}
          sizes={`${dimension * 2}px`}
          className="h-full w-full object-cover"
          unoptimized
          priority={false}
        />
      </div>
    );
  }

  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-bold text-white ${className}`}
      style={style}
      aria-hidden="true"
    >
      <span className={`font-semibold leading-none ${initialsClassName}`} style={{ fontSize: Math.max(10, Math.round(dimension * 0.38)) }}>
        {getInitials(name || "")}
      </span>
    </div>
  );
}
