// Bounded in-process companion extension registry for the Aiden Telegram surface.

import type { TelegramMessage, TelegramUpdate } from "./telegram-bot-api.js";
import type { TelegramInboundContent } from "./telegram-inbound.js";

export interface TelegramExtensionContext {
  profile: string;
  chatId: number;
  threadId?: number;
  ownerUserId: number;
  workspaceId?: string;
}

export interface TelegramExtensionCommand {
  name: string;
  description: string;
  handler(input: { argument: string; message: TelegramMessage; context: TelegramExtensionContext }): Promise<string | void>;
}

export interface TelegramExtensionSection {
  id: string;
  label: string;
  callbackData: string;
}

export interface TelegramVoiceSynthesisResult {
  bytes: Uint8Array;
  name?: string;
  mimeType?: "audio/ogg" | "audio/opus";
  caption?: string;
}

export interface TelegramExtensionRegistration {
  id: string;
  commands?: readonly TelegramExtensionCommand[];
  sections?: readonly TelegramExtensionSection[];
  statusRows?: () => readonly string[] | Promise<readonly string[]>;
  handleUpdate?: (update: TelegramUpdate, context: TelegramExtensionContext) => boolean | Promise<boolean>;
  handleCallback?: (data: string, context: TelegramExtensionContext) => string | void | Promise<string | void>;
  transformInbound?: (content: TelegramInboundContent, message: TelegramMessage, context: TelegramExtensionContext) => TelegramInboundContent | Promise<TelegramInboundContent>;
  transformOutbound?: (markdown: string, context: TelegramExtensionContext) => string | Promise<string>;
  synthesizeVoice?: (text: string, options: { lang?: string; rate?: string; context: TelegramExtensionContext }) => Promise<TelegramVoiceSynthesisResult | undefined>;
}

const extensions = new Map<string, TelegramExtensionRegistration>();
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const COMMAND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;

export function registerTelegramExtension(registration: TelegramExtensionRegistration): () => void {
  if (!ID_PATTERN.test(registration.id)) throw new Error(`Invalid Telegram extension id: ${registration.id}`);
  if (extensions.has(registration.id)) throw new Error(`Telegram extension already registered: ${registration.id}`);
  const commandNames = new Set<string>();
  for (const command of registration.commands ?? []) {
    if (!COMMAND_PATTERN.test(command.name)) throw new Error(`Invalid Telegram extension command: ${command.name}`);
    if (commandNames.has(command.name)) throw new Error(`Duplicate Telegram extension command: ${command.name}`);
    if ([...extensions.values()].some((extension) => extension.commands?.some((existing) => existing.name === command.name))) {
      throw new Error(`Telegram extension command already registered: ${command.name}`);
    }
    commandNames.add(command.name);
  }
  for (const section of registration.sections ?? []) {
    if (!section.id || section.id.length > 32 || !section.callbackData.startsWith(`ext:${registration.id}:`)) {
      throw new Error(`Telegram extension ${registration.id} has an invalid or unowned section callback.`);
    }
    if (section.label.length < 1 || section.label.length > 64 || section.callbackData.length > 64) {
      throw new Error(`Telegram extension ${registration.id} section exceeds Telegram limits.`);
    }
  }
  const frozen = Object.freeze({
    ...registration,
    commands: registration.commands ? Object.freeze([...registration.commands]) : undefined,
    sections: registration.sections ? Object.freeze([...registration.sections]) : undefined,
  });
  extensions.set(registration.id, frozen);
  return () => {
    if (extensions.get(registration.id) === frozen) extensions.delete(registration.id);
  };
}

export function getTelegramExtensions(): readonly TelegramExtensionRegistration[] {
  return [...extensions.values()];
}

export function telegramExtensionCallbackData(extensionId: string, action: string): string {
  if (!ID_PATTERN.test(extensionId) || !action || action.length > 40) throw new Error("Invalid Telegram extension callback identity.");
  return `ext:${extensionId}:${action}`;
}

export function clearTelegramExtensionsForTests(): void {
  extensions.clear();
}
