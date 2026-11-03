// Electron-free logic behind the Images home: the All Images library's search, filters,
// sort and day sections, Save All's cap, its grid's arrow keys, and each workflow card's
// newest image.
import { SAVE_ALL_MAX_IMAGES, type GalleryItem } from "../shared/images/ipc-types";
import type { ImageModelOption } from "../shared/images/port";
import { modelNames } from "./viewer/viewer-core";

export type LibrarySort = "newest" | "oldest";

export interface LibraryFilters {
  query: string;
  /** A workflow facet key (see `workflowFacetKey`), or null for every workflow. */
  workflow: string | null;
  /** A model facet key (see `modelFacetKey`), or null for every model. */
  model: string | null;
  sort: LibrarySort;
}

export const EMPTY_LIBRARY_FILTERS: LibraryFilters = { query: "", workflow: null, model: null, sort: "newest" };

/** Images of workflows that no longer exist share one facet. Workflow ids are UUIDs, so this never collides. */
export const DELETED_WORKFLOWS_FACET = ":deleted";

export function workflowFacetKey(item: Pick<GalleryItem, "workflowId" | "workflowTitle">): string {
  return item.workflowTitle === undefined ? DELETED_WORKFLOWS_FACET : item.workflowId;
}

export function modelFacetKey(item: Pick<GalleryItem, "provider" | "model">): string {
  return `${item.provider}::${item.model}`;
}

function queryTerms(query: string): string[] {
  return query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
}

/** What a search looks through: the prompt, the model (id and display name), and the workflow and node titles. */
function searchText(item: GalleryItem, models: readonly ImageModelOption[]): string {
  const label = modelNames(item, models).model;
  // Joined by newlines, so a term never matches across two fields.
  return [item.prompt, item.model, label, item.workflowTitle, item.nodeTitle]
    .filter((part): part is string => Boolean(part))
    .join("\n")
    .toLocaleLowerCase();
}

type Facet = "query" | "workflow" | "model";

function matcher(filters: LibraryFilters, models: readonly ImageModelOption[], skip?: Facet) {
  const terms = skip === "query" ? [] : queryTerms(filters.query);
  return (item: GalleryItem) => {
    if (skip !== "workflow" && filters.workflow !== null && workflowFacetKey(item) !== filters.workflow) return false;
    if (skip !== "model" && filters.model !== null && modelFacetKey(item) !== filters.model) return false;
    if (terms.length === 0) return true;
    const text = searchText(item, models);
    return terms.every((term) => text.includes(term));
  };
}

/**
 * The images the library shows: every search term (case-insensitive, in any order) found in
 * the item's prompt, model, workflow title or node title, within the chosen workflow and
 * model, newest or oldest first. Images that finished at the same moment keep the gallery's order.
 */
export function filterLibrary(
  items: readonly GalleryItem[],
  filters: LibraryFilters,
  models: readonly ImageModelOption[] = [],
): GalleryItem[] {
  const matched = items
    .map((item, order) => ({ item, order }))
    .filter(({ item }) => matcher(filters, models)(item));
  const direction = filters.sort === "oldest" ? 1 : -1;
  matched.sort((a, b) => (a.item.createdAt - b.item.createdAt) * direction || a.order - b.order);
  return matched.map(({ item }) => item);
}

export interface FacetOption {
  key: string;
  label: string;
  count: number;
}

const byCountThenLabel = (a: FacetOption, b: FacetOption) => b.count - a.count || a.label.localeCompare(b.label);

/**
 * The workflow and model choices with how many images each would show. Each facet counts
 * within the search and the other facet, so picking a workflow narrows the model counts and
 * the reverse. `total` is what "All" would show for each.
 */
export function libraryFacets(
  items: readonly GalleryItem[],
  filters: LibraryFilters,
  models: readonly ImageModelOption[] = [],
): { workflows: FacetOption[]; models: FacetOption[]; workflowTotal: number; modelTotal: number } {
  const tally = (skip: "workflow" | "model", keyOf: (item: GalleryItem) => string, labelOf: (item: GalleryItem) => string) => {
    const matches = matcher(filters, models, skip);
    const options = new Map<string, FacetOption>();
    let total = 0;
    for (const item of items) {
      if (!matches(item)) continue;
      total += 1;
      const key = keyOf(item);
      const option = options.get(key);
      if (option) option.count += 1;
      else options.set(key, { key, label: labelOf(item), count: 1 });
    }
    return { options: [...options.values()].sort(byCountThenLabel), total };
  };
  const workflows = tally("workflow", workflowFacetKey, (item) => item.workflowTitle ?? "Deleted workflows");
  const modelOptions = tally("model", modelFacetKey, (item) => modelNames(item, models).model ?? "Unknown model");
  return { workflows: workflows.options, models: modelOptions.options, workflowTotal: workflows.total, modelTotal: modelOptions.total };
}

export interface LibraryDaySection {
  key: string;
  label: string;
  /** The day's images, each with its position in the filtered list (the viewer's index). */
  entries: { item: GalleryItem; index: number }[];
}

const localDayKey = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/** Sections a sorted list by local calendar day: "Today", "Yesterday", then the date. */
export function sectionByDay(
  items: readonly GalleryItem[],
  now: number,
  formatDate: (timestamp: number) => string,
): LibraryDaySection[] {
  const today = localDayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = localDayKey(yesterdayDate.getTime());
  const sections: LibraryDaySection[] = [];
  items.forEach((item, index) => {
    const key = localDayKey(item.createdAt);
    let section = sections[sections.length - 1];
    if (!section || section.key !== key) {
      const label = key === today ? "Today" : key === yesterday ? "Yesterday" : formatDate(item.createdAt);
      section = { key, label, entries: [] };
      sections.push(section);
    }
    section.entries.push({ item, index });
  });
  return sections;
}

/** What Save All sends for a set: at most `SAVE_ALL_MAX_IMAGES`, in the order shown. */
export function saveAllSelection(items: readonly GalleryItem[]): { assetIds: string[]; total: number; capped: boolean } {
  return {
    assetIds: items.slice(0, SAVE_ALL_MAX_IMAGES).map((item) => item.assetId),
    total: items.length,
    capped: items.length > SAVE_ALL_MAX_IMAGES,
  };
}

/** The accessible name of a library tile: its place, its workflow and the start of its prompt. */
export function tileLabel(item: GalleryItem, index: number, count: number): string {
  const prompt = item.prompt?.trim().replace(/\s+/gu, " ");
  const shortPrompt = prompt && prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt;
  const workflow = item.workflowTitle ?? "Deleted workflow";
  return `Image ${index + 1} of ${count}, ${workflow}${shortPrompt ? `: ${shortPrompt}` : ""}`;
}

export interface TileRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type GridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

/**
 * The tile an arrow key moves to in a grid laid out in reading order across day sections.
 * ← and → step through the list; ↑ and ↓ go to the nearest row above or below (crossing
 * into the next section) and the tile there closest in column. Stops at the edges.
 */
export function gridMove(rects: readonly TileRect[], from: number, key: GridKey): number {
  const count = rects.length;
  if (count === 0) return -1;
  const current = Math.min(Math.max(from, 0), count - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowLeft") return Math.max(0, current - 1);
  if (key === "ArrowRight") return Math.min(count - 1, current + 1);
  const origin = rects[current]!;
  const centreX = origin.left + origin.width / 2;
  const centreY = origin.top + origin.height / 2;
  const down = key === "ArrowDown";
  // The nearest row in that direction: the closest tile top past this tile's centre.
  let rowTop: number | null = null;
  for (const rect of rects) {
    const ahead = down ? rect.top > centreY : rect.top + rect.height < centreY;
    if (!ahead) continue;
    if (rowTop === null || (down ? rect.top < rowTop : rect.top > rowTop)) rowTop = rect.top;
  }
  if (rowTop === null) return current;
  let best = current;
  let bestDistance = Number.POSITIVE_INFINITY;
  rects.forEach((rect, index) => {
    if (Math.abs(rect.top - rowTop!) > 1) return;
    const distance = Math.abs(rect.left + rect.width / 2 - centreX);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

export interface WorkflowImageSummary {
  latest: GalleryItem;
  count: number;
}

/** Each workflow's newest image and how many images the gallery lists for it. */
export function summarizeWorkflowImages(items: readonly GalleryItem[]): Map<string, WorkflowImageSummary> {
  const summaries = new Map<string, WorkflowImageSummary>();
  for (const item of items) {
    const summary = summaries.get(item.workflowId);
    if (!summary) summaries.set(item.workflowId, { latest: item, count: 1 });
    else {
      summary.count += 1;
      if (item.createdAt > summary.latest.createdAt) summary.latest = item;
    }
  }
  return summaries;
}

/** Whether the library's Open Workflow can go to an image's workflow. */
export function workflowAvailable(item: GalleryItem, liveWorkflowIds: ReadonlySet<string> | null): boolean {
  if (item.workflowTitle === undefined) return false;
  return liveWorkflowIds === null || liveWorkflowIds.has(item.workflowId);
}
