import {
  branchTip,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  insertEntry,
  setValue,
  Session,
  type AgentMessage,
  type JsonValue,
  type Entry,
  TODO_CONTEXT,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export interface PiSessionMetadata {
  id: string;
  createdAt: number;
}

export interface PiPersistentSessionMetadata extends PiSessionMetadata {
  cwd: string;
  path: string;
  modifiedAt: number;
  sourceFormat: 4;
  storageVersion?: number;
  parentSessionId?: string;
  legacyParentSessionPath?: string;
  metadata?: Record<string, unknown>;
}

export type PiSessionEntry = Entry;

export type PiCustomEntry = Extract<PiSessionEntry, { type: "custom" }>;

export interface PiSessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
  activeToolNames: string[] | null;
}

export type PiEntryProjector = (
  entry: PiCustomEntry,
  index: number,
  entries: readonly PiSessionEntry[],
) => readonly AgentMessage[] | undefined;

function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => withoutUndefined(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)]),
    ) as T;
  }
  return value;
}

/** Aiden-owned v4 journal contract, deliberately independent of Pi repository types. */
export interface PiSessionPort<Metadata extends PiSessionMetadata = PiSessionMetadata> {
  appendCompaction(input: {
    id: string;
    summary: string;
    retainedTail: AgentMessage[];
    tokensBefore: number;
    details?: unknown;
    usage?: Usage;
  }): Promise<string>;
  appendCustomEntry(customType: string, data?: unknown): Promise<string>;
  appendMessage(message: AgentMessage): Promise<string>;
  buildContext(): Promise<PiSessionContext>;
  getBranch(): Promise<PiSessionEntry[]>;
  getEntries(): Promise<PiSessionEntry[]>;
  getLeafId(): Promise<string | null>;
  getMetadata(): Promise<Metadata>;
  moveTo(entryId: string | null): Promise<void>;
  withEntryProjectors(
    projectors: Readonly<Record<string, PiEntryProjector>>,
  ): PiSessionPort<Metadata>;
}

class CurrentPiSessionPort<Metadata extends PiSessionMetadata>
  implements PiSessionPort<Metadata>
{
  readonly #session: Session;
  readonly #entryProjectors: Readonly<Record<string, PiEntryProjector>>;

  constructor(
    session: Session,
    entryProjectors: Readonly<Record<string, PiEntryProjector>> = {},
    private readonly metadataOverride?: Metadata,
  ) {
    this.#session = session;
    this.#entryProjectors = entryProjectors;
  }

  async #branch() {
    return (await this.#session.branch("main", TODO_CONTEXT)) ??
      this.#session.createBranch("main", null, TODO_CONTEXT);
  }

  async appendCompaction(
    input: Parameters<PiSessionPort<Metadata>["appendCompaction"]>[0],
  ): Promise<string> {
    await this.#branch();
    await this.#session.mutate(async (mutator) => {
      const tip = await mutator.getValue(branchTip("main"), TODO_CONTEXT);
      if (!tip) throw new Error("The Pi main branch is missing.");
      await mutator.commit([
        insertEntry({
          type: "compaction",
          id: input.id,
          parentId: tip.value,
          summary: input.summary,
          retainedTail: withoutUndefined(input.retainedTail),
          tokensBefore: input.tokensBefore,
          ...(input.details === undefined ? {} : { details: jsonValue(input.details) }),
          ...(input.usage === undefined ? {} : { usage: input.usage }),
          fromHook: false,
        }),
        setValue(branchTip("main"), input.id),
      ], TODO_CONTEXT);
    }, TODO_CONTEXT);
    return input.id;
  }

  appendCustomEntry: PiSessionPort<Metadata>["appendCustomEntry"] = async (customType, data) =>
    (await this.#branch()).appendCustomEntry(customType, data === undefined ? undefined : jsonValue(data), TODO_CONTEXT);
  appendMessage: PiSessionPort<Metadata>["appendMessage"] = async (message) =>
    (await this.#branch()).appendMessage(withoutUndefined(message), TODO_CONTEXT);

  async buildContext(): Promise<PiSessionContext> {
    const branch = await this.getBranch();
    let thinkingLevel = "off";
    let model: PiSessionContext["model"] = null;
    let activeToolNames: string[] | null = null;
    for (const entry of branch) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        model = { provider: entry.message.provider, modelId: entry.message.model };
      }
      if (entry.type !== "custom" || !entry.customType.startsWith("aiden.pi-legacy.")) continue;
      const data = entry.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      if (entry.customType === "aiden.pi-legacy.thinking_level_change" && typeof data.thinkingLevel === "string") {
        thinkingLevel = data.thinkingLevel;
      } else if (entry.customType === "aiden.pi-legacy.model_change" && typeof data.provider === "string" && typeof data.modelId === "string") {
        model = { provider: data.provider, modelId: data.modelId };
      } else if (entry.customType === "aiden.pi-legacy.active_tools_change" && Array.isArray(data.activeToolNames)) {
        activeToolNames = data.activeToolNames.filter((name): name is string => typeof name === "string");
      }
    }
    let lastCompaction = -1;
    for (let index = branch.length - 1; index >= 0; index--) {
      if (branch[index]?.type === "compaction") { lastCompaction = index; break; }
    }
    const entries = lastCompaction < 0 ? branch : branch.slice(lastCompaction);
    const messages: AgentMessage[] = [];
    for (const [index, entry] of entries.entries()) {
      if (entry.type === "message") {
        messages.push(entry.message);
      } else if (entry.type === "compaction") {
        messages.push(createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp));
        messages.push(...entry.retainedTail);
      } else if (entry.type === "branch_summary" && entry.summary) {
        messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
      } else if (entry.type === "custom") {
        messages.push(...(this.#entryProjectors[entry.customType]?.(entry, index, entries) ?? []));
      }
    }
    return { messages, thinkingLevel, model, activeToolNames };
  }

  async getBranch(): Promise<PiSessionEntry[]> {
    return (await (await this.#branch()).findEntries({ order: "oldestFirst" }, TODO_CONTEXT)) as PiSessionEntry[];
  }

  async getEntries(): Promise<PiSessionEntry[]> {
    return (await this.#session.findEntries({ order: "asc" }, TODO_CONTEXT)) as PiSessionEntry[];
  }

  getLeafId: PiSessionPort<Metadata>["getLeafId"] = async () => (await this.#branch()).getTipId(TODO_CONTEXT);
  getMetadata: PiSessionPort<Metadata>["getMetadata"] = async () =>
    this.metadataOverride ?? this.#session.metadata as unknown as Metadata;

  async moveTo(entryId: string | null): Promise<void> {
    await this.#session.setValue(branchTip("main"), entryId, TODO_CONTEXT);
  }

  withEntryProjectors(
    projectors: Readonly<Record<string, PiEntryProjector>>,
  ): PiSessionPort<Metadata> {
    return Object.keys(projectors).length === 0
      ? this
      : new CurrentPiSessionPort(this.#session, projectors, this.metadataOverride);
  }
}

function jsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(withoutUndefined(value));
  if (encoded === undefined) throw new Error("Pi session data must be JSON-compatible.");
  return JSON.parse(encoded) as JsonValue;
}

/** The only session compatibility adapter that receives the current Pi session object. */
export function createPiSessionPort<Metadata extends PiSessionMetadata>(
  session: Session,
  metadata?: Metadata,
): PiSessionPort<Metadata> {
  return new CurrentPiSessionPort(session, {}, metadata);
}
