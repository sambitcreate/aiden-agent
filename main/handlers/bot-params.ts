import {
  BOT_LIMITS,
  isBotAvatar,
  type BotAvatarSuggestionInput,
  type BotCreateInput,
  type BotUpdateInput,
} from "../../renderer/shared/bots.js";

const CREATE_KEYS = new Set(["avatar", "description", "instructions", "name"]);
const UPDATE_KEYS = new Set([...CREATE_KEYS, "id"]);
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
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(`Invalid ${label}.`);
  return value;
}

function createFields(record: Record<string, unknown>): BotCreateInput {
  if (!isBotAvatar(record.avatar)) throw new Error("Invalid bot avatar.");
  return {
    name: text(record.name, "bot name", BOT_LIMITS.nameChars)!,
    description: text(record.description, "bot description", BOT_LIMITS.descriptionChars, true),
    instructions: text(record.instructions, "bot instructions", BOT_LIMITS.instructionsChars)!,
    avatar: record.avatar,
  };
}

export function parseBotCreate(value: unknown): BotCreateInput {
  return createFields(exact(value, CREATE_KEYS, "bot creation fields"));
}

export function parseBotUpdate(value: unknown): BotUpdateInput {
  const record = exact(value, UPDATE_KEYS, "bot update fields");
  return { id: text(record.id, "bot id", BOT_LIMITS.idChars)!, ...createFields(record) };
}

export function parseBotId(value: unknown): string {
  return text(value, "bot id", BOT_LIMITS.idChars)!;
}

export function parseBotChatCreate(value: unknown) {
  const record = exact(value, CHAT_KEYS, "bot chat creation fields");
  return {
    botId: parseBotId(record.botId),
    workspaceId: text(record.workspaceId, "workspace id", 256)!,
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
