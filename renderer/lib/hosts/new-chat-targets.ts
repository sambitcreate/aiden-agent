import type { PeerFeedRow, PeerHostFeedSnapshot, PeerHostStatus, PeerHostView } from "../../shared/peer-host";
import { sidebarHosts, type SidebarHost } from "../sidebar-remote-groups";
import type { HostChatCapability } from "./host-chat-adapter";
import { hostControlRefusal, remoteHostCapabilities } from "./remote-host-adapter";
import { localComputerNoun } from "../../shared/computer-noun";
import { isBotAvatarAppearance, type BotAvatar } from "../../shared/bots";
import { peerFeedBotAttention } from "../../shared/peer-feed-inbox";
import { clipPendingAttentionSummary } from "../../shared/chat-pending-attention";
import { remoteBotPhotoAsset, type RemoteBotPhotoAsset } from "./remote-bot-photo-asset";

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

/**
 * Why `host` cannot do `capability` for this computer now. The host is named
 * by its label, and this computer by its platform noun ("this Mac" on macOS).
 */
function unavailableReason(
  host: SidebarHost,
  view: PeerHostView | undefined,
  capability: HostChatCapability,
  action: string,
  platform: string | null | undefined,
): string | undefined {
  if (!view || !remoteHostCapabilities(view).has(capability))
    return `${host.label} hasn't allowed this ${localComputerNoun(platform)} to ${action}.`;
  return hostControlRefusal(host, host.label)?.message;
}

/**
 * Enabled paired hosts in registry order. A host that is not online, or did
 * not grant this Mac permission to create chats, stays listed with a reason.
 */
export function newChatMachines(
  views: readonly PeerHostView[],
  statuses: readonly PeerHostStatus[],
  platform: string | null | undefined,
): NewChatMachine[] {
  const byId = new Map(views.map((view) => [view.id, view]));
  return sidebarHosts(views, statuses).map((host) => {
    const disabledReason = unavailableReason(host, byId.get(host.id), "createChat", "start chats", platform);
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

/**
 * The projects this window created on one host that its feed has never
 * listed. Once the feed lists one, the feed alone speaks for it, so a project
 * the host later deletes is not revived by this window's memory of creating
 * it. The feed's answer and the create's answer can arrive in either order.
 */
export interface CreatedProjects {
  hostId: string;
  /** Created here and not yet listed by the feed, newest first. */
  pending: readonly RemoteProjectChoice[];
  /** Every project ID the host's feed has listed since this window opened. */
  listed: ReadonlySet<string>;
}

export type CreatedProjectsEvent =
  | { type: "created"; hostId: string; project: RemoteProjectChoice }
  | { type: "feed"; hostId: string; feed: PeerHostFeedSnapshot | null | undefined };

export function createdProjects(hostId: string): CreatedProjects {
  return { hostId, pending: [], listed: new Set() };
}

export function reduceCreatedProjects(state: CreatedProjects, event: CreatedProjectsEvent): CreatedProjects {
  const current = event.hostId === state.hostId ? state : createdProjects(event.hostId);
  if (event.type === "created") {
    if (current.listed.has(event.project.id)) return current;
    const others = current.pending.filter((project) => project.id !== event.project.id);
    return { ...current, pending: [event.project, ...others] };
  }
  const rows = event.feed?.workspaces ?? [];
  if (rows.every((row) => current.listed.has(row.id)) && current === state) return state;
  const listed = new Set(current.listed);
  for (const row of rows) listed.add(row.id);
  return { ...current, listed, pending: current.pending.filter((project) => !listed.has(project.id)) };
}

/** A Bot that lives on a paired host. */
export interface RemoteBotChoice {
  id: string;
  name: string;
  /** The Bot's description. Searchable, but not shown as the row's line. */
  purpose?: string;
  /** The Bot's avatar shape and colour as its host sends them; absent when the row has none or a malformed one. */
  avatar?: BotAvatar;
  /** The host says a turn is running, and the host is online now. */
  working?: true;
  /** An approval, a question, a hand-off or an open issue waits on the person (revision 50). Outranks `working`. */
  needsYou?: true;
  /**
   * The person paused the Bot (only a host that sends this Mac the
   * `bot:handoffs` rows says so), a turn stopped part-way and waits to be
   * resumed, or the Bot's AI model cannot be used.
   */
  status?: "paused" | "interrupted" | "needs_model";
  /** The line the host's own Bots list shows under the name (revision 66), one plain line. */
  preview?: string;
  /** When the Bot's newest reply arrived, by the host's clock; the row's unread dot compares it with what this Mac showed. */
  lastReplyAt?: number;
  /** The Bot's photo, as the host lists it; read on demand. */
  photo?: RemoteBotPhotoAsset;
}

/** The longest preview a remote Bot row shows; a host sends at most this (revision 66). */
export const REMOTE_BOT_PREVIEW_MAX = 140;

export interface RemoteBotGroup {
  host: NewChatMachine;
  bots: RemoteBotChoice[];
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
  platform: string | null | undefined,
): RemoteBotGroup[] {
  const byId = new Map(views.map((view) => [view.id, view]));
  const groups: RemoteBotGroup[] = [];
  for (const host of sidebarHosts(views, statuses)) {
    const feed = feeds.get(host.id);
    // A run the host reported before it went offline may have ended since.
    const hostOnline = host.availability === "online" && feed?.stale !== true;
    const bots = (feed?.bots ?? [])
      .map((row): RemoteBotChoice => {
        const purpose = text(row, "purpose");
        const semantic = (row.avatar as { semantic?: unknown } | null | undefined)?.semantic;
        const { needsYou } = peerFeedBotAttention(row);
        // The host already sends one plain line; it is still another computer's text.
        const preview = clipPendingAttentionSummary(row.preview, REMOTE_BOT_PREVIEW_MAX);
        const lastReplyAt = typeof row.lastReplyAt === "string" ? Date.parse(row.lastReplyAt) : Number.NaN;
        const photo = remoteBotPhotoAsset(row);
        return {
          id: row.id,
          name: text(row, "name") ?? "Untitled Bot",
          ...(purpose ? { purpose } : {}),
          ...(isBotAvatarAppearance(semantic) ? { avatar: semantic } : {}),
          ...(hostOnline && row.sessionState === "running" ? { working: true as const } : {}),
          ...(needsYou ? { needsYou: true as const } : {}),
          ...(row.sessionState === "paused" || row.sessionState === "interrupted" || row.sessionState === "needs_model"
            ? { status: row.sessionState as "paused" | "interrupted" | "needs_model" }
            : {}),
          ...(preview ? { preview } : {}),
          ...(Number.isFinite(lastReplyAt) && lastReplyAt > 0 ? { lastReplyAt } : {}),
          ...(photo ? { photo } : {}),
        };
      });
    const view = byId.get(host.id);
    if (bots.length === 0) {
      // A pairing made before this Mac could use another Mac's Bots holds no
      // Bot grants (they are fixed at pairing), so the feed lists none.
      if (view && view.features.includes("bot-durable-session-v1") && !view.capabilities.includes("bot:read"))
        groups.push({
          host: { ...host, disabledReason: `To use ${host.label}'s Bots here, pair this ${localComputerNoun(platform)} with it again.` },
          bots: [],
        });
      continue;
    }
    const disabledReason = unavailableReason(host, view, "botChats", "start Bot chats", platform);
    groups.push({ host: disabledReason ? { ...host, disabledReason } : host, bots });
  }
  return groups;
}
