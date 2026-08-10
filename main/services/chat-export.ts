import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Chat } from "./types.js";
import {
  projectVisibleChatMessage,
  projectVisibleChatMetadata,
  type VisibleChatMessage,
} from "./visible-chat-projection.js";
import { jsonStringBytesBounded } from "./json-representation.js";
import { boundedUnicodePrefix } from "../../renderer/shared/unicode-prefix.js";

export const AIDEN_CHAT_EXPORT_VERSION = 1 as const;
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_MESSAGES = 10_000;

function createExportBudget() {
  let charged = 4 * 1024;
  const charge = (text: string | undefined) => {
    if (text === undefined) return;
    charged += jsonStringBytesBounded(text, MAX_EXPORT_BYTES - charged);
    if (charged > MAX_EXPORT_BYTES) {
      throw new Error("This chat is too large to export as one Aiden file.");
    }
  };
  const chargeMessage = (message: AidenChatExportMessageV1) => {
    charged += 512;
    charge(message.id);
    charge(message.role);
    charge(message.content);
    charge(message.model);
    charge(message.skill?.name);
    charge(message.skill?.source);
    for (const attachment of message.attachments ?? []) {
      charged += 256;
      charge(attachment.id);
      charge(attachment.name);
      charge(attachment.mimeType);
      charge(attachment.kind === "image" ? attachment.data : attachment.text);
    }
    if (charged > MAX_EXPORT_BYTES) {
      throw new Error("This chat is too large to export as one Aiden file.");
    }
  };
  return { charge, chargeMessage };
}

function assertExportRepresentationBounded(value: AidenChatExportV1): void {
  if (value.chat.messages.length > MAX_EXPORT_MESSAGES) {
    throw new Error("This chat has too many messages to export safely.");
  }
  const budget = createExportBudget();
  budget.charge(value.exportedAt);
  budget.charge(value.chat.title);
  budget.charge(value.chat.workspaceId);
  budget.charge(value.chat.providerId);
  budget.charge(value.chat.model);
  for (const message of value.chat.messages) {
    budget.chargeMessage(message);
  }
}

export interface AidenChatExportV1 {
  schema: "aiden.chat.export";
  version: typeof AIDEN_CHAT_EXPORT_VERSION;
  exportedAt: string;
  chat: {
    title: string;
    workspaceId?: string;
    providerId?: string;
    model?: string;
    createdAt: number;
    updatedAt: number;
    messages: AidenChatExportMessageV1[];
  };
}

export type AidenChatExportMessageV1 = VisibleChatMessage;

export function projectAidenChatExport(
  chat: Chat,
  exportedAt = new Date().toISOString(),
): AidenChatExportV1 {
  const metadata = projectVisibleChatMetadata(chat);
  const budget = createExportBudget();
  budget.charge(exportedAt);
  budget.charge(metadata.title);
  budget.charge(metadata.workspaceId);
  budget.charge(metadata.providerId);
  budget.charge(metadata.model);
  const messages: AidenChatExportMessageV1[] = [];
  for (const candidate of chat.messages) {
    const message = projectVisibleChatMessage(candidate);
    if (!message) continue;
    if (messages.length >= MAX_EXPORT_MESSAGES) {
      throw new Error("This chat has too many messages to export safely.");
    }
    budget.chargeMessage(message);
    messages.push(message);
  }
  const projected: AidenChatExportV1 = {
    schema: "aiden.chat.export",
    version: AIDEN_CHAT_EXPORT_VERSION,
    exportedAt,
    chat: {
      title: metadata.title,
      workspaceId: metadata.workspaceId,
      providerId: metadata.providerId,
      model: metadata.model,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messages,
    },
  };
  if (
    !Number.isSafeInteger(projected.chat.createdAt) ||
    projected.chat.createdAt < 0 ||
    !Number.isSafeInteger(projected.chat.updatedAt) ||
    projected.chat.updatedAt < 0
  ) {
    throw new Error("This chat contains invalid session timestamps.");
  }
  return projected;
}

export async function writeAidenChatExport(
  target: string,
  chat: Chat,
  exportedAt = new Date().toISOString(),
): Promise<void> {
  const value = projectAidenChatExport(chat, exportedAt);
  assertExportRepresentationBounded(value);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_EXPORT_BYTES) {
    throw new Error("This chat is too large to export as one Aiden file.");
  }
  const directory = path.dirname(target);
  const staging = path.join(directory, `.aiden-chat-export.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(staging, "wx", 0o600);
    try {
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(staging, target);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await fs.rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeAidenChatExportForRenderer(
  target: string,
  chat: Chat,
): Promise<void> {
  try {
    await writeAidenChatExport(target, chat);
  } catch {
    throw new Error("Aiden could not write the exported chat.");
  }
}

export function safeExportFileName(title: string): string {
  const normalized = boundedUnicodePrefix(title, 640)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const base = Array.from(normalized).slice(0, 80).join("");
  return `${base || "Aiden chat"}.aiden-chat.json`;
}
