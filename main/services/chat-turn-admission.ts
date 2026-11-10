import type { PreparedSkillInvocation } from "./skill-invocation-turn.js";
import {
  SLASH_LIMITS,
  SkillInvocationError,
} from "../../renderer/shared/slash-commands.js";
import {
  INITIAL_CHAT_TURN_LIFECYCLE,
  canPrepareChatTurnSkill,
  chatTurnSkillBytes,
  holdsChatTurnAuthority,
  isChatTurnReadyForHandoff,
  transitionChatTurn,
  transitionChatTurnSkillCustody,
  type ChatTurnEvent,
  type ChatTurnLifecycle,
  type ChatTurnPool,
  type ChatTurnPoolName,
  type ChatTurnRejection,
  type ChatTurnSkillCustody,
  type ChatTurnSkillCustodyEvent,
  type ChatTurnTransition,
} from "./chat-turn-admission-lifecycle.js";

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
  /** Mark work ready for handoff; cached first-send receipts stay charged until release. */
  settleAsyncWork(options?: { retainAppendPayloadUntilRelease?: boolean }): void;
  onReleased(cleanup: () => void): void;
  release(): void;
}

interface ChatTurnRecord {
  lease: ChatTurnLease;
  lifecycle: ChatTurnLifecycle;
  preparedSkillInvocation?: PreparedSkillInvocation;
  /** Apply one event and execute its effects. */
  commit(event: ChatTurnEvent): ChatTurnTransition;
  expiry: ReturnType<typeof setTimeout>;
  /** A release callback's failure, held until pending work settles. */
  releaseFailure?: { error: unknown };
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
    };
    const runReleaseCallbacks = (record: ChatTurnRecord): { error: unknown } | undefined => {
      clearTimeout(record.expiry);
      const pendingCleanups = [...cleanups];
      cleanups.clear();
      let failure: { error: unknown } | undefined;
      for (const cleanup of pendingCleanups) {
        try {
          cleanup();
        } catch (error) {
          failure ??= { error };
        }
      }
      return failure;
    };
    const commit = (record: ChatTurnRecord, event: ChatTurnEvent): ChatTurnTransition => {
      const transition = transitionChatTurn(record.lifecycle, event);
      // A callback below can re-enter with another event, so the new state must
      // already be in place.
      record.lifecycle = transition.state;
      let failure: { error: unknown } | undefined;
      for (const effect of transition.effects) {
        if (effect.type === "budget") this.charge(effect.pool, effect.turns, effect.bytes);
        else if (effect.type === "revoked") failure = runReleaseCallbacks(record);
        else finalize(record);
      }
      // A failing callback must not strand the chat: its accounting is
      // finished first, and the failure then reaches the caller. Callers run
      // release() then settleAsyncWork() unguarded, and the expiry timer is
      // gone, so pending work holds the failure until it has settled.
      failure ??= record.releaseFailure;
      if (!failure) return transition;
      if (record.lifecycle.preparation === "pending") {
        record.releaseFailure = failure;
        return transition;
      }
      record.releaseFailure = undefined;
      throw failure.error;
    };
    /** Events from a lease that no longer occupies the chat are ignored. */
    const currentRecord = (): ChatTurnRecord | undefined => {
      const record = this.turns.get(chatId);
      return record?.lease === lease ? record : undefined;
    };
    const reject = (event: ChatTurnEvent): ChatTurnRejection | undefined => {
      const record = currentRecord();
      return record ? record.commit(event).rejected : "unavailable";
    };
    const lease: ChatTurnLease = {
      chatId,
      turnId,
      ownerId,
      isActive: () => {
        const record = currentRecord();
        return record !== undefined && holdsChatTurnAuthority(record.lifecycle);
      },
      reserveAppendPayload: (bytes) => {
        const rejected = reject({ type: "reserve-append", bytes, pool: this.pool("append") });
        if (rejected === "capacity") {
          throw new Error(
            "Too many messages are waiting to be saved. Try again in a moment.",
          );
        }
        if (rejected) throw new Error("This message turn is no longer available.");
      },
      reserveSkillPreparation: () => {
        const rejected = reject({
          type: "reserve-skill",
          bytes: SLASH_LIMITS.formattedInvocationBytes,
          pool: this.pool("skill"),
        });
        if (rejected) throwSkillRejection(rejected);
      },
      prepareSkillInvocation: (invocation) => {
        const record = currentRecord();
        // The payload is measured only for a turn that can still accept it.
        if (!record || !canPrepareChatTurnSkill(record.lifecycle)) {
          throwSkillRejection("unavailable");
        }
        const { rejected } = record.commit({
          type: "prepare-skill",
          bytes: Buffer.byteLength(invocation.formattedPrompt, "utf8"),
        });
        if (rejected) throwSkillRejection(rejected);
        record.preparedSkillInvocation = invocation;
      },
      settleAsyncWork: (options) => {
        currentRecord()?.commit({
          type: "settle",
          retainAppend: options?.retainAppendPayloadUntilRelease === true,
        });
      },
      onReleased: (cleanup) => {
        if (!lease.isActive()) cleanup();
        else cleanups.add(cleanup);
      },
      release: () => {
        currentRecord()?.commit({ type: "revoke" });
      },
    };
    const expiry = setTimeout(() => lease.release(), this.leaseTtlMs);
    expiry.unref?.();
    const record: ChatTurnRecord = {
      lease,
      lifecycle: INITIAL_CHAT_TURN_LIFECYCLE,
      commit: (event) => commit(record, event),
      expiry,
    };
    this.turns.set(chatId, record);
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
      record !== undefined &&
      isChatTurnReadyForHandoff(record.lifecycle) &&
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
    if (!record || lease?.turnId !== turnId || lease.ownerId !== ownerId) {
      return false;
    }
    const heldSkillBytes = chatTurnSkillBytes(record.lifecycle);
    if (record.commit({ type: "begin-registration" }).rejected) return false;
    let custody: ChatTurnSkillCustody = heldSkillBytes === undefined ? "released" : "lease";
    const advanceCustody = (event: ChatTurnSkillCustodyEvent): void => {
      const next = transitionChatTurnSkillCustody(custody, event);
      custody = next.custody;
      if (next.refund) this.charge("skill", -1, -heldSkillBytes!);
    };
    try {
      registerGeneration(record.preparedSkillInvocation, () =>
        advanceCustody("release-requested"));
    } catch (error) {
      advanceCustody("registration-failed");
      record.commit({ type: "registration-failed" });
      throw error;
    }
    // The prompt remains charged after the append lease disappears because
    // initialization and the active Agent still retain its expanded bytes.
    advanceCustody("transferred");
    record.commit({ type: "registration-succeeded" });
    return true;
  }

  private pool(name: ChatTurnPoolName): ChatTurnPool {
    return name === "append"
      ? {
          turns: this.appendTurns,
          bytes: this.appendBytes,
          maxTurns: this.maxAppendTurns,
          maxBytes: this.maxAppendBytes,
        }
      : {
          turns: this.skillTurns,
          bytes: this.skillBytes,
          maxTurns: this.maxPreparedTurns,
          maxBytes: this.maxPreparedBytes,
        };
  }

  private charge(name: ChatTurnPoolName, turns: number, bytes: number): void {
    if (name === "append") {
      this.appendTurns += turns;
      this.appendBytes += bytes;
    } else {
      this.skillTurns += turns;
      this.skillBytes += bytes;
    }
  }
}

function throwSkillRejection(rejected: ChatTurnRejection): never {
  throw new SkillInvocationError(
    "turn_unavailable",
    rejected === "capacity"
      ? "Too many skill messages are waiting to start. Try again in a moment."
      : "This skill turn is no longer available.",
  );
}
