import { randomUUID } from "node:crypto";
import {
  isSafeSubagentIdentifier,
  parseSubagentRunSnapshotV2,
  type SubagentRunSnapshotV2,
  type SubagentRunStateV2,
} from "../../../renderer/shared/subagent-runs.js";
import {
  parseSubagentManagementRequestV2,
  type SubagentManagementRequestV2,
} from "./management-v2.js";

export const MAX_SUBAGENT_CONTROL_RECORDS = 512;
export const MAX_SUBAGENT_CONTROL_WAITERS_PER_RUN = 32;
export const MAX_SUBAGENT_CONTROL_STEERING_PER_RUN = 8;
export const MAX_SUBAGENT_CONTROL_STEERING_CHARS_PER_RUN = 32_000;
const MAX_IDENTIFIER_ALLOCATION_ATTEMPTS = 128;

const TERMINAL_STATES = new Set<SubagentRunStateV2>([
  "completed",
  "failed",
  "timed_out",
  "interrupted",
  "stopped",
]);

export interface SubagentControlOwnerV2 {
  chatId: string;
  workspaceId: string;
  ownerDocumentId: string;
  authorityRevision: number;
}

export interface SubagentControlRegistrationV2 {
  snapshot: SubagentRunSnapshotV2;
  ownerDocumentId: string;
  /** Must synchronously revoke every unconsumed approval for this run. */
  revokeApprovals(): void;
  /** Must synchronously propagate the logical stop to queued and active work. */
  stop(reason: Error): void;
  steer?(instruction: string, signal: AbortSignal): Promise<void> | void;
  onSnapshot?(snapshot: SubagentRunSnapshotV2): void;
}

export interface SubagentRetryPreparationV2 {
  registration: SubagentControlRegistrationV2;
  /** Called only after the fresh retry record has been validated and registered. */
  start(signal: AbortSignal): void;
}

export interface SubagentRetryRequestV2 {
  source: SubagentRunSnapshotV2;
  retryOfRunId: string;
  runId: string;
  childId: string;
  groupId: string;
  owner: SubagentControlOwnerV2;
}

export interface SubagentControlRegistryOptionsV2 {
  prepareRetry?: (
    request: SubagentRetryRequestV2,
  ) => Promise<SubagentRetryPreparationV2> | SubagentRetryPreparationV2;
  now?: () => number;
  randomUUID?: () => string;
  maxRecords?: number;
}

export type SubagentManagementResultV2 =
  | { version: 2; action: "status"; snapshot: SubagentRunSnapshotV2 }
  | {
      version: 2;
      action: "wait";
      snapshot: SubagentRunSnapshotV2;
      timedOut: boolean;
    }
  | {
      version: 2;
      action: "stop";
      snapshot: SubagentRunSnapshotV2;
      changed: boolean;
    }
  | {
      version: 2;
      action: "retry";
      sourceSnapshot: SubagentRunSnapshotV2;
      snapshot: SubagentRunSnapshotV2;
    }
  | { version: 2; action: "steer"; snapshot: SubagentRunSnapshotV2 };

interface Waiter {
  timer: ReturnType<typeof setTimeout>;
  resolve(result: { snapshot: SubagentRunSnapshotV2; timedOut: boolean }): void;
}

interface SteeringWork {
  instruction: string;
  resolve(snapshot: SubagentRunSnapshotV2): void;
  reject(error: Error): void;
}

interface ControlRecord {
  snapshot: SubagentRunSnapshotV2;
  ownerDocumentId: string;
  revokeApprovals(): void;
  stop(reason: Error): void;
  steer?: (instruction: string, signal: AbortSignal) => Promise<void> | void;
  onSnapshot?: (snapshot: SubagentRunSnapshotV2) => void;
  control: AbortController;
  waiters: Set<Waiter>;
  steering: SteeringWork[];
  steeringChars: number;
  steeringActive: boolean;
  retryInFlight: boolean;
}

function cloneSnapshot(snapshot: SubagentRunSnapshotV2): SubagentRunSnapshotV2 {
  return structuredClone(snapshot);
}

function ignoreControlHookFailure(operation: () => void): void {
  try {
    operation();
  } catch {
    // A host integration hook cannot reopen authority or prevent settlement.
  }
}

function validPrivateDocumentId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes("\0");
}

function assertOwner(owner: SubagentControlOwnerV2): void {
  if (
    !isSafeSubagentIdentifier(owner.chatId) ||
    !isSafeSubagentIdentifier(owner.workspaceId) ||
    !validPrivateDocumentId(owner.ownerDocumentId) ||
    !Number.isSafeInteger(owner.authorityRevision) ||
    owner.authorityRevision < 1
  ) {
    throw new Error("Invalid subagent control owner.");
  }
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function sameRunIdentity(left: SubagentRunSnapshotV2, right: SubagentRunSnapshotV2): boolean {
  return (
    left.runId === right.runId &&
    left.groupId === right.groupId &&
    left.generationId === right.generationId &&
    left.childId === right.childId &&
    left.chatId === right.chatId &&
    left.workspaceId === right.workspaceId &&
    left.role === right.role &&
    left.label === right.label &&
    left.taskPreview === right.taskPreview &&
    left.startedAt === right.startedAt &&
    left.modelId === right.modelId &&
    sameOptional(left.parentRunId, right.parentRunId) &&
    sameOptional(left.retryOfRunId, right.retryOfRunId) &&
    left.depth === right.depth &&
    left.execution === right.execution &&
    left.context === right.context &&
    left.authorityRevision === right.authorityRevision
  );
}

function validStateProgression(current: SubagentRunStateV2, next: SubagentRunStateV2): boolean {
  if (TERMINAL_STATES.has(current) || next === "stopped") return false;
  if (current === "queued") return true;
  if (current === "starting") return next !== "queued";
  return next !== "queued" && next !== "starting";
}

function assertMonotonicProgress(
  current: SubagentRunSnapshotV2,
  next: SubagentRunSnapshotV2,
): void {
  const currentMilestones = current.milestones ?? [];
  const nextMilestones = next.milestones ?? [];
  if (
    next.revision <= current.revision ||
    next.updatedAt < current.updatedAt ||
    next.turns < current.turns ||
    next.tools < current.tools ||
    next.tokens < current.tokens ||
    nextMilestones.length < currentMilestones.length ||
    currentMilestones.some((milestone, index) => nextMilestones[index] !== milestone) ||
    !validStateProgression(current.state, next.state)
  ) {
    throw new Error("Subagent control lifecycle cannot move backward.");
  }
}

function stoppedSnapshot(snapshot: SubagentRunSnapshotV2, now: number): SubagentRunSnapshotV2 {
  if (!Number.isFinite(now) || now < 0 || snapshot.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Subagent control could not record a safe stop.");
  }
  const candidate: Record<string, unknown> = structuredClone(snapshot) as unknown as Record<
    string,
    unknown
  >;
  const stoppedAt = Math.max(snapshot.updatedAt, now);
  candidate.state = "stopped";
  candidate.revision = snapshot.revision + 1;
  candidate.updatedAt = stoppedAt;
  candidate.finishedAt = stoppedAt;
  candidate.warnings = ["Stopped by the user."];
  delete candidate.activity;
  delete candidate.latestText;
  delete candidate.terminalMarkdown;
  delete candidate.error;
  const parsed = parseSubagentRunSnapshotV2(candidate);
  if (!parsed) throw new Error("Subagent control produced an invalid stopped snapshot.");
  return parsed;
}

/**
 * Main-process control plane for exact foreground child management. It owns no
 * IPC surface and receives no renderer object; callers must supply an exact
 * main-resolved owner tuple on every operation.
 */
export class SubagentControlRegistryV2 {
  private readonly records = new Map<string, ControlRecord>();
  private readonly now: () => number;
  private readonly allocateUuid: () => string;
  private readonly maxRecords: number;

  constructor(private readonly options: SubagentControlRegistryOptionsV2 = {}) {
    this.now = options.now ?? Date.now;
    this.allocateUuid = options.randomUUID ?? randomUUID;
    this.maxRecords = options.maxRecords ?? MAX_SUBAGENT_CONTROL_RECORDS;
    if (
      !Number.isSafeInteger(this.maxRecords) ||
      this.maxRecords < 1 ||
      this.maxRecords > MAX_SUBAGENT_CONTROL_RECORDS
    ) {
      throw new Error("Invalid subagent control record limit.");
    }
  }

  get size(): number {
    return this.records.size;
  }

  register(input: SubagentControlRegistrationV2): SubagentRunSnapshotV2 {
    const snapshot = parseSubagentRunSnapshotV2(input.snapshot);
    if (
      !snapshot ||
      snapshot.execution !== "foreground" ||
      snapshot.authorityRevision < 1 ||
      !validPrivateDocumentId(input.ownerDocumentId) ||
      typeof input.revokeApprovals !== "function" ||
      typeof input.stop !== "function"
    ) {
      throw new Error("Invalid subagent control registration.");
    }
    if (this.records.has(snapshot.runId)) {
      throw new Error("Subagent control run identity was reused.");
    }
    const record: ControlRecord = {
      snapshot,
      ownerDocumentId: input.ownerDocumentId,
      revokeApprovals: input.revokeApprovals,
      stop: input.stop,
      ...(input.steer ? { steer: input.steer } : {}),
      ...(input.onSnapshot ? { onSnapshot: input.onSnapshot } : {}),
      control: new AbortController(),
      waiters: new Set(),
      steering: [],
      steeringChars: 0,
      steeringActive: false,
      retryInFlight: false,
    };
    if (TERMINAL_STATES.has(snapshot.state)) {
      // Complete the mandatory approval fence before capacity eviction so a
      // rejected terminal admission cannot discard already accepted history.
      record.revokeApprovals();
    }
    if (this.records.size >= this.maxRecords) this.evictOldestTerminalRecord();
    if (this.records.size >= this.maxRecords) {
      throw new Error("The subagent control registry is full.");
    }
    this.records.set(snapshot.runId, record);
    if (TERMINAL_STATES.has(snapshot.state)) {
      this.closeTerminalRecord(record);
    }
    return cloneSnapshot(snapshot);
  }

  /** Remove only a pristine queued record that never crossed launch admission. */
  unregisterPrepared(owner: SubagentControlOwnerV2, runId: string): boolean {
    const record = this.ownedRecord(owner, runId);
    if (
      record.snapshot.state !== "queued" ||
      record.snapshot.revision !== 1 ||
      record.waiters.size > 0 ||
      record.steering.length > 0 ||
      record.steeringActive ||
      record.retryInFlight
    ) {
      throw new Error("Only an unlaunched queued subagent can be unregistered.");
    }
    record.revokeApprovals();
    if (!record.control.signal.aborted) {
      record.control.abort(new Error("Subagent launch preparation was rolled back."));
    }
    return this.records.delete(runId);
  }

  status(owner: SubagentControlOwnerV2, runId: string): SubagentRunSnapshotV2 {
    return cloneSnapshot(this.ownedRecord(owner, runId).snapshot);
  }

  update(
    owner: SubagentControlOwnerV2,
    candidate: SubagentRunSnapshotV2,
  ): SubagentRunSnapshotV2 {
    const record = this.ownedRecord(owner, candidate.runId);
    const next = parseSubagentRunSnapshotV2(candidate);
    if (!next || !sameRunIdentity(record.snapshot, next)) {
      throw new Error("Subagent control update changed immutable run authority.");
    }
    assertMonotonicProgress(record.snapshot, next);
    this.publish(record, next);
    return cloneSnapshot(next);
  }

  async wait(
    owner: SubagentControlOwnerV2,
    runId: string,
    timeoutMs: number,
  ): Promise<{ snapshot: SubagentRunSnapshotV2; timedOut: boolean }> {
    const parsed = parseSubagentManagementRequestV2({
      version: 2,
      action: "wait",
      runId,
      timeoutMs,
    });
    if (parsed.action !== "wait") throw new Error("Invalid subagent wait request.");
    const record = this.ownedRecord(owner, parsed.runId);
    if (TERMINAL_STATES.has(record.snapshot.state)) {
      return { snapshot: cloneSnapshot(record.snapshot), timedOut: false };
    }
    if (parsed.timeoutMs === 0) {
      return { snapshot: cloneSnapshot(record.snapshot), timedOut: true };
    }
    if (record.waiters.size >= MAX_SUBAGENT_CONTROL_WAITERS_PER_RUN) {
      throw new Error("Too many waits are pending for this subagent.");
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        timer: setTimeout(() => {
          record.waiters.delete(waiter);
          resolve({ snapshot: cloneSnapshot(record.snapshot), timedOut: true });
        }, parsed.timeoutMs),
        resolve,
      };
      record.waiters.add(waiter);
    });
  }

  stop(
    owner: SubagentControlOwnerV2,
    runId: string,
  ): { snapshot: SubagentRunSnapshotV2; changed: boolean } {
    const record = this.ownedRecord(owner, runId);
    if (TERMINAL_STATES.has(record.snapshot.state)) {
      return { snapshot: cloneSnapshot(record.snapshot), changed: false };
    }
    const reason = new Error("Subagent run stopped by its owner.");
    if (!record.control.signal.aborted) record.control.abort(reason);
    // A terminal acknowledgement is authoritative. If either mandatory hook
    // cannot confirm revocation/cancellation, keep the prior non-terminal
    // snapshot and surface the failure instead of claiming work stopped.
    record.revokeApprovals();
    record.stop(reason);
    this.publish(record, stoppedSnapshot(record.snapshot, this.now()));
    return { snapshot: cloneSnapshot(record.snapshot), changed: true };
  }

  async steer(
    owner: SubagentControlOwnerV2,
    runId: string,
    instruction: string,
  ): Promise<SubagentRunSnapshotV2> {
    const parsed = parseSubagentManagementRequestV2({
      version: 2,
      action: "steer",
      runId,
      instruction,
    });
    if (parsed.action !== "steer") throw new Error("Invalid subagent steer request.");
    const record = this.ownedRecord(owner, parsed.runId);
    if (TERMINAL_STATES.has(record.snapshot.state)) {
      throw new Error("A terminal subagent cannot be steered.");
    }
    if (!record.steer) throw new Error("Subagent steering is unavailable for this run.");
    const pendingCount = record.steering.length + (record.steeringActive ? 1 : 0);
    if (
      pendingCount >= MAX_SUBAGENT_CONTROL_STEERING_PER_RUN ||
      record.steeringChars + parsed.instruction.length >
        MAX_SUBAGENT_CONTROL_STEERING_CHARS_PER_RUN
    ) {
      throw new Error("The subagent steering queue is full.");
    }
    return new Promise<SubagentRunSnapshotV2>((resolve, reject) => {
      record.steering.push({ instruction: parsed.instruction, resolve, reject });
      record.steeringChars += parsed.instruction.length;
      this.pumpSteering(record);
    });
  }

  async retry(
    owner: SubagentControlOwnerV2,
    runId: string,
  ): Promise<{ sourceSnapshot: SubagentRunSnapshotV2; snapshot: SubagentRunSnapshotV2 }> {
    const sourceRecord = this.ownedRecord(owner, runId);
    if (!TERMINAL_STATES.has(sourceRecord.snapshot.state)) {
      throw new Error("Only a terminal subagent run can be retried.");
    }
    if (!this.options.prepareRetry) throw new Error("Subagent retry is unavailable.");
    if (sourceRecord.retryInFlight) throw new Error("A retry is already being prepared.");
    sourceRecord.retryInFlight = true;
    try {
      sourceRecord.revokeApprovals();
      const identities = this.allocateRetryIdentities();
      const source = cloneSnapshot(sourceRecord.snapshot);
      const prepared = await this.options.prepareRetry({
        source,
        retryOfRunId: source.runId,
        ...identities,
        owner: { ...owner },
      });
      this.assertRetryRegistration(source, owner, identities, prepared.registration);
      const retrySnapshot = this.register(prepared.registration);
      const retryRecord = this.records.get(retrySnapshot.runId)!;
      try {
        prepared.start(retryRecord.control.signal);
      } catch (error) {
        this.stop(
          {
            chatId: retrySnapshot.chatId,
            workspaceId: retrySnapshot.workspaceId,
            ownerDocumentId: prepared.registration.ownerDocumentId,
            authorityRevision: retrySnapshot.authorityRevision,
          },
          retrySnapshot.runId,
        );
        throw error;
      }
      return {
        sourceSnapshot: source,
        snapshot: cloneSnapshot(retryRecord.snapshot),
      };
    } finally {
      sourceRecord.retryInFlight = false;
    }
  }

  async execute(
    owner: SubagentControlOwnerV2,
    value: SubagentManagementRequestV2 | unknown,
  ): Promise<SubagentManagementResultV2> {
    const request = parseSubagentManagementRequestV2(value);
    switch (request.action) {
      case "status":
        return { version: 2, action: "status", snapshot: this.status(owner, request.runId) };
      case "wait": {
        const result = await this.wait(owner, request.runId, request.timeoutMs);
        return { version: 2, action: "wait", ...result };
      }
      case "stop": {
        const result = this.stop(owner, request.runId);
        return { version: 2, action: "stop", ...result };
      }
      case "retry": {
        const result = await this.retry(owner, request.runId);
        return { version: 2, action: "retry", ...result };
      }
      case "steer":
        return {
          version: 2,
          action: "steer",
          snapshot: await this.steer(owner, request.runId, request.instruction),
        };
    }
  }

  private ownedRecord(owner: SubagentControlOwnerV2, runId: string): ControlRecord {
    assertOwner(owner);
    if (!isSafeSubagentIdentifier(runId)) throw new Error("Invalid subagent control run.");
    const record = this.records.get(runId);
    if (
      !record ||
      record.snapshot.chatId !== owner.chatId ||
      record.snapshot.workspaceId !== owner.workspaceId ||
      record.ownerDocumentId !== owner.ownerDocumentId ||
      record.snapshot.authorityRevision !== owner.authorityRevision
    ) {
      throw new Error("Subagent control authority does not match.");
    }
    return record;
  }

  private publish(record: ControlRecord, snapshot: SubagentRunSnapshotV2): void {
    if (TERMINAL_STATES.has(snapshot.state)) record.revokeApprovals();
    record.snapshot = snapshot;
    if (record.onSnapshot) {
      ignoreControlHookFailure(() => record.onSnapshot?.(cloneSnapshot(snapshot)));
    }
    if (TERMINAL_STATES.has(snapshot.state)) this.closeTerminalRecord(record);
  }

  private closeTerminalRecord(record: ControlRecord): void {
    if (!record.control.signal.aborted) {
      record.control.abort(new Error("Subagent run reached a terminal state."));
    }
    for (const waiter of [...record.waiters]) {
      clearTimeout(waiter.timer);
      record.waiters.delete(waiter);
      waiter.resolve({ snapshot: cloneSnapshot(record.snapshot), timedOut: false });
    }
    const error = new Error("The subagent ended before queued steering was accepted.");
    for (const work of record.steering.splice(0)) {
      record.steeringChars -= work.instruction.length;
      work.reject(error);
    }
  }

  private evictOldestTerminalRecord(): void {
    const candidate = [...this.records.entries()]
      .filter(([, record]) => TERMINAL_STATES.has(record.snapshot.state))
      .sort(
        ([leftId, left], [rightId, right]) =>
          left.snapshot.updatedAt - right.snapshot.updatedAt ||
          leftId.localeCompare(rightId),
      )[0];
    if (candidate) this.records.delete(candidate[0]);
  }

  private pumpSteering(record: ControlRecord): void {
    if (record.steeringActive || TERMINAL_STATES.has(record.snapshot.state)) return;
    const work = record.steering.shift();
    if (!work || !record.steer) return;
    record.steeringActive = true;
    const signal = record.control.signal;
    let removeAbort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("The subagent ended before steering was accepted."),
        );
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => signal.removeEventListener("abort", onAbort);
      }
    });
    void Promise.race([
      Promise.resolve().then(() => record.steer?.(work.instruction, signal)),
      aborted,
    ])
      .then(() => {
        if (TERMINAL_STATES.has(record.snapshot.state) || signal.aborted) {
          throw new Error("The subagent ended before steering was accepted.");
        }
        work.resolve(cloneSnapshot(record.snapshot));
      })
      .catch((error: unknown) => {
        work.reject(error instanceof Error ? error : new Error("Subagent steering failed."));
      })
      .finally(() => {
        removeAbort();
        record.steeringChars -= work.instruction.length;
        record.steeringActive = false;
        this.pumpSteering(record);
      });
  }

  private allocateRetryIdentities(): { runId: string; childId: string; groupId: string } {
    for (let attempt = 0; attempt < MAX_IDENTIFIER_ALLOCATION_ATTEMPTS; attempt += 1) {
      const nonce = this.allocateUuid();
      const identities = {
        runId: `run-${nonce}`,
        childId: `child-${nonce}`,
        groupId: `retry-${nonce}`,
      };
      if (
        isSafeSubagentIdentifier(identities.runId) &&
        isSafeSubagentIdentifier(identities.childId) &&
        isSafeSubagentIdentifier(identities.groupId) &&
        !this.records.has(identities.runId)
      ) {
        return identities;
      }
    }
    throw new Error("Could not allocate a safe subagent retry identity.");
  }

  private assertRetryRegistration(
    source: SubagentRunSnapshotV2,
    owner: SubagentControlOwnerV2,
    identities: { runId: string; childId: string; groupId: string },
    registration: SubagentControlRegistrationV2,
  ): void {
    const retry = parseSubagentRunSnapshotV2(registration.snapshot);
    if (
      !retry ||
      retry.runId !== identities.runId ||
      retry.childId !== identities.childId ||
      retry.groupId !== identities.groupId ||
      retry.retryOfRunId !== source.runId ||
      retry.runId === source.runId ||
      retry.childId === source.childId ||
      retry.generationId !== source.generationId ||
      retry.chatId !== source.chatId ||
      retry.workspaceId !== source.workspaceId ||
      retry.depth !== source.depth ||
      !sameOptional(retry.parentRunId, source.parentRunId) ||
      retry.execution !== "foreground" ||
      retry.context !== source.context ||
      retry.role !== source.role ||
      retry.label !== source.label ||
      retry.taskPreview !== source.taskPreview ||
      retry.state !== "queued" ||
      retry.revision !== 1 ||
      retry.finishedAt !== undefined ||
      retry.turns !== 0 ||
      retry.tools !== 0 ||
      retry.tokens !== 0 ||
      (retry.milestones?.length ?? 0) !== 0 ||
      retry.warnings.length !== 0 ||
      registration.ownerDocumentId !== owner.ownerDocumentId
    ) {
      throw new Error("Subagent retry preparation changed bound lineage or reused runtime state.");
    }
  }
}
