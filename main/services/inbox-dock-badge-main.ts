import type { ChatPendingAttention } from "../../renderer/shared/chat-pending-attention.js";
import { isLocalInboxChat } from "../../renderer/shared/inbox-state.js";
import { app, ipcMain, logger, onBroadcast } from "../platform.js";
import { botApplicationService } from "./bot-application-service-main.js";
import { chatActivityRegistry } from "./chat-activity.js";
import { pendingAttentionForChat, readInterruptedRunWaits } from "./chat-pending-attention.js";
import { detachedPromptLog } from "./chat-pending-attention-main.js";
import { chatReadMarkers } from "./chat-read-markers-main.js";
import { chatStore } from "./chat-store.js";
import { chatTriage } from "./chat-triage-main.js";
import { configStore } from "./config-store.js";
import { hostPlatformCapabilities } from "./host-platform-capabilities.js";
import { hostRunRegistry } from "./host-runs-main.js";
import {
  badgeSurface,
  createInboxBadgeDriver,
  inboxBadgeCount,
  type BadgeApp,
  type InboxBadgeDriver,
  type InboxBadgeLocal,
  type InboxBadgePeer,
} from "./inbox-dock-badge.js";
import { interruptedWaits } from "./interrupted-waits-main.js";
import { peekPeerHostManager } from "./peer-host-manager-main.js";
import { piRuntimeEffectStore } from "./pi-runtime-effect-store.js";

/** Whatever changes a row's Needs you placement. */
const BADGE_CHANNELS: ReadonlySet<string> = new Set([
  "chats:changed",
  "chats:metadata-updated",
  "chats:activity-changed",
  "chats:read-markers-changed",
  "chats:triage-changed",
  "workspaces:changed",
  "bots:changed",
  "bots:attention",
  "remote:host-feed",
  "remote:peer-host-state",
]);

const BOT_SUMMARY_CONCURRENCY = 4;

async function botsNeedingYou(): Promise<string[]> {
  if (!hostPlatformCapabilities().bots) return [];
  const bots = await botApplicationService.list();
  if (bots.length === 0) return [];
  const { botLiveProjection } = await import("./bot-runtime/bot-session-main.js");
  const live = botLiveProjection();
  const ids = bots.map((bot) => bot.id);
  const waiting: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(BOT_SUMMARY_CONCURRENCY, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++]!;
        // A summary that can't be read leaves that Bot out, as the host feed does.
        const summary = await live.summary(id).catch(() => undefined);
        if (summary?.needsYou) waiting.push(id);
      }
    }),
  );
  return waiting;
}

async function readLocal(): Promise<InboxBadgeLocal> {
  const [chats, workspaces, markers, triage, bots] = await Promise.all([
    chatStore.listSummaryMetadata(),
    configStore.listWorkspaces(),
    chatReadMarkers.snapshot().catch(() => null),
    chatTriage.snapshot().catch(() => null),
    botsNeedingYou().catch((error: unknown) => {
      logger.warn("inbox", "Could not read Bot attention for the Dock badge.", error);
      return [];
    }),
  ]);
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const listed = chats.filter((chat) => isLocalInboxChat(chat, (id) => workspaceIds.has(id)));
  const interrupted = await readInterruptedRunWaits(
    listed.map((chat) => chat.id),
    {
      waits: interruptedWaits,
      operations: piRuntimeEffectStore,
      onError: (error) => logger.warn("inbox", "Could not read interrupted waits for the Dock badge.", error),
    },
  );
  const pending = new Map<string, ChatPendingAttention>();
  for (const chat of listed) {
    const attention = pendingAttentionForChat(chat.id, {
      runs: hostRunRegistry,
      detached: detachedPromptLog,
      interrupted: interrupted.get(chat.id),
    });
    if (attention) pending.set(chat.id, attention);
  }
  return {
    chats: listed,
    workspaceIds,
    activity: chatActivityRegistry.snapshot(),
    markers,
    triage: triage?.chats ?? {},
    pending,
    botsNeedingYou: bots,
  };
}

/** Paired hosts' last-known feeds. Never starts the supervisor: no peer traffic for a badge. */
function readPeers(): InboxBadgePeer[] {
  const manager = peekPeerHostManager();
  if (!manager) return [];
  return manager.statuses().map((status) => ({ status, feed: manager.feedSnapshot(status.hostId) }));
}

async function count(): Promise<number> {
  return inboxBadgeCount({ now: Date.now(), local: await readLocal(), peers: readPeers() });
}

let driver: InboxBadgeDriver | undefined;
let detachers: (() => void)[] = [];
/** The latest window report; off until one arrives. */
let requested = false;

/**
 * `app:setInboxDockBadge(enabled)`: a window reports whether the badge should
 * show (the Inbox is the sidebar view and its switch is on). The latest report
 * wins, and the badge stays put when every window closes, so the Dock keeps
 * counting with no window open.
 */
export function registerInboxDockBadgeIpc(): void {
  ipcMain.handle("app:setInboxDockBadge", (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new Error("Expected a boolean.");
    requested = enabled;
    driver?.setEnabled(enabled);
  });
}

/**
 * Start counting. Unpackaged builds keep their `DEV` badge and never show a
 * count, so they start nothing; platforms with no badge start nothing either.
 */
export function startInboxDockBadge(options: { packaged: boolean }): void {
  if (!options.packaged || driver) return;
  const surface = badgeSurface(process.platform, app as unknown as BadgeApp);
  if (!surface) return;
  const current = createInboxBadgeDriver({
    surface,
    count,
    onError: (error) => logger.warn("inbox", "Could not count Needs you for the Dock badge.", error),
  });
  driver = current;
  const invalidate = (): void => current.invalidate();
  detachers = [
    onBroadcast((channel) => {
      if (BADGE_CHANNELS.has(channel)) invalidate();
    }),
    chatStore.onIndexChanged(invalidate),
    configStore.onWorkspacesChanged(invalidate),
    hostRunRegistry.onChange(invalidate),
  ];
  current.setEnabled(requested);
}

export function stopInboxDockBadge(): void {
  for (const detach of detachers) detach();
  detachers = [];
  driver?.dispose();
  driver = undefined;
}
