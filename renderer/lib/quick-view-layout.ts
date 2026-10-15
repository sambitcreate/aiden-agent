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

/** Moves `id` to `toVisibleIndex` among `visible`; hidden sections follow, keeping their relative order. */
export function moveSection(
  layout: QuickViewLayout,
  id: QuickViewSectionId,
  toVisibleIndex: number,
  visible: readonly QuickViewSectionId[],
): QuickViewLayout {
  const shown = layout.order.filter((entry) => visible.includes(entry) && entry !== id);
  const index = Math.max(0, Math.min(shown.length, toVisibleIndex));
  shown.splice(index, 0, id);
  const hidden = layout.order.filter((entry) => !shown.includes(entry));
  return { ...layout, order: [...shown, ...hidden] };
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
