import type { PreparedSkillInvocation } from "./skill-invocation-turn.js";
import {
  SLASH_LIMITS,
  SkillInvocationError,
} from "../../renderer/shared/slash-commands.js";

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_MAX_PREPARED_TURNS = 16;
const DEFAULT_MAX_PREPARED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_APPEND_TURNS = 16;
const DEFAULT_MAX_APPEND_BYTES = 64 * 1024 * 1024;

export interface ChatTurnAdmissionOptions {
  leaseTtlMs?: number;
  maxPreparedTurns?: number;
  maxPreparedBytes?: number;
  maxAppendTurns?: number;
  maxAppendBytes?: number;
}

export interface ChatTurnLease {
  readonly chatId: string;
  readonly ownerId: string;
  readonly turnId: string;
  isActive(): boolean;
  reserveAppendPayload(bytes: number): void;
  reserveSkillPreparation(): void;
  prepareSkillInvocation(invocation: PreparedSkillInvocation): void;
  /** Release payload accounting only after the append async frame settles. */
  settleAsyncWork(): void;
  onReleased(cleanup: () => void): void;
  release(): void;
}

interface ChatTurnRecord {
  lease: ChatTurnLease;
  preparedSkillInvocation?: PreparedSkillInvocation;
  skillBytes: number;
  skillSlotReserved: boolean;
  appendBytes: number;
  appendSlotReserved: boolean;
  authorityActive: boolean;
  asyncSettled: boolean;
  expiry: ReturnType<typeof setTimeout>;
}

/**
 * Owns the append-to-generation critical section for one chat.
 *
 * A lease can cross awaits while a user message is persisted, then hand off
 * synchronously to generation registration. JavaScript cannot interleave
 * another renderer or scheduler claim between the registration callback and
 * release of the lease.
 */
export class ChatTurnAdmission {
  private readonly turns = new Map<string, ChatTurnRecord>();
  private readonly reconciliationRequiredOwners = new Set<string>();
  private readonly leaseTtlMs: number;
  private readonly maxPreparedTurns: number;
  private readonly maxPreparedBytes: number;
  private readonly maxAppendTurns: number;
  private readonly maxAppendBytes: number;
  private skillTurns = 0;
  private skillBytes = 0;
  private appendTurns = 0;
  private appendBytes = 0;

  constructor(options: ChatTurnAdmissionOptions = {}) {
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.maxPreparedTurns =
      options.maxPreparedTurns ?? DEFAULT_MAX_PREPARED_TURNS;
    this.maxPreparedBytes =
      options.maxPreparedBytes ?? DEFAULT_MAX_PREPARED_BYTES;
    this.maxAppendTurns = options.maxAppendTurns ?? DEFAULT_MAX_APPEND_TURNS;
    this.maxAppendBytes = options.maxAppendBytes ?? DEFAULT_MAX_APPEND_BYTES;
  }

  tryBegin(
    chatId: string,
    turnId: string,
    ownerId: string,
    generationBusy: boolean,
  ): ChatTurnLease | null {
    if (
      generationBusy ||
      this.turns.has(chatId) ||
      this.requiresAppendReconciliation(ownerId)
    ) {
      return null;
    }

    const cleanups = new Set<() => void>();
    const finalize = (record: ChatTurnRecord): void => {
      if (this.turns.get(chatId) !== record) return;
      this.turns.delete(chatId);
      clearTimeout(record.expiry);
      if (record.skillSlotReserved) {
        this.skillTurns -= 1;
        this.skillBytes -= record.skillBytes;
        record.skillSlotReserved = false;
        record.skillBytes = 0;
      }
      if (record.appendSlotReserved) {
        this.appendTurns -= 1;
        this.appendBytes -= record.appendBytes;
        record.appendSlotReserved = false;
        record.appendBytes = 0;
      }
    };
    const lease: ChatTurnLease = {
      chatId,
      turnId,
      ownerId,
      isActive: () => {
        const record = this.turns.get(chatId);
        return record?.lease === lease && record.authorityActive;
      },
      reserveAppendPayload: (bytes) => {
        const record = this.turns.get(chatId);
        if (
          !record?.authorityActive ||
          record?.lease !== lease ||
          record.appendSlotReserved ||
          !Number.isSafeInteger(bytes) ||
          bytes < 0
        ) {
          throw new Error("This message turn is no longer available.");
        }
        if (
          this.appendTurns >= this.maxAppendTurns ||
          bytes > this.maxAppendBytes - this.appendBytes
        ) {
          throw new Error(
            "Too many messages are waiting to be saved. Try again in a moment.",
          );
        }
        record.appendSlotReserved = true;
        record.appendBytes = bytes;
        this.appendTurns += 1;
        this.appendBytes += bytes;
      },
      reserveSkillPreparation: () => {
        const record = this.turns.get(chatId);
        if (
          !record?.authorityActive ||
          record?.lease !== lease ||
          record.skillSlotReserved
        ) {
          throw new Error("This skill turn is no longer available.");
        }
        const reservationBytes = SLASH_LIMITS.formattedInvocationBytes;
        if (
          this.skillTurns >= this.maxPreparedTurns ||
          reservationBytes > this.maxPreparedBytes - this.skillBytes
        ) {
          throw new SkillInvocationError(
            "turn_unavailable",
            "Too many skill messages are waiting to start. Try again in a moment.",
          );
        }
        record.skillSlotReserved = true;
        record.skillBytes = reservationBytes;
        this.skillTurns += 1;
        this.skillBytes += reservationBytes;
      },
      prepareSkillInvocation: (invocation) => {
        const record = this.turns.get(chatId);
        if (
          !record?.authorityActive ||
          record?.lease !== lease ||
          !record.skillSlotReserved ||
          record.preparedSkillInvocation
        ) {
          throw new Error("This skill turn is no longer available.");
        }
        const invocationBytes = Buffer.byteLength(
          invocation.formattedPrompt,
          "utf8",
        );
        if (invocationBytes > record.skillBytes) {
          throw new SkillInvocationError(
            "turn_unavailable",
            "Too many skill messages are waiting to start. Try again in a moment.",
          );
        }
        record.preparedSkillInvocation = invocation;
        this.skillBytes -= record.skillBytes - invocationBytes;
        record.skillBytes = invocationBytes;
      },
      settleAsyncWork: () => {
        const record = this.turns.get(chatId);
        if (!record || record.lease !== lease || record.asyncSettled) return;
        record.asyncSettled = true;
        if (record.appendSlotReserved) {
          this.appendTurns -= 1;
          this.appendBytes -= record.appendBytes;
          record.appendSlotReserved = false;
          record.appendBytes = 0;
        }
        if (!record.authorityActive) finalize(record);
      },
      onReleased: (cleanup) => {
        if (!lease.isActive()) cleanup();
        else cleanups.add(cleanup);
      },
      release: () => {
        const record = this.turns.get(chatId);
        if (!record || record.lease !== lease || !record.authorityActive)
          return;
        record.authorityActive = false;
        clearTimeout(record.expiry);
        for (const cleanup of cleanups) cleanup();
        cleanups.clear();
        if (record.asyncSettled) finalize(record);
      },
    };
    const expiry = setTimeout(() => lease.release(), this.leaseTtlMs);
    expiry.unref?.();
    this.turns.set(chatId, {
      lease,
      skillBytes: 0,
      skillSlotReserved: false,
      appendBytes: 0,
      appendSlotReserved: false,
      authorityActive: true,
      asyncSettled: false,
      expiry,
    });
    return lease;
  }

  isAdmitted(chatId: string): boolean {
    return this.turns.has(chatId);
  }

  /**
   * Fail closed for the lifetime of a renderer document after storage could
   * not determine whether an append crossed its durability barrier. A fresh
   * renderer document is created only by reload, after startup/read recovery
   * has had an opportunity to reconcile the store.
   */
  markAppendReconciliationRequired(ownerId: string): void {
    if (ownerId) this.reconciliationRequiredOwners.add(ownerId);
  }

  requiresAppendReconciliation(ownerId: string): boolean {
    return this.reconciliationRequiredOwners.has(ownerId);
  }

  clearAppendReconciliationRequired(ownerId: string): void {
    this.reconciliationRequiredOwners.delete(ownerId);
  }

  owns(chatId: string, turnId: string, ownerId: string): boolean {
    const record = this.turns.get(chatId);
    const lease = record?.lease;
    return (
      record?.authorityActive === true &&
      record.asyncSettled &&
      lease?.turnId === turnId &&
      lease.ownerId === ownerId
    );
  }

  releaseMatching(chatId: string, turnId: string, ownerId: string): boolean {
    const lease = this.turns.get(chatId)?.lease;
    if (lease?.turnId !== turnId || lease.ownerId !== ownerId) return false;
    lease.release();
    return true;
  }

  releaseChat(chatId: string): boolean {
    const lease = this.turns.get(chatId)?.lease;
    if (!lease) return false;
    lease.release();
    return true;
  }

  releaseAll(): void {
    for (const { lease } of [...this.turns.values()]) lease.release();
  }

  /**
   * Register generation ownership and release the matching append lease as one
   * synchronous operation. A throwing registration keeps the lease intact so
   * the caller can fail closed or release it deliberately.
   */
  handoff(
    chatId: string,
    turnId: string,
    ownerId: string,
    registerGeneration: (
      skillInvocation: PreparedSkillInvocation | undefined,
      releaseSkillReservation: () => void,
    ) => void,
  ): boolean {
    const record = this.turns.get(chatId);
    const lease = record?.lease;
    if (
      !record?.authorityActive ||
      !record.asyncSettled ||
      lease?.turnId !== turnId ||
      lease.ownerId !== ownerId
    ) {
      return false;
    }
    const retainedSkillBytes = record.skillBytes;
    const retainsSkillReservation = record.skillSlotReserved;
    let transferred = false;
    let released = !retainsSkillReservation;
    let releaseRequested = false;
    const releaseSkillReservation = () => {
      if (released) return;
      if (!transferred) {
        releaseRequested = true;
        return;
      }
      released = true;
      this.skillTurns -= 1;
      this.skillBytes -= retainedSkillBytes;
    };
    registerGeneration(record.preparedSkillInvocation, releaseSkillReservation);
    if (retainsSkillReservation) {
      // The prompt remains charged after the append lease disappears because
      // initialization and the active Agent still retain its expanded bytes.
      record.skillSlotReserved = false;
      record.skillBytes = 0;
      transferred = true;
      if (releaseRequested) releaseSkillReservation();
    }
    lease.release();
    return true;
  }
}
