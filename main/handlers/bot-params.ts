import {
  BOT_LIMITS,
  isBotAvatar,
  type BotAvatarSuggestionInput,
  type BotCreateInput,
  type BotUpdateInput,
} from "../../renderer/shared/bots.js";
import {
  isBoundedBotText,
  isPathSafeBotCapabilityId,
} from "../../renderer/shared/bot-capabilities.js";

const CREATE_KEYS = new Set([
  "avatar",
  "description",
  "instructions",
  "name",
  "openingGreeting",
]);
const UPDATE_KEYS = new Set([...CREATE_KEYS, "expectedRevision", "id"]);
const CHAT_KEYS = new Set(["botId", "model", "providerId", "workspaceId"]);
const AVATAR_SUGGESTION_KEYS = new Set([
  "currentAvatar",
  "model",
  "prompt",
  "providerId",
  "requestId",
]);

function exact(value: unknown, keys: ReadonlySet<string>, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}.`);
  const record = value as Record<string, unknown>;
  let count = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    count += 1;
    if (count > keys.size || !keys.has(key)) throw new Error(`Invalid ${label}.`);
  }
  return record;
}

function text(value: unknown, label: string, maximum: number, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim() || !isBoundedBotText(value, maximum))
    throw new Error(`Invalid ${label}.`);
  return value;
}

function createFields(record: Record<string, unknown>): BotCreateInput {
  if (!isBotAvatar(record.avatar)) throw new Error("Invalid bot avatar.");
  const openingGreeting = text(
    record.openingGreeting,
    "bot opening greeting",
    BOT_LIMITS.openingGreetingChars,
    true,
  );
  return {
    name: text(record.name, "bot name", BOT_LIMITS.nameChars)!,
    description: text(record.description, "bot description", BOT_LIMITS.descriptionChars, true),
    instructions: text(record.instructions, "bot instructions", BOT_LIMITS.instructionsChars)!,
    ...(openingGreeting === undefined ? {} : { openingGreeting }),
    avatar: record.avatar,
  };
}

export function parseBotCreate(value: unknown): BotCreateInput {
  return createFields(exact(value, CREATE_KEYS, "bot creation fields"));
}

export function parseBotUpdate(value: unknown): BotUpdateInput {
  const record = exact(value, UPDATE_KEYS, "bot update fields");
  return {
    id: parseBotId(record.id),
    expectedRevision: parseBotRevision(record.expectedRevision),
    ...createFields(record),
  };
}

export function parseBotRevision(value: unknown): string {
  if (!isPathSafeBotCapabilityId(value, 128)) {
    throw new Error("Invalid bot revision.");
  }
  return value;
}

export function parseBotId(value: unknown): string {
  if (!isPathSafeBotCapabilityId(value, BOT_LIMITS.idChars)) {
    throw new Error("Invalid bot id.");
  }
  return value;
}

export function parseBotChatCreate(value: unknown) {
  const record = exact(value, CHAT_KEYS, "bot chat creation fields");
  // Legacy desktop renderers still send the visible workspace selection. Bot
  // chats now always use their main-owned hidden home, so accept but ignore it.
  if (record.workspaceId !== undefined) {
    text(record.workspaceId, "workspace id", 256);
  }
  return {
    botId: parseBotId(record.botId),
    providerId: text(record.providerId, "provider id", 256, true),
    model: text(record.model, "model id", 512, true),
  };
}

export function parseBotAvatarSuggestionInput(value: unknown): BotAvatarSuggestionInput {
  const record = exact(value, AVATAR_SUGGESTION_KEYS, "bot avatar suggestion fields");
  if (!isBotAvatar(record.currentAvatar)) throw new Error("Invalid current bot avatar.");
  return {
    requestId: text(record.requestId, "bot avatar request id", BOT_LIMITS.avatarRequestIdChars)!,
    prompt: text(record.prompt, "bot avatar prompt", BOT_LIMITS.avatarPromptChars)!,
    providerId: text(record.providerId, "provider id", 256)!,
    model: text(record.model, "model id", 512)!,
    currentAvatar: record.currentAvatar,
  };
}

export function parseBotAvatarRequestId(value: unknown): string {
  return text(value, "bot avatar request id", BOT_LIMITS.avatarRequestIdChars)!;
}
