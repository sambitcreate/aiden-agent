import type { ChatUiVisualV1 } from "../shared/aiden-ui/types";
import type { ChatArtifactEventV1 } from "../shared/chat-artifacts";
import { isToolStep } from "../shared/generation-timeline";
import type { AssistantPresentationRow } from "./assistant-message-presentation";
import type { ChatMessage } from "./types";

/**
 * Placement and live state for native (render_ui) visuals, mirroring the
 * HTML visuals: each sits after the activity row of its producing call,
 * drafts stand in until the visual is presented, and the live copy owns the
 * streaming row until the saved message takes over.
 */

export type UiDrafts = ReadonlyMap<string, ChatUiVisualV1>;

export interface UiVisualSlots {
  byRowKey: Map<string, ChatUiVisualV1[]>;
  trailing: ChatUiVisualV1[];
  draftsByRowKey: Map<string, ChatUiVisualV1[]>;
}

export function uiVisualSlots(
  rows: readonly AssistantPresentationRow[] | null,
  visuals: readonly ChatUiVisualV1[],
  drafts: UiDrafts,
): UiVisualSlots {
  const rowKeyByCall = new Map<string, string>();
  for (const row of rows ?? []) {
    if (row.kind !== "activity") continue;
    for (const step of row.steps) if (isToolStep(step)) rowKeyByCall.set(step.toolCallId, row.key);
  }
  const presentedCalls = new Set(visuals.flatMap((visual) => (visual.toolCallId ? [visual.toolCallId] : [])));
  const byRowKey = new Map<string, ChatUiVisualV1[]>();
  const trailing: ChatUiVisualV1[] = [];
  for (const visual of visuals) {
    const rowKey = visual.toolCallId ? rowKeyByCall.get(visual.toolCallId) : undefined;
    if (!rowKey) {
      trailing.push(visual);
      continue;
    }
    byRowKey.set(rowKey, [...(byRowKey.get(rowKey) ?? []), visual]);
  }
  const draftsByRowKey = new Map<string, ChatUiVisualV1[]>();
  for (const [toolCallId, draft] of drafts) {
    const rowKey = rowKeyByCall.get(toolCallId);
    if (!rowKey || presentedCalls.has(toolCallId)) continue;
    draftsByRowKey.set(rowKey, [...(draftsByRowKey.get(rowKey) ?? []), draft]);
  }
  return { byRowKey, trailing, draftsByRowKey };
}

export function reduceUiVisuals(
  visuals: readonly ChatUiVisualV1[],
  event: ChatArtifactEventV1,
): readonly ChatUiVisualV1[] {
  if (event.operation === "reset") return visuals.length ? [] : visuals;
  if (event.operation !== "ui") return visuals;
  const index = visuals.findIndex((visual) => visual.id === event.visual.id);
  if (index < 0) return [...visuals, event.visual];
  return visuals.map((visual, position) => (position === index ? event.visual : visual));
}

export function reduceUiDrafts(drafts: UiDrafts, event: ChatArtifactEventV1): UiDrafts {
  switch (event.operation) {
    case "reset":
      return drafts.size ? new Map() : drafts;
    case "ui_draft":
      return new Map(drafts).set(event.toolCallId, event.visual);
    case "ui":
    case "draft_end": {
      const toolCallId = event.operation === "ui" ? event.visual.toolCallId : event.toolCallId;
      if (!toolCallId || !drafts.has(toolCallId)) return drafts;
      const next = new Map(drafts);
      next.delete(toolCallId);
      return next;
    }
    default:
      return drafts;
  }
}

/** Saved visuals per message, minus any still shown live in the streaming row. */
export function uiVisualsByMessage(
  messages: readonly ChatMessage[],
  liveIds: ReadonlySet<string>,
  streamingRowVisible: boolean,
): Map<string, ChatUiVisualV1[]> {
  const result = new Map<string, ChatUiVisualV1[]>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.uiVisuals?.length) continue;
    const visible = streamingRowVisible
      ? message.uiVisuals.filter((visual) => !liveIds.has(visual.id))
      : message.uiVisuals;
    if (visible.length) result.set(message.id, visible);
  }
  return result;
}

function sameVisuals(a: readonly ChatUiVisualV1[], b: readonly ChatUiVisualV1[]): boolean {
  return a.length === b.length && a.every((visual, index) => visual === b[index]);
}

/** Keep list identity when nothing changed, so memoized settled rows skip re-rendering. */
export function reuseUnchangedUiLists(
  previous: ReadonlyMap<string, ChatUiVisualV1[]> | undefined,
  next: ReadonlyMap<string, ChatUiVisualV1[]>,
): Map<string, ChatUiVisualV1[]> {
  const result = new Map<string, ChatUiVisualV1[]>();
  for (const [key, visuals] of next) {
    const prior = previous?.get(key);
    result.set(key, prior && sameVisuals(prior, visuals) ? prior : visuals);
  }
  return result;
}
