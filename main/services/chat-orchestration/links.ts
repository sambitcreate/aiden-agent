// The local record of which chat started which (docs/plans/proactive-aiden-plan.md,
// Phase 5, D2). One link per started chat: its lead, the idempotency key that
// started it, the permission ceiling the lead set, whether the person took it
// over, the run the lead is following, an owed result and which results the
// lead has already heard about. Kept in `chat-orchestration.json` (mode 0600)
// in Aiden's data folder; never projected to a phone, a paired Mac or an app.
//
// Reads are synchronous from memory once restored. Writes are serialized; a
// failed save is logged and the memory copy stays current, so a full disk
// costs the record after a restart, never the running work.

import { isStorableResult, isStorableResultSchema } from "./result-schema.js";
import { isValidBranchName } from "../../../renderer/shared/worktree-on-send.js";
import { APPROVAL_MODES, MAC_GRANT_CLASSES, type ApprovalMode, type MacGrantClass } from "../../../renderer/shared/approval-mode.js";
import type { ApprovalCeiling } from "../approval-gate/run-approval.js";

export type ChatLinkRunEnd = "done" | "stopped" | "failed" | "interrupted";

export interface ChatLink {
  childChatId: string;
  leadChatId: string;
  /** The key the lead started this chat with (`agent-chat:<lead>:<key>:<index>`). */
  key: string;
  title: string;
  createdAt: number;
  ceiling: ApprovalCeiling;
  /** When the lead last sent a message into this chat. */
  leadSentAt?: number;
  /** The person typed in this chat after the lead's last message. */
  tookOverAt?: number;
  /** The run the lead started most recently in this chat. */
  runId?: string;
  /** A finished run the lead has not been told about yet. */
  owed?: { runId: string; end: ChatLinkRunEnd; at: number };
  /** Runs the lead has already been told about, newest last. */
  delivered?: string[];
  /** The branch of the new worktree the chat runs in, when the lead asked for one. */
  branch?: string;
  /** The JSON Schema the lead asked the chat's result to match (Phase 5, D6). */
  resultSchema?: Record<string, unknown>;
  /** The newest result the chat submitted that matched `resultSchema`. */
  result?: { value: unknown; at: number };
}

export interface ChatLinkDocument {
  version: 1;
  links: ChatLink[];
}

export interface ChatLinkStorage {
  load(): Promise<unknown>;
  save(document: ChatLinkDocument): Promise<void>;
}

/** Links kept, oldest dropped first; a memory guard, not a limit on started chats. */
export const CHAT_LINK_LIMIT = 5_000;
const DELIVERED_LIMIT = 16;
const TITLE_CHARS = 200;
const ID = /^[A-Za-z0-9._-]{1,128}$/u;
const KEY = /^[A-Za-z0-9._:-]{1,300}$/u;
const RUN_ENDS: readonly ChatLinkRunEnd[] = ["done", "stopped", "failed", "interrupted"];

export function emptyChatLinkDocument(): ChatLinkDocument {
  return { version: 1, links: [] };
}

function time(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseCeiling(value: unknown): ApprovalCeiling | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!APPROVAL_MODES.includes(record.mode as ApprovalMode) || typeof record.chatOnly !== "boolean") return undefined;
  if (!Array.isArray(record.macGrants) || !record.macGrants.every((grant) => MAC_GRANT_CLASSES.includes(grant as MacGrantClass))) {
    return undefined;
  }
  return { mode: record.mode as ApprovalMode, macGrants: [...new Set(record.macGrants as MacGrantClass[])], chatOnly: record.chatOnly };
}

/** One link, or `undefined` when any required part is missing or damaged. Optional parts that are damaged are dropped. */
export function parseChatLink(value: unknown): ChatLink | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const ceiling = parseCeiling(record.ceiling);
  const createdAt = time(record.createdAt);
  if (
    typeof record.childChatId !== "string" || !ID.test(record.childChatId) ||
    typeof record.leadChatId !== "string" || !ID.test(record.leadChatId) ||
    record.childChatId === record.leadChatId ||
    typeof record.key !== "string" || !KEY.test(record.key) ||
    typeof record.title !== "string" || [...record.title].length > TITLE_CHARS ||
    createdAt === undefined || !ceiling
  ) {
    return undefined;
  }
  const link: ChatLink = {
    childChatId: record.childChatId,
    leadChatId: record.leadChatId,
    key: record.key,
    title: record.title,
    createdAt,
    ceiling,
  };
  const leadSentAt = time(record.leadSentAt);
  if (leadSentAt !== undefined) link.leadSentAt = leadSentAt;
  const tookOverAt = time(record.tookOverAt);
  if (tookOverAt !== undefined) link.tookOverAt = tookOverAt;
  if (typeof record.runId === "string" && KEY.test(record.runId)) link.runId = record.runId;
  const owed = record.owed as Record<string, unknown> | undefined;
  if (owed && typeof owed === "object" && typeof owed.runId === "string" && KEY.test(owed.runId) &&
      RUN_ENDS.includes(owed.end as ChatLinkRunEnd) && time(owed.at) !== undefined) {
    link.owed = { runId: owed.runId, end: owed.end as ChatLinkRunEnd, at: owed.at as number };
  }
  if (typeof record.branch === "string" && record.branch.length <= 255 && isValidBranchName(record.branch)) link.branch = record.branch;
  if (isStorableResultSchema(record.resultSchema)) {
    link.resultSchema = record.resultSchema;
    const result = record.result as Record<string, unknown> | undefined;
    if (result && typeof result === "object" && !Array.isArray(result) && isStorableResult(result.value) && time(result.at) !== undefined) {
      link.result = { value: result.value, at: result.at as number };
    }
  }
  if (Array.isArray(record.delivered)) {
    const delivered = record.delivered.filter((runId): runId is string => typeof runId === "string" && KEY.test(runId));
    if (delivered.length > 0) link.delivered = delivered.slice(-DELIVERED_LIMIT);
  }
  return link;
}

/** The document with every damaged link dropped; a damaged file reads as empty. */
export function parseChatLinkDocument(value: unknown): ChatLinkDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyChatLinkDocument();
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.links)) return emptyChatLinkDocument();
  const seen = new Set<string>();
  const links: ChatLink[] = [];
  for (const candidate of record.links) {
    const link = parseChatLink(candidate);
    // A chat has one lead: the first link for it wins.
    if (!link || seen.has(link.childChatId)) continue;
    seen.add(link.childChatId);
    links.push(link);
  }
  return { version: 1, links: links.slice(-CHAT_LINK_LIMIT) };
}

/** What a started chat whose link is lost runs under: Ask, no Mac grants. */
export const LOST_LINK_CEILING: ApprovalCeiling = Object.freeze({ mode: "ask", macGrants: [], chatOnly: false }) as ApprovalCeiling;

/** The ceiling for a chat: its link's, or the lost-link one when only its `startedBy` survives. */
export function startedChatCeiling(
  links: Pick<ChatLinkStore, "ceilingFor">,
  chatId: string,
  startedBy: { chatId: string } | undefined,
): ApprovalCeiling | undefined {
  return links.ceilingFor(chatId) ?? (startedBy ? { ...LOST_LINK_CEILING, macGrants: [] } : undefined);
}

export class ChatLinkStore {
  private readonly links = new Map<string, ChatLink>();
  private restored: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: ChatLinkStorage,
    private readonly log: (message: string, error?: unknown) => void = () => undefined,
  ) {}

  /** Loads the saved links once; later calls wait for the same load. */
  restore(): Promise<void> {
    this.restored ??= (async () => {
      let saved: unknown;
      try {
        saved = await this.storage.load();
      } catch (error) {
        this.log("Could not read the started-chat links.", error);
      }
      for (const link of parseChatLinkDocument(saved).links) {
        if (!this.links.has(link.childChatId)) this.links.set(link.childChatId, link);
      }
    })();
    return this.restored;
  }

  get(childChatId: string): ChatLink | undefined {
    const link = this.links.get(childChatId);
    return link ? structuredClone(link) : undefined;
  }

  /** The link a lead created with this key, so a replayed start finds its chat. */
  byKey(leadChatId: string, key: string): ChatLink | undefined {
    for (const link of this.links.values()) {
      if (link.leadChatId === leadChatId && link.key === key) return structuredClone(link);
    }
    return undefined;
  }

  /** The chats this lead started, oldest first. */
  childrenOf(leadChatId: string): ChatLink[] {
    return [...this.links.values()].filter((link) => link.leadChatId === leadChatId).map((link) => structuredClone(link));
  }

  /** The ceiling a started chat runs under, or `undefined` for any other chat. */
  ceilingFor(chatId: string): ApprovalCeiling | undefined {
    const ceiling = this.links.get(chatId)?.ceiling;
    return ceiling ? structuredClone(ceiling) : undefined;
  }

  /** Records a started chat. A chat already linked keeps its first link. */
  add(link: ChatLink): Promise<ChatLink> {
    const parsed = parseChatLink(link);
    if (!parsed) return Promise.reject(new Error("Invalid started-chat link."));
    const existing = this.links.get(parsed.childChatId);
    if (existing) return Promise.resolve(structuredClone(existing));
    this.links.set(parsed.childChatId, parsed);
    while (this.links.size > CHAT_LINK_LIMIT) {
      const oldest = this.links.keys().next().value;
      if (oldest === undefined) break;
      this.links.delete(oldest);
    }
    return this.persist().then(() => structuredClone(parsed));
  }

  /**
   * Changes one link. `change` edits a copy; an edit that would leave the link
   * damaged is refused. Resolves with the saved link, or `undefined` when the
   * chat has no link.
   */
  update(childChatId: string, change: (link: ChatLink) => void): Promise<ChatLink | undefined> {
    const current = this.links.get(childChatId);
    if (!current) return Promise.resolve(undefined);
    const draft = structuredClone(current);
    change(draft);
    if (draft.delivered) draft.delivered = draft.delivered.slice(-DELIVERED_LIMIT);
    const parsed = parseChatLink(draft);
    if (!parsed || parsed.childChatId !== childChatId || parsed.leadChatId !== current.leadChatId) {
      return Promise.reject(new Error("Invalid started-chat link."));
    }
    this.links.set(childChatId, parsed);
    return this.persist().then(() => structuredClone(parsed));
  }

  /**
   * A deleted chat: its own link goes, and so do the links of chats it
   * started. Those chats keep `startedBy`, so they run under the lost-link
   * ceiling (Ask, no Mac grants) and never get `child_chats` themselves.
   */
  deleteChat(chatId: string): Promise<void> {
    let changed = this.links.delete(chatId);
    for (const [child, link] of this.links) {
      if (link.leadChatId !== chatId) continue;
      this.links.delete(child);
      changed = true;
    }
    return changed ? this.persist() : Promise.resolve();
  }

  /** Waits for every save started so far. */
  flush(): Promise<void> {
    return this.writes;
  }

  private persist(): Promise<void> {
    const write = this.writes.then(async () => {
      try {
        await this.storage.save({ version: 1, links: [...this.links.values()].map((link) => structuredClone(link)) });
      } catch (error) {
        this.log("Could not save the started-chat links.", error);
      }
    });
    this.writes = write;
    return write;
  }
}
