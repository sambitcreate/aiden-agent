export const BOT_AVATARS = ["spark", "orbit", "leaf", "prism", "wave", "ember"] as const;
export type BotAvatar = (typeof BOT_AVATARS)[number];

export const BOT_AVATAR_LABELS: Record<BotAvatar, string> = {
  spark: "Wisp",
  orbit: "Orb",
  leaf: "Drop",
  prism: "Hex",
  wave: "Cloud",
  ember: "Peak",
};

export const BOT_LIMITS = {
  idChars: 160,
  nameChars: 80,
  descriptionChars: 280,
  instructionsChars: 32_000,
} as const;

export interface BotDefinition {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  avatar: BotAvatar;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface BotCreateInput {
  name: string;
  description?: string;
  instructions: string;
  avatar: BotAvatar;
}

export interface BotUpdateInput extends BotCreateInput {
  id: string;
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

export function isBotAvatar(value: unknown): value is BotAvatar {
  return typeof value === "string" && (BOT_AVATARS as readonly string[]).includes(value);
}
