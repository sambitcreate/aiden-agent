import { CHAT_ROW_STATES, isChatRowState, type ChatRowState } from "../shared/chat-row-state";
import type {
  PeerBlockedReason,
  PeerFeedRow,
  PeerHostFeedSnapshot,
  PeerHostStatus,
  PeerHostView,
  PeerRepositoryIdentity,
  PeerRunState,
} from "../shared/peer-host";
import {
  LOCAL_SIDEBAR_HOST_ID,
  projectOrderKey,
  sidebarAttention,
  type SidebarChatSummary,
  type SidebarMachineFilter,
  type SidebarProjectGrouping,
  type SidebarProjectSummary,
} from "./sidebar-organization";

/**
 * Remote adapter for the sidebar projection: maps each paired host's
 * last-known feed rows into the same host-qualified summaries the local
 * adapter produces, then combines both sides under the machine filter and the
 * cross-machine grouping. Everything here is pure.
 */

export const LOCAL_MACHINE_LABEL = "This Mac";

export type SidebarHostAvailability = "online" | "connecting" | "offline" | "blocked";

export interface SidebarHost {
  id: string;
  /** Display name, with a short instance suffix when another host shares it. */
  label: string;
  availability: SidebarHostAvailability;
  blockedReason?: PeerBlockedReason;
}

export interface RemoteSidebarProject extends SidebarProjectSummary {
  remote: true;
  hostId: string;
  hostLabel: string;
  workspaceId: string;
  repository: PeerRepositoryIdentity | null;
  branchName: string | null;
  /** True while the host is not connected: the row is last-known and read-only. */
  stale: boolean;
}

export interface RemoteSidebarChat extends SidebarChatSummary {
  remote: true;
  hostId: string;
  hostLabel: string;
  chatId: string;
  workspaceId: string;
  rowState: ChatRowState;
  unread: boolean;
  stale: boolean;
}

export function isRemoteSidebarProject(project: SidebarProjectSummary): project is RemoteSidebarProject {
  return (project as Partial<RemoteSidebarProject>).remote === true;
}

export function isRemoteSidebarChat(chat: SidebarChatSummary): chat is RemoteSidebarChat {
  return (chat as Partial<RemoteSidebarChat>).remote === true;
}

/** A host's supervisor state as the availability every remote surface shows. */
export function hostAvailability(
  status: PeerHostStatus | undefined,
): Pick<SidebarHost, "availability" | "blockedReason"> {
  switch (status?.state.kind) {
    case "connected":
      return { availability: "online" };
    case "backoff":
      return { availability: "offline" };
    case "blocked":
      return { availability: "blocked", blockedReason: status.state.reason };
    default:
      // Not yet reported, starting, or a transient disabled state while enabling.
      return { availability: "connecting" };
  }
}

/**
 * Enabled paired hosts in registry order. Names are not unique, so a name that
 * another enabled host (or this Mac) also uses gets the host ID's last four
 * characters as an instance suffix.
 */
export function sidebarHosts(
  views: readonly PeerHostView[],
  statuses: readonly PeerHostStatus[],
): SidebarHost[] {
  const enabled = views.filter((view) => view.enabled);
  const byStatus = new Map(statuses.map((status) => [status.hostId, status]));
  const nameOf = (view: PeerHostView) => view.name.trim() || "Paired Mac";
  const counts = new Map<string, number>([[LOCAL_MACHINE_LABEL.toLocaleLowerCase(), 1]]);
  for (const view of enabled) {
    const folded = nameOf(view).toLocaleLowerCase();
    counts.set(folded, (counts.get(folded) ?? 0) + 1);
  }
  return enabled.map((view) => {
    const name = nameOf(view);
    const shared = (counts.get(name.toLocaleLowerCase()) ?? 0) > 1;
    return {
      id: view.id,
      label: shared ? `${name} (${view.id.slice(-4)})` : name,
      ...hostAvailability(byStatus.get(view.id)),
    };
  });
}

function text(row: PeerFeedRow, field: string): string | null {
  const value = row[field];
  return typeof value === "string" && value.trim() ? value : null;
}

function time(row: PeerFeedRow, field: string): number | undefined {
  const value = row[field];
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function repositoryOf(row: PeerFeedRow): PeerRepositoryIdentity | null {
  const value = row.repository;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { canonicalKey, relativePath } = value as Record<string, unknown>;
  return typeof canonicalKey === "string" && canonicalKey && typeof relativePath === "string"
    ? { canonicalKey, relativePath }
    : null;
}

const LIVE_RUN_STATES = new Set<string>(["working", "needs_approval", "needs_input"]);

function moreUrgent(left: ChatRowState, right: ChatRowState): ChatRowState {
  return CHAT_ROW_STATES.indexOf(left) <= CHAT_ROW_STATES.indexOf(right) ? left : right;
}

/** Newest run per chat; the feed keeps runs in insertion order, newest last. */
function latestRuns(runs: readonly PeerRunState[]): Map<string, PeerRunState> {
  const latest = new Map<string, PeerRunState>();
  for (const run of runs) latest.set(run.chatId, run);
  return latest;
}

export interface RemoteSidebarRows {
  projects: RemoteSidebarProject[];
  chats: RemoteSidebarChat[];
}

/**
 * One host's feed snapshot as sidebar rows. `isOpen` names the chat the user is
 * viewing, whose output never reads as unread.
 */
export function remoteSidebarRows(
  host: SidebarHost,
  snapshot: PeerHostFeedSnapshot | undefined,
  isOpen: (hostId: string, chatId: string) => boolean = () => false,
): RemoteSidebarRows {
  if (!snapshot || snapshot.hostId !== host.id) return { projects: [], chats: [] };
  const stale = snapshot.stale || host.availability !== "online";
  const projects = snapshot.workspaces.map((row): RemoteSidebarProject => {
    const name = text(row, "name") ?? "Untitled project";
    return {
      key: projectOrderKey(host.id, row.id),
      name,
      searchText: `${name} ${text(row, "repositoryName") ?? ""} ${host.label}`,
      createdAt: time(row, "createdAt"),
      lastActivityAt: time(row, "updatedAt"),
      remote: true,
      hostId: host.id,
      hostLabel: host.label,
      workspaceId: row.id,
      repository: repositoryOf(row),
      branchName: text(row, "branchName"),
      stale,
    };
  });
  const runs = latestRuns(snapshot.runs);
  const chats = snapshot.summaries.flatMap((row): RemoteSidebarChat[] => {
    const workspaceId = text(row, "workspaceId");
    if (!workspaceId) return [];
    const run = runs.get(row.id);
    const summaryState: ChatRowState = isChatRowState(row.rowState)
      ? row.rowState
      : row.activity === "active"
        ? "working"
        : "idle";
    const runState =
      run && LIVE_RUN_STATES.has(run.state) && isChatRowState(run.state) ? run.state : "idle";
    let rowState = moreUrgent(runState, summaryState);
    // A stale host cannot confirm a run is still going; a waiting prompt stays visible.
    if (stale && rowState === "working") rowState = "idle";
    const unread = !isOpen(host.id, row.id) && (row.unread === true || run?.unread === true);
    return [
      {
        key: projectOrderKey(host.id, row.id),
        projectKey: projectOrderKey(host.id, workspaceId),
        title: text(row, "title") ?? "New chat",
        createdAt: time(row, "createdAt"),
        lastActivityAt: time(row, "updatedAt"),
        attention: sidebarAttention(rowState, unread),
        remote: true,
        hostId: host.id,
        hostLabel: host.label,
        chatId: row.id,
        workspaceId,
        rowState,
        unread,
        stale,
      },
    ];
  });
  return { projects, chats };
}

/** The machine filter in effect: a host that is no longer paired falls back to all machines. */
export function effectiveMachineFilter(
  filter: SidebarMachineFilter,
  hosts: readonly SidebarHost[],
): SidebarMachineFilter {
  if (hosts.length === 0) return "all";
  if (filter.startsWith("host:")) {
    const hostId = filter.slice("host:".length);
    return hosts.some((host) => host.id === hostId) ? filter : "all";
  }
  return filter;
}

export function machineFilterLabel(
  filter: SidebarMachineFilter,
  hosts: readonly SidebarHost[],
): string {
  if (filter === "all") return "All machines";
  if (filter === "local") return LOCAL_MACHINE_LABEL;
  const hostId = filter.slice("host:".length);
  return hosts.find((host) => host.id === hostId)?.label ?? "All machines";
}

export function machineFilterForHost(hostId: string): SidebarMachineFilter {
  return `host:${hostId}`;
}

/** One sidebar project group: a single workspace, or same-repository workspaces across machines. */
export interface SidebarProjectEntry<L extends SidebarProjectSummary> extends SidebarProjectSummary {
  /** The member whose name and key the group uses: this Mac's when it has one. */
  primary: L | RemoteSidebarProject;
  /** Every machine's workspace in the group, this Mac first, then by host label. */
  members: (L | RemoteSidebarProject)[];
}

export interface CombineSidebarRowsInput<L extends SidebarProjectSummary, LC extends SidebarChatSummary> {
  local: { projects: readonly L[]; chats: readonly LC[] };
  remote: readonly RemoteSidebarRows[];
  hosts: readonly SidebarHost[];
  filter: SidebarMachineFilter;
  grouping: SidebarProjectGrouping;
  /** This Mac's repository identity for a local project, when known. */
  localRepository?: (project: L) => PeerRepositoryIdentity | null | undefined;
}

export interface CombinedSidebarRows<L extends SidebarProjectSummary, LC extends SidebarChatSummary> {
  projects: SidebarProjectEntry<L>[];
  chats: (LC | RemoteSidebarChat)[];
}

function machineOf(project: SidebarProjectSummary): string {
  return isRemoteSidebarProject(project) ? project.hostId : LOCAL_SIDEBAR_HOST_ID;
}

function minTime(values: (number | undefined)[]): number | undefined {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return usable.length > 0 ? Math.min(...usable) : undefined;
}

function maxTime(values: (number | undefined)[]): number | undefined {
  const usable = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return usable.length > 0 ? Math.max(...usable) : undefined;
}

function singleEntry<L extends SidebarProjectSummary>(project: L | RemoteSidebarProject): SidebarProjectEntry<L> {
  return {
    key: project.key,
    name: project.name,
    searchText: project.searchText,
    createdAt: project.createdAt,
    lastActivityAt: project.lastActivityAt,
    primary: project,
    members: [project],
  };
}

/**
 * Applies the machine filter and the cross-machine grouping. Only workspaces
 * with a repository identity merge, at most one per machine; a second
 * same-machine match stays its own group. A merged group keeps its primary's
 * host-qualified key, so manual order survives grouping changes for that row.
 */
export function combineSidebarRows<L extends SidebarProjectSummary, LC extends SidebarChatSummary>(
  input: CombineSidebarRowsInput<L, LC>,
): CombinedSidebarRows<L, LC> {
  const filter = effectiveMachineFilter(input.filter, input.hosts);
  const showLocal = filter === "all" || filter === "local";
  const shownHost = (hostId: string) =>
    filter === "all" || filter === machineFilterForHost(hostId);
  const hostOrder = new Map(input.hosts.map((host, index) => [host.id, index]));
  const remoteProjects = input.remote
    .flatMap((rows) => rows.projects)
    .filter((project) => shownHost(project.hostId))
    .sort(
      (left, right) =>
        (hostOrder.get(left.hostId) ?? Infinity) - (hostOrder.get(right.hostId) ?? Infinity) ||
        left.hostLabel.localeCompare(right.hostLabel) ||
        (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    );
  const candidates: (L | RemoteSidebarProject)[] = [
    ...(showLocal ? input.local.projects : []),
    ...remoteProjects,
  ];

  const groupKeyOf = (project: L | RemoteSidebarProject): string | null => {
    if (input.grouping === "separate") return null;
    const repository = isRemoteSidebarProject(project)
      ? project.repository
      : (input.localRepository?.(project as L) ?? null);
    if (!repository) return null;
    return input.grouping === "repository"
      ? repository.canonicalKey
      : JSON.stringify([repository.canonicalKey, repository.relativePath]);
  };

  const groups: (L | RemoteSidebarProject)[][] = [];
  const byGroupKey = new Map<string, (L | RemoteSidebarProject)[]>();
  for (const project of candidates) {
    const groupKey = groupKeyOf(project);
    const existing = groupKey === null ? undefined : byGroupKey.get(groupKey);
    if (existing && !existing.some((member) => machineOf(member) === machineOf(project))) {
      existing.push(project);
      continue;
    }
    const group = [project];
    groups.push(group);
    if (groupKey !== null && !existing) byGroupKey.set(groupKey, group);
  }

  const projectKeyFor = new Map<string, string>();
  const projects = groups.map((members): SidebarProjectEntry<L> => {
    if (members.length === 1) return singleEntry(members[0]);
    const primary = members[0];
    for (const member of members.slice(1)) projectKeyFor.set(member.key, primary.key);
    return {
      key: primary.key,
      name: primary.name,
      searchText: members.map((member) => member.searchText ?? member.name).join(" "),
      createdAt: minTime(members.map((member) => member.createdAt)),
      lastActivityAt: maxTime(members.map((member) => member.lastActivityAt)),
      primary,
      members,
    };
  });

  const chats: (LC | RemoteSidebarChat)[] = [
    ...(showLocal ? input.local.chats : []),
    ...input.remote.flatMap((rows) => rows.chats.filter((chat) => shownHost(chat.hostId))),
  ].map((chat) => {
    const merged = projectKeyFor.get(chat.projectKey);
    return merged === undefined ? chat : { ...chat, projectKey: merged };
  });
  return { projects, chats };
}

/** The machines a merged group spans, this Mac first, for its badges. */
export function projectEntryMachineLabels<L extends SidebarProjectSummary>(
  entry: SidebarProjectEntry<L>,
): string[] {
  return entry.members.map((member) =>
    isRemoteSidebarProject(member) ? member.hostLabel : LOCAL_MACHINE_LABEL,
  );
}
