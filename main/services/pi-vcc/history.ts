import { VccError } from "./errors.js";
import { createHash } from "node:crypto";
import type { AgentMessage, CompactionPreparation } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { sanitizeCredentialText } from "../../../renderer/shared/subagent-safe-text.js";
import type { PiSessionEntry } from "../pi-session-port.js";

export interface HistoryMessage {
  reference: string;
  message: AgentMessage;
}
export interface HistoryArchive {
  messages: HistoryMessage[];
  opaque: string[];
}

const fingerprint = (message: AgentMessage): string =>
  createHash("sha256").update(JSON.stringify(message)).digest("hex");

/** Only the caller's active branch is accepted. Never read ambient session files. */
export function archiveFromBranch(branch: readonly PiSessionEntry[]): HistoryArchive {
  if (branch.length > 100_000) throw new VccError("history_limit");
  const messages: HistoryMessage[] = [];
  const known = new Set<string>();
  let opaque: string[] = [];
  for (const entry of branch) {
    if (entry.type === "message") {
      messages.push({ reference: entry.id, message: entry.message });
      known.add(fingerprint(entry.message));
    } else if (entry.type === "compaction") {
      // A checkpoint without preceding source messages is an imported gap.
      // Never pretend its summary can be regenerated from just its kept tail.
      const details = entry.details as { engine?: unknown } | undefined;
      // A v4 checkpoint does not prove that all pre-import raw history exists.
      // Preserve the newest LLM/unknown summary as opaque carry-forward context;
      // replacing older opaque summaries bounds repeated engine switching.
      if (entry.summary.trim() && (messages.length === 0 || details?.engine !== "vcc")) {
        opaque = [entry.summary];
      }
      for (const [index, message] of entry.retainedTail.entries()) {
        const key = fingerprint(message);
        if (known.has(key)) continue;
        messages.push({ reference: `${entry.id}:retained:${index}`, message });
        known.add(key);
      }
    } else if (entry.type === "branch_summary" && entry.summary.trim()) {
      const message: AgentMessage = {
        role: "branchSummary",
        summary: entry.summary,
        fromId: entry.fromId,
        timestamp: entry.timestamp,
      };
      messages.push({ reference: entry.id, message });
      known.add(fingerprint(message));
    }
  }
  return { messages, opaque };
}

export function sourceForPreparation(
  branch: readonly PiSessionEntry[],
  preparation: CompactionPreparation,
): HistoryArchive {
  const archive = archiveFromBranch(branch);
  const tail = preparation.retainedTail;
  const withOpaqueMessages = (messages: HistoryMessage[]): HistoryArchive => ({
    messages,
    opaque: [
      ...archive.opaque,
      ...messages.flatMap(({ message }) =>
        message.role === "compactionSummary" || message.role === "branchSummary"
          ? [message.summary]
          : [],
      ),
    ],
  });
  if (tail.length === 0) return withOpaqueMessages(archive.messages);
  // The Pi tail is a suffix, including virtual retained messages after restart.
  // Refuse an unknown boundary instead of summarizing retained content twice.
  const start = archive.messages.length - tail.length;
  if (
    start < 0 ||
    tail.some(
      (message, i) => fingerprint(message) !== fingerprint(archive.messages[start + i].message),
    )
  ) {
    throw new VccError("unsafe_boundary");
  }
  return withOpaqueMessages(archive.messages.slice(0, start));
}

function safeText(value: string): string {
  return sanitizeCredentialText(value)
    .replace(/data:[^,\s]*;base64,[A-Za-z0-9+/=_-]+/giu, "[binary attachment omitted]")
    .replace(
      /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{1024,}={0,2}(?![A-Za-z0-9+/=_-])/gu,
      "[encoded payload omitted]",
    );
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[nested content omitted]";
  if (typeof value === "string") return safeText(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "[binary payload omitted]";
  if (Array.isArray(value)) return value.map((item) => safeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "Buffer") return "[binary payload omitted]";
    if (record.type === "image" || record.type === "audio" || typeof record.mimeType === "string") {
      return "[binary attachment omitted]";
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(
          key,
        )
          ? "[credential omitted]"
          : safeValue(item, depth + 1),
      ]),
    );
  }
  return value;
}

/** Never feed reasoning, signatures, provider metadata or binary data to VCC/recall. */
export function compilerMessage(message: AgentMessage): Message | undefined {
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
    return undefined;
  }
  if (
    message.role === "assistant" &&
    (message.stopReason === "error" || message.stopReason === "aborted")
  )
    return undefined;
  const content =
    typeof message.content === "string"
      ? safeText(message.content)
      : message.content.flatMap((part): object[] => {
          if (part.type === "text") return [{ type: "text", text: safeText(part.text) }];
          if (part.type === "image") return [{ type: "text", text: `[image: ${part.mimeType}]` }];
          if (part.type === "toolCall")
            return [
              {
                type: "toolCall",
                id: part.id,
                name: part.name === "run_command" ? "bash" : part.name,
                arguments: safeValue(part.arguments),
              },
            ];
          return [];
        });
  return {
    role: message.role,
    content,
    timestamp: message.timestamp,
    ...(message.role === "toolResult"
      ? {
          toolName: message.toolName === "run_command" ? "bash" : message.toolName,
          toolCallId: message.toolCallId,
        }
      : {}),
  } as Message;
}

export function historyText(message: AgentMessage): string {
  if (message.role === "compactionSummary" || message.role === "branchSummary")
    return sanitizeCredentialText(message.summary);
  const safe = compilerMessage(message);
  if (!safe) return "";
  return typeof safe.content === "string"
    ? safe.content
    : safe.content
        .map((part) =>
          part.type === "text"
            ? part.text
            : part.type === "toolCall"
              ? `${part.name} ${JSON.stringify(part.arguments)}`
              : "",
        )
        .filter(Boolean)
        .join("\n");
}
