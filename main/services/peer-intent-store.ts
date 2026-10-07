import { isDeepStrictEqual } from "node:util";
import type { PeerOperation } from "../../renderer/shared/peer-operation.js";
import { hostIdentifier } from "../../renderer/shared/peer-host.js";
import { chatIntentRetryAllowed, type SavedChatIntent } from "../../renderer/shared/chat-intent.js";

interface BoundIntent { identity: string; intent: SavedChatIntent }
const MAX_RECORDS = 128;
const MAX_BYTES = 4 * 1024 * 1024;
const key = (intent: SavedChatIntent) => JSON.stringify([intent.hostId, intent.chatId, intent.idempotencyKey]);
export function parseSavedChatIntent(value: unknown): SavedChatIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved request.");
  const intent = value as SavedChatIntent;
  hostIdentifier(intent.hostId);
  hostIdentifier(intent.chatId);
  if (typeof intent.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(intent.idempotencyKey)
    || !Number.isSafeInteger(intent.createdAt) || intent.createdAt <= 0
    || !intent.request || !["send", "cancel", "respondApproval", "answerQuestion", "submitInput", "fork"].includes(intent.request.kind)
    || !intent.request.input || typeof intent.request.input !== "object"
    || intent.request.input.idempotencyKey !== intent.idempotencyKey
    || Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw new Error("Invalid saved request.");
  return structuredClone(intent);
}
/** The exact wire operation represented by the saved local request. */
function savedOperation(intent: SavedChatIntent): PeerOperation {
  const request = intent.request;
  const idempotencyKey = intent.idempotencyKey;
  switch (request.kind) {
    case "send": return { operation: "send", resourceId: intent.chatId, idempotencyKey, body: {
      text: request.input.text,
      ...(request.input.attachmentIds?.length ? { attachmentIds: request.input.attachmentIds } : {}),
      ...(request.input.skill ? { skill: request.input.skill } : {}),
    } };
    case "cancel": return { operation: "runCancel", resourceId: request.input.runId, idempotencyKey, body: {} };
    case "respondApproval": return { operation: "runRespondApproval", resourceId: request.input.runId,
      itemId: request.input.approvalId, idempotencyKey, body: { decision: request.input.decision,
        ...(request.input.decision === "allow" && request.input.scope ? { scope: request.input.scope } : {}) } };
    case "answerQuestion": return { operation: "runRespondQuestion", resourceId: request.input.runId,
      itemId: request.input.promptId, idempotencyKey, body: { cancelled: request.input.response.cancelled,
        answers: request.input.response.cancelled ? [] : request.input.response.answers } };
    case "submitInput": return { operation: "runInputs", resourceId: request.input.runId, idempotencyKey,
      body: { mode: request.input.mode, text: request.input.text } };
    case "fork": return { operation: "forkChat", resourceId: intent.chatId, idempotencyKey, revision: request.input.revision,
      body: { messageId: request.input.messageId, position: request.input.position,
        ...(request.input.summary ? { summary: request.input.summary.instructions ? { focus: request.input.summary.instructions } : {} } : {}) } };
  }
}

/** Atomic, serialized persistence. Unknown attempts are never evicted to admit new work. */
export class PeerIntentStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: { load(): Promise<BoundIntent[]>; save(value: BoundIntent[]): Promise<void> },
    private readonly identity: (hostId: string) => Promise<string | null>) {}
  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work); this.tail = result.catch(() => {}); return result;
  }
  private async load(): Promise<BoundIntent[]> {
    const rows = await this.storage.load();
    if (!Array.isArray(rows) || rows.length > MAX_RECORDS || Buffer.byteLength(JSON.stringify(rows)) > MAX_BYTES)
      throw new Error("Saved requests need recovery.");
    return rows.map(row => {
      if (typeof row.identity !== "string" || !row.identity) throw new Error("Saved requests need recovery.");
      return { identity: row.identity, intent: parseSavedChatIntent(row.intent) };
    });
  }
  list(hostId: string, chatId: string): Promise<SavedChatIntent[]> {
    hostIdentifier(hostId); hostIdentifier(chatId);
    return this.run(async () => {
      const identity = await this.identity(hostId);
      const rows = await this.load();
      const current = rows.filter(row => row.intent.hostId !== hostId || row.identity === identity);
      if (current.length !== rows.length) await this.storage.save(current);
      return current.filter(row => row.intent.hostId === hostId && row.intent.chatId === chatId).map(row => row.intent);
    });
  }
  put(value: unknown): Promise<void> {
    const intent = parseSavedChatIntent(value);
    return this.run(async () => {
      const identity = await this.identity(intent.hostId);
      if (!identity) throw new Error("Pair this computer before sending.");
      const rows = (await this.load()).filter(row => row.intent.hostId !== intent.hostId || row.identity === identity);
      const previous = rows.find(row => key(row.intent) === key(intent));
      if (previous && JSON.stringify(previous.intent) !== JSON.stringify(intent)) throw new Error("This saved request cannot be changed.");
      if (previous) return;
      const next = [...rows, { identity, intent }];
      if (next.length > MAX_RECORDS || Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw new Error("Resolve saved requests before sending more.");
      await this.storage.save(next);
      if (await this.identity(intent.hostId) !== identity) throw new Error("The computer's pairing changed.");
    });
  }
  admissionIdentity(hostId: string, operation: PeerOperation): Promise<string> {
    hostIdentifier(hostId);
    return this.run(async () => {
      const rows = await this.load();
      const row = rows.find(row => row.intent.hostId === hostId && row.intent.idempotencyKey === operation.idempotencyKey);
      if (!row) throw new Error("This saved request is no longer available. Check delivery on the host.");
      if (!isDeepStrictEqual(savedOperation(row.intent), operation)) throw new Error("The saved request cannot be changed during recovery.");
      if (!chatIntentRetryAllowed(row.intent.createdAt)) throw new Error("The saved request retry window has ended.");
      return row.identity;
    });
  }
  remove(hostId: string, chatId: string, idempotencyKey: string): Promise<void> {
    hostIdentifier(hostId); hostIdentifier(chatId);
    return this.run(async () => {
      const rows = await this.load();
      await this.storage.save(rows.filter(row => row.intent.hostId !== hostId || row.intent.chatId !== chatId || row.intent.idempotencyKey !== idempotencyKey));
    });
  }
}
export type { BoundIntent };
