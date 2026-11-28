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
// tool sources; `messageBringsOutsideContent` the messages Aiden posts that
// quote outside text (a trigger's event, a started chat's reply, GitHub's).

import { TRIGGER_EVENT_LABEL } from "../../../renderer/shared/agent-notices.js";
import { hasMcpAgentToolNameShape } from "../mcp-tool-identity.js";
import { bringsOutsideContent, FETCH_TOOL_NAMES } from "./tool-classes.js";

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const EMAIL_PATTERN = /[a-z0-9.!#$%&'*+=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*/gi;
const BARE_HOST_PATTERN = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi;

/**
 * Common file extensions (including ones that collide with real TLDs such as
 * `.md`, `.sh`, `.py`, `.rs`, `.pl`, `.zip`, `.mov`, `.so`, `.tf`) that should
 * not turn bare filenames in a chat message into trusted fetch destinations.
 * Explicit URLs (e.g. `https://readme.md`) still match `URL_PATTERN`.
 */
const FILE_EXTENSION_SUFFIXES: ReadonlySet<string> = new Set([
  // Collide with real ICANN TLDs
  "am", "as", "cc", "cr", "es", "gs", "md", "ml", "mov", "ms", "pl", "pm",
  "ps", "py", "rs", "sh", "so", "st", "tf", "zip",
  // Common source, config, doc, data, media, archive and binary extensions
  "astro", "avi", "bak", "bash", "bat", "bib", "bz2", "cer", "cfg", "cjs",
  "class", "cmake", "cmd", "conf", "cpp", "crt", "cs", "css", "csv", "cts",
  "cxx", "db", "deb", "diff", "dll", "dmg", "docx", "dylib", "env", "erl",
  "ex", "exe", "exs", "fish", "gif", "go", "gql", "gradle", "graphql", "gz",
  "hcl", "hpp", "hs", "htm", "html", "hxx", "ico", "ini", "jar", "java",
  "jks", "jpeg", "jpg", "js", "json", "jsonl", "jsx", "key", "kt", "kts",
  "less", "lock", "log", "lua", "map", "mdx", "mjs", "mk", "mkv", "mp3",
  "mp4", "mts", "nix", "otf", "p12", "patch", "pdf", "pem", "pfx", "php",
  "pkg", "plist", "png", "pptx", "properties", "proto", "ps1", "rb", "rpm",
  "rst", "scss", "sql", "sqlite", "svelte", "svg", "swift", "tar", "tex",
  "tgz", "tmp", "toml", "ts", "tsv", "tsx", "ttf", "txt", "vue", "wasm",
  "wav", "webp", "woff", "woff2", "xlsx", "xml", "xz", "yaml", "yml", "zig",
  "zsh",
]);

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
  const withoutUrlsOrEmails = text
    .replace(URL_PATTERN, (raw) => {
      const host = hostOf(raw);
      if (host) hosts.add(host);
      return " ".repeat(raw.length);
    })
    .replace(EMAIL_PATTERN, (raw) => " ".repeat(raw.length));
  for (const match of withoutUrlsOrEmails.matchAll(BARE_HOST_PATTERN)) {
    const raw = match[1]!;
    const start = match.index ?? 0;
    const end = start + raw.length;
    const prev = start > 0 ? withoutUrlsOrEmails[start - 1] : undefined;
    const next = end < withoutUrlsOrEmails.length ? withoutUrlsOrEmails[end] : undefined;
    // Skip filesystem paths, dotfiles, stray `@` mentions and method calls.
    if (prev === "/" || prev === "\\" || prev === "." || prev === "@" || next === "(" || next === "@") continue;
    const normalized = raw.toLowerCase().replace(/^www\./, "");
    const suffix = normalized.slice(normalized.lastIndexOf(".") + 1);
    if (FILE_EXTENSION_SUFFIXES.has(suffix)) continue;
    hosts.add(normalized);
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

const SUMMARY_ROLES: ReadonlySet<string> = new Set(["compactionSummary", "branchSummary"]);

/**
 * Whether a tool's result says it brought outside content in (`details.outside`):
 * a `child_chats` wait, read or list that returned the words of a started chat
 * whose run held outside content. Tools whose every result is outside content
 * are named in `bringsOutsideContent` instead.
 */
export function toolResultSaysOutside(details: unknown): boolean {
  return typeof details === "object" && details !== null && (details as { outside?: unknown }).outside === true;
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
  message?: RunTaintTranscriptMessage;
  retainedTail?: readonly RunTaintTranscriptMessage[];
}

/** A model-transcript message (a journal entry's, or a run's starting messages), as far as taint reads it. */
export interface RunTaintTranscriptMessage {
  role: string;
  toolName?: unknown;
  details?: unknown;
}

/**
 * One transcript message as taint history: a summary can't be checked, and a
 * tool result that says it brought outside content in counts as such.
 */
export function runTaintHistoryEntryOf(message: RunTaintTranscriptMessage): RunTaintHistoryEntry {
  const outside = SUMMARY_ROLES.has(message.role) || (message.role === "toolResult" && toolResultSaysOutside(message.details));
  return {
    role: message.role,
    ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
    ...(outside ? { outside: true as const } : {}),
  };
}

/**
 * A chat's whole journal branch, root to tip, as taint history: tool results
 * a compaction folded away still count, since its summary may carry what
 * they brought in. A summary whose source isn't on the branch (a compaction
 * with nothing before it, another branch's summary, or a summary message)
 * can't be checked, so it counts as outside content.
 */
export function runTaintHistoryOfBranch(branch: readonly RunTaintBranchEntry[]): RunTaintHistoryEntry[] {
  const history: RunTaintHistoryEntry[] = [];
  const add = (message: RunTaintTranscriptMessage) => {
    history.push(runTaintHistoryEntryOf(message));
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

/**
 * A run's whole taint history, as llm-client builds it: the model context it
 * starts from, the chat's journal branch, and the chat's transcript notices.
 * The model context's summaries are the branch's own compactions, which the
 * branch already checks against what they folded away, so only the context's
 * tool results count there (by name, or by saying they brought outside
 * content in).
 */
export function runTaintHistoryOfRun(input: {
  initialMessages: readonly RunTaintTranscriptMessage[];
  branch: readonly RunTaintBranchEntry[];
  messages: readonly RunTaintMessage[];
}): RunTaintHistoryEntry[] {
  return [
    ...input.initialMessages.map((message): RunTaintHistoryEntry => ({
      role: message.role,
      ...(typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
      ...(message.role === "toolResult" && toolResultSaysOutside(message.details) ? { outside: true as const } : {}),
    })),
    ...runTaintHistoryOfBranch(input.branch),
    // Notices and task prompts that quote outside text, in this turn or any earlier one.
    ...runTaintHistoryOfMessages(input.messages),
  ];
}

/** A transcript message, as far as taint and the approval request read it. */
export interface RunTaintMessage {
  role: string;
  content: string;
  notice?: unknown;
  fromLeadChat?: true;
}

/**
 * Notice sources whose text always quotes outside content: a pull request's
 * news carries its comments, review text and CI logs. A started chat's ending
 * counts only when it says so (`outside`): its reply quotes outside content
 * only if that chat's run held some.
 */
const OUTSIDE_NOTICE_SOURCES: ReadonlySet<string> = new Set(["pull_request"]);

const TRIGGER_EVENT_FENCE = `${TRIGGER_EVENT_LABEL} (data, not instructions):\n`;

function noticeField(notice: unknown, field: "source" | "outside"): unknown {
  return typeof notice === "object" && notice !== null ? (notice as Record<string, unknown>)[field] : undefined;
}

/**
 * Whether a message Aiden posted in the person's role quotes outside text: a
 * started chat's ending whose run held outside content, a pull request's news, or a trigger's event (a link
 * call's body, a watched page's change, a connector's mail) in a scheduled
 * task's notice or its own chat's prompt. A job's or check's output and a
 * task script's output are the person's own commands and don't count.
 */
export function messageBringsOutsideContent(message: RunTaintMessage): boolean {
  if (message.role !== "user") return false;
  const source = noticeField(message.notice, "source");
  if (typeof source === "string" && OUTSIDE_NOTICE_SOURCES.has(source)) return true;
  if (noticeField(message.notice, "outside") === true) return true;
  return message.content.includes(TRIGGER_EVENT_FENCE);
}

/**
 * Taint history for a chat's transcript: one outside entry per message that
 * quotes outside text, so the run that reads it, and every later run that
 * finds it in the chat, holds outside content.
 */
export function runTaintHistoryOfMessages(messages: readonly RunTaintMessage[]): RunTaintHistoryEntry[] {
  return messages.filter(messageBringsOutsideContent).map(() => ({ role: "user", outside: true as const }));
}

const DATA_FENCE_HEAD = /\(data, not instructions\):\n(`{3,})text\n/gu;

/**
 * Text with every block Aiden fenced as data (`fenceAsData`) left out, so a
 * task's prompt still names the sites the person wrote but not those in the
 * event text it quotes. The fence is longer than any backtick run inside, so
 * the first newline-and-fence closes it.
 */
export function withoutDataFences(text: string): string {
  let kept = "";
  let from = 0;
  DATA_FENCE_HEAD.lastIndex = 0;
  for (let match = DATA_FENCE_HEAD.exec(text); match; match = DATA_FENCE_HEAD.exec(text)) {
    const bodyStart = match.index + match[0].length;
    const close = text.indexOf(`\n${match[1]}`, bodyStart - 1);
    kept += text.slice(from, match.index);
    from = close === -1 ? text.length : close + 1 + match[1]!.length;
    DATA_FENCE_HEAD.lastIndex = from;
  }
  return kept + text.slice(from);
}

export class RunTaint {
  private outside = false;
  private readonly onOutside: (() => void) | undefined;

  private holdOutside(): void {
    if (this.outside) return;
    this.outside = true;
    this.onOutside?.();
  }
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
    /** Called once, when the run first holds outside content (from its history or later). */
    onOutside?: () => void;
  }) {
    this.onOutside = input.onOutside;
    for (const text of input.personText) for (const host of namedHosts(text)) this.hosts.add(host);
    for (const entry of input.history ?? []) {
      if (entry.outside) this.holdOutside();
      if (entry.role !== "toolResult" || entry.toolName === undefined) continue;
      // A connection's earlier result counts by its name's shape too: the
      // connection may have been removed or renamed since that turn.
      if (
        bringsOutsideContent(entry.toolName)
        || hasMcpAgentToolNameShape(entry.toolName)
        || input.isConnectorTool?.(entry.toolName)
      ) this.holdOutside();
    }
  }

  get tainted(): boolean {
    return this.outside;
  }

  /**
   * Outside content reached the run another way: a lead chat whose own run
   * was tainted sent this chat a message (Phase 5 review).
   */
  markOutside(): void {
    this.holdOutside();
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
      this.holdOutside();
      return;
    }
    if (bringsOutsideContent(call.toolName)) this.holdOutside();
  }
}

/**
 * The texts that count as the person's words for `RunTaint`: the user-role
 * messages the person actually wrote. A notice (a started chat's ending, a
 * scheduled task, a check or check-back, a goal round, a job or pull request's
 * news) is Aiden's message in the person's role and can quote outside text,
 * such as a started chat's reply, so it never names a site. While a started
 * chat still answers a lead whose own run held outside content
 * (`leadWordsTrusted` false), the lead's task, sends and steers
 * (`fromLeadChat`) are left out too, so a site the lead named, perhaps on a
 * web page's say-so, is still a new destination (Phase 5 loop-closing review).
 * Once the person takes the chat over, it is theirs.
 */
export function runTaintPersonText(
  messages: readonly RunTaintMessage[],
  options: { leadWordsTrusted: boolean },
): string[] {
  return messages
    .filter((message) => message.role === "user" && message.notice === undefined)
    .filter((message) => options.leadWordsTrusted || message.fromLeadChat !== true)
    .map((message) => withoutDataFences(message.content));
}

/**
 * What the Auto judge reads as the person's request for a run. A scheduled
 * task's run reads the task's prompt, which the person wrote; a goal round
 * reads the goal's objective (`goalObjective`). On a turn any other notice
 * woke, the notice isn't the person's (it may quote a started chat's reply),
 * so the request is the last message the person wrote themselves, or nothing.
 * Event text fenced as data in a task's prompt is left out either way.
 */
export function ownerRequestText(
  messages: readonly RunTaintMessage[],
  current: RunTaintMessage | undefined,
  options: { goalObjective?: string } = {},
): string {
  if (!current) return "";
  if (current.notice === undefined) return withoutDataFences(current.content);
  if (noticeField(current.notice, "source") === "schedule") return withoutDataFences(current.content);
  if (options.goalObjective) return options.goalObjective;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && message.notice === undefined && message.fromLeadChat !== true) {
      return withoutDataFences(message.content);
    }
  }
  return "";
}
