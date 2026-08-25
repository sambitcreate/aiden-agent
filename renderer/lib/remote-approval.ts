import type { ApprovalPrompt, RemoteApprovalPrompt } from "./ipc.js";

export function mergeRemoteApproval(
  current: ApprovalPrompt[],
  remote: RemoteApprovalPrompt | null,
  now = Date.now(),
): ApprovalPrompt[] {
  const local = current.filter((approval) => approval.source !== "remote");
  if (!remote || new Date(remote.expiresAt).getTime() <= now) return local;
  return [...local, {
    approvalId: remote.approvalId,
    toolCallId: remote.toolCallId,
    toolName: remote.toolName,
    summary: remote.summary,
    canAllow: remote.canAllow,
    ...(remote.details ? { details: remote.details } : {}),
    source: "remote",
  }];
}

export function isLatestRemoteApprovalRefresh(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}
