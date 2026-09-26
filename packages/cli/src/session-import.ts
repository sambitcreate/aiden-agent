import { openSync, closeSync, fstatSync, readFileSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createCurrentPiSessionRepository } from "../../../main/services/pi-session-repository-port.js";
import { parseAttachments } from "../../../main/services/attachment-contract.js";
import type { Message } from "@earendil-works/pi-ai";
import { exportSession } from "./sessions.ts";

function importContext(messages: readonly { role: string }[]): Message[] {
  return messages.map((message) => {
    if (["user", "assistant", "toolResult"].includes(message.role)) return message as Message;
    const summary = (message as { summary?: unknown }).summary;
    if (typeof summary === "string") return { role: "user", content: `Imported conversation summary:\n${summary}`, timestamp: Date.now() };
    throw new Error(`Cannot import the journal message role ${message.role}. Use a portable Aiden chat export for this conversation.`);
  });
}

function snapshot(file: string): string {
  const fd = openSync(file, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error("Import requires a regular file of at most 64 MiB.");
    const text = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("The source changed while being read. Retry when its writer is idle.");
    return text;
  } finally { closeSync(fd); }
}

export async function exportSessionFile(agentDir: string, source: string, target: string) {
  const staging = join(agentDir, "import-staging", randomUUID());
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const file = join(staging, "snapshot.jsonl");
    writeFileSync(file, snapshot(resolve(source)), { flag: "wx", mode: 0o600 });
    return await exportSession(SessionManager.open(file), target);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/** Import always creates a new journal; no desktop or existing CLI journal is opened for writing. */
export async function importSession(agentDir: string, cwd: string, source: string) {
  const text = snapshot(resolve(source));
  let messages: Message[] = [], name: string | undefined;
  let first: Record<string, unknown>;
  try { first = JSON.parse(text); } catch { first = JSON.parse(text.split("\n").find((line) => line.trim()) ?? "null"); }
  // pi 0.87 storage v1 headers carry `v: 4`; 0.84.4 journals carry `version: 4`
  // and are upgraded by the repository port when listed.
  if (first?.kind === "header" && (first.v === 4 || first.version === 4)) {
    const staging = join(agentDir, "import-staging", randomUUID()); mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(join(staging, "workspace"), { mode: 0o700 });
      writeFileSync(join(staging, "workspace", "snapshot.jsonl"), text, { flag: "wx", mode: 0o600 });
      const repository = createCurrentPiSessionRepository(staging);
      const metadata = (await repository.list())[0];
      if (!metadata) throw new Error("No valid desktop v4 journal was found.");
      const port = await repository.open(metadata);
      const context = await port.buildContext();
      messages = importContext(context.messages);
      name = typeof metadata.metadata?.title === "string" ? metadata.metadata.title : undefined;
    } finally { rmSync(staging, { recursive: true, force: true }); }
  } else if (first?.type === "session") {
    const staging = join(agentDir, "import-staging", randomUUID()); mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      const file = join(staging, "snapshot.jsonl"); writeFileSync(file, text, { flag: "wx", mode: 0o600 });
      const manager = SessionManager.open(file);
      messages = importContext(manager.buildSessionContext().messages);
      name = manager.getSessionName();
    } finally { rmSync(staging, { recursive: true, force: true }); }
  } else {
    const document = JSON.parse(text);
    if (document.schema !== "aiden.chat.export" || document.version !== 1 || !Array.isArray(document.chat?.messages) || document.chat.messages.length > 10_000) throw new Error("Expected .aiden-chat.json or a pi session journal.");
    name = typeof document.chat.title === "string" ? document.chat.title.slice(0, 200) : undefined;
    messages = document.chat.messages.map((message: Record<string, unknown>) => {
      if (!["user", "assistant"].includes(String(message.role)) || typeof message.content !== "string" || typeof message.createdAt !== "number" || !Number.isSafeInteger(message.createdAt) || message.createdAt < 0) throw new Error("Invalid exported message.");
      const attachments = parseAttachments(message.attachments);
      const content = [{ type: "text" as const, text: message.content }, ...(attachments ?? []).map((attachment) => attachment.kind === "image"
        ? { type: "image" as const, data: attachment.data!, mimeType: attachment.mimeType }
        : { type: "text" as const, text: `File: ${attachment.name}\n${attachment.text}` })];
      if (message.role === "user") return { role: "user", content, timestamp: message.createdAt };
      return { role: "assistant", content: [{ type: "text", text: message.content }], timestamp: message.createdAt,
        api: "openai-completions", provider: "imported", model: typeof message.model === "string" ? message.model : "imported", stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    });
  }
  const manager = SessionManager.create(cwd, join(agentDir, "sessions", `import-${randomUUID()}`));
  for (const message of messages) manager.appendMessage(message);
  if (name) manager.appendSessionInfo(name);
  // Pi defers persistence until an assistant response; imported user-only chats must also survive exit.
  const file = manager.getSessionFile()!;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
  return { id: manager.getSessionId(), path: file, messages: messages.length };
}
