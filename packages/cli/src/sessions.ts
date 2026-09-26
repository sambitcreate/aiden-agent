import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeAidenChatExport } from "../../../main/services/chat-export.js";
import type { Chat, ChatMessage } from "../../../main/services/types.js";

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export function sessionChat(manager: Pick<SessionManager, "getBranch" | "getSessionId" | "getSessionName" | "getHeader">): Chat {
  const messages: ChatMessage[] = [];
  let providerId: string | undefined, model: string | undefined;
  for (const entry of manager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "assistant") { providerId = message.provider; model = message.model; }
    const attachments = Array.isArray(message.content) ? message.content.flatMap((part) => part.type === "image" ? [{
      id: randomUUID(), kind: "image" as const, name: "Image", mimeType: part.mimeType,
      data: part.data, size: Buffer.byteLength(part.data, "base64"),
    }] : []) : [];
    messages.push({ id: entry.id, role: message.role, content: messageText(message.content),
      createdAt: message.timestamp, ...(message.role === "assistant" ? { model: message.model } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
  }
  const createdAt = Date.parse(manager.getHeader()?.timestamp ?? new Date().toISOString());
  return { id: manager.getSessionId(), title: manager.getSessionName() ?? "New agent", providerId, model,
    createdAt, updatedAt: messages.at(-1)?.createdAt ?? createdAt, messages } as Chat;
}

export async function exportSession(manager: Parameters<typeof sessionChat>[0], target: string): Promise<string> {
  const destination = resolve(target);
  await writeAidenChatExport(destination, sessionChat(manager));
  return destination;
}

export async function searchSessions(agentDir: string, query: string) {
  if (!query.trim()) throw new Error("Provide a search query.");
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return (await SessionManager.listAll(join(agentDir, "sessions")))
    .filter((session) => words.every((word) => `${session.name ?? ""}\n${session.firstMessage}`.toLocaleLowerCase().includes(word)))
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(0, 100).map(({ id, path, cwd, name, firstMessage, modified }) => ({ id, path, cwd, title: name, preview: firstMessage, modified }));
}
