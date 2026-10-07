/** Legacy avatar ids are still read from older Bot stores; Aiden never writes them. */
export const BOT_AVATARS = ["spark", "orbit", "leaf", "prism", "wave", "ember"] as const;
export type LegacyBotAvatar = (typeof BOT_AVATARS)[number];

export const BOT_AVATAR_SHAPES = [
  "wisp",
  "orb",
  "drop",
  "hex",
  "cloud",
  "peak",
  "squircle",
  "capsule",
] as const;
export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number];

export const BOT_AVATAR_SHAPE_LABELS: Record<BotAvatarShape, string> = {
  wisp: "Wisp",
  orb: "Orb",
  drop: "Drop",
  hex: "Hex",
  cloud: "Cloud",
  peak: "Peak",
  squircle: "Squircle",
  capsule: "Capsule",
};

export const BOT_AVATAR_COLORS = [
  "lilac",
  "sky",
  "mint",
  "sun",
  "periwinkle",
  "coral",
  "peach",
  "aqua",
] as const;
export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number];

export const BOT_AVATAR_COLOR_LABELS: Record<BotAvatarColor, string> = {
  lilac: "Lilac",
  sky: "Sky",
  mint: "Mint",
  sun: "Sun",
  periwinkle: "Periwinkle",
  coral: "Coral",
  peach: "Peach",
  aqua: "Aqua",
};

/**
 * Retired avatar axes. Every Bot now renders one fixed eye mark, and Aiden no
 * longer offers these as choices. They stay in the stored and paired-device
 * recipe until the next Aiden Remote revision drops them on all clients.
 */
export const BOT_AVATAR_EYES = ["dots", "wide", "happy", "sleepy", "focus", "wink"] as const;
export type BotAvatarEyes = (typeof BOT_AVATAR_EYES)[number];

export const BOT_AVATAR_DETAILS = [
  "none",
  "halo",
  "orbit",
  "sparkles",
  "antenna",
  "bolts",
] as const;
export type BotAvatarDetail = (typeof BOT_AVATAR_DETAILS)[number];

/**
 * A bounded, theme-safe vector recipe. Only `shape` and `color` are chosen by
 * people; `eyes` and `detail` are retired and ignored by the renderer.
 */
export interface BotAvatarAppearance {
  version: 1;
  shape: BotAvatarShape;
  color: BotAvatarColor;
  eyes: BotAvatarEyes;
  detail: BotAvatarDetail;
}

export type BotAvatar = LegacyBotAvatar | BotAvatarAppearance;

export const DEFAULT_BOT_AVATAR: BotAvatarAppearance = {
  version: 1,
  shape: "wisp",
  color: "lilac",
  eyes: "dots",
  detail: "sparkles",
};

const LEGACY_BOT_AVATAR_APPEARANCES: Record<LegacyBotAvatar, BotAvatarAppearance> = {
  spark: DEFAULT_BOT_AVATAR,
  orbit: { version: 1, shape: "orb", color: "sky", eyes: "wide", detail: "orbit" },
  leaf: { version: 1, shape: "drop", color: "mint", eyes: "happy", detail: "none" },
  prism: { version: 1, shape: "hex", color: "sun", eyes: "focus", detail: "bolts" },
  wave: { version: 1, shape: "cloud", color: "periwinkle", eyes: "sleepy", detail: "halo" },
  ember: { version: 1, shape: "peak", color: "coral", eyes: "wink", detail: "antenna" },
};

export const BOT_LIMITS = {
  idChars: 160,
  nameChars: 80,
  descriptionChars: 280,
  instructionsChars: 32_000,
  openingGreetingChars: 2_000,
} as const;

export interface BotDefinition {
  id: string;
  /** Main-owned optimistic concurrency token for identity/archive mutations. */
  revision: string;
  name: string;
  description?: string;
  instructions: string;
  /** Copied into a newly created Bot chat once; editing never rewrites history. */
  openingGreeting?: string;
  avatar: BotAvatar;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

/** Bounded canonical PNG bytes projected by main without exposing its private asset path. */
export interface BotRendererCanonicalPhoto {
  assetRevision: string;
  dataUrl: `data:image/png;base64,${string}`;
}

export interface BotCreateInput {
  name: string;
  description?: string;
  instructions: string;
  openingGreeting?: string;
  avatar: BotAvatar;
}

export interface BotUpdateInput extends BotCreateInput {
  id: string;
  expectedRevision: string;
}

export interface TelegramBotBindingView {
  botId: string;
  profile: string;
  chatId: number;
  threadId?: number;
  ownerUserId: number;
  backingChatId: string;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
}

export interface TelegramBotTargetOption {
  profile: string;
  label: string;
  paired: boolean;
  hasToken: boolean;
  enabled: boolean;
  chatId?: number;
  threadId?: number;
  workspaceId?: string;
  workspaceName?: string;
}

function includes<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isLegacyBotAvatar(value: unknown): value is LegacyBotAvatar {
  return includes(BOT_AVATARS, value);
}

export function isBotAvatarAppearance(value: unknown): value is BotAvatarAppearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const avatar = value as Record<string, unknown>;
  const keys = Object.keys(avatar);
  return (
    keys.length === 5 &&
    keys.every((key) => ["version", "shape", "color", "eyes", "detail"].includes(key)) &&
    avatar.version === 1 &&
    includes(BOT_AVATAR_SHAPES, avatar.shape) &&
    includes(BOT_AVATAR_COLORS, avatar.color) &&
    includes(BOT_AVATAR_EYES, avatar.eyes) &&
    includes(BOT_AVATAR_DETAILS, avatar.detail)
  );
}

export function isBotAvatar(value: unknown): value is BotAvatar {
  return isLegacyBotAvatar(value) || isBotAvatarAppearance(value);
}

export function resolveBotAvatar(value: BotAvatar): BotAvatarAppearance {
  const appearance = typeof value === "string" ? LEGACY_BOT_AVATAR_APPEARANCES[value] : value;
  return { ...appearance };
}
