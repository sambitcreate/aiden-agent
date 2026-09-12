import {
  buildSessionContext,
  Session,
  type AgentMessage,
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
  parentSessionId?: string;
  legacyParentSessionPath?: string;
  metadata?: Record<string, unknown>;
}

interface PiSessionEntryBase {
  type: string;
  id: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
}

export type PiSessionEntry =
  | (PiSessionEntryBase & { type: "message"; message: AgentMessage; terminate?: true })
  | (PiSessionEntryBase & { type: "thinking_level_change"; thinkingLevel: string })
  | (PiSessionEntryBase & { type: "model_change"; provider: string; modelId: string })
  | (PiSessionEntryBase & { type: "active_tools_change"; activeToolNames: string[] })
  | (PiSessionEntryBase & {
      type: "compaction";
      summary: string;
      retainedTail: AgentMessage[];
      tokensBefore: number;
      details?: unknown;
      usage?: Usage;
    })
  | (PiSessionEntryBase & {
      type: "branch_summary";
      fromId: string;
      summary: string;
      details?: unknown;
      usage?: Usage;
    })
  | (PiSessionEntryBase & { type: "custom"; customType: string; data?: unknown });

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
  ) {
    this.#session = session;
    this.#entryProjectors = entryProjectors;
  }

  async appendCompaction(
    input: Parameters<PiSessionPort<Metadata>["appendCompaction"]>[0],
  ): Promise<string> {
    const entry = await this.#session.appendEntry(
      {
        type: "compaction",
        id: input.id,
        summary: input.summary,
        retainedTail: withoutUndefined(input.retainedTail),
        tokensBefore: input.tokensBefore,
        ...(input.details === undefined ? {} : { details: input.details }),
        ...(input.usage === undefined ? {} : { usage: input.usage }),
      },
      "main",
    );
    return entry.id;
  }

  appendCustomEntry: PiSessionPort<Metadata>["appendCustomEntry"] = (...args) =>
    this.#session.appendCustomEntry(...args);
  appendMessage: PiSessionPort<Metadata>["appendMessage"] = (message) =>
    this.#session.appendMessage(withoutUndefined(message));

  async buildContext(): Promise<PiSessionContext> {
    return buildSessionContext(await this.getBranch(), {
      entryProjectors: this.#entryProjectors,
    });
  }

  async getBranch(): Promise<PiSessionEntry[]> {
    return (await this.#session.findEntriesOnBranch({ order: "oldestFirst" })) as PiSessionEntry[];
  }

  async getEntries(): Promise<PiSessionEntry[]> {
    return (await this.#session.findEntries({ order: "oldestFirst" })) as PiSessionEntry[];
  }

  getLeafId: PiSessionPort<Metadata>["getLeafId"] = () => this.#session.getLeafId();
  getMetadata: PiSessionPort<Metadata>["getMetadata"] = async () =>
    (await this.#session.getMetadata()) as unknown as Metadata;

  async moveTo(entryId: string | null): Promise<void> {
    await this.#session.moveLane("main", entryId);
  }

  withEntryProjectors(
    projectors: Readonly<Record<string, PiEntryProjector>>,
  ): PiSessionPort<Metadata> {
    return Object.keys(projectors).length === 0
      ? this
      : new CurrentPiSessionPort(this.#session, projectors);
  }
}

/** The only session compatibility adapter that receives the current Pi session object. */
export function createPiSessionPort<Metadata extends PiSessionMetadata>(
  session: Session,
): PiSessionPort<Metadata> {
  return new CurrentPiSessionPort(session);
}
