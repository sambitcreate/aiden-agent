import { createHash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { isSafeSubagentIdentifier } from "../../../renderer/shared/subagent-runs.js";

export const MAX_CANONICAL_ARGUMENT_BYTES = 64 * 1024;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_ENTRIES = 2_048;
const MAX_PENDING_SUBAGENT_APPROVALS = 128;
const MAX_SUBAGENT_APPROVAL_ID_ALLOCATION_ATTEMPTS = 128;

const PREPARE_INPUT_KEYS = [
  "treeRootId",
  "runId",
  "childId",
  "chatId",
  "workspaceId",
  "ownerDocumentId",
  "toolCallId",
  "toolName",
  "authorityRevision",
  "arguments",
  "expiresAt",
] as const;

export interface SubagentApprovalBindingV2 {
  treeRootId: string;
  runId: string;
  childId: string;
  chatId: string;
  workspaceId: string;
  ownerDocumentId: string;
  toolCallId: string;
  toolName: string;
  authorityRevision: number;
  argumentDigest: string;
  expiresAt: number;
}

export interface PrepareSubagentApprovalV2Input extends Omit<
  SubagentApprovalBindingV2,
  "argumentDigest"
> {
  arguments: unknown;
}

interface PendingSubagentApprovalV2 {
  binding: Readonly<SubagentApprovalBindingV2>;
  authorized: boolean;
}

function plainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface CanonicalState {
  depth: number;
  entries: number;
  active: WeakSet<object>;
}

function dataDescriptors(value: object): Record<PropertyKey, PropertyDescriptor> {
  if (utilTypes.isProxy(value)) {
    throw new Error("Subagent approval arguments contain an unsupported proxy.");
  }
  return Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>;
}

function dataProperty(
  descriptor: PropertyDescriptor | undefined,
  requireEnumerable = true,
): unknown {
  if (
    !descriptor ||
    !("value" in descriptor) ||
    (requireEnumerable && descriptor.enumerable !== true)
  ) {
    throw new Error("Subagent approval arguments contain an accessor or non-data property.");
  }
  return descriptor.value;
}

function withCanonicalContainer(
  value: object,
  state: CanonicalState,
  canonicalize: () => string,
): string {
  if (state.active.has(value)) {
    throw new Error("Subagent approval arguments contain a cyclic structure.");
  }
  state.active.add(value);
  state.depth += 1;
  try {
    if (state.depth > MAX_CANONICAL_DEPTH) {
      throw new Error("Subagent approval arguments exceed their structural limit.");
    }
    return canonicalize();
  } finally {
    state.depth -= 1;
    state.active.delete(value);
  }
}

function canonicalValue(value: unknown, state: CanonicalState): string {
  state.entries += 1;
  if (state.entries > MAX_CANONICAL_ENTRIES) {
    throw new Error("Subagent approval arguments exceed their structural limit.");
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Subagent approval arguments are not finite.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "object" && value !== null && utilTypes.isProxy(value)) {
    throw new Error("Subagent approval arguments contain an unsupported proxy.");
  }
  if (Array.isArray(value)) {
    return withCanonicalContainer(value, state, () => {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error("Subagent approval arguments contain an unsupported value.");
      }
      const descriptors = dataDescriptors(value);
      const length = dataProperty(descriptors.length, false);
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        throw new Error("Subagent approval arguments contain an invalid array.");
      }
      if ((length as number) > MAX_CANONICAL_ENTRIES) {
        throw new Error("Subagent approval arguments exceed their structural limit.");
      }
      const allowedKeys = new Set<PropertyKey>([
        "length",
        ...Array.from({ length: length as number }, (_entry, index) => String(index)),
      ]);
      if (Reflect.ownKeys(descriptors).some((key) => !allowedKeys.has(key))) {
        throw new Error("Subagent approval arguments contain unsupported array properties.");
      }
      const entries: string[] = [];
      for (let index = 0; index < (length as number); index += 1) {
        entries.push(canonicalValue(dataProperty(descriptors[String(index)]), state));
      }
      return `[${entries.join(",")}]`;
    });
  }
  if (typeof value === "object") {
    if (!plainRecord(value)) {
      throw new Error("Subagent approval arguments contain an unsupported value.");
    }
    return withCanonicalContainer(value, state, () => {
      const descriptors = dataDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) {
        throw new Error("Subagent approval arguments contain unsupported symbol properties.");
      }
      return `{${(keys as string[])
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonicalValue(dataProperty(descriptors[key]), state)}`,
        )
        .join(",")}}`;
    });
  }
  throw new Error("Subagent approval arguments contain an unsupported value.");
}

export function subagentApprovalArgumentDigestV2(toolName: string, value: unknown): string {
  if (!isSafeSubagentIdentifier(toolName)) {
    throw new Error("Invalid subagent approval tool identity.");
  }
  const canonical = canonicalValue(
    { toolName, arguments: value },
    { depth: 0, entries: 0, active: new WeakSet<object>() },
  );
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_ARGUMENT_BYTES) {
    throw new Error("Subagent approval arguments exceed their byte limit.");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Snapshot plain JSON without invoking getters, proxy traps, or coercion hooks. */
export function canonicalSubagentApprovalArgumentsV2(
  value: unknown,
  maximumBytes = MAX_CANONICAL_ARGUMENT_BYTES,
): string {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_CANONICAL_ARGUMENT_BYTES
  ) {
    throw new Error("Invalid subagent approval argument byte limit.");
  }
  const canonical = canonicalValue(value, {
    depth: 0,
    entries: 0,
    active: new WeakSet<object>(),
  });
  if (Buffer.byteLength(canonical, "utf8") > maximumBytes) {
    throw new Error("Subagent approval arguments exceed their byte limit.");
  }
  return canonical;
}

function validBinding(binding: SubagentApprovalBindingV2): boolean {
  return (
    [
      binding.treeRootId,
      binding.runId,
      binding.childId,
      binding.chatId,
      binding.workspaceId,
      binding.toolCallId,
      binding.toolName,
    ].every(isSafeSubagentIdentifier) &&
    typeof binding.ownerDocumentId === "string" &&
    binding.ownerDocumentId.length > 0 &&
    binding.ownerDocumentId.length <= 256 &&
    !binding.ownerDocumentId.includes("\0") &&
    Number.isSafeInteger(binding.authorityRevision) &&
    binding.authorityRevision >= 1 &&
    /^[a-f0-9]{64}$/u.test(binding.argumentDigest) &&
    Number.isFinite(binding.expiresAt) &&
    binding.expiresAt > 0
  );
}

function prepareInputSnapshot(
  input: PrepareSubagentApprovalV2Input,
): PrepareSubagentApprovalV2Input {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    utilTypes.isProxy(input)
  ) {
    throw new Error("Invalid subagent approval input.");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Invalid subagent approval input.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== PREPARE_INPUT_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !PREPARE_INPUT_KEYS.includes(key as (typeof PREPARE_INPUT_KEYS)[number]),
    )
  ) {
    throw new Error("Invalid subagent approval input fields.");
  }
  const field = (key: (typeof PREPARE_INPUT_KEYS)[number]): unknown =>
    dataProperty(descriptors[key]);
  return {
    treeRootId: field("treeRootId") as string,
    runId: field("runId") as string,
    childId: field("childId") as string,
    chatId: field("chatId") as string,
    workspaceId: field("workspaceId") as string,
    ownerDocumentId: field("ownerDocumentId") as string,
    toolCallId: field("toolCallId") as string,
    toolName: field("toolName") as string,
    authorityRevision: field("authorityRevision") as number,
    arguments: field("arguments"),
    expiresAt: field("expiresAt") as number,
  };
}

function sameBinding(
  binding: SubagentApprovalBindingV2,
  current: PrepareSubagentApprovalV2Input,
): boolean {
  return (
    binding.treeRootId === current.treeRootId &&
    binding.runId === current.runId &&
    binding.childId === current.childId &&
    binding.chatId === current.chatId &&
    binding.workspaceId === current.workspaceId &&
    binding.ownerDocumentId === current.ownerDocumentId &&
    binding.toolCallId === current.toolCallId &&
    binding.toolName === current.toolName &&
    binding.authorityRevision === current.authorityRevision &&
    binding.argumentDigest ===
      subagentApprovalArgumentDigestV2(current.toolName, current.arguments) &&
    binding.expiresAt === current.expiresAt
  );
}

export class SubagentApprovalLedgerV2 {
  private readonly pending = new Map<string, PendingSubagentApprovalV2>();
  private readonly callOwners = new Set<string>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly allocateId: () => string = () => `approval-${randomUUID()}`,
  ) {}

  prepare(input: PrepareSubagentApprovalV2Input): {
    approvalId: string;
    binding: Readonly<SubagentApprovalBindingV2>;
  } {
    this.removeExpired();
    if (this.pending.size >= MAX_PENDING_SUBAGENT_APPROVALS) {
      throw new Error("Too many subagent approvals are pending.");
    }
    const current = prepareInputSnapshot(input);
    const argumentDigest = subagentApprovalArgumentDigestV2(current.toolName, current.arguments);
    const binding: SubagentApprovalBindingV2 = {
      treeRootId: current.treeRootId,
      runId: current.runId,
      childId: current.childId,
      chatId: current.chatId,
      workspaceId: current.workspaceId,
      ownerDocumentId: current.ownerDocumentId,
      toolCallId: current.toolCallId,
      toolName: current.toolName,
      authorityRevision: current.authorityRevision,
      argumentDigest,
      expiresAt: current.expiresAt,
    };
    if (!validBinding(binding) || binding.expiresAt <= this.now()) {
      throw new Error("Invalid or expired subagent approval binding.");
    }
    const callOwner = `${binding.runId}\0${binding.toolCallId}`;
    if (this.callOwners.has(callOwner)) {
      throw new Error("A subagent tool call already has an approval binding.");
    }
    let approvalId: string | undefined;
    for (let attempt = 0; attempt < MAX_SUBAGENT_APPROVAL_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
      const candidate = this.allocateId();
      if (isSafeSubagentIdentifier(candidate) && !this.pending.has(candidate)) {
        approvalId = candidate;
        break;
      }
    }
    if (!approvalId) {
      throw new Error("Could not allocate a subagent approval identity.");
    }
    const frozen = Object.freeze(binding);
    this.callOwners.add(callOwner);
    this.pending.set(approvalId, { binding: frozen, authorized: false });
    return { approvalId, binding: frozen };
  }

  authorize(
    approvalId: string,
    ownerDocumentId: string,
    current: PrepareSubagentApprovalV2Input,
  ): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending || pending.authorized || pending.binding.ownerDocumentId !== ownerDocumentId) {
      return false;
    }
    if (pending.binding.expiresAt <= this.now()) {
      this.remove(approvalId, pending);
      return false;
    }
    let matches = false;
    try {
      matches = sameBinding(pending.binding, prepareInputSnapshot(current));
    } catch {
      return false;
    }
    if (!matches) return false;
    pending.authorized = true;
    return true;
  }

  consume(approvalId: string, current: PrepareSubagentApprovalV2Input): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending?.authorized) return false;
    if (pending.binding.expiresAt <= this.now()) {
      this.remove(approvalId, pending);
      return false;
    }
    let matches = false;
    try {
      matches = sameBinding(pending.binding, prepareInputSnapshot(current));
    } catch {
      return false;
    }
    if (!matches) return false;
    this.remove(approvalId, pending);
    return true;
  }

  deny(approvalId: string, ownerDocumentId: string): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending || pending.binding.ownerDocumentId !== ownerDocumentId) return false;
    this.remove(approvalId, pending);
    return true;
  }

  cancelRun(runId: string): void {
    for (const [approvalId, pending] of [...this.pending]) {
      if (pending.binding.runId === runId) this.remove(approvalId, pending);
    }
  }

  clear(): void {
    this.pending.clear();
    this.callOwners.clear();
  }

  get pendingCount(): number {
    this.removeExpired();
    return this.pending.size;
  }

  private removeExpired(): void {
    const current = this.now();
    for (const [approvalId, pending] of this.pending) {
      if (pending.binding.expiresAt <= current) this.remove(approvalId, pending);
    }
  }

  private remove(approvalId: string, pending: PendingSubagentApprovalV2): void {
    this.pending.delete(approvalId);
    this.callOwners.delete(`${pending.binding.runId}\0${pending.binding.toolCallId}`);
  }
}
