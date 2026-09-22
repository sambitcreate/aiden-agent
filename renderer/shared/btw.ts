export const BTW_LIMITS = Object.freeze({
  questionCodePoints: 4_000,
  questionBytes: 16_000,
  answerCodePoints: 24_000,
  historyTurns: 8,
  historyBytes: 192 * 1024,
  contextMessages: 128,
  contextBytes: 512 * 1024,
  concurrentChats: 2,
  timeoutMs: 120_000,
  lifecycleSettleGraceMs: 1_500,
});

export type BtwTerminalStatus = "completed" | "failed" | "cancelled";

export type BtwEventV1 =
  | {
      version: 1;
      chatId: string;
      requestId: string;
      sequence: number;
      type: "started";
      question: string;
      hasHistory: boolean;
      contextTrimmed: boolean;
    }
  | {
      version: 1;
      chatId: string;
      requestId: string;
      sequence: number;
      type: "delta";
      delta: string;
    }
  | {
      version: 1;
      chatId: string;
      requestId: string;
      sequence: number;
      type: "reset";
    }
  | {
      version: 1;
      chatId: string;
      requestId: string;
      sequence: number;
      type: "terminal";
      status: BtwTerminalStatus;
      answer?: string;
      message?: string;
      contextTrimmed: boolean;
    }
  | {
      version: 1;
      chatId: string;
      requestId: string;
      sequence: number;
      type: "cleared";
    };

export interface BtwStartReceiptV1 {
  version: 1;
  chatId: string;
  requestId: string;
}

function safeIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/u.test(value);
}

export function parseBtwEvent(value: unknown): BtwEventV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (
    event.version !== 1 ||
    !safeIdentity(event.chatId) ||
    !safeIdentity(event.requestId) ||
    !Number.isSafeInteger(event.sequence) ||
    (event.sequence as number) < 0
  ) return null;
  if (event.type === "started") {
    if (
      typeof event.question !== "string" ||
      typeof event.hasHistory !== "boolean" ||
      typeof event.contextTrimmed !== "boolean"
    ) return null;
  } else if (event.type === "delta") {
    if (typeof event.delta !== "string") return null;
  } else if (event.type === "terminal") {
    if (
      !["completed", "failed", "cancelled"].includes(String(event.status)) ||
      (event.answer !== undefined && typeof event.answer !== "string") ||
      (event.message !== undefined && typeof event.message !== "string") ||
      typeof event.contextTrimmed !== "boolean"
    ) return null;
  } else if (event.type !== "cleared" && event.type !== "reset") {
    return null;
  }
  return event as unknown as BtwEventV1;
}
