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
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  // Use first letter of first word — covers latin and cyrillic.
  const first = trimmed.charAt(0);
  return first.toUpperCase() || "?";
}

function buildAvatarUrl(src: string, cacheKey?: string | number | null) {
  const base = src.trim();
  if (!base) return null;
  const separator = base.includes("?") ? "&" : "?";
  if (cacheKey != null && cacheKey !== "") {
    return `${base}${separator}v=${encodeURIComponent(String(cacheKey))}`;
  }
  // If no explicit cache key, attach a fixed-but-simple buster derived from path
  // so the very first render after server restart doesn't hit a stale cached
  // placeholder; browsers will still revalidate via Cache-Control.
  return `${base}${separator}v=1`;
}

export default function Avatar({
  src,
  name,
  color,
  size = 40,
  className = "",
  initialsClassName = "",
  cacheKey,
}: AvatarProps) {
  const dimension = Math.max(16, Math.min(128, Math.round(size)));
  const url = useMemo(() => {
    if (typeof src !== "string") return null;
    if (!src || !src.trim()) return null;
    // Only accept absolute paths on this origin or data: (none here).
    if (/^https?:\/\//i.test(src)) return null;
    return buildAvatarUrl(src, cacheKey);
  }, [src, cacheKey]);

  const style = {
    width: dimension,
    height: dimension,
    backgroundColor: color || "#6C5CE7",
  } as const;

  if (url) {
    return (
      <div
        className={`relative shrink-0 overflow-hidden rounded-full ${className}`}
        style={style}
        aria-label={name ? `Аватар ${name}` : "Аватар"}
      >
        <Image
          src={url}
          alt={name ? `Аватар ${name}` : "Аватар"}
          width={dimension}
          height={dimension}
          sizes={`${dimension}px`}
          className="h-full w-full object-cover"
          unoptimized
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
      <span
        className={`leading-none ${initialsClassName}`}
        style={{ fontSize: Math.max(10, Math.round(dimension * 0.38)) }}
      >
        {getInitials(name || "")}
      </span>
    </div>
  );
}
