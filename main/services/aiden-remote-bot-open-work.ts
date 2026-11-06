import type { BotOpenWorkMutation, BotOpenWorkResult, BotOpenWorkSnapshot } from "../../renderer/shared/bot-open-work.js";

/** Old clients have closed source/link unions and cannot receive peer records. */
export function projectRemoteBotOpenWork(snapshot: BotOpenWorkSnapshot, peers: boolean): BotOpenWorkSnapshot {
  if (peers) return snapshot;
  const items = snapshot.items.filter((item) => item.source.kind !== "peer")
    .map((item) => ({ ...item, links: item.links.filter((link) => link.kind !== "peer") }));
  const visible = new Set(items.map((item) => item.id));
  return { ...snapshot, items, undo: snapshot.undo.filter((undo) => visible.has(undo.itemId)) };
}

export function remoteBotOpenWorkMutationVisible(snapshot: BotOpenWorkSnapshot, mutation: BotOpenWorkMutation): boolean {
  if (mutation.action === "add") return true;
  const id = mutation.action === "undo" ? snapshot.undo.find((undo) => undo.mutationId === mutation.undoOf)?.itemId : mutation.id;
  return snapshot.items.some((item) => item.id === id && item.source.kind !== "peer");
}

export function projectRemoteBotOpenWorkResult(result: BotOpenWorkResult, peers: boolean): BotOpenWorkResult {
  if (peers || !result.snapshot) return result;
  const snapshot = projectRemoteBotOpenWork(result.snapshot, false);
  if (!result.ok) return { ...result, snapshot };
  const { itemId, undo, ...rest } = result;
  return { ...rest, snapshot,
    ...(itemId && snapshot.items.some((item) => item.id === itemId) ? { itemId } : {}),
    ...(undo && snapshot.undo.some((entry) => entry.mutationId === undo.mutationId) ? { undo } : {}),
  };
}
