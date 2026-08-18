import type { BotAvatar as BotAvatarName } from "../shared/bots";

const avatarBodies: Record<BotAvatarName, { color: string; path: string; eyeY: number }> = {
  spark: {
    color: "var(--bot-avatar-wisp)",
    path: "M20 3.5C25 3.5 26.5 7.2 30.8 8.8C35.2 10.5 37 14.4 35.2 18.5C33.8 21.7 36 24.5 33.5 29.2C31.2 33.7 27.5 32.8 23.2 35.3C18.8 37.9 15.8 34.7 11.2 34.2C6.6 33.7 5.4 29.8 5.7 25.4C6 21.6 2.9 19.3 4.8 14.8C6.6 10.4 10.5 10.5 13.4 7.2C15.3 5 17.2 3.5 20 3.5Z",
    eyeY: 18,
  },
  orbit: {
    color: "var(--bot-avatar-orb)",
    path: "M20 3.5A16.5 16.5 0 1 1 20 36.5A16.5 16.5 0 0 1 20 3.5Z",
    eyeY: 18,
  },
  leaf: {
    color: "var(--bot-avatar-drop)",
    path: "M20 3.2C20 3.2 6.2 19 6.2 26.4A13.8 12.5 0 0 0 33.8 26.4C33.8 19 20 3.2 20 3.2Z",
    eyeY: 23,
  },
  prism: {
    color: "var(--bot-avatar-hex)",
    path: "M20 3.5L34.3 11.8V28.2L20 36.5L5.7 28.2V11.8L20 3.5Z",
    eyeY: 18,
  },
  wave: {
    color: "var(--bot-avatar-cloud)",
    path: "M10.2 33A7.3 7.3 0 0 1 9 18.5A9.8 9.8 0 0 1 28.8 14A7.4 7.4 0 0 1 30.1 33H10.2Z",
    eyeY: 23,
  },
  ember: {
    color: "var(--bot-avatar-peak)",
    path: "M20 4.5L36 33.8H4L20 4.5Z",
    eyeY: 25,
  },
};

function AvatarFace({ avatar }: { avatar: BotAvatarName }) {
  const body = avatarBodies[avatar];
  return (
    <svg viewBox="0 0 40 40" focusable="false">
      <path d={body.path} fill={body.color} />
      <path d={body.path} fill="var(--bot-avatar-sheen)" opacity="0.08" transform="translate(-1 -1) scale(.97)" />
      <g fill="var(--bot-avatar-face)">
        <ellipse cx="15.3" cy={body.eyeY} rx="2.25" ry="3.15" />
        <ellipse cx="24.7" cy={body.eyeY} rx="2.25" ry="3.15" />
      </g>
      <g fill="var(--bot-avatar-eye-highlight)" opacity="0.9">
        <circle cx="14.6" cy={body.eyeY - 1} r="0.65" />
        <circle cx="24" cy={body.eyeY - 1} r="0.65" />
      </g>
      <circle cx="33.2" cy="7.2" r="2.2" fill="var(--bot-avatar-marker)" stroke="var(--bot-avatar-eye-highlight)" strokeWidth="1.2" />
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

export function BotAvatar({ avatar, name, size = "medium" }: {
  avatar: BotAvatarName;
  name: string;
  size?: "small" | "medium" | "large";
}) {
  return (
    <span
      aria-hidden="true"
      title={name}
      className={`grid shrink-0 place-items-center rounded-card bg-control shadow-control ${
        size === "small"
          ? "size-7 p-1"
          : size === "large"
            ? "size-12 p-1.5"
            : "size-9 p-1.5"
      }`}
    >
      <AvatarFace avatar={avatar} />
    </span>
  );
}
