import { createHash } from "node:crypto";
import { parseChatRunInput, type ChatRunInputRequest, type ChatRunInputReceipt } from "../../renderer/shared/chat-run-input.js";
import type { PiRuntimeQueueReceipt } from "./pi-agent-runtime-harness.js";

/** Per-run host boundary; Remote additionally persists its principal-scoped operation ledger. */
export function createChatRunInputAdmission(deps: {
  streamId: string;
  ownerDocumentId: string;
  isCurrent(): boolean;
  revalidate(): Promise<void>;
  persist(messageId: string, text: string): Promise<void>;
  queue(input: ChatRunInputRequest, persist: () => Promise<void>): Promise<PiRuntimeQueueReceipt>;
}) {
  const requests = new Map<string, { fingerprint: string; result: Promise<ChatRunInputReceipt> }>();
  return (raw: unknown): Promise<ChatRunInputReceipt> => {
    const input = parseChatRunInput(raw);
    const identity = { requestId: input.requestId, streamId: deps.streamId, mode: input.mode };
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = requests.get(input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("Run input request ID was reused with different content.");
      return existing.result;
    }
    if (requests.size >= 128) return Promise.resolve({ ...identity, accepted: false, reason: "capacity" });
    const result = (async (): Promise<ChatRunInputReceipt> => {
      if (!deps.isCurrent()) return { ...identity, accepted: false, reason: "not-active" };
      await deps.revalidate();
      if (!deps.isCurrent()) return { ...identity, accepted: false, reason: "cancelled" };
      const messageId = `input-${createHash("sha256").update(`${deps.ownerDocumentId}:${deps.streamId}:${input.requestId}`).digest("hex")}`;
      const receipt = await deps.queue(input, () => deps.persist(messageId, input.text));
      if (!receipt.accepted) {
        return { ...identity, accepted: false, reason: receipt.reason === "capacity" ? "capacity" : receipt.reason === "cancelled" ? "cancelled" : "not-active" };
      }
      return { ...identity, accepted: true, admission: "queued", messageId };
    })();
    requests.set(input.requestId, { fingerprint, result });
    return result;
  };
}
