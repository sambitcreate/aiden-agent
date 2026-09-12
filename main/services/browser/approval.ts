import { createHash } from "node:crypto";
import { BROWSER_MUTATION_TOOL_NAMES, browserToolApprovalSummary } from "../browser-tools.js";

/** Main-only page identity. Never accept these revisions from renderer/model input. */
export interface BrowserApprovalTarget {
  workspaceId: string;
  tabId: string;
  url: string;
  /** Changes on navigation start and commit, including a same-URL reload. */
  documentRevision: string;
  /** Changes when a person takes control or the tab is closed. */
  controlRevision: number;
}

export interface BrowserToolApproval {
  readonly toolName: string;
  readonly target: Readonly<BrowserApprovalTarget>;
  readonly argumentsFingerprint: string;
  readonly summary: string;
}

export class BrowserApprovalExpiredError extends Error {
  readonly code = "BROWSER_APPROVAL_EXPIRED";

  constructor(reason = "stale target") {
    super(`The browser page or action changed while approval was pending (${reason}). Inspect the current page and ask again.`);
    this.name = "BrowserApprovalExpiredError";
  }
}

function validTarget(target: BrowserApprovalTarget): boolean {
  return Boolean(target && [target.workspaceId, target.tabId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 200)
    && typeof target.url === "string" && target.url.length <= 8192
    && typeof target.documentRevision === "string" && target.documentRevision.length > 0 && target.documentRevision.length <= 200
    && Number.isSafeInteger(target.controlRevision) && target.controlRevision >= 0);
}

function fingerprint(args: Record<string, unknown>, tabId: string): string {
  if (!args || typeof args !== "object" || Array.isArray(args)
    || (args.tabId !== undefined && args.tabId !== tabId)) throw new BrowserApprovalExpiredError();
  // The exact resolved tab is part of approval even when the model omitted tabId.
  // Sort object keys because serialization order is not an argument change.
  const encoded = JSON.stringify({ ...args, tabId }, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
    }
    return value;
  });
  return createHash("sha256").update(encoded).digest("hex");
}

/** Capture before showing approval, and pin its tabId into the execution arguments. */
export function prepareBrowserToolApproval(
  toolName: string,
  args: Record<string, unknown>,
  target: BrowserApprovalTarget,
): BrowserToolApproval {
  if (!BROWSER_MUTATION_TOOL_NAMES.has(toolName) || !validTarget(target)) throw new BrowserApprovalExpiredError();
  return Object.freeze({
    toolName,
    target: Object.freeze({ ...target }),
    argumentsFingerprint: fingerprint(args, target.tabId),
    summary: `${browserToolApprovalSummary(toolName)}\n${target.url}`,
  });
}

/** Read current identity from main immediately before dispatch, after approval settles. */
export function assertBrowserToolApproval(
  approval: BrowserToolApproval,
  toolName: string,
  args: Record<string, unknown>,
  current: BrowserApprovalTarget,
): void {
  const expected = approval.target;
  const reason = !validTarget(current) ? "invalid target"
    : approval.toolName !== toolName ? "tool changed"
    : current.workspaceId !== expected.workspaceId || current.tabId !== expected.tabId ? "tab changed"
    : current.url !== expected.url || current.documentRevision !== expected.documentRevision ? "page navigated"
    : current.controlRevision !== expected.controlRevision ? "user took control"
    : fingerprint(args, expected.tabId) !== approval.argumentsFingerprint ? "arguments changed" : undefined;
  if (reason) throw new BrowserApprovalExpiredError(reason);
}
