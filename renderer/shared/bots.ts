/** Legacy avatar ids remain readable so existing bots never lose their identity. */
export const BOT_AVATARS = ["spark", "orbit", "leaf", "prism", "wave", "ember"] as const;
export type LegacyBotAvatar = (typeof BOT_AVATARS)[number];

export const BOT_AVATAR_LABELS: Record<LegacyBotAvatar, string> = {
  spark: "Wisp",
  orbit: "Orb",
  leaf: "Drop",
  prism: "Hex",
  wave: "Cloud",
  ember: "Peak",
};

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

export const BOT_AVATAR_EYES = ["dots", "wide", "happy", "sleepy", "focus", "wink"] as const;
export type BotAvatarEyes = (typeof BOT_AVATAR_EYES)[number];

export const BOT_AVATAR_EYE_LABELS: Record<BotAvatarEyes, string> = {
  dots: "Friendly",
  wide: "Curious",
  happy: "Bright",
  sleepy: "Calm",
  focus: "Focused",
  wink: "Playful",
};

export const BOT_AVATAR_DETAILS = [
  "none",
  "halo",
  "orbit",
  "sparkles",
  "antenna",
  "bolts",
] as const;
export type BotAvatarDetail = (typeof BOT_AVATAR_DETAILS)[number];

export const BOT_AVATAR_DETAIL_LABELS: Record<BotAvatarDetail, string> = {
  none: "Clean",
  halo: "Halo",
  orbit: "Orbit",
  sparkles: "Sparkles",
  antenna: "Antenna",
  bolts: "Bolts",
};

/** A bounded, theme-safe vector recipe. Facial features are intentionally eyes only. */
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
  avatarPromptChars: 1_200,
  avatarRationaleChars: 280,
  avatarRequestIdChars: 128,
} as const;

export const BOT_AVATAR_GENERATION_FAILURE_MESSAGES = {
  busy: "A bot face is already being designed in this window. Wait for it to stop and try again.",
  cancelled: "Bot face design was cancelled.",
  provider: "The selected model could not design a bot face. Check its connection and try again.",
  timeout: "The selected model took too long to design a bot face. Try again.",
} as const;

export type BotAvatarGenerationFailureKind = keyof typeof BOT_AVATAR_GENERATION_FAILURE_MESSAGES;

/** Strip Electron's IPC wrapper by projecting only main-owned, allowlisted copy. */
export function botAvatarSuggestionErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    Object.values(BOT_AVATAR_GENERATION_FAILURE_MESSAGES).find((message) =>
      raw.includes(message),
    ) ?? BOT_AVATAR_GENERATION_FAILURE_MESSAGES.provider
  );
}

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

export interface BotAvatarSuggestionInput {
  requestId: string;
  prompt: string;
  providerId: string;
  model: string;
  currentAvatar: BotAvatar;
}

export interface BotAvatarSuggestion {
  avatar: BotAvatarAppearance;
  rationale: string;
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
