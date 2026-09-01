import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const LEGACY_SESSION_VERSION = 3;

interface LegacySessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  metadata?: Record<string, unknown>;
}

export interface LegacyPiEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export interface LegacyPiSession {
  header: LegacySessionHeader;
  entries: LegacyPiEntry[];
  leafId: string | null;
  tornFinalLine: boolean;
}

export interface LegacyPiMigrationVerification {
  format: "pi-session-v3";
  targetFormat: "pi-session-v4";
  sourceSha256: string;
  sessionId: string;
  entryCount: number;
  activeBranchEntryCount: number;
  messageCount: number;
  customEntryCount: number;
  compactionCount: number;
  abandonedEntryCount: number;
  tornFinalLine: boolean;
  wouldChange: boolean;
  changes: {
    materializedRetainedTailCheckpoints: number;
    preservedCustomEntries: number;
    preservedModelChanges: number;
    preservedAbandonedEntries: number;
  };
  validation: "context_parity";
}

export interface LegacyPiContext {
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
  activeToolNames: string[] | null;
  messages: AgentMessage[];
}

export interface LegacyPiMigrationProjection {
  targetFormat: "pi-session-v4";
  entries: LegacyPiEntry[];
  sourceContext: LegacyPiContext;
  targetContext: LegacyPiContext;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function textOrImagePart(value: unknown): boolean {
  const part = record(value);
  return (
    (part?.type === "text" && typeof part.text === "string") ||
    (part?.type === "image" && typeof part.data === "string" && nonEmptyString(part.mimeType))
  );
}

function assistantPart(value: unknown): boolean {
  const part = record(value);
  return (
    (part?.type === "text" && typeof part.text === "string") ||
    (part?.type === "thinking" &&
      typeof part.thinking === "string" &&
      (part.redacted === undefined || typeof part.redacted === "boolean")) ||
    (part?.type === "toolCall" &&
      nonEmptyString(part.id) &&
      nonEmptyString(part.name) &&
      Boolean(record(part.arguments)))
  );
}

function messageContent(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every((part) => textOrImagePart(part)))
  );
}

function validUsage(value: unknown): boolean {
  const usage = record(value);
  const cost = record(usage?.cost);
  return Boolean(
    usage &&
      cost &&
      ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) =>
        finiteNumber(usage[key]),
      ) &&
      ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) =>
        finiteNumber(cost[key]),
      ),
  );
}

function validLegacyAgentMessage(value: unknown): value is AgentMessage {
  const message = record(value);
  if (!message || !finiteNumber(message.timestamp)) return false;
  switch (message.role) {
    case "user":
      return messageContent(message.content);
    case "assistant":
      return (
        Array.isArray(message.content) &&
        message.content.every((part) => assistantPart(part)) &&
        nonEmptyString(message.api) &&
        nonEmptyString(message.provider) &&
        nonEmptyString(message.model) &&
        validUsage(message.usage) &&
        ["stop", "length", "toolUse", "error", "aborted"].includes(
          String(message.stopReason),
        )
      );
    case "toolResult":
      return (
        nonEmptyString(message.toolCallId) &&
        nonEmptyString(message.toolName) &&
        Array.isArray(message.content) &&
        message.content.every((part) => textOrImagePart(part)) &&
        typeof message.isError === "boolean" &&
        (message.addedToolNames === undefined ||
          (Array.isArray(message.addedToolNames) &&
            message.addedToolNames.every((name) => typeof name === "string")))
      );
    case "bashExecution":
      return (
        typeof message.command === "string" &&
        typeof message.output === "string" &&
        (message.exitCode === undefined || finiteNumber(message.exitCode)) &&
        typeof message.cancelled === "boolean" &&
        typeof message.truncated === "boolean"
      );
    case "custom":
      return (
        nonEmptyString(message.customType) &&
        messageContent(message.content) &&
        typeof message.display === "boolean"
      );
    case "branchSummary":
      return typeof message.summary === "string" && nonEmptyString(message.fromId);
    case "compactionSummary":
      return typeof message.summary === "string" && finiteNumber(message.tokensBefore);
    default:
      return false;
  }
}

function parseHeader(value: unknown): LegacySessionHeader {
  const candidate = record(value);
  if (
    candidate?.type !== "session" ||
    candidate.version !== LEGACY_SESSION_VERSION ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.timestamp !== "string" ||
    candidate.timestamp.length === 0 ||
    typeof candidate.cwd !== "string" ||
    candidate.cwd.length === 0
  ) {
    throw new Error("The legacy Pi journal has an invalid v3 session header.");
  }
  if (
    candidate.parentSession !== undefined &&
    typeof candidate.parentSession !== "string"
  ) {
    throw new Error("The legacy Pi journal has an invalid parent session path.");
  }
  const metadata = record(candidate.metadata);
  if (candidate.metadata !== undefined && !metadata) {
    throw new Error("The legacy Pi journal has invalid metadata.");
  }
  return {
    type: "session",
    version: 3,
    id: candidate.id,
    timestamp: candidate.timestamp,
    cwd: candidate.cwd,
    ...(typeof candidate.parentSession === "string"
      ? { parentSession: candidate.parentSession }
      : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function parseEntry(value: unknown, lineNumber: number): LegacyPiEntry {
  const candidate = record(value);
  if (
    !candidate ||
    typeof candidate.type !== "string" ||
    candidate.type.length === 0 ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    (candidate.parentId !== null && typeof candidate.parentId !== "string") ||
    typeof candidate.timestamp !== "string" ||
    candidate.timestamp.length === 0
  ) {
    throw new Error(`The legacy Pi journal has an invalid entry on line ${lineNumber}.`);
  }
  const nonEmptyString = (entryValue: unknown): entryValue is string =>
    typeof entryValue === "string" && entryValue.length > 0;
  const optionalBoolean = (entryValue: unknown): boolean =>
    entryValue === undefined || typeof entryValue === "boolean";
  const stringArray = (entryValue: unknown): entryValue is string[] =>
    Array.isArray(entryValue) && entryValue.every((item) => typeof item === "string");
  const validContent = (entryValue: unknown): boolean =>
    typeof entryValue === "string" ||
    (Array.isArray(entryValue) &&
      entryValue.every((part) => record(part) && nonEmptyString(record(part)?.type)));
  let shapeValid = false;
  switch (candidate.type) {
    case "message": {
      shapeValid = validLegacyAgentMessage(candidate.message);
      break;
    }
    case "thinking_level_change":
      shapeValid = nonEmptyString(candidate.thinkingLevel);
      break;
    case "model_change":
      shapeValid = nonEmptyString(candidate.provider) && nonEmptyString(candidate.modelId);
      break;
    case "active_tools_change":
      shapeValid = stringArray(candidate.activeToolNames);
      break;
    case "compaction":
      shapeValid =
        typeof candidate.summary === "string" &&
        nonEmptyString(candidate.firstKeptEntryId) &&
        typeof candidate.tokensBefore === "number" &&
        Number.isFinite(candidate.tokensBefore) &&
        candidate.tokensBefore >= 0 &&
        optionalBoolean(candidate.fromHook);
      break;
    case "branch_summary":
      shapeValid =
        nonEmptyString(candidate.fromId) &&
        typeof candidate.summary === "string" &&
        optionalBoolean(candidate.fromHook);
      break;
    case "custom":
      shapeValid = nonEmptyString(candidate.customType);
      break;
    case "custom_message":
      shapeValid =
        nonEmptyString(candidate.customType) &&
        validContent(candidate.content) &&
        typeof candidate.display === "boolean";
      break;
    case "label":
      shapeValid =
        nonEmptyString(candidate.targetId) &&
        (candidate.label === undefined || typeof candidate.label === "string");
      break;
    case "session_info":
      shapeValid = candidate.name === undefined || typeof candidate.name === "string";
      break;
    case "leaf":
      shapeValid = candidate.targetId === null || nonEmptyString(candidate.targetId);
      break;
    default:
      shapeValid = false;
  }
  if (!shapeValid) {
    throw new Error(
      `The legacy Pi journal has an invalid or unsupported ${candidate.type} entry on line ${lineNumber}.`,
    );
  }
  return candidate as LegacyPiEntry;
}

/**
 * Decode a Pi v3 JSONL journal without importing Pi's session implementation.
 * A final incomplete JSON record is reported but never repaired by this reader.
 */
export function decodeLegacyPiSession(contents: string): LegacyPiSession {
  const rawLines = contents.split("\n");
  const nonEmpty = rawLines
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0);
  if (nonEmpty.length === 0) throw new Error("The legacy Pi journal is empty.");

  let tornFinalLine = false;
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(nonEmpty[0]!.line);
  } catch {
    throw new Error("The legacy Pi journal header is not valid JSON.");
  }
  const header = parseHeader(headerValue);
  const entries: LegacyPiEntry[] = [];
  const byId = new Map<string, LegacyPiEntry>();
  let leafId: string | null = null;
  for (let index = 1; index < nonEmpty.length; index += 1) {
    const item = nonEmpty[index]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.line);
    } catch {
      const isIncompleteLastRecord =
        index === nonEmpty.length - 1 && !item.line.trimEnd().endsWith("}");
      if (!isIncompleteLastRecord) {
        throw new Error(`The legacy Pi journal has invalid JSON on line ${item.lineNumber}.`);
      }
      tornFinalLine = true;
      break;
    }
    const entry = parseEntry(parsed, item.lineNumber);
    if (byId.has(entry.id)) {
      throw new Error(`The legacy Pi journal repeats entry id ${entry.id}.`);
    }
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      throw new Error(`The legacy Pi journal entry ${entry.id} has a missing parent.`);
    }
    entries.push(entry);
    byId.set(entry.id, entry);
    leafId =
      entry.type === "leaf"
        ? ((entry.targetId as string | null) ?? null)
        : entry.id;
  }
  if (leafId !== null && !byId.has(leafId)) {
    throw new Error("The legacy Pi journal points at a missing active leaf.");
  }
  return { header, entries, leafId, tornFinalLine };
}

export function legacyPiActiveBranch(session: LegacyPiSession): LegacyPiEntry[] {
  if (session.leafId === null) return [];
  const byId = new Map(session.entries.map((entry) => [entry.id, entry]));
  const branch: LegacyPiEntry[] = [];
  const visited = new Set<string>();
  let current = byId.get(session.leafId);
  while (current) {
    if (visited.has(current.id)) throw new Error("The legacy Pi journal contains a parent cycle.");
    visited.add(current.id);
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    if (branch[0]?.parentId && !current) {
      throw new Error("The legacy Pi journal active branch has a missing parent.");
    }
  }
  return branch;
}

function legacyContextEntries(branch: LegacyPiEntry[]): LegacyPiEntry[] {
  let compaction: LegacyPiEntry | undefined;
  for (const entry of branch) if (entry.type === "compaction") compaction = entry;
  if (!compaction) return branch;
  const compactionIndex = branch.indexOf(compaction);
  const firstKeptEntryId = compaction.firstKeptEntryId;
  if (typeof firstKeptEntryId !== "string" || !firstKeptEntryId) {
    throw new Error("The legacy Pi compaction is missing firstKeptEntryId.");
  }
  const retained: LegacyPiEntry[] = [compaction];
  let foundFirstKept = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = branch[index]!;
    if (entry.id === firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) retained.push(entry);
  }
  if (!foundFirstKept) {
    throw new Error("The legacy Pi compaction retained boundary is not on its active branch.");
  }
  retained.push(...branch.slice(compactionIndex + 1));
  return retained;
}

/** Reconstruct the provider-neutral messages Pi v0.80 owns in a v3 journal. */
function messagesFromLegacyContextEntries(entries: readonly LegacyPiEntry[]): AgentMessage[] {
  return entries.flatMap((entry) => {
    if (entry.type === "message") return [entry.message as AgentMessage];
    if (entry.type === "custom_message") {
      return [
        {
          role: "custom",
          customType: entry.customType,
          content: entry.content,
          display: entry.display,
          details: entry.details,
          timestamp: new Date(entry.timestamp).getTime(),
        } as AgentMessage,
      ];
    }
    if (entry.type === "compaction") {
      return [
        {
          role: "compactionSummary",
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: new Date(entry.timestamp).getTime(),
        } as AgentMessage,
      ];
    }
    if (entry.type === "branch_summary" && entry.summary) {
      return [
        {
          role: "branchSummary",
          summary: entry.summary,
          fromId: entry.fromId,
          timestamp: new Date(entry.timestamp).getTime(),
        } as AgentMessage,
      ];
    }
    return [];
  });
}

/** Reconstruct Pi's complete v0.80 provider-neutral context and state. */
function contextStateFromBranch(branch: readonly LegacyPiEntry[]): Omit<LegacyPiContext, "messages"> {
  let thinkingLevel = "off";
  let model: LegacyPiContext["model"] = null;
  let activeToolNames: string[] | null = null;
  for (const entry of branch) {
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      thinkingLevel = entry.thinkingLevel;
    } else if (
      entry.type === "model_change" &&
      typeof entry.provider === "string" &&
      typeof entry.modelId === "string"
    ) {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message") {
      const message = record(entry.message);
      if (
        message?.role === "assistant" &&
        typeof message.provider === "string" &&
        typeof message.model === "string"
      ) {
        model = { provider: message.provider, modelId: message.model };
      }
    } else if (entry.type === "active_tools_change" && Array.isArray(entry.activeToolNames)) {
      activeToolNames = entry.activeToolNames.filter(
        (name): name is string => typeof name === "string",
      );
    }
  }
  return { thinkingLevel, model, activeToolNames };
}

export function buildLegacyPiContextState(session: LegacyPiSession): LegacyPiContext {
  const branch = legacyPiActiveBranch(session);
  return {
    ...contextStateFromBranch(branch),
    messages: messagesFromLegacyContextEntries(legacyContextEntries(branch)),
  };
}

/** Reconstruct only the provider-neutral messages Pi v0.80 owns in a v3 journal. */
export function buildLegacyPiContext(session: LegacyPiSession): AgentMessage[] {
  return buildLegacyPiContextState(session).messages;
}

function materializedRetainedTail(
  entry: LegacyPiEntry,
  byId: ReadonlyMap<string, LegacyPiEntry>,
): AgentMessage[] {
  if (entry.type !== "compaction") return [];
  const firstKeptEntryId = entry.firstKeptEntryId;
  if (typeof firstKeptEntryId !== "string" || !firstKeptEntryId) {
    throw new Error("The legacy Pi compaction is missing firstKeptEntryId.");
  }
  const reverse: LegacyPiEntry[] = [];
  let current = entry.parentId ? byId.get(entry.parentId) : undefined;
  while (current) {
    reverse.push(current);
    if (current.id === firstKeptEntryId) {
      return messagesFromLegacyContextEntries(reverse.reverse());
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  throw new Error("The legacy Pi compaction retained boundary is not reachable.");
}

type ProjectedEntry = LegacyPiEntry;

function projectedActiveBranch(
  entries: readonly ProjectedEntry[],
  leafId: string | null,
): ProjectedEntry[] {
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: ProjectedEntry[] = [];
  const visited = new Set<string>();
  let current = byId.get(leafId);
  while (current) {
    if (visited.has(current.id)) throw new Error("The projected Pi v4 session has a parent cycle.");
    visited.add(current.id);
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    if (branch[0]?.parentId && !current) {
      throw new Error("The projected Pi v4 active branch has a missing parent.");
    }
  }
  return branch;
}

/** Independently reconstruct Pi v4 retained-tail context from projected entries. */
export function buildProjectedPiV4Context(
  entries: readonly ProjectedEntry[],
  leafId: string | null,
): LegacyPiContext {
  const branch = projectedActiveBranch(entries, leafId);
  let checkpointIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "compaction") {
      checkpointIndex = index;
      break;
    }
  }
  if (checkpointIndex < 0) {
    return {
      ...contextStateFromBranch(branch),
      messages: messagesFromLegacyContextEntries(branch),
    };
  }
  const checkpoint = branch[checkpointIndex]!;
  if (!("retainedTail" in checkpoint) || !Array.isArray(checkpoint.retainedTail)) {
    throw new Error("The projected Pi v4 checkpoint is missing retainedTail.");
  }
  const summary = messagesFromLegacyContextEntries([checkpoint as LegacyPiEntry]);
  const later = messagesFromLegacyContextEntries(
    branch.slice(checkpointIndex + 1) as LegacyPiEntry[],
  );
  return {
    ...contextStateFromBranch(branch as LegacyPiEntry[]),
    messages: [
      ...summary,
      ...(checkpoint.retainedTail as AgentMessage[]),
      ...later,
    ],
  };
}

/**
 * Build the Phase 3 conversion projection entirely in memory. This shared
 * projection is the verifier's target-side evidence and later migration input.
 */
export function projectLegacyPiMigration(
  session: LegacyPiSession,
): LegacyPiMigrationProjection {
  const byId = new Map(session.entries.map((entry) => [entry.id, entry]));
  const entries: LegacyPiEntry[] = session.entries.map((entry) => {
    if (entry.type !== "compaction") return structuredClone(entry);
    const { firstKeptEntryId: _legacyBoundary, ...checkpoint } = entry;
    return {
      ...structuredClone(checkpoint),
      retainedTail: structuredClone(materializedRetainedTail(entry, byId)),
    } as LegacyPiEntry;
  });
  const sourceContext = buildLegacyPiContextState(session);
  const targetContext = buildProjectedPiV4Context(entries, session.leafId);
  return { targetFormat: "pi-session-v4", entries, sourceContext, targetContext };
}

export function verifyLegacyPiMigration(contents: string): LegacyPiMigrationVerification {
  const session = decodeLegacyPiSession(contents);
  const branch = legacyPiActiveBranch(session);
  const activeIds = new Set(branch.map((entry) => entry.id));
  const projection = projectLegacyPiMigration(session);
  if (JSON.stringify(projection.sourceContext) !== JSON.stringify(projection.targetContext)) {
    throw new Error("The projected Pi v4 migration changes provider context.");
  }
  const abandonedEntryCount = session.entries.filter((entry) => !activeIds.has(entry.id)).length;
  return {
    format: "pi-session-v3",
    targetFormat: projection.targetFormat,
    sourceSha256: createHash("sha256").update(contents).digest("hex"),
    sessionId: session.header.id,
    entryCount: session.entries.length,
    activeBranchEntryCount: branch.length,
    messageCount: session.entries.filter((entry) => entry.type === "message").length,
    customEntryCount: session.entries.filter((entry) => entry.type === "custom").length,
    compactionCount: session.entries.filter((entry) => entry.type === "compaction").length,
    abandonedEntryCount,
    tornFinalLine: session.tornFinalLine,
    wouldChange: true,
    changes: {
      materializedRetainedTailCheckpoints: session.entries.filter(
        (entry) => entry.type === "compaction",
      ).length,
      preservedCustomEntries: session.entries.filter((entry) => entry.type === "custom").length,
      preservedModelChanges: session.entries.filter(
        (entry) => entry.type === "model_change",
      ).length,
      preservedAbandonedEntries: abandonedEntryCount,
    },
    validation: "context_parity",
  };
}

/** Read-only helper for migration diagnostics and release verification. */
export async function verifyLegacyPiMigrationFile(
  filePath: string,
): Promise<LegacyPiMigrationVerification> {
  return verifyLegacyPiMigration(await readFile(filePath, "utf8"));
}
