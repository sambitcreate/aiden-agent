import type { PeerFeedRow, PeerHostFeedSnapshot, PeerHostStatus, PeerHostView } from "../../shared/peer-host";
import { sidebarHosts, type SidebarHost } from "../sidebar-remote-groups";
import type { HostChatCapability } from "./host-chat-adapter";
import { hostControlRefusal, remoteHostCapabilities } from "./remote-host-adapter";

/**
 * Where new work can start: this Mac or a paired host, the projects each host
 * reported, and the Bots each host offers. Everything here is pure and reads
 * only the hosts' last-known registry, status and feed rows.
 */

/** A paired Mac a new chat could run on. */
export interface NewChatMachine extends SidebarHost {
  /** Why a new chat cannot start there now; absent when it can. */
  disabledReason?: string;
}

/** Why `host` cannot do `capability` for this Mac now, naming the host rather than "this Mac". */
function unavailableReason(
  host: SidebarHost,
  view: PeerHostView | undefined,
  capability: HostChatCapability,
  action: string,
): string | undefined {
  if (!view || !remoteHostCapabilities(view).has(capability)) return `${host.label} hasn't allowed this Mac to ${action}.`;
  return hostControlRefusal(host)?.message.replace(/this Mac/i, host.label);
}

/**
 * Enabled paired hosts in registry order. A host that is not online, or did
 * not grant this Mac permission to create chats, stays listed with a reason.
 */
export function newChatMachines(
  views: readonly PeerHostView[],
  statuses: readonly PeerHostStatus[],
): NewChatMachine[] {
  const byId = new Map(views.map((view) => [view.id, view]));
  return sidebarHosts(views, statuses).map((host) => {
    const disabledReason = unavailableReason(host, byId.get(host.id), "createChat", "start chats");
    return disabledReason ? { ...host, disabledReason } : host;
  });
}

/** A project on a paired host, as its feed last reported it. */
export interface RemoteProjectChoice {
  id: string;
  name: string;
  /** The project's folder or repository, when the host shared one. */
  detail?: string;
}

function text(row: PeerFeedRow, field: string): string | undefined {
  const value = row[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function updatedAt(row: PeerFeedRow): number {
  const parsed = Date.parse(text(row, "updatedAt") ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The host's projects, most recently used first. */
export function remoteProjectChoices(
  feed: PeerHostFeedSnapshot | null | undefined,
  created: readonly RemoteProjectChoice[] = [],
): RemoteProjectChoice[] {
  const listed = [...(feed?.workspaces ?? [])]
    .sort((a, b) => updatedAt(b) - updatedAt(a))
    .map((row) => {
      const detail = text(row, "repositoryName");
      return { id: row.id, name: text(row, "name") ?? "Untitled project", ...(detail ? { detail } : {}) };
    });
  // A project this window just created is offered at once, before the host's feed reports it.
  const known = new Set(listed.map((project) => project.id));
  return [...created.filter((project) => !known.has(project.id)), ...listed];
}

/** A Bot that lives on a paired host. */
export interface RemoteBotChoice {
  id: string;
  name: string;
  purpose?: string;
}

export interface RemoteBotGroup {
  host: NewChatMachine;
  bots: RemoteBotChoice[];
}

function archived(row: PeerFeedRow): boolean {
  return row.health === "archived" || text(row, "archivedAt") !== undefined;
}

/**
 * Each paired host's Bots, grouped by host. Archived Bots are left out, since
 * they cannot start or continue work. A host that cannot open Bot chats for
 * this Mac now keeps its Bots listed, with the reason.
 */
export function remoteBotGroups(
  views: readonly PeerHostView[],
  statuses: readonly PeerHostStatus[],
  feeds: ReadonlyMap<string, PeerHostFeedSnapshot | null | undefined>,
): RemoteBotGroup[] {
  const byId = new Map(views.map((view) => [view.id, view]));
  const groups: RemoteBotGroup[] = [];
  for (const host of sidebarHosts(views, statuses)) {
    const bots = (feeds.get(host.id)?.bots ?? [])
      .filter((row) => !archived(row))
      .map((row) => {
        const purpose = text(row, "purpose");
        return { id: row.id, name: text(row, "name") ?? "Untitled Bot", ...(purpose ? { purpose } : {}) };
      });
    if (bots.length === 0) continue;
    const disabledReason = unavailableReason(host, byId.get(host.id), "botChats", "start Bot chats");
    groups.push({ host: disabledReason ? { ...host, disabledReason } : host, bots });
  }
  return groups;
}
