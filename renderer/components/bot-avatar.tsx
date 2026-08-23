import * as React from "react";
import {
  resolveBotAvatar,
  type BotAvatar as BotAvatarValue,
  type BotAvatarAppearance,
  type BotAvatarEyes,
  type BotAvatarShape,
} from "../shared/bots";
import { useBotCanonicalPhoto } from "../lib/bot-canonical-photo-cache";

interface AvatarBody {
  path: string;
  eyeY: number;
  eyeSpread: number;
}

const avatarBodies: Record<BotAvatarShape, AvatarBody> = {
  wisp: {
    path: "M20 3.5C25 3.5 26.5 7.2 30.8 8.8C35.2 10.5 37 14.4 35.2 18.5C33.8 21.7 36 24.5 33.5 29.2C31.2 33.7 27.5 32.8 23.2 35.3C18.8 37.9 15.8 34.7 11.2 34.2C6.6 33.7 5.4 29.8 5.7 25.4C6 21.6 2.9 19.3 4.8 14.8C6.6 10.4 10.5 10.5 13.4 7.2C15.3 5 17.2 3.5 20 3.5Z",
    eyeY: 19,
    eyeSpread: 4.8,
  },
  orb: {
    path: "M20 3.5A16.5 16.5 0 1 1 20 36.5A16.5 16.5 0 0 1 20 3.5Z",
    eyeY: 19,
    eyeSpread: 5,
  },
  drop: {
    path: "M20 3.2C20 3.2 6.2 19 6.2 26.4A13.8 12.5 0 0 0 33.8 26.4C33.8 19 20 3.2 20 3.2Z",
    eyeY: 24,
    eyeSpread: 4.7,
  },
  hex: {
    path: "M20 3.5L34.3 11.8V28.2L20 36.5L5.7 28.2V11.8L20 3.5Z",
    eyeY: 19,
    eyeSpread: 5,
  },
  cloud: {
    path: "M10.2 33A7.3 7.3 0 0 1 9 18.5A9.8 9.8 0 0 1 28.8 14A7.4 7.4 0 0 1 30.1 33H10.2Z",
    eyeY: 24,
    eyeSpread: 5,
  },
  peak: {
    path: "M20 4.5C20.7 4.5 21.3 5 21.8 5.8L35.8 31.4C36.5 32.7 35.6 34.3 34.1 34.3H5.9C4.4 34.3 3.5 32.7 4.2 31.4L18.2 5.8C18.7 5 19.3 4.5 20 4.5Z",
    eyeY: 25,
    eyeSpread: 4.5,
  },
  squircle: {
    path: "M12.1 4.2C7.1 4.7 4.7 7.1 4.2 12.1C3.7 17.4 3.7 22.6 4.2 27.9C4.7 32.9 7.1 35.3 12.1 35.8C17.4 36.3 22.6 36.3 27.9 35.8C32.9 35.3 35.3 32.9 35.8 27.9C36.3 22.6 36.3 17.4 35.8 12.1C35.3 7.1 32.9 4.7 27.9 4.2C22.6 3.7 17.4 3.7 12.1 4.2Z",
    eyeY: 20,
    eyeSpread: 5,
  },
  capsule: {
    path: "M12.8 3.8H27.2C32.4 3.8 35.8 8.1 35.8 13.3V26.7C35.8 31.9 32.4 36.2 27.2 36.2H12.8C7.6 36.2 4.2 31.9 4.2 26.7V13.3C4.2 8.1 7.6 3.8 12.8 3.8Z",
    eyeY: 20,
    eyeSpread: 5.3,
  },
};

function EyePair({ style, y, spread }: { style: BotAvatarEyes; y: number; spread: number }) {
  const left = 20 - spread;
  const right = 20 + spread;
  const ink = "var(--bot-avatar-face)";
  const highlight = "var(--bot-avatar-eye-highlight)";

  if (style === "happy") {
    return (
      <g fill="none" stroke={ink} strokeLinecap="round" strokeWidth="2.35">
        <path
          d={`M${left - 2.2} ${y + 0.8}C${left - 1.1} ${y - 2} ${left + 1.1} ${y - 2} ${left + 2.2} ${y + 0.8}`}
        />
        <path
          d={`M${right - 2.2} ${y + 0.8}C${right - 1.1} ${y - 2} ${right + 1.1} ${y - 2} ${right + 2.2} ${y + 0.8}`}
        />
      </g>
    );
  }
  if (style === "sleepy") {
    return (
      <g fill="none" stroke={ink} strokeLinecap="round" strokeWidth="2.35">
        <path
          d={`M${left - 2.3} ${y}C${left - 1} ${y + 1.2} ${left + 1} ${y + 1.2} ${left + 2.3} ${y}`}
        />
        <path
          d={`M${right - 2.3} ${y}C${right - 1} ${y + 1.2} ${right + 1} ${y + 1.2} ${right + 2.3} ${y}`}
        />
      </g>
    );
  }
  if (style === "focus") {
    return (
      <g fill={ink}>
        <rect
          x={left - 2.5}
          y={y - 1.2}
          width="5"
          height="2.6"
          rx="1.3"
          transform={`rotate(9 ${left} ${y})`}
        />
        <rect
          x={right - 2.5}
          y={y - 1.2}
          width="5"
          height="2.6"
          rx="1.3"
          transform={`rotate(-9 ${right} ${y})`}
        />
      </g>
    );
  }
  if (style === "wink") {
    return (
      <>
        <ellipse cx={left} cy={y} rx="2.1" ry="2.9" fill={ink} />
        <circle cx={left - 0.65} cy={y - 0.9} r="0.58" fill={highlight} />
        <path
          d={`M${right - 2.3} ${y}C${right - 1} ${y + 1.3} ${right + 1} ${y + 1.3} ${right + 2.3} ${y}`}
          fill="none"
          stroke={ink}
          strokeLinecap="round"
          strokeWidth="2.35"
        />
      </>
    );
  }

  const wide = style === "wide";
  const radiusX = wide ? 2.7 : 2.05;
  const radiusY = wide ? 3.25 : 2.85;
  return (
    <>
      <g fill={ink}>
        <ellipse cx={left} cy={y} rx={radiusX} ry={radiusY} />
        <ellipse cx={right} cy={y} rx={radiusX} ry={radiusY} />
      </g>
      <g fill={highlight} opacity="0.94">
        <circle cx={left - 0.7} cy={y - 1} r={wide ? 0.72 : 0.58} />
        <circle cx={right - 0.7} cy={y - 1} r={wide ? 0.72 : 0.58} />
      </g>
    </>
  );
}

function BackDetail({ appearance }: { appearance: BotAvatarAppearance }) {
  const ink = "var(--bot-avatar-face)";
  if (appearance.detail === "halo") {
    return (
      <ellipse
        cx="20"
        cy="5.2"
        rx="8"
        ry="2.5"
        fill="none"
        stroke={ink}
        strokeWidth="1.5"
        opacity="0.46"
      />
    );
  }
  if (appearance.detail === "orbit") {
    return (
      <ellipse
        cx="20"
        cy="20"
        rx="19"
        ry="8.2"
        fill="none"
        stroke={ink}
        strokeWidth="1.45"
        opacity="0.42"
        transform="rotate(-18 20 20)"
      />
    );
  }
  if (appearance.detail === "antenna") {
    return (
      <g fill="none" stroke={ink} strokeLinecap="round" strokeWidth="1.7" opacity="0.62">
        <path d="M20 7V2.8" />
        <circle cx="20" cy="1.8" r="1.5" fill={ink} stroke="none" />
      </g>
    );
  }
  return null;
}

function FrontDetail({ appearance }: { appearance: BotAvatarAppearance }) {
  const ink = "var(--bot-avatar-face)";
  if (appearance.detail === "sparkles") {
    return (
      <g fill={ink} opacity="0.52">
        <path d="M34 7.3L34.8 9.5L37 10.3L34.8 11.1L34 13.3L33.2 11.1L31 10.3L33.2 9.5Z" />
        <path d="M5.2 27.5L5.8 29.1L7.4 29.7L5.8 30.3L5.2 31.9L4.6 30.3L3 29.7L4.6 29.1Z" />
      </g>
    );
  }
  if (appearance.detail === "bolts") {
    return (
      <g fill={ink} opacity="0.5">
        <path d="M3.7 15.3L0.8 20H3.4L2.5 24.7L6.3 19.1H3.8Z" />
        <path d="M36.3 15.3L39.2 20H36.6L37.5 24.7L33.7 19.1H36.2Z" />
      </g>
    );
  }
  return null;
}

function AvatarFace({ avatar }: { avatar: BotAvatarValue }) {
  const appearance = resolveBotAvatar(avatar);
  const body = avatarBodies[appearance.shape];
  const color = `var(--bot-avatar-${appearance.color})`;
  return (
    <svg viewBox="0 0 40 40" focusable="false">
      <BackDetail appearance={appearance} />
      <path d={body.path} fill="var(--bot-avatar-face)" opacity="0.14" transform="translate(0 1)" />
      <path d={body.path} fill={color} />
      <path
        d={body.path}
        fill="var(--bot-avatar-sheen)"
        opacity="0.12"
        transform="translate(-1.2 -1.2) scale(.97)"
      />
      <EyePair style={appearance.eyes} y={body.eyeY} spread={body.eyeSpread} />
      <FrontDetail appearance={appearance} />
    </svg>
  );
}

/** Monochrome Aiden bot mark sized to match the sidebar's Lucide icon rhythm. */
export function BotSidebarIcon() {
  return (
    <svg aria-hidden="true" className="size-5" viewBox="0 0 24 24" fill="none" focusable="false">
      <path
        d="M12 2.9C14.8 2.9 15.5 5 17.8 5.8C20.1 6.6 21.1 8.8 20 10.9C19.2 12.5 20.5 14.1 19.1 16.5C17.9 18.7 15.9 18.2 13.6 19.6C11.3 21 9.7 19.3 7.3 19.1C4.9 18.8 4.2 16.7 4.4 14.4C4.6 12.4 2.9 11.2 4 8.9C5 6.6 7.1 6.7 8.6 5C9.6 3.7 10.6 2.9 12 2.9Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <ellipse cx="9.2" cy="11.3" rx="1.05" ry="1.45" fill="currentColor" />
      <ellipse cx="14.8" cy="11.3" rx="1.05" ry="1.45" fill="currentColor" />
    </svg>
  );
}

export function BotAvatar({
  avatar,
  botId,
  name,
  photoLoading = "none",
  size = "medium",
}: {
  avatar: BotAvatarValue;
  botId?: string;
  name: string;
  photoLoading?: "none" | "visible" | "immediate";
  size?: "small" | "medium" | "large" | "preview";
}) {
  const avatarRef = React.useRef<HTMLSpanElement>(null);
  const [nearViewport, setNearViewport] = React.useState(photoLoading === "immediate");
  React.useEffect(() => {
    if (photoLoading === "none") {
      setNearViewport(false);
      return;
    }
    if (photoLoading === "immediate") {
      setNearViewport(true);
      return;
    }
    const element = avatarRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      setNearViewport(entries.some(({ isIntersecting }) => isIntersecting));
    }, { rootMargin: "160px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [photoLoading]);
  const photoEnabled = Boolean(botId) && nearViewport && photoLoading !== "none";
  const photo = useBotCanonicalPhoto(
    botId,
    photoEnabled,
    photoLoading === "immediate" ? "selected" : "visible",
  );
  const [failedRevision, setFailedRevision] = React.useState<string>();
  const showPhoto = photo && failedRevision !== photo.assetRevision;
  return (
    <span
      ref={avatarRef}
      aria-hidden="true"
      title={name}
      className={`relative grid shrink-0 place-items-center overflow-hidden bg-control shadow-control ${
        size === "small"
          ? "size-7 rounded-card p-1"
          : size === "large"
            ? "size-12 rounded-card p-1.5"
            : size === "preview"
              ? "size-36 rounded-[2rem] p-5"
              : "size-9 rounded-card p-1.5"
      }`}
    >
      <AvatarFace avatar={avatar} />
      {showPhoto ? (
        <img
          alt=""
          className="absolute inset-0 size-full object-cover"
          draggable={false}
          src={photo.dataUrl}
          onError={() => setFailedRevision(photo.assetRevision)}
        />
      ) : null}
    </span>
  );
}
