// Taint tracking for one run (docs/plans/bot-ux-simplification.md §3.2).
//
// Once outside content enters a run (a web page, search results, a connector's
// data), text the person never wrote could steer the model. From then on two
// kinds of call are "new destinations" for the gate (step 6): the first use in
// the run of a connector not yet used in it, even a read, and a fetch to a
// site the person did not name. Never ask still runs them; Ask asks; Auto
// judges them.
//
// The person's own words name sites; their workspace files and attachments are
// their own content and do not taint the run. `bringsOutsideContent` lists the
// sources.

import { bringsOutsideContent, FETCH_TOOL_NAMES } from "./tool-classes.js";

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const BARE_HOST_PATTERN = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi;

function hostOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

/** The sites a person's text names: full URLs and bare host names. */
export function namedHosts(text: string): Set<string> {
  const hosts = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const host = hostOf(match[0]);
    if (host) hosts.add(host);
  }
  for (const match of text.matchAll(BARE_HOST_PATTERN)) {
    hosts.add(match[1]!.toLowerCase().replace(/^www\./, ""));
  }
  return hosts;
}

/** The URL a fetch tool would load, from its arguments. */
export function fetchTarget(toolName: string, args: unknown): string | undefined {
  if (!FETCH_TOOL_NAMES.has(toolName) || args === null || typeof args !== "object") return undefined;
  const url = (args as { url?: unknown }).url;
  return typeof url === "string" ? url : undefined;
}

export interface RunTaintCall {
  toolName: string;
  args?: unknown;
  /** The connector (MCP server) a connector tool belongs to. */
  connectorId?: string;
}

export interface RunTaintHistoryEntry {
  role: string;
  toolName?: string;
  /** Counts as outside content whatever its role: a summary of history that can't be checked. */
  outside?: true;
}

/** One entry of a chat's journal branch, as far as taint reads it. */
export interface RunTaintBranchEntry {
  type: string;
  message?: { role: string; toolName?: unknown };
  retainedTail?: readonly { role: string; toolName?: unknown }[];
}

const SUMMARY_ROLES: ReadonlySet<string> = new Set(["compactionSummary", "branchSummary"]);

/**
 * A chat's whole journal branch, root to tip, as taint history: tool results
 * a compaction folded away still count, since its summary may carry what
 * they brought in. A summary whose source isn't on the branch (a compaction
 * with nothing before it, another branch's summary, or a summary message)
 * can't be checked, so it counts as outside content.
 */
export function runTaintHistoryOfBranch(branch: readonly RunTaintBranchEntry[]): RunTaintHistoryEntry[] {
  const history: RunTaintHistoryEntry[] = [];
  const add = (message: { role: string; toolName?: unknown }) => {
    history.push({ role: message.role, ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
      ...(SUMMARY_ROLES.has(message.role) ? { outside: true as const } : {}) });
  };
  let folded = false;
  for (const entry of branch) {
    if (entry.type === "message" && entry.message) {
      add(entry.message);
      folded = true;
    } else if (entry.type === "compaction") {
      if (!folded) history.push({ role: "compactionSummary", outside: true });
      for (const message of entry.retainedTail ?? []) add(message);
    } else if (entry.type === "branch_summary") {
      history.push({ role: "branchSummary", outside: true });
    }
  }
  return history;
}

export class RunTaint {
  private outside = false;
  private readonly connectorsUsed = new Set<string>();
  private readonly hosts = new Set<string>();

  /**
   * `personText` is what the person wrote in this chat (their messages);
   * `history` is the run's starting transcript, so outside content from an
   * earlier turn still counts.
   */
  constructor(input: {
    personText: readonly string[];
    history?: readonly RunTaintHistoryEntry[];
    isConnectorTool?: (toolName: string) => boolean;
  }) {
    for (const text of input.personText) for (const host of namedHosts(text)) this.hosts.add(host);
    for (const entry of input.history ?? []) {
      if (entry.outside) this.outside = true;
      if (entry.role !== "toolResult" || entry.toolName === undefined) continue;
      if (bringsOutsideContent(entry.toolName) || input.isConnectorTool?.(entry.toolName)) this.outside = true;
    }
  }

  get tainted(): boolean {
    return this.outside;
  }

  /** The person named another site mid-run (a steering message). */
  addPersonText(text: string): void {
    for (const host of namedHosts(text)) this.hosts.add(host);
  }

  /** Whether the gate should treat this call as a new destination. */
  isNewDestination(call: RunTaintCall): boolean {
    if (!this.outside) return false;
    if (call.connectorId !== undefined) return !this.connectorsUsed.has(call.connectorId);
    const target = fetchTarget(call.toolName, call.args);
    if (target === undefined) return false;
    const host = hostOf(target);
    if (host === undefined) return true;
    for (const named of this.hosts) if (host === named || host.endsWith(`.${named}`)) return false;
    return true;
  }

  /**
   * A call is about to run. Its connector counts as used, and a call that
   * brings outside content taints the rest of the run.
   */
  observeRunning(call: RunTaintCall): void {
    if (call.connectorId !== undefined) {
      this.connectorsUsed.add(call.connectorId);
      this.outside = true;
      return;
    }
    if (bringsOutsideContent(call.toolName)) this.outside = true;
  }
}
