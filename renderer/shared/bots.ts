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

/**
 * The one colour table for Bot characters, shared with Aiden On The Go: the
 * `--bot-avatar-*` tokens in `styles.css`, the iOS and Android palettes, and
 * the `botAvatarPalette` contract fixture all use exactly these values.
 */
export const BOT_AVATAR_COLOR_HEX: Record<BotAvatarColor, string> = {
  lilac: "#C6A9FF",
  sky: "#83D8FF",
  mint: "#88E8B1",
  sun: "#FFDA7B",
  periwinkle: "#B2BCFF",
  coral: "#FF9F9B",
  peach: "#FFC294",
  aqua: "#78E8DF",
  rose: "#FFA3C7",
  lime: "#C6EC7E",
  plum: "#DDA8F2",
  graphite: "#C5C5CE",
};

/** The eye mark drawn on every character colour. */
export const BOT_AVATAR_FACE_HEX = "#292735";

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
} as const;

export const BOT_CHAT_ACTIVITY_LEVELS = ["quiet", "summary", "detailed"] as const;
export type BotChatActivityLevel = (typeof BOT_CHAT_ACTIVITY_LEVELS)[number];
export const BOT_CHAT_ACTIVITY_WORDINGS = ["follows", "thinking"] as const;
export type BotChatActivityWording = (typeof BOT_CHAT_ACTIVITY_WORDINGS)[number];

/** How much a Bot chat shows while the Bot works, and what its status line says (spec §7). */
export interface BotChatActivity {
  level: BotChatActivityLevel;
  wording: BotChatActivityWording;
}

/** What an absent setting means; new Bots never store it. */
const DEFAULT_BOT_CHAT_ACTIVITY: BotChatActivity = { level: "quiet", wording: "follows" };

/** Exact check: both keys, current values, nothing else. */
export function parseBotChatActivity(value: unknown): BotChatActivity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.every((key) => key === "level" || key === "wording")) return undefined;
  if (!includes(BOT_CHAT_ACTIVITY_LEVELS, record.level) || !includes(BOT_CHAT_ACTIVITY_WORDINGS, record.wording))
    return undefined;
  return { level: record.level, wording: record.wording };
}

export function resolveBotChatActivity(value: BotChatActivity | undefined): BotChatActivity {
  return value ? { level: value.level, wording: value.wording } : { ...DEFAULT_BOT_CHAT_ACTIVITY };
}

/**
 * How much a Bot may interrupt the person (spec §6 P4): quiet hours, in the
 * Mac's time zone, and a cap on proactive notifications per local day.
 */
export interface BotInterruptions {
  quietHours: { enabled: boolean; start: string; end: string };
  dailyLimit: number;
}

export const BOT_INTERRUPTIONS_MAX_DAILY_LIMIT = 20;

export const DEFAULT_BOT_INTERRUPTIONS: BotInterruptions = {
  quietHours: { enabled: true, start: "22:00", end: "07:00" },
  dailyLimit: 5,
};

const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

/** Strict: exact keys, HH:MM times (00:00–23:59), a whole limit 0–20. */
export function parseBotInterruptions(value: unknown): BotInterruptions {
  const fail = (): never => {
    throw new Error("Invalid interruption settings.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.every((key) => key === "quietHours" || key === "dailyLimit")) return fail();
  const quiet = record.quietHours;
  if (!quiet || typeof quiet !== "object" || Array.isArray(quiet)) return fail();
  const hours = quiet as Record<string, unknown>;
  const hourKeys = Object.keys(hours);
  if (hourKeys.length !== 3 || !hourKeys.every((key) => key === "enabled" || key === "start" || key === "end")) return fail();
  if (typeof hours.enabled !== "boolean") return fail();
  if (typeof hours.start !== "string" || !CLOCK_TIME.test(hours.start)) return fail();
  if (typeof hours.end !== "string" || !CLOCK_TIME.test(hours.end)) return fail();
  const limit = record.dailyLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > BOT_INTERRUPTIONS_MAX_DAILY_LIMIT) return fail();
  return { quietHours: { enabled: hours.enabled, start: hours.start, end: hours.end }, dailyLimit: limit };
}

/** The stored setting, or the defaults when none (or an unreadable one) is stored. */
export function resolveBotInterruptions(value: unknown): BotInterruptions {
  try {
    return value === undefined ? structuredClone(DEFAULT_BOT_INTERRUPTIONS) : parseBotInterruptions(value);
  } catch {
    return structuredClone(DEFAULT_BOT_INTERRUPTIONS);
  }
}

export interface BotDefinition {
  id: string;
  /** Main-owned optimistic concurrency token for identity/archive mutations. */
  revision: string;
  name: string;
  description?: string;
  /** The Bot's soul: person-authored personality and how it helps (Profile → Instructions). */
  instructions: string;
  avatar: BotAvatar;
  /** Absent: Quiet, Follows the work. */
  chatActivity?: BotChatActivity;
  /** Absent: the defaults (quiet hours 22:00–07:00, 5 a day). */
  interruptions?: BotInterruptions;
  /** `false`: the person turned off "Let <Bot> set its own wake-ups". Absent: on (main never stores `true`). */
  selfWakeUps?: boolean;
  createdAt: number;
  updatedAt: number;
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
  avatar: BotAvatar;
}

export interface BotUpdateInput extends BotCreateInput {
  id: string;
  expectedRevision: string;
  /** Absent keeps the stored choice, so identity edits never reset it. */
  chatActivity?: BotChatActivity;
  /** Absent keeps the stored setting. */
  interruptions?: BotInterruptions;
  /** Absent keeps the stored setting. */
  selfWakeUps?: boolean;
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
