// The gate's tool classes (docs/plans/bot-ux-simplification.md §3.2): fixed
// sets in code, never settings.
//
//   Exempt         a Bot's own things: never asks
//   Mac            shell, file changes, Computer Use: first use asks in every mode
//   Consequential  changes or sends something: judged in Auto, asked in Ask
//   Explicit-only  asks once in every mode, never judged, never remembered
//   Held           never applied by the agent (hook proposals, access or rule
//                  changes go through their own Apply / Dismiss)
//
// Connector and MCP tools are classed by Rakazo's name heuristic, below.

import type { MacGrantClass } from "../../../renderer/shared/approval-mode.js";

/** The person's Mac, by the part a tool reaches. */
export const MAC_TOOL_CLASSES: ReadonlyMap<string, MacGrantClass> = new Map([
  ["run_command", "shell"],
  ["write_file", "files"],
  ["edit_file", "files"],
  ["computer_use", "computer-use"],
  ["form_fill", "computer-use"],
]);

/**
 * Disclosure tools (deviation e): sending the person's data to another
 * service asks in every mode, Never ask included.
 */
export const DISCLOSURE_TOOL_NAMES: ReadonlySet<string> = new Set(["share_image", "generate_image", "classify"]);

/**
 * A Bot's own things (§3.2 Exempt): its memory, its notes, its wake-ups, its
 * subagents and its Bot computer (the Lume VM, not the person's Mac).
 * Schedule changes stay explicit-only (deviation b), which the gate checks
 * first.
 */
export const BOT_EXEMPT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bot_memory",
  "routine_notes",
  "wake_up",
  "subagent",
  "computer",
  "computer_shell",
]);

/**
 * Tools whose results bring outside content into the run (§3.2 Taint), besides
 * every connector (MCP) tool: the web, a device's screen, a subagent's report
 * (it may have read anything), a pull request's comments, and codemode (it
 * calls connectors). Shell output and the person's workspace files are their
 * own project and do not taint; a command that fetches runs only on the
 * person's shell grant.
 */
const TAINT_SOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_fetch",
  "web_search",
  "web_search_exa",
  "device_screenshot",
  "subagent",
  "follow_pull_request",
  "codemode",
]);

/** Browser tools that only change the window, never read the page. */
const BROWSER_WINDOW_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["browser_resize", "browser_set_appearance"]);

/** Whether a tool's result brings outside content into the run. Every browser tool reads or acts on a page. */
export function bringsOutsideContent(toolName: string): boolean {
  if (TAINT_SOURCE_TOOL_NAMES.has(toolName)) return true;
  return toolName.startsWith("browser_") && !BROWSER_WINDOW_ONLY_TOOL_NAMES.has(toolName);
}

/** Tools that fetch a URL the model chose: a destination once the run is tainted. */
export const FETCH_TOOL_NAMES: ReadonlySet<string> = new Set(["web_fetch", "browser_open", "browser_navigate"]);

/** Verbs that change or send something wherever they appear in a name. */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  "send", "create", "delete", "pay", "remove", "update", "publish", "write", "edit", "modify", "set", "add",
  "put", "patch", "upload", "share", "invite", "move", "archive", "cancel", "buy", "purchase", "transfer",
  "submit", "reply", "forward", "approve", "reject", "merge", "execute", "insert", "replace", "rename", "trash",
  "destroy", "revoke", "grant", "charge", "refund", "subscribe", "unsubscribe", "deploy", "restart", "kill",
  "commit", "push", "assign", "accept", "decline", "withdraw", "deposit", "sell", "upsert", "erase", "purge",
]);

/** Words that are verbs at the front of a name but often nouns elsewhere ("get_order"). */
const LEADING_WRITE_VERBS: ReadonlySet<string> = new Set([
  "post", "order", "label", "star", "like", "comment", "draft", "block", "unblock", "message", "text", "email",
  "call", "dial", "link", "unlink", "schedule", "run", "start", "stop", "mark", "book", "save", "sync", "import",
  "apply", "close", "complete", "resolve", "reopen", "pin", "unpin", "mute", "notify", "tweet", "trade", "clear",
  "reset", "enable", "disable", "toggle", "connect", "disconnect", "follow", "unfollow", "react", "drop", "play",
  "record", "fill", "click", "type", "press", "open", "launch", "install", "uninstall", "restore", "duplicate",
  "copy", "convert", "generate", "make", "do", "perform", "trigger", "invoke", "process", "handle", "request",
]);

/** Verbs that only read: Rakazo's list, deliberately short. */
const READ_VERBS: ReadonlySet<string> = new Set(["get", "list", "search", "find", "read"]);

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

export type ConnectorToolEffect = "read" | "write";

/**
 * Rakazo's name heuristic for a connector or MCP tool: verbs such as send,
 * create, delete and pay are writes; get, list, search, find and read are
 * reads; anything else is a write.
 *
 * - A write verb anywhere in the name makes it a write (`get_and_delete`).
 * - A name that starts with a verb-or-noun word such as "post" or "order" is a
 *   write; elsewhere that word is a noun ("get_order" reads).
 * - A tool declared `readOnly: false` is always a write, and a declared read
 *   never relaxes the name: `readOnlyHint: true` on `send_message` is still a
 *   write.
 */
export function connectorToolEffect(name: string, declared?: { readOnlyHint?: unknown }): ConnectorToolEffect {
  if (declared?.readOnlyHint === false) return "write";
  const words = nameWords(name);
  if (words.some((word) => WRITE_VERBS.has(word))) return "write";
  if (words.length > 0 && LEADING_WRITE_VERBS.has(words[0]!)) return "write";
  if (words.some((word) => READ_VERBS.has(word))) return "read";
  return "write";
}

/** The declared MCP annotations of a tools/list entry, read without trusting its shape. */
export function declaredReadOnlyHint(annotations: unknown): { readOnlyHint?: boolean } {
  if (annotations === null || typeof annotations !== "object" || Array.isArray(annotations)) return {};
  const descriptor = Object.getOwnPropertyDescriptor(annotations, "readOnlyHint");
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "boolean"
    ? { readOnlyHint: descriptor.value }
    : {};
}
