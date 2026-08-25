import {
  SUBAGENT_TERMINAL_STATES,
  isSafeSubagentIdentifier,
  parseSubagentMessageReferenceV1,
  parseSubagentRunSnapshot,
  type SubagentMessageReferenceV1,
  type SubagentRunSnapshot,
  type SubagentRunStateV2,
  type SubagentSnapshotRole,
} from "../shared/subagent-runs";

export type SubagentRunViewRole = SubagentSnapshotRole | "unknown";
export type SubagentRunViewState = SubagentRunStateV2 | "unknown";
export type SubagentRunViewSource = "message" | "live";

export interface SubagentReferenceMessage {
  id: string;
  createdAt: number;
  subagents?: SubagentMessageReferenceV1;
}

/**
 * One deduplicated row/chip in the current chat. `unknown` is intentional for
 * references persisted before V1 gained per-run metadata; the UI must not
 * invent a role or terminal outcome for those messages.
 */
export interface SubagentRunView {
  runId: string;
  generationId: string;
  label: string;
  role: SubagentRunViewRole;
  state: SubagentRunViewState;
  terminal: boolean;
  source: SubagentRunViewSource;
  sortKey: string;
  referenceMessageId?: string;
  snapshot?: SubagentRunSnapshot;
}

export interface SubagentSnapshotOwner {
  chatId: string;
  workspaceId?: string;
}

export interface SubagentRunViewCounts {
  total: number;
  active: number;
  done: number;
  completed: number;
  failed: number;
  timedOut: number;
  interrupted: number;
  stopped: number;
  unknown: number;
}

export interface SubagentRunViewSplit {
  active: SubagentRunView[];
  done: SubagentRunView[];
}

export interface SubagentPersistenceHandoff {
  liveSnapshots: SubagentRunSnapshot[];
  handoffSnapshots: SubagentRunSnapshot[];
  loadedSnapshots: SubagentRunSnapshot[];
}

/**
 * The caller must retain this exact object while its read is in flight.
 * Identity comparison prevents an older request for the same run from winning
 * after a newer request has started.
 */
export interface SubagentDetailRequest {
  chatId: string;
  workspaceId?: string;
  runId: string;
  generationId: string;
  minimumRevision?: number;
}

function snapshotBelongsToOwner(
  snapshot: SubagentRunSnapshot,
  owner: SubagentSnapshotOwner | undefined,
): boolean {
  return (
    !owner ||
    (snapshot.chatId === owner.chatId &&
      (owner.workspaceId === undefined ||
        snapshot.workspaceId === owner.workspaceId))
  );
}

function sameRunAuthority(
  left: SubagentRunSnapshot,
  right: SubagentRunSnapshot,
): boolean {
  return (
    left.version === right.version &&
    left.runId === right.runId &&
    left.groupId === right.groupId &&
    left.generationId === right.generationId &&
    left.childId === right.childId &&
    left.chatId === right.chatId &&
    left.workspaceId === right.workspaceId &&
    left.startedAt === right.startedAt &&
    (left.version !== 2 ||
      (right.version === 2 &&
        left.authorityRevision === right.authorityRevision &&
        left.depth === right.depth &&
        left.execution === right.execution &&
        left.context === right.context &&
        left.parentRunId === right.parentRunId &&
        left.retryOfRunId === right.retryOfRunId))
  );
}

export function isSubagentRunViewStateActive(
  state: SubagentRunViewState,
): boolean {
  return (
    state === "queued" ||
    state === "starting" ||
    state === "running" ||
    state === "needs_attention"
  );
}

export function isSubagentRunSnapshotTerminal(
  snapshot: SubagentRunSnapshot,
): boolean {
  return snapshot.version === 2
    ? snapshot.state === "completed" ||
        snapshot.state === "failed" ||
        snapshot.state === "timed_out" ||
        snapshot.state === "interrupted" ||
        snapshot.state === "stopped" ||
        snapshot.state === "unknown"
    : SUBAGENT_TERMINAL_STATES.has(snapshot.state);
}

/**
 * Accept only a strictly newer revision for the same immutable run identity.
 * Invalid, cross-chat, cross-workspace, or identity-changing updates leave the
 * current safe value untouched.
 */
export function mergeSubagentSnapshot(
  current: SubagentRunSnapshot | undefined,
  incoming: SubagentRunSnapshot,
  owner?: SubagentSnapshotOwner,
): SubagentRunSnapshot | undefined {
  const parsedCurrent = current ? parseSubagentRunSnapshot(current) : undefined;
  const safeCurrent =
    parsedCurrent && snapshotBelongsToOwner(parsedCurrent, owner)
      ? parsedCurrent
      : undefined;
  const parsedIncoming = parseSubagentRunSnapshot(incoming);
  if (!parsedIncoming || !snapshotBelongsToOwner(parsedIncoming, owner))
    return safeCurrent;
  if (!safeCurrent) return parsedIncoming;
  if (!sameRunAuthority(safeCurrent, parsedIncoming)) return safeCurrent;
  return parsedIncoming.revision > safeCurrent.revision
    ? parsedIncoming
    : safeCurrent;
}

function snapshotSortKey(snapshot: SubagentRunSnapshot): string {
  return `${String(snapshot.startedAt).padStart(16, "0")}:${snapshot.runId}`;
}

/**
 * Merge event batches without revision rollback. Sorting only on immutable
 * start time and run ID keeps roster order stable as snapshots update.
 */
export function mergeSubagentSnapshots(
  current: readonly SubagentRunSnapshot[],
  incoming: readonly SubagentRunSnapshot[],
  owner: SubagentSnapshotOwner,
): SubagentRunSnapshot[] {
  const merged = new Map<string, SubagentRunSnapshot>();
  for (const candidate of [...current, ...incoming]) {
    const next = mergeSubagentSnapshot(
      merged.get(candidate.runId),
      candidate,
      owner,
    );
    if (next) merged.set(next.runId, next);
  }
  return [...merged.values()].sort((left, right) =>
    snapshotSortKey(left).localeCompare(snapshotSortKey(right)),
  );
}

type PersistedSnapshotReference = "absent" | "matching" | "conflicting";

function persistedSnapshotReference(
  snapshot: SubagentRunSnapshot,
  messages: readonly SubagentReferenceMessage[],
): PersistedSnapshotReference {
  for (const message of messages) {
    const reference = parseSubagentMessageReferenceV1(message.subagents);
    if (!reference) continue;
    const runIndex = reference.runIds.indexOf(snapshot.runId);
    if (runIndex === -1) continue;
    if (reference.generationId !== snapshot.generationId) return "conflicting";
    const item = reference.items?.[runIndex];
    if (
      item &&
      (item.runId !== snapshot.runId ||
        item.label !== snapshot.label ||
        item.role !== snapshot.role ||
        item.state !== snapshot.state)
    ) {
      return "conflicting";
    }
    return "matching";
  }
  return "absent";
}

/**
 * Preserve a terminal renderer-safe snapshot while its live event subtree is
 * replaced by the persisted assistant-message reference. Exact matching
 * references promote the snapshot into the loaded cache; owner, generation,
 * terminal metadata, immutable identity, and monotonic revisions remain
 * authoritative. A later generation ends any unmatched handoff.
 */
export function reconcileSubagentPersistenceHandoff(
  loadedSnapshots: readonly SubagentRunSnapshot[],
  handoffSnapshots: readonly SubagentRunSnapshot[],
  previousLiveSnapshots: readonly SubagentRunSnapshot[],
  incomingLiveSnapshots: readonly SubagentRunSnapshot[],
  references: readonly SubagentReferenceMessage[],
  owner: SubagentSnapshotOwner,
): SubagentPersistenceHandoff {
  const liveSnapshots = mergeSubagentSnapshots(
    [],
    incomingLiveSnapshots,
    owner,
  );
  const liveRunIds = new Set(liveSnapshots.map(({ runId }) => runId));
  const nextGenerationIds = new Set(
    liveSnapshots.map(({ generationId }) => generationId),
  );
  const candidates = mergeSubagentSnapshots(
    [],
    [
      ...handoffSnapshots,
      ...previousLiveSnapshots.filter(
        (snapshot) =>
          isSubagentRunSnapshotTerminal(snapshot) &&
          !liveRunIds.has(snapshot.runId),
      ),
    ],
    owner,
  );
  const promoted: SubagentRunSnapshot[] = [];
  const pending: SubagentRunSnapshot[] = [];

  for (const snapshot of candidates) {
    const persisted = persistedSnapshotReference(snapshot, references);
    if (persisted === "matching") {
      promoted.push(snapshot);
      continue;
    }
    if (
      persisted === "conflicting" ||
      (nextGenerationIds.size > 0 &&
        !nextGenerationIds.has(snapshot.generationId))
    ) {
      continue;
    }
    pending.push(snapshot);
  }

  return {
    liveSnapshots,
    handoffSnapshots: pending,
    loadedSnapshots: mergeSubagentSnapshots(
      [],
      [...loadedSnapshots, ...promoted],
      owner,
    ),
  };
}

function referenceSortKey(
  message: SubagentReferenceMessage,
  messageIndex: number,
  runIndex: number,
): string {
  const createdAt =
    Number.isFinite(message.createdAt) && message.createdAt >= 0
      ? message.createdAt
      : 0;
  return `0:${String(createdAt).padStart(16, "0")}:${String(messageIndex).padStart(8, "0")}:${String(runIndex).padStart(2, "0")}`;
}

function liveSortKey(snapshot: SubagentRunSnapshot): string {
  return `1:${snapshotSortKey(snapshot)}`;
}

/**
 * Combine durable terminal references with current-chat live snapshots.
 * Durable message order is authoritative, live revisions enrich matching
 * entries, and runs are deduplicated by their renderer-safe run ID.
 */
export function buildSubagentRunViews(
  chatId: string,
  messages: readonly SubagentReferenceMessage[],
  snapshots: readonly SubagentRunSnapshot[],
  workspaceId?: string,
): SubagentRunView[] {
  if (
    !isSafeSubagentIdentifier(chatId) ||
    (workspaceId !== undefined && !isSafeSubagentIdentifier(workspaceId))
  ) {
    return [];
  }
  const safeSnapshots = mergeSubagentSnapshots([], snapshots, {
    chatId,
    workspaceId,
  });
  const snapshotsByRunId = new Map(
    safeSnapshots.map((snapshot) => [snapshot.runId, snapshot]),
  );
  const views: SubagentRunView[] = [];
  const seen = new Set<string>();
  let legacyIndex = 0;

  for (
    let messageIndex = 0;
    messageIndex < messages.length;
    messageIndex += 1
  ) {
    const message = messages[messageIndex]!;
    const reference = parseSubagentMessageReferenceV1(message.subagents);
    if (!reference) continue;
    for (let runIndex = 0; runIndex < reference.runIds.length; runIndex += 1) {
      const runId = reference.runIds[runIndex]!;
      if (seen.has(runId)) continue;
      seen.add(runId);
      const item = reference.items?.[runIndex];
      const candidate = snapshotsByRunId.get(runId);
      const snapshot =
        candidate?.generationId === reference.generationId
          ? candidate
          : undefined;
      legacyIndex += 1;
      views.push({
        runId,
        generationId: reference.generationId,
        label: snapshot?.label ?? item?.label ?? `Subagent ${legacyIndex}`,
        role: snapshot?.role ?? item?.role ?? "unknown",
        state: snapshot?.state ?? item?.state ?? "unknown",
        terminal: snapshot ? isSubagentRunSnapshotTerminal(snapshot) : true,
        source: snapshot ? "live" : "message",
        sortKey: referenceSortKey(message, messageIndex, runIndex),
        ...(isSafeSubagentIdentifier(message.id)
          ? { referenceMessageId: message.id }
          : {}),
        ...(snapshot ? { snapshot } : {}),
      });
    }
  }

  for (const snapshot of safeSnapshots) {
    if (seen.has(snapshot.runId)) continue;
    seen.add(snapshot.runId);
    views.push({
      runId: snapshot.runId,
      generationId: snapshot.generationId,
      label: snapshot.label,
      role: snapshot.role,
      state: snapshot.state,
      terminal: isSubagentRunSnapshotTerminal(snapshot),
      source: "live",
      sortKey: liveSortKey(snapshot),
      snapshot,
    });
  }

  return views.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
}

function preferRunView(
  current: SubagentRunView,
  candidate: SubagentRunView,
): SubagentRunView {
  if (!current.snapshot) return candidate.snapshot ? candidate : current;
  if (!candidate.snapshot) return current;
  return candidate.snapshot.revision > current.snapshot.revision
    ? candidate
    : current;
}

function uniqueRunViews(views: readonly SubagentRunView[]): SubagentRunView[] {
  const unique = new Map<string, SubagentRunView>();
  for (const view of views) {
    const current = unique.get(view.runId);
    unique.set(view.runId, current ? preferRunView(current, view) : view);
  }
  return [...unique.values()].sort((left, right) =>
    left.sortKey.localeCompare(right.sortKey),
  );
}

export function splitSubagentRunViews(
  views: readonly SubagentRunView[],
): SubagentRunViewSplit {
  const active: SubagentRunView[] = [];
  const done: SubagentRunView[] = [];
  for (const view of uniqueRunViews(views)) {
    if (isSubagentRunViewStateActive(view.state)) {
      active.push(view);
    } else {
      done.push(view);
    }
  }
  return { active, done };
}

export function summarizeSubagentRunViews(
  views: readonly SubagentRunView[],
): SubagentRunViewCounts {
  const split = splitSubagentRunViews(views);
  const all = [...split.active, ...split.done];
  return {
    total: all.length,
    active: split.active.length,
    done: split.done.length,
    completed: all.filter(({ state }) => state === "completed").length,
    failed: all.filter(({ state }) => state === "failed").length,
    timedOut: all.filter(({ state }) => state === "timed_out").length,
    interrupted: all.filter(({ state }) => state === "interrupted").length,
    stopped: all.filter(({ state }) => state === "stopped").length,
    unknown: all.filter(({ state }) => state === "unknown").length,
  };
}

export function isSubagentSelectionValid(
  selectedRunId: string | undefined,
  views: readonly SubagentRunView[],
): boolean {
  return (
    selectedRunId !== undefined &&
    uniqueRunViews(views).some(({ runId }) => runId === selectedRunId)
  );
}

export function resolveSubagentSelection(
  selectedRunId: string | undefined,
  views: readonly SubagentRunView[],
): string | undefined {
  const unique = uniqueRunViews(views);
  return selectedRunId && unique.some(({ runId }) => runId === selectedRunId)
    ? selectedRunId
    : unique[0]?.runId;
}

const STATUS_LABELS: Record<SubagentRunViewState, string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Working",
  completed: "Done",
  failed: "Failed",
  timed_out: "Timed out",
  interrupted: "Interrupted",
  needs_attention: "Needs attention",
  stopped: "Stopped",
  unknown: "Outcome unknown",
};

export function subagentStatusLabel(state: SubagentRunViewState): string {
  return STATUS_LABELS[state];
}

export function subagentElapsedMilliseconds(
  view: SubagentRunView,
  now = Date.now(),
): number | undefined {
  const snapshot = view.snapshot;
  if (!snapshot || !Number.isFinite(now)) return undefined;
  const end = isSubagentRunViewStateActive(snapshot.state)
    ? Math.max(now, snapshot.startedAt)
    : (snapshot.finishedAt ?? snapshot.updatedAt);
  return Math.max(0, end - snapshot.startedAt);
}

export function formatSubagentElapsed(milliseconds: number): string {
  const totalSeconds = Number.isFinite(milliseconds)
    ? Math.max(0, Math.floor(milliseconds / 1_000))
    : 0;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function subagentElapsedLabel(
  view: SubagentRunView,
  now = Date.now(),
): string | undefined {
  const elapsed = subagentElapsedMilliseconds(view, now);
  return elapsed === undefined ? undefined : formatSubagentElapsed(elapsed);
}

export function captureSubagentDetailRequest(
  chatId: string,
  view: Pick<SubagentRunView, "runId" | "generationId"> & {
    snapshot?: Pick<SubagentRunSnapshot, "revision">;
  },
  workspaceId?: string,
): SubagentDetailRequest {
  return {
    chatId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    runId: view.runId,
    generationId: view.generationId,
    ...(view.snapshot ? { minimumRevision: view.snapshot.revision } : {}),
  };
}

/**
 * Return a parsed detail snapshot only when both request identity and current
 * UI ownership still match. Every stale/malformed result resolves to
 * `undefined`, making the safe path convenient for promise continuations.
 */
export function resolveSubagentDetailResult(
  request: SubagentDetailRequest,
  currentRequest: SubagentDetailRequest | undefined,
  currentChatId: string,
  selectedRunId: string | undefined,
  value: unknown,
): SubagentRunSnapshot | undefined {
  if (
    request !== currentRequest ||
    currentChatId !== request.chatId ||
    selectedRunId !== request.runId
  ) {
    return undefined;
  }
  const snapshot = parseSubagentRunSnapshot(value);
  if (
    !snapshot ||
    snapshot.chatId !== request.chatId ||
    snapshot.runId !== request.runId ||
    snapshot.generationId !== request.generationId ||
    (request.minimumRevision !== undefined &&
      snapshot.revision < request.minimumRevision) ||
    (request.workspaceId !== undefined &&
      snapshot.workspaceId !== request.workspaceId)
  ) {
    return undefined;
  }
  return snapshot;
}
