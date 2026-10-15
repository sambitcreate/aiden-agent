// Quick View card order and which cards the user opened (all start closed). Device-local, per user, not per workspace.
export type QuickViewSectionId = "environment" | "changes" | "context" | "subagents";

export interface QuickViewLayout {
  order: QuickViewSectionId[];
  expanded: Partial<Record<QuickViewSectionId, true>>;
}

const SECTION_IDS: readonly QuickViewSectionId[] = ["environment", "changes", "context", "subagents"];
export const QUICK_VIEW_LAYOUT_STORAGE_KEY = "aiden-agent.quick-view.layout";
export const DEFAULT_QUICK_VIEW_LAYOUT: QuickViewLayout = { order: [...SECTION_IDS], expanded: {} };

const isSectionId = (value: unknown): value is QuickViewSectionId =>
  typeof value === "string" && (SECTION_IDS as readonly string[]).includes(value);

export function parseQuickViewLayout(raw: string | null): QuickViewLayout {
  if (!raw) return DEFAULT_QUICK_VIEW_LAYOUT;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_QUICK_VIEW_LAYOUT;
  }
  if (!value || typeof value !== "object") return DEFAULT_QUICK_VIEW_LAYOUT;
  const record = value as { order?: unknown; expanded?: unknown };
  const order: QuickViewSectionId[] = [];
  for (const id of Array.isArray(record.order) ? record.order : []) {
    if (isSectionId(id) && !order.includes(id)) order.push(id);
  }
  for (const id of SECTION_IDS) if (!order.includes(id)) order.push(id);
  const expanded: QuickViewLayout["expanded"] = {};
  if (record.expanded && typeof record.expanded === "object") {
    for (const [id, flag] of Object.entries(record.expanded)) {
      if (isSectionId(id) && flag === true) expanded[id] = true;
    }
  }
  return { order, expanded };
}

export function serializeQuickViewLayout(layout: QuickViewLayout): string {
  return JSON.stringify(layout);
}

/**
 * Moves `id` to `toVisibleIndex` among `visible`. Each hidden section stays directly after the
 * visible section it followed in the saved order (or at the front if none preceded it).
 */
export function moveSection(
  layout: QuickViewLayout,
  id: QuickViewSectionId,
  toVisibleIndex: number,
  visible: readonly QuickViewSectionId[],
): QuickViewLayout {
  const isVisibleSlot = (entry: QuickViewSectionId) => entry === id || visible.includes(entry);
  const leading: QuickViewSectionId[] = [];
  const followers = new Map<QuickViewSectionId, QuickViewSectionId[]>();
  let anchor: QuickViewSectionId | null = null;
  for (const entry of layout.order) {
    if (isVisibleSlot(entry)) {
      anchor = entry;
      followers.set(entry, []);
    } else if (anchor) {
      followers.get(anchor)!.push(entry);
    } else {
      leading.push(entry);
    }
  }
  const shown = layout.order.filter((entry) => isVisibleSlot(entry) && entry !== id);
  const index = Math.max(0, Math.min(shown.length, toVisibleIndex));
  shown.splice(index, 0, id);
  const order = [...leading, ...shown.flatMap((entry) => [entry, ...(followers.get(entry) ?? [])])];
  return { ...layout, order };
}

export function toggleSectionExpanded(layout: QuickViewLayout, id: QuickViewSectionId): QuickViewLayout {
  const expanded = { ...layout.expanded };
  if (expanded[id]) delete expanded[id];
  else expanded[id] = true;
  return { ...layout, expanded };
}

/**
 * Index the dragged card lands on. The leading edge decides: moving up, the card's top
 * must pass a neighbour's midpoint; moving down, its bottom. Midpoint-to-midpoint never
 * lets a tall card pass a short one.
 */
export function dragTargetIndex(
  rects: readonly { top: number; height: number }[],
  from: number,
  dy: number,
): number {
  const top = rects[from].top + dy;
  const bottom = top + rects[from].height;
  for (let index = 0; index < from; index += 1) {
    if (top < rects[index].top + rects[index].height / 2) return index;
  }
  let target = from;
  for (let index = from + 1; index < rects.length; index += 1) {
    if (bottom > rects[index].top + rects[index].height / 2) target = index;
  }
  return target;
}

export interface QuickViewVisibilityInput {
  /** The Changes rule holds: a Git repo with working changes, commits ahead, or this chat's PR. */
  changesVisible: boolean;
  /** A commit or push dialog is open, or the Git operation it started is still running. */
  changesHeld: boolean;
  /** Changes was on screen in the last committed render. */
  changesWasShown: boolean;
  /** The chat has a context projection (after its first message). */
  hasContextPressure: boolean;
  subagentsEnabled: boolean;
  /** Runs this chat has started, finished ones included. */
  subagentRunCount: number;
}

/**
 * The Quick View cards to show, in saved order. Environment always shows; Changes, Context
 * and Subagents only once they have something to say. A Changes card that owns an open
 * dialog or a running Git operation stays until that finishes, even if its rule lapses.
 */
export function quickViewVisibleSections(
  order: readonly QuickViewSectionId[],
  input: QuickViewVisibilityInput,
): QuickViewSectionId[] {
  const shown: Record<QuickViewSectionId, boolean> = {
    environment: true,
    changes: input.changesVisible || (input.changesHeld && input.changesWasShown),
    context: input.hasContextPressure,
    subagents: input.subagentsEnabled && input.subagentRunCount > 0,
  };
  return order.filter((id) => shown[id]);
}
