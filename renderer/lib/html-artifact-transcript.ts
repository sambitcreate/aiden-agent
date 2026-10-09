import type { ChatMessage } from "./types";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import { isToolStep } from "../shared/generation-timeline";
import type { AssistantPresentationRow } from "./assistant-message-presentation";

export interface HtmlArtifactSlots {
  byRowKey: Map<string, ChatHtmlArtifactV1[]>;
  trailing: ChatHtmlArtifactV1[];
}

function sameArtifacts(a: readonly ChatHtmlArtifactV1[], b: readonly ChatHtmlArtifactV1[]): boolean {
  return a.length === b.length && a.every((item, index) => item.mediaId === b[index]?.mediaId && item.id === b[index]?.id);
}

/**
 * Keep each anchor's array identity while its artifacts are unchanged, so a
 * plan recomputed on every streaming frame does not defeat SettledMessageRow's
 * memo for rows that own visuals.
 */
export function reuseUnchangedArtifactLists(
  previous: ReadonlyMap<string, ChatHtmlArtifactV1[]> | undefined,
  next: ReadonlyMap<string, ChatHtmlArtifactV1[]>,
): Map<string, ChatHtmlArtifactV1[]> {
  const result = new Map<string, ChatHtmlArtifactV1[]>();
  for (const [anchor, artifacts] of next) {
    const prior = previous?.get(anchor);
    result.set(anchor, prior && sameArtifacts(prior, artifacts) ? prior : artifacts);
  }
  return result;
}

/** Put each artifact right after the activity row holding its producing tool call. */
export function htmlArtifactSlots(
  rows: readonly AssistantPresentationRow[] | null,
  artifacts: readonly ChatHtmlArtifactV1[],
  placements: ReadonlyMap<string, string>,
): HtmlArtifactSlots {
  const rowKeyByCall = new Map<string, string>();
  for (const row of rows ?? []) {
    if (row.kind !== "activity") continue;
    for (const step of row.steps) if (isToolStep(step)) rowKeyByCall.set(step.toolCallId, row.key);
  }
  const byRowKey = new Map<string, ChatHtmlArtifactV1[]>();
  const trailing: ChatHtmlArtifactV1[] = [];
  for (const artifact of artifacts) {
    const call = placements.get(artifact.mediaId);
    const rowKey = call ? rowKeyByCall.get(call) : undefined;
    if (!rowKey) {
      trailing.push(artifact);
      continue;
    }
    const list = byRowKey.get(rowKey);
    if (list) list.push(artifact);
    else byRowKey.set(rowKey, [artifact]);
  }
  return { byRowKey, trailing };
}

export interface HtmlArtifactTranscriptEntry {
  key: string;
  anchor: string;
  artifact: ChatHtmlArtifactV1;
  source: "persisted" | "live";
}

/** Keep artifact keys in one transcript sibling list across stream handoff. */
export function htmlArtifactTranscriptPlan(
  messages: readonly ChatMessage[],
  liveArtifacts: readonly ChatHtmlArtifactV1[],
  streamingRowVisible: boolean,
): HtmlArtifactTranscriptEntry[] {
  const liveMediaIds = new Set(liveArtifacts.map((artifact) => artifact.mediaId));
  const entries: HtmlArtifactTranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const artifact of message.htmlArtifacts ?? []) {
      if (streamingRowVisible && liveMediaIds.has(artifact.mediaId)) continue;
      entries.push({
        key: `html:${artifact.mediaId}`,
        anchor: `message:${message.id}`,
        artifact,
        source: "persisted",
      });
    }
  }
  if (streamingRowVisible) {
    for (const artifact of liveArtifacts) {
      entries.push({
        key: `html:${artifact.mediaId}`,
        anchor: "streaming",
        artifact,
        source: "live",
      });
    }
  }
  return entries;
}
