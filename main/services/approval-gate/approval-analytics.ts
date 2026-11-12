// What an approval card's analytics may say: its kind, the mode it was asked
// under, which chat asked, and how it was answered. Enums only; never the
// tool's arguments, the summary, a path or a command
// (docs/analytics.md, "approval_shown" and "approval_answered").

import type { AnalyticsEventProps } from "../analytics/analytics-events.js";
import { reportAnalyticsEvent } from "../analytics/analytics-report.js";
import type { ToolApprovalScope } from "../../../renderer/shared/tool-approval-scope.js";

export type ApprovalAnalyticsKind = AnalyticsEventProps<"approval_shown">["kind"];
export type ApprovalAnalyticsMode = AnalyticsEventProps<"approval_shown">["mode"];
export type ApprovalAnalyticsChat = AnalyticsEventProps<"approval_shown">["chat"];
export type ApprovalAnalyticsAnswer = AnalyticsEventProps<"approval_answered">["scope"];

const DETAIL_KINDS: Readonly<Record<string, ApprovalAnalyticsKind>> = {
  "scheduled-task": "schedule",
  "assistant-automation": "schedule",
  "subagent-workspace-write": "subagent",
  "subagent-mcp-mutation": "subagent",
  "subagent-shell": "subagent",
  "subagent-run-grant": "subagent",
  "form-fill-batch": "form_fill",
  "hook-proposal": "hook",
  "computer-use-access": "computer_use",
  "model-classification": "classifier",
};

const FILE_TOOLS: ReadonlySet<string> = new Set(["edit_file", "write_file", "delete_file", "move_file"]);
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["run_command", "background_job"]);

function detailsKind(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const kind = (details as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
}

/** The card's kind, from its tool and the specialized review it carries. */
export function approvalAnalyticsKind(prompt: { toolName: string; details?: unknown; preview?: { kind: string } }): ApprovalAnalyticsKind {
  const fromDetails = DETAIL_KINDS[detailsKind(prompt.details) ?? ""];
  if (fromDetails) return fromDetails;
  if (prompt.toolName === "classify") return "classifier";
  if (prompt.toolName === "computer_use") return "computer_use";
  if (prompt.toolName === "form_fill") return "form_fill";
  if (prompt.preview?.kind === "command" || COMMAND_TOOLS.has(prompt.toolName)) return "command";
  if (prompt.preview?.kind === "file" || FILE_TOOLS.has(prompt.toolName)) return "file";
  return "tool";
}

/** Which chat asked: a subagent's card carries its own details. */
export function approvalAnalyticsChat(surface: "workspace" | "bot", details: unknown): ApprovalAnalyticsChat {
  if (surface === "bot") return "bot";
  return detailsKind(details)?.startsWith("subagent-") ? "subagent" : "workspace";
}

/** A workspace's access as the mode its cards were asked under. */
export function approvalAnalyticsMode(permission: string | undefined): ApprovalAnalyticsMode {
  switch (permission) {
    case "full":
      return "full";
    case "read-only":
      return "read_only";
    case "none":
      return "none";
    default:
      return "ask";
  }
}

/** How far an answer reached. A Bot's remembered allow is its allow list. */
export function approvalAnalyticsAnswer(
  allowed: boolean,
  scope: ToolApprovalScope | undefined,
  surface: "workspace" | "bot",
): ApprovalAnalyticsAnswer {
  if (!allowed) return "deny";
  if (scope === "chat") return "chat";
  if (scope === "always") return surface === "bot" ? "bot" : "workspace";
  if (scope === "workspace") return "workspace";
  return "once";
}

export interface ApprovalAnalyticsSource {
  surface: "workspace" | "bot";
  /** The mode the stream's cards are asked under, read when a card is shown. */
  mode(streamId: string): ApprovalAnalyticsMode;
}

interface ShownApproval {
  kind: ApprovalAnalyticsKind;
  mode: ApprovalAnalyticsMode;
  chat: ApprovalAnalyticsChat;
}

/** One `approval_shown` per published card and at most one `approval_answered`, by the person. */
export class ApprovalAnalytics {
  private readonly shownCards = new Map<string, ShownApproval>();

  constructor(private readonly source: ApprovalAnalyticsSource) {}

  shown(prompt: { approvalId: string; streamId: string; toolName: string; details?: unknown; preview?: { kind: string } }): void {
    try {
      const card: ShownApproval = {
        kind: approvalAnalyticsKind(prompt),
        mode: this.source.mode(prompt.streamId),
        chat: approvalAnalyticsChat(this.source.surface, prompt.details),
      };
      this.shownCards.set(prompt.approvalId, card);
      reportAnalyticsEvent("approval_shown", card);
    } catch {
      // Analytics never breaks the card.
    }
  }

  answered(approvalId: string, allowed: boolean, scope: ToolApprovalScope | undefined): void {
    const card = this.shownCards.get(approvalId);
    if (!card) return;
    this.shownCards.delete(approvalId);
    reportAnalyticsEvent("approval_answered", { ...card, scope: approvalAnalyticsAnswer(allowed, scope, this.source.surface) });
  }

  /** The card left without the person's answer (cancelled, expired, the run ended). */
  forget(approvalId: string): void {
    this.shownCards.delete(approvalId);
  }
}
