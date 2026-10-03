import type { ChatRowState } from "../shared/chat-row-state";

/**
 * Pure sidebar ordering and grouping. Inputs are plain project/chat summaries
 * so local workspaces today, and remote host rows later, share one projection.
 * Nothing here reads React state, storage, or the clock implicitly.
 */

/** Host id used to qualify this machine's own workspaces in project keys. */
export const LOCAL_SIDEBAR_HOST_ID = "local";

export const SIDEBAR_VIEWS = ["projects", "recent", "attention"] as const;
export type SidebarView = (typeof SIDEBAR_VIEWS)[number];

export const SIDEBAR_CHAT_SORTS = ["last_activity", "created"] as const;
export type SidebarChatSort = (typeof SIDEBAR_CHAT_SORTS)[number];

export const SIDEBAR_PROJECT_SORTS = ["last_activity", "created", "manual"] as const;
export type SidebarProjectSort = (typeof SIDEBAR_PROJECT_SORTS)[number];

/** Triage tier used by the Needs attention view, most urgent first. */
export const SIDEBAR_ATTENTION_TIERS = [
  "needs_approval",
  "needs_input",
  "working",
  "unread",
  "none",
] as const;
export type SidebarAttention = (typeof SIDEBAR_ATTENTION_TIERS)[number];

export const SIDEBAR_ATTENTION_LABELS: Readonly<Record<SidebarAttention, string>> = {
  needs_approval: "Needs approval",
  needs_input: "Needs input",
  working: "Working",
  unread: "Unread",
  none: "Other chats",
};

/** A live row state outranks unread output: a chat still working is not "done". */
export function sidebarAttention(rowState: ChatRowState, unread: boolean): SidebarAttention {
  if (rowState !== "idle") return rowState;
  return unread ? "unread" : "none";
}

/**
 * Host-qualified project key used for manual order. Both parts are URI-encoded
 * so the single `:` separator stays unambiguous for any host or project id.
 */
export function projectOrderKey(hostId: string, projectId: string): string {
  return `${encodeURIComponent(hostId)}:${encodeURIComponent(projectId)}`;
}

export function parseProjectOrderKey(key: string): { hostId: string; projectId: string } | null {
  const parts = key.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    return { hostId: decodeURIComponent(parts[0]), projectId: decodeURIComponent(parts[1]) };
  } catch {
    return null;
  }
}

export interface SidebarProjectSummary {
  /** Host-qualified key from `projectOrderKey`. */
  key: string;
  name: string;
  /** Text matched by search; defaults to `name`. */
  searchText?: string;
  createdAt?: number;
  /** The project's own activity; the projection also folds in its chats'. */
  lastActivityAt?: number;
}

export interface SidebarChatSummary {
  key: string;
  /** Owning project's key. Chats whose project is not supplied are dropped. */
  projectKey: string;
  title: string;
  createdAt?: number;
  lastActivityAt?: number;
  attention: SidebarAttention;
}

export interface SidebarProjectGroup<P extends SidebarProjectSummary, C extends SidebarChatSummary> {
  project: P;
  chats: C[];
  /** Newest of the project's own and its chats' activity, or null when undated. */
  lastActivityAt: number | null;
}

export interface SidebarChatSection<C extends SidebarChatSummary> {
  id: string;
  label: string;
  chats: C[];
}

export interface SidebarOrganizeInput<P extends SidebarProjectSummary, C extends SidebarChatSummary> {
  projects: readonly P[];
  chats: readonly C[];
  search: string;
  view: SidebarView;
  chatSort: SidebarChatSort;
  projectSort: SidebarProjectSort;
  /** Stored manual order; only consulted when `projectSort` is `manual`. */
  projectOrder: readonly string[];
  /** Clock for the Recent view's day buckets. */
  now: number;
}

export interface SidebarOrganization<P extends SidebarProjectSummary, C extends SidebarChatSummary> {
  /** Project groups in display order, filtered by search. */
  projectGroups: SidebarProjectGroup<P, C>[];
  /** Every supplied project key in display order, ignoring search. */
  projectOrder: string[];
  /** Chat sections for the Recent and Needs attention views; empty otherwise. */
  chatSections: SidebarChatSection<C>[];
}

function usableTime(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Newest first; undated items always follow dated ones. */
function compareNewest(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function chatTime(chat: SidebarChatSummary, sort: SidebarChatSort): number | null {
  return usableTime(sort === "created" ? chat.createdAt : chat.lastActivityAt);
}

function chatComparator(sort: SidebarChatSort) {
  return (left: SidebarChatSummary, right: SidebarChatSummary) =>
    compareNewest(chatTime(left, sort), chatTime(right, sort)) ||
    left.title.localeCompare(right.title) ||
    compareKeys(left.key, right.key);
}

function attentionComparator(left: SidebarChatSummary, right: SidebarChatSummary): number {
  return (
    SIDEBAR_ATTENTION_TIERS.indexOf(left.attention) -
      SIDEBAR_ATTENTION_TIERS.indexOf(right.attention) ||
    chatComparator("last_activity")(left, right)
  );
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function startOfDay(ts: number): Date {
  const day = new Date(ts);
  day.setHours(0, 0, 0, 0);
  return day;
}

/** Day bucket in local time: "Recent" (today), "Yesterday", a month this year, or "Older". */
function recentBucketLabel(ts: number | null, now: number): string {
  if (ts === null) return "Older";
  const today = startOfDay(now);
  if (ts >= today.getTime()) return "Recent";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (ts >= yesterday.getTime()) return "Yesterday";
  const date = new Date(ts);
  return date.getFullYear() === today.getFullYear() ? MONTHS[date.getMonth()] : "Older";
}

function bySections<C extends SidebarChatSummary>(
  chats: readonly C[],
  sectionOf: (chat: C) => { id: string; label: string },
): SidebarChatSection<C>[] {
  const sections: SidebarChatSection<C>[] = [];
  const byId = new Map<string, SidebarChatSection<C>>();
  for (const chat of chats) {
    const { id, label } = sectionOf(chat);
    let section = byId.get(id);
    if (!section) {
      section = { id, label, chats: [] };
      byId.set(id, section);
      sections.push(section);
    }
    section.chats.push(chat);
  }
  return sections;
}

/**
 * Places stored keys first in their stored order, then every other item in its
 * base order. Stored keys without a matching item are ignored.
 */
function applyManualOrder<T extends { key: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const placed = new Set<string>();
  const result: T[] = [];
  for (const key of order) {
    const item = byKey.get(key);
    if (!item || placed.has(key)) continue;
    placed.add(key);
    result.push(item);
  }
  for (const item of items) if (!placed.has(item.key)) result.push(item);
  return result;
}

export function organizeSidebar<P extends SidebarProjectSummary, C extends SidebarChatSummary>(
  input: SidebarOrganizeInput<P, C>,
): SidebarOrganization<P, C> {
  const query = input.search.trim().toLocaleLowerCase();
  const projectByKey = new Map(input.projects.map((project) => [project.key, project]));
  const projectMatches = (project: P) =>
    query.length > 0 && (project.searchText ?? project.name).toLocaleLowerCase().includes(query);
  const titleMatches = (chat: C) => chat.title.toLocaleLowerCase().includes(query);

  const admitted = input.chats.filter((chat) => projectByKey.has(chat.projectKey));
  const chatsByProject = new Map<string, C[]>();
  for (const chat of [...admitted].sort(chatComparator(input.chatSort))) {
    const owned = chatsByProject.get(chat.projectKey) ?? [];
    owned.push(chat);
    chatsByProject.set(chat.projectKey, owned);
  }

  const allGroups = input.projects.map((project): SidebarProjectGroup<P, C> => {
    const chats = chatsByProject.get(project.key) ?? [];
    let lastActivityAt = usableTime(project.lastActivityAt);
    for (const chat of chats) {
      const at = usableTime(chat.lastActivityAt);
      if (at !== null && (lastActivityAt === null || at > lastActivityAt)) lastActivityAt = at;
    }
    return { project, chats, lastActivityAt };
  });
  const byName = (left: SidebarProjectGroup<P, C>, right: SidebarProjectGroup<P, C>) =>
    left.project.name.localeCompare(right.project.name) ||
    compareKeys(left.project.key, right.project.key);
  const byActivity = [...allGroups].sort(
    (left, right) => compareNewest(left.lastActivityAt, right.lastActivityAt) || byName(left, right),
  );
  const ordered =
    input.projectSort === "created"
      ? [...allGroups].sort(
          (left, right) =>
            compareNewest(usableTime(left.project.createdAt), usableTime(right.project.createdAt)) ||
            byName(left, right),
        )
      : input.projectSort === "manual"
        ? applyManualOrder(
            byActivity.map((group) => ({ key: group.project.key, group })),
            input.projectOrder,
          ).map(({ group }) => group)
        : byActivity;

  const projectGroups = query
    ? ordered.flatMap((group) => {
        if (projectMatches(group.project)) return [group];
        const chats = group.chats.filter(titleMatches);
        return chats.length > 0 ? [{ ...group, chats }] : [];
      })
    : ordered;

  let chatSections: SidebarChatSection<C>[] = [];
  if (input.view !== "projects") {
    const visible = admitted.filter(
      (chat) => !query || titleMatches(chat) || projectMatches(projectByKey.get(chat.projectKey)!),
    );
    chatSections =
      input.view === "recent"
        ? bySections([...visible].sort(chatComparator(input.chatSort)), (chat) => {
            const label = recentBucketLabel(chatTime(chat, input.chatSort), input.now);
            return { id: label, label };
          })
        : bySections([...visible].sort(attentionComparator), (chat) => ({
            id: chat.attention,
            label: SIDEBAR_ATTENTION_LABELS[chat.attention],
          }));
  }

  return {
    projectGroups,
    projectOrder: ordered.map((group) => group.project.key),
    chatSections,
  };
}

export interface SidebarDisplayOptions<P extends SidebarProjectSummary> {
  search: string;
  isExpanded: (project: P) => boolean;
  /** True once "Show N more" revealed every chat in the group. */
  isFullyRevealed: (project: P) => boolean;
  collapsedChatLimit: number;
}

/** The chats a project group shows: none when collapsed, a preview, or all of them. */
export function visibleProjectChats<P extends SidebarProjectSummary, C extends SidebarChatSummary>(
  group: SidebarProjectGroup<P, C>,
  options: SidebarDisplayOptions<P>,
): C[] {
  const searching = options.search.trim().length > 0;
  if (!searching && !options.isExpanded(group.project)) return [];
  return searching || options.isFullyRevealed(group.project)
    ? group.chats
    : group.chats.slice(0, options.collapsedChatLimit);
}

/**
 * The project's most recently active chat, whatever order its rows are shown
 * in, so "Open latest chat" does not depend on the display sort.
 */
export function latestProjectChat<P extends SidebarProjectSummary, C extends SidebarChatSummary>(
  group: SidebarProjectGroup<P, C>,
): C | undefined {
  const byActivity = chatComparator("last_activity");
  return group.chats.reduce<C | undefined>(
    (latest, chat) => (latest === undefined || byActivity(chat, latest) < 0 ? chat : latest),
    undefined,
  );
}

/**
 * Chat rows exactly as the active view displays them, section by section, so
 * jump shortcuts and previous/next navigation follow what is on screen.
 */
export function displayedSidebarChats<P extends SidebarProjectSummary, C extends SidebarChatSummary>(
  organization: SidebarOrganization<P, C>,
  view: SidebarView,
  options: SidebarDisplayOptions<P>,
): { chats: C[] }[] {
  if (view !== "projects") return organization.chatSections.map(({ chats }) => ({ chats }));
  return [
    {
      chats: organization.projectGroups.flatMap((group) => visibleProjectChats(group, options)),
    },
  ];
}

export function canMoveProjectKey(
  order: readonly string[],
  key: string,
  offset: -1 | 1,
): boolean {
  const index = order.indexOf(key);
  return index >= 0 && index + offset >= 0 && index + offset < order.length;
}

/** Moves one key a single place up (-1) or down (1); otherwise returns a copy. */
export function moveProjectKey(order: readonly string[], key: string, offset: -1 | 1): string[] {
  const next = [...order];
  if (!canMoveProjectKey(order, key, offset)) return next;
  const index = order.indexOf(key);
  [next[index], next[index + offset]] = [next[index + offset], next[index]];
  return next;
}

/** Moves `key` to sit before or after `targetKey`, as a drag-and-drop does. */
export function moveProjectKeyTo(
  order: readonly string[],
  key: string,
  targetKey: string,
  placement: "before" | "after",
): string[] {
  if (key === targetKey || !order.includes(key) || !order.includes(targetKey)) return [...order];
  const without = order.filter((candidate) => candidate !== key);
  const targetIndex = without.indexOf(targetKey);
  without.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, key);
  return without;
}

/**
 * Combines a newly arranged list with the previously stored order so keys for
 * projects that are not listed right now (another host offline, say) survive.
 */
export function mergeProjectOrder(
  arranged: readonly string[],
  stored: readonly string[],
): string[] {
  const listed = new Set(arranged);
  return [...arranged, ...stored.filter((key) => !listed.has(key))];
}

export interface SidebarPreferences {
  view: SidebarView;
  chatSort: SidebarChatSort;
  projectSort: SidebarProjectSort;
  /** Host-qualified project keys in manual order. */
  projectOrder: string[];
  /** Local workspace ids whose groups are expanded. */
  expandedWorkspaceIds: string[];
}

export const DEFAULT_SIDEBAR_PREFERENCES: Readonly<SidebarPreferences> = Object.freeze({
  view: "projects",
  chatSort: "last_activity",
  projectSort: "last_activity",
  projectOrder: [],
  expandedWorkspaceIds: [],
});

export const MAX_SIDEBAR_PROJECT_ORDER = 500;
const MAX_PERSISTED_EXPANSIONS = 200;
const MAX_PROJECT_ORDER_KEY_LENGTH = 512;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * Reads the stored sidebar preferences, migrating the earlier
 * `{ organization, expandedWorkspaceIds }` shape. When `validLocalProjectIds`
 * is supplied, local entries for removed workspaces are pruned; keys for other
 * hosts are kept because their projects may simply be offline.
 */
export function parseSidebarPreferences(
  value: string | null,
  validLocalProjectIds?: readonly string[],
): SidebarPreferences {
  const valid = validLocalProjectIds ? new Set(validLocalProjectIds) : null;
  const isLocalProject = (id: string) =>
    SAFE_WORKSPACE_ID.test(id) && (valid === null || valid.has(id));
  let record: Record<string, unknown>;
  try {
    const parsed = value ? (JSON.parse(value) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_SIDEBAR_PREFERENCES, projectOrder: [], expandedWorkspaceIds: [] };
    }
    record = parsed as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_SIDEBAR_PREFERENCES, projectOrder: [], expandedWorkspaceIds: [] };
  }

  const view =
    oneOf(SIDEBAR_VIEWS, record.view) ?? (record.organization === "recent" ? "recent" : "projects");
  const expandedWorkspaceIds = Array.isArray(record.expandedWorkspaceIds)
    ? Array.from(
        new Set(
          record.expandedWorkspaceIds.filter(
            (id): id is string => typeof id === "string" && isLocalProject(id),
          ),
        ),
      ).slice(0, MAX_PERSISTED_EXPANSIONS)
    : [];
  const projectOrder = Array.isArray(record.projectOrder)
    ? Array.from(
        new Set(
          record.projectOrder.filter((key): key is string => {
            if (typeof key !== "string" || key.length > MAX_PROJECT_ORDER_KEY_LENGTH) return false;
            const parsed = parseProjectOrderKey(key);
            if (!parsed) return false;
            return parsed.hostId !== LOCAL_SIDEBAR_HOST_ID || isLocalProject(parsed.projectId);
          }),
        ),
      ).slice(0, MAX_SIDEBAR_PROJECT_ORDER)
    : [];
  return {
    view,
    chatSort: oneOf(SIDEBAR_CHAT_SORTS, record.chatSort) ?? DEFAULT_SIDEBAR_PREFERENCES.chatSort,
    projectSort:
      oneOf(SIDEBAR_PROJECT_SORTS, record.projectSort) ?? DEFAULT_SIDEBAR_PREFERENCES.projectSort,
    projectOrder,
    expandedWorkspaceIds,
  };
}

/** Serializes preferences, keeping the legacy `organization` for older builds. */
export function serializeSidebarPreferences(preferences: SidebarPreferences): string {
  return JSON.stringify({
    ...preferences,
    organization: preferences.view === "recent" ? "recent" : "workspace",
  });
}
