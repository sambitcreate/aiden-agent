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
  "rose",
  "lime",
  "plum",
  "graphite",
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
  rose: "Rose",
  lime: "Lime",
  plum: "Plum",
  graphite: "Graphite",
};

/** A bounded, theme-safe vector recipe: one colour and one shape, with one fixed eye mark. */
export interface BotAvatarAppearance {
  version: 1;
  shape: BotAvatarShape;
  color: BotAvatarColor;
}

export type BotAvatar = BotAvatarAppearance;

export const DEFAULT_BOT_AVATAR: BotAvatarAppearance = {
  version: 1,
  shape: "wisp",
  color: "lilac",
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

/** Exact recipe check for new input (IPC, Remote, tools). */
export function isBotAvatarAppearance(value: unknown): value is BotAvatarAppearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const avatar = value as Record<string, unknown>;
  const keys = Object.keys(avatar);
  return (
    keys.length === 3 &&
    keys.every((key) => ["version", "shape", "color"].includes(key)) &&
    avatar.version === 1 &&
    includes(BOT_AVATAR_SHAPES, avatar.shape) &&
    includes(BOT_AVATAR_COLORS, avatar.color)
  );
}

export function isBotAvatar(value: unknown): value is BotAvatar {
  return isBotAvatarAppearance(value);
}

export function resolveBotAvatar(value: BotAvatar): BotAvatarAppearance {
  return { version: 1, shape: value.shape, color: value.color };
}
