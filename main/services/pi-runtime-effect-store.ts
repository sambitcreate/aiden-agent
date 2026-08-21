import { DataStore } from "./data-store.js";
import {
  MAX_PI_RUNTIME_EFFECTS,
  MAX_PI_RUNTIME_OPERATIONS,
  digestPiRuntimeEffectArguments,
  emptyPiRuntimeEffectDatabase,
  isPiRuntimeEffectTerminal,
  isPiRuntimeOperationTerminal,
  parseDurablePiRuntimeEffectDatabase,
  parseDurablePiRuntimeEffectOwner,
  parseStartPiRuntimeOperationInput,
  isSafePiRuntimeIdentity,
  piRuntimeTerminalDigest,
  snapshotPiRuntimeEffectArguments,
  type DurablePiRuntimeEffect,
  type DurablePiRuntimeEffectDatabase,
  type DurablePiRuntimeEffectOwner,
  type DurablePiRuntimeOperation,
  type DurablePiRuntimeOperationState,
  type FinishPiRuntimeEffectInput,
  type PreparePiRuntimeEffectInput,
  type StartPiRuntimeOperationInput,
} from "./pi-runtime-effect-core.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";

const MAX_STORE_BYTES = 8 * 1024 * 1024;
const STORE_WRITE_HEADROOM_BYTES = 256 * 1024;
const STARTUP_CANCELLED = piRuntimeTerminalDigest("startup_cancelled_before_dispatch");
const STARTUP_UNKNOWN = piRuntimeTerminalDigest("startup_never_replay_outcome_unknown");
const STARTUP_INTERRUPTED = piRuntimeTerminalDigest("startup_safe_replay_not_resumed");
const EXPLICIT_CANCELLED = piRuntimeTerminalDigest("cancelled_before_dispatch");
const TERMINAL_WRITE_UNKNOWN = piRuntimeTerminalDigest("terminal_persistence_failed_unknown");

export interface PiRuntimeEffectStoreOptions {
  root?: () => string;
  filename?: string;
  now?: () => number;
  dataStore?: DataStore<DurablePiRuntimeEffectDatabase>;
}

function ownerMatches(effect: DurablePiRuntimeEffect, owner: DurablePiRuntimeEffectOwner): boolean {
  return (
    effect.effectId === owner.effectId &&
    effect.operationId === owner.operationId &&
    effect.runId === owner.runId &&
    effect.chatId === owner.chatId
  );
}

function operationMatches(
  operation: DurablePiRuntimeOperation,
  input: StartPiRuntimeOperationInput,
): boolean {
  return (
    operation.operationId === input.operationId &&
    operation.runId === input.runId &&
    operation.sessionId === input.sessionId &&
    operation.chatId === input.chatId &&
    operation.lane === input.lane &&
    operation.contributionRevision === input.contributionRevision
  );
}

function pruneOneTerminalOperation(database: DurablePiRuntimeEffectDatabase): boolean {
  const candidate = database.operations
    .filter(
      (operation) =>
        isPiRuntimeOperationTerminal(operation.state) &&
        !database.effects.some(
          (effect) =>
            effect.operationId === operation.operationId &&
            effect.state !== "cancelled_before_dispatch" &&
            effect.recoveryRecordedAt === undefined,
        ),
    )
    .sort(
      (left, right) =>
        left.updatedAt - right.updatedAt || left.operationId.localeCompare(right.operationId),
    )[0];
  if (!candidate) return false;
  database.operations = database.operations.filter(
    ({ operationId }) => operationId !== candidate.operationId,
  );
  database.effects = database.effects.filter(
    ({ operationId }) => operationId !== candidate.operationId,
  );
  return true;
}

function serializedDatabaseBytes(database: DurablePiRuntimeEffectDatabase): number {
  return Buffer.byteLength(`${JSON.stringify(database, null, 2)}\n`, "utf8");
}

function pruneToWritableSize(database: DurablePiRuntimeEffectDatabase): void {
  while (serializedDatabaseBytes(database) > MAX_STORE_BYTES - STORE_WRITE_HEADROOM_BYTES) {
    if (!pruneOneTerminalOperation(database)) {
      throw new Error("Pi runtime effect history is at byte capacity.");
    }
  }
}

function makeDataStore(
  options: PiRuntimeEffectStoreOptions,
): DataStore<DurablePiRuntimeEffectDatabase> {
  return new DataStore(
    options.filename ?? "pi-runtime-effects.json",
    emptyPiRuntimeEffectDatabase(),
    options.root,
    {
      maxBytes: MAX_STORE_BYTES,
      normalize: (value) =>
        parseDurablePiRuntimeEffectDatabase(value) ?? emptyPiRuntimeEffectDatabase(),
      isSafe: (value) => parseDurablePiRuntimeEffectDatabase(value) !== undefined,
      rejectCorruptWrite: true,
      rejectUnsafeWrite: true,
      reloadBeforeWrite: false,
      fileMode: 0o600,
    },
  );
}

/**
 * Process-owned durable effect evidence for both foreground and child Pi runs.
 * It stores replay arguments only for explicitly safe tools and never retries an
 * effect by itself; operation resumption remains a harness policy decision.
 */
export class PiRuntimeEffectStore {
  private readonly now: () => number;
  private readonly data: DataStore<DurablePiRuntimeEffectDatabase>;
  private readonly localUnknown = new Map<string, DurablePiRuntimeEffect>();
  private initialized = false;

  constructor(options: PiRuntimeEffectStoreOptions) {
    this.now = options.now ?? Date.now;
    this.data = options.dataStore ?? makeDataStore(options);
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid Pi effect-store clock.");
    return value;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("Pi runtime effect storage is not initialized.");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.data.load();
    if (await this.data.loadedFromCorruptFile()) {
      throw new Error("Pi runtime effect storage is unreadable and was preserved.");
    }
    if (await this.data.loadedFromUnsafeFile()) {
      throw new Error("Pi runtime effect storage has an unsupported shape and was preserved.");
    }
    const restartAt = this.currentTime();
    await this.data.update((database) => {
      let changed = false;
      database.effects = database.effects.map((effect) => {
        if (effect.state !== "prepared" && effect.state !== "dispatch_started") return effect;
        changed = true;
        const updatedAt = Math.max(effect.updatedAt, restartAt);
        if (effect.state === "prepared") {
          return {
            ...effect,
            state: "cancelled_before_dispatch" as const,
            updatedAt,
            terminalDigest: STARTUP_CANCELLED,
          };
        }
        return effect.replay === "never"
          ? {
              ...effect,
              state: "unknown" as const,
              updatedAt,
              terminalDigest: STARTUP_UNKNOWN,
            }
          : {
              ...effect,
              state: "interrupted" as const,
              updatedAt,
              terminalDigest: STARTUP_INTERRUPTED,
            };
      });
      database.operations = database.operations.map((operation) => {
        if (operation.state !== "running") return operation;
        changed = true;
        return {
          ...operation,
          state: "interrupted" as const,
          updatedAt: Math.max(operation.updatedAt, restartAt),
        };
      });
      if (changed) database.revision += 1;
    });
    this.initialized = true;
  }

  async startOperation(value: unknown): Promise<DurablePiRuntimeOperation> {
    this.requireInitialized();
    const input = parseStartPiRuntimeOperationInput(value);
    if (!input) throw new Error("Invalid Pi runtime operation preparation.");
    const startedAt = this.currentTime();
    return this.data.update((database) => {
      const existing = database.operations.find(
        ({ operationId }) => operationId === input.operationId,
      );
      if (existing) {
        if (!operationMatches(existing, input)) {
          throw new Error("Pi runtime operation identity was reused.");
        }
        return structuredClone(existing);
      }
      while (database.operations.length >= MAX_PI_RUNTIME_OPERATIONS) {
        if (!pruneOneTerminalOperation(database)) {
          throw new Error("Pi runtime operation history is at capacity.");
        }
      }
      const operation: DurablePiRuntimeOperation = {
        version: 1,
        ...input,
        state: "running",
        startedAt,
        updatedAt: startedAt,
      };
      database.operations.push(operation);
      database.revision += 1;
      pruneToWritableSize(database);
      return structuredClone(operation);
    });
  }

  async finishOperation(
    operationId: string,
    state: Exclude<DurablePiRuntimeOperationState, "running">,
  ): Promise<DurablePiRuntimeOperation> {
    this.requireInitialized();
    if (
      !isSafePiRuntimeIdentity(operationId) ||
      !["completed", "app_cancelled", "provider_failed", "host_failed", "interrupted"].includes(
        state,
      )
    ) {
      throw new Error("Invalid Pi runtime operation completion.");
    }
    const updatedAt = this.currentTime();
    const localTerminalEffects = [...this.localUnknown.values()].filter(
      (effect) => effect.operationId === operationId,
    );
    const finished = await this.data.update((database) => {
      const index = database.operations.findIndex(
        (operation) => operation.operationId === operationId,
      );
      const operation = database.operations[index];
      if (!operation) throw new Error("Pi runtime operation was not found.");
      database.effects = database.effects.map((effect) => {
        const local = this.localUnknown.get(effect.effectId);
        return local && local.operationId === operationId ? local : effect;
      });
      if (operation.state !== "running") {
        if (operation.state === state) {
          if (localTerminalEffects.length > 0) database.revision += 1;
          return structuredClone(operation);
        }
        throw new Error("Pi runtime operation is already terminal.");
      }
      if (
        database.effects.some(
          (effect) =>
            effect.operationId === operationId && !isPiRuntimeEffectTerminal(effect.state),
        )
      ) {
        throw new Error("Pi runtime operation has an unsettled effect.");
      }
      const finished: DurablePiRuntimeOperation = {
        ...operation,
        state,
        updatedAt: Math.max(operation.updatedAt, updatedAt),
      };
      database.operations[index] = finished;
      database.revision += 1;
      return structuredClone(finished);
    });
    for (const effect of localTerminalEffects) this.localUnknown.delete(effect.effectId);
    return finished;
  }

  async prepareEffect(input: PreparePiRuntimeEffectInput): Promise<DurablePiRuntimeEffect> {
    this.requireInitialized();
    const operationInput = parseStartPiRuntimeOperationInput({
      operationId: input.operationId,
      runId: input.runId,
      sessionId: input.sessionId,
      chatId: input.chatId,
      lane: input.lane,
      contributionRevision: input.contributionRevision,
    });
    const owner = parseDurablePiRuntimeEffectOwner({
      effectId: input.effectId,
      operationId: input.operationId,
      runId: input.runId,
      chatId: input.chatId,
    });
    if (!operationInput || !owner) {
      throw new Error("Invalid Pi runtime effect preparation.");
    }
    if (
      !isSafePiRuntimeIdentity(input.turnId) ||
      !isSafePiRuntimeIdentity(input.toolCallId) ||
      !isSafePiRuntimeIdentity(input.toolName) ||
      (input.replay !== undefined && input.replay !== "safe" && input.replay !== "never")
    ) {
      throw new Error("Invalid Pi runtime effect identity.");
    }
    const replay = piRuntimeReplayPolicy(input);
    const argumentsSnapshot =
      replay === "safe" ? snapshotPiRuntimeEffectArguments(input.arguments) : undefined;
    const argumentDigest =
      argumentsSnapshot?.digest ?? digestPiRuntimeEffectArguments(input.arguments);
    const preparedAt = this.currentTime();
    return this.data.update((database) => {
      const operation = database.operations.find(
        ({ operationId }) => operationId === input.operationId,
      );
      if (
        !operation ||
        !operationMatches(operation, operationInput) ||
        operation.state !== "running"
      ) {
        throw new Error("Pi runtime effect does not belong to an active operation.");
      }
      const existing = database.effects.find((effect) => effect.effectId === input.effectId);
      if (existing) {
        if (
          ownerMatches(existing, owner) &&
          existing.sessionId === input.sessionId &&
          existing.lane === input.lane &&
          existing.turnId === input.turnId &&
          existing.toolCallId === input.toolCallId &&
          existing.toolName === input.toolName &&
          existing.replay === replay &&
          existing.argumentDigest === argumentDigest
        ) {
          return structuredClone(existing);
        }
        throw new Error("Pi runtime effect identity was reused.");
      }
      if (
        database.effects.some(
          (effect) =>
            effect.operationId === input.operationId &&
            effect.turnId === input.turnId &&
            effect.toolCallId === input.toolCallId,
        )
      ) {
        throw new Error("Pi runtime tool-call identity was reused.");
      }
      while (database.effects.length >= MAX_PI_RUNTIME_EFFECTS) {
        if (!pruneOneTerminalOperation(database)) {
          throw new Error("Pi runtime effect history is at capacity.");
        }
      }
      const effect: DurablePiRuntimeEffect = {
        version: 1,
        effectId: input.effectId,
        operationId: input.operationId,
        runId: input.runId,
        sessionId: input.sessionId,
        chatId: input.chatId,
        lane: input.lane,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        replay,
        state: "prepared",
        argumentDigest,
        ...(argumentsSnapshot ? { arguments: argumentsSnapshot.value } : {}),
        preparedAt,
        updatedAt: preparedAt,
      };
      database.effects.push(effect);
      database.revision += 1;
      pruneToWritableSize(database);
      return structuredClone(effect);
    });
  }

  private async transitionEffect(
    value: unknown,
    from: "prepared" | "dispatch_started",
    to: "dispatch_started" | "cancelled_before_dispatch",
  ): Promise<DurablePiRuntimeEffect> {
    this.requireInitialized();
    const owner = parseDurablePiRuntimeEffectOwner(value);
    if (!owner) throw new Error("Invalid Pi runtime effect owner.");
    const updatedAt = this.currentTime();
    return this.data.update((database) => {
      const index = database.effects.findIndex(({ effectId }) => effectId === owner.effectId);
      const effect = database.effects[index];
      if (!effect || !ownerMatches(effect, owner)) {
        throw new Error("Pi runtime effect ownership mismatch.");
      }
      if (effect.state !== from) {
        if (effect.state === to) return structuredClone(effect);
        throw new Error(`Pi runtime effect cannot move from ${effect.state} to ${to}.`);
      }
      const transitioned: DurablePiRuntimeEffect = {
        ...effect,
        state: to,
        updatedAt: Math.max(effect.updatedAt, updatedAt),
        ...(to === "cancelled_before_dispatch" ? { terminalDigest: EXPLICIT_CANCELLED } : {}),
      };
      database.effects[index] = transitioned;
      database.revision += 1;
      return structuredClone(transitioned);
    });
  }

  markEffectDispatchStarted(value: unknown): Promise<DurablePiRuntimeEffect> {
    return this.transitionEffect(value, "prepared", "dispatch_started");
  }

  cancelEffectBeforeDispatch(value: unknown): Promise<DurablePiRuntimeEffect> {
    return this.transitionEffect(value, "prepared", "cancelled_before_dispatch");
  }

  async finishEffect(input: FinishPiRuntimeEffectInput): Promise<DurablePiRuntimeEffect> {
    this.requireInitialized();
    const owner = parseDurablePiRuntimeEffectOwner({
      effectId: input.effectId,
      operationId: input.operationId,
      runId: input.runId,
      chatId: input.chatId,
    });
    if (
      !owner ||
      !["completed", "remote_error", "unknown", "interrupted"].includes(input.state) ||
      !/^[a-f0-9]{64}$/u.test(input.terminalDigest)
    ) {
      throw new Error("Invalid Pi runtime effect completion.");
    }
    const updatedAt = this.currentTime();
    let dispatchedPrior: DurablePiRuntimeEffect | undefined;
    try {
      const finished = await this.data.update((database) => {
        const index = database.effects.findIndex(({ effectId }) => effectId === owner.effectId);
        const effect = database.effects[index];
        if (!effect || !ownerMatches(effect, owner)) {
          throw new Error("Pi runtime effect was not found or ownership changed.");
        }
        if (effect.state !== "dispatch_started") {
          if (effect.state === input.state && effect.terminalDigest === input.terminalDigest) {
            return structuredClone(effect);
          }
          throw new Error("Pi runtime effect was not dispatch-started.");
        }
        dispatchedPrior = structuredClone(effect);
        const next: DurablePiRuntimeEffect = {
          ...effect,
          state: input.state,
          updatedAt: Math.max(effect.updatedAt, updatedAt),
          terminalDigest: input.terminalDigest,
        };
        database.effects[index] = next;
        database.revision += 1;
        return structuredClone(next);
      });
      this.localUnknown.delete(owner.effectId);
      return finished;
    } catch (error) {
      // Only a failed publication after the terminal mutation becomes
      // uncertain. Validation and conflicting terminal calls did not dispatch
      // or change durable evidence, so they must not obscure a known record.
      if (dispatchedPrior) {
        this.localUnknown.set(owner.effectId, {
          ...dispatchedPrior,
          state: "unknown",
          updatedAt: Math.max(dispatchedPrior.updatedAt, updatedAt),
          terminalDigest: TERMINAL_WRITE_UNKNOWN,
        });
      }
      throw error;
    }
  }

  async getEffect(value: unknown): Promise<DurablePiRuntimeEffect | null> {
    this.requireInitialized();
    const owner = parseDurablePiRuntimeEffectOwner(value);
    if (!owner) return null;
    const local = this.localUnknown.get(owner.effectId);
    if (local) return ownerMatches(local, owner) ? structuredClone(local) : null;
    const database = await this.data.load();
    const effect = database.effects.find(({ effectId }) => effectId === owner.effectId);
    return effect && ownerMatches(effect, owner) ? structuredClone(effect) : null;
  }

  async listOperationsByChat(chatId: string): Promise<DurablePiRuntimeOperation[]> {
    this.requireInitialized();
    if (!isSafePiRuntimeIdentity(chatId)) return [];
    return (await this.data.load()).operations
      .filter((operation) => operation.chatId === chatId)
      .map((operation) => structuredClone(operation));
  }

  async listEffectsByChat(chatId: string): Promise<DurablePiRuntimeEffect[]> {
    this.requireInitialized();
    if (!isSafePiRuntimeIdentity(chatId)) return [];
    return (await this.data.load()).effects
      .filter((effect) => effect.chatId === chatId)
      .map((effect) => structuredClone(this.localUnknown.get(effect.effectId) ?? effect));
  }

  /** Effects whose result may be absent from the recovered Pi branch. */
  async listEffectsNeedingRecoveryByChat(chatId: string): Promise<DurablePiRuntimeEffect[]> {
    this.requireInitialized();
    if (!isSafePiRuntimeIdentity(chatId)) return [];
    const database = await this.data.load();
    return database.effects
      .map((effect) => this.localUnknown.get(effect.effectId) ?? effect)
      .filter(
        (effect) =>
          effect.chatId === chatId &&
          effect.recoveryRecordedAt === undefined &&
          (effect.state === "completed" ||
            effect.state === "remote_error" ||
            effect.state === "unknown" ||
            effect.state === "interrupted"),
      )
      .map((effect) => structuredClone(effect));
  }

  /** Publish only after the Pi recovery boundary and its idempotency marker commit. */
  async markRecoveryRecorded(value: unknown): Promise<DurablePiRuntimeEffect> {
    this.requireInitialized();
    const owner = parseDurablePiRuntimeEffectOwner(value);
    if (!owner) throw new Error("Invalid Pi runtime effect recovery owner.");
    const recordedAt = this.currentTime();
    const local = this.localUnknown.get(owner.effectId);
    const recovered = await this.data.update((database) => {
      const index = database.effects.findIndex(({ effectId }) => effectId === owner.effectId);
      const durable = database.effects[index];
      if (!durable || !ownerMatches(durable, owner) || (local && !ownerMatches(local, owner))) {
        throw new Error("Pi runtime effect recovery ownership mismatch.");
      }
      const effect = local ?? durable;
      if (effect.recoveryRecordedAt !== undefined) return structuredClone(effect);
      if (!isPiRuntimeEffectTerminal(effect.state)) {
        throw new Error("An active Pi runtime effect cannot be recovery-recorded.");
      }
      const recovered: DurablePiRuntimeEffect = {
        ...effect,
        recoveryRecordedAt: Math.max(effect.updatedAt, recordedAt),
      };
      database.effects[index] = recovered;
      database.revision += 1;
      return structuredClone(recovered);
    });
    this.localUnknown.delete(owner.effectId);
    return recovered;
  }

  /**
   * A foreground visible-turn commit proves only foreground-lane effects have
   * a durable Pi result. Child sessions are intentionally in-memory, so their
   * effects remain pending until an explicit no-repeat recovery boundary is
   * committed to the foreground journal.
   */
  async acknowledgeChatEffectsDurable(chatId: string): Promise<void> {
    this.requireInitialized();
    if (!isSafePiRuntimeIdentity(chatId)) {
      throw new Error("Invalid Pi runtime effect chat acknowledgement.");
    }
    const recordedAt = this.currentTime();
    await this.data.update((database) => {
      let changed = false;
      database.effects = database.effects.map((effect) => {
        if (
          effect.chatId !== chatId ||
          effect.lane !== "foreground" ||
          effect.recoveryRecordedAt !== undefined ||
          !isPiRuntimeEffectTerminal(effect.state) ||
          effect.state === "cancelled_before_dispatch"
        ) {
          return effect;
        }
        changed = true;
        return {
          ...effect,
          recoveryRecordedAt: Math.max(effect.updatedAt, recordedAt),
        };
      });
      if (changed) database.revision += 1;
    });
  }

  async deleteChat(chatId: string): Promise<void> {
    this.requireInitialized();
    if (!isSafePiRuntimeIdentity(chatId)) return;
    await this.data.update((database) => {
      if (
        database.operations.some(
          (operation) => {
            if (operation.chatId !== chatId || operation.state !== "running") return false;
            const localTerminal = [...this.localUnknown.values()].some(
              (effect) => effect.operationId === operation.operationId,
            );
            if (!localTerminal) return true;
            return database.effects.some((effect) => {
              if (effect.operationId !== operation.operationId) return false;
              const effective = this.localUnknown.get(effect.effectId) ?? effect;
              return !isPiRuntimeEffectTerminal(effective.state);
            });
          },
        ) ||
        database.effects.some(
          (effect) => {
            const effective = this.localUnknown.get(effect.effectId) ?? effect;
            return effective.chatId === chatId && !isPiRuntimeEffectTerminal(effective.state);
          },
        )
      ) {
        throw new Error("Pi runtime chat has active durable effects and cannot be deleted.");
      }
      const operationIds = new Set(
        database.operations
          .filter((operation) => operation.chatId === chatId)
          .map(({ operationId }) => operationId),
      );
      const priorOperations = database.operations.length;
      const priorEffects = database.effects.length;
      database.operations = database.operations.filter((operation) => operation.chatId !== chatId);
      database.effects = database.effects.filter(
        (effect) => effect.chatId !== chatId && !operationIds.has(effect.operationId),
      );
      if (
        database.operations.length !== priorOperations ||
        database.effects.length !== priorEffects
      ) {
        database.revision += 1;
      }
    });
    for (const [effectId, effect] of this.localUnknown) {
      if (effect.chatId === chatId) this.localUnknown.delete(effectId);
    }
  }

  /** Remove private effect evidence whose visible chat no longer exists. */
  async reconcileChats(validChatIds: ReadonlySet<string>): Promise<void> {
    this.requireInitialized();
    const valid = new Set([...validChatIds].filter((chatId) => isSafePiRuntimeIdentity(chatId)));
    await this.data.update((database) => {
      const orphanOperationIds = new Set(
        database.operations
          .filter((operation) => !valid.has(operation.chatId))
          .map(({ operationId }) => operationId),
      );
      if (orphanOperationIds.size === 0) return;
      database.operations = database.operations.filter(
        ({ operationId }) => !orphanOperationIds.has(operationId),
      );
      database.effects = database.effects.filter(
        ({ operationId }) => !orphanOperationIds.has(operationId),
      );
      database.revision += 1;
    });
    for (const [effectId, effect] of this.localUnknown) {
      if (!valid.has(effect.chatId)) this.localUnknown.delete(effectId);
    }
  }
}

/** App-lifetime effect journal rooted in Electron's active user-data profile. */
export const piRuntimeEffectStore = new PiRuntimeEffectStore({});
