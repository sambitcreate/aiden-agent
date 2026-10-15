/**
 * Answer an agent's `session/request_permission` with Aiden's policy.
 *
 * Local read-like operations are allowed in every mode (T3 Code
 * AcpClientPolicy.ts @ f870c419fc, MIT). Mutations and network fetches follow the generation's
 * workspace permission: Full allows, Ask shows Aiden's approval card, and
 * read-only or no-access refuses. A dismissed or failed approval is always a
 * refusal, never an implicit allow.
 */
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";

import { relativeDisplayPath } from "./activity.js";
import type { AcpPermissionClassification } from "./harness.js";
import type { AcpApprovalRequest, AcpTurnHost } from "./host.js";

/** Local reads only. Network fetches can carry data out, so they follow mutation policy. */
const READ_LIKE: ReadonlySet<ToolKind> = new Set<ToolKind>(["read", "search", "think"]);
const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

export function optionFor(
  options: readonly PermissionOption[],
  preferred: readonly PermissionOptionKind[],
): PermissionOption | undefined {
  for (const kind of preferred) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match;
  }
  return undefined;
}

function selected(option: PermissionOption | undefined): RequestPermissionResponse {
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : CANCELLED;
}

function allow(request: RequestPermissionRequest): RequestPermissionResponse {
  return selected(optionFor(request.options, ["allow_once", "allow_always"]));
}

function reject(request: RequestPermissionRequest): RequestPermissionResponse {
  return selected(optionFor(request.options, ["reject_once", "reject_always"]));
}

export function approvalKind(kind: ToolKind | null | undefined): AcpApprovalRequest["kind"] {
  switch (kind) {
    case "execute":
      return "command";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "read":
    case "search":
      return "file_read";
    case "fetch":
      return "fetch";
    default:
      return "other";
  }
}

function cleanTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  return Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 400);
}

export async function answerPermission(
  request: RequestPermissionRequest,
  classification: AcpPermissionClassification,
  host: AcpTurnHost,
  signal: AbortSignal,
  activityId?: string,
): Promise<RequestPermissionResponse> {
  if (signal.aborted) return CANCELLED;
  if (classification.kind === "question") {
    if (!host.askQuestion) return CANCELLED;
    try {
      const answer = await host.askQuestion(classification.question, signal);
      const option = request.options.find((candidate) => candidate.optionId === answer);
      return option ? selected(option) : CANCELLED;
    } catch {
      return CANCELLED;
    }
  }

  const kind = request.toolCall.kind ?? undefined;
  if (kind && READ_LIKE.has(kind)) return allow(request);
  const permission = host.permission();
  if (permission === "full") return allow(request);
  if (permission === "read-only" || permission === "none") return reject(request);

  const paths = (request.toolCall.locations ?? [])
    .map((location) => relativeDisplayPath(location.path, host.roots))
    .filter((value): value is string => !!value)
    .slice(0, 8);
  let outcome;
  try {
    outcome = await host.requestApproval(
      {
        toolCallId: String(request.toolCall.toolCallId),
        ...(activityId ? { activityId } : {}),
        kind: approvalKind(kind),
        ...(kind === "delete" || kind === "move" ? { fileChange: kind } : {}),
        title: cleanTitle(request.toolCall.title) || "The agent wants to make a change.",
        paths,
        ...(classification.warning ? { warning: classification.warning } : {}),
        offersAlways: request.options.some((option) => option.kind === "allow_always"),
      },
      signal,
    );
  } catch {
    return reject(request);
  }
  switch (outcome) {
    case "allow_once":
      return selected(optionFor(request.options, ["allow_once", "allow_always"]));
    case "allow_always":
      return selected(optionFor(request.options, ["allow_always", "allow_once"]));
    case "cancelled":
      return signal.aborted ? CANCELLED : reject(request);
    default:
      return reject(request);
  }
}
