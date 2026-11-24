import * as React from "react";
import { Bot, Loader2 } from "lucide-react";
import type { NewChatMachine, RemoteBotChoice, RemoteBotGroup } from "../lib/hosts/new-chat-targets";
import { useRemoteBotPhoto } from "../lib/hosts/remote-images";
import { isRemoteBotUnread, markRemoteBotHostListed, useRemoteBotSeen } from "../lib/remote-bot-seen";
import { matchesSearch } from "../lib/search-fold";
import { RemoteHostMarker } from "./sidebar-remote";
import { cn } from "../lib/ui-utils";
import {
  BOT_INTERRUPTED_ROW_LABEL,
  BOT_NEEDS_MODEL_LABEL,
  BOT_PAUSED_ROW_LABEL,
} from "../main/bots/bot-session-state";
import { BOT_WAITING_LINE, BOT_WORKING_LINE } from "../main/bots/bot-sidebar-rows";
import { Text } from "./ui";
import { pauseWhenUnseen } from "../lib/offscreen-pause";
import { BotAvatar } from "./bot-avatar";
import { BotNeedsYouBadge } from "./bot-needs-you-badge";
import { BotUnreadDot } from "./bot-unread-dot";

type RemoteBotLine = { kind: "waiting" | "working" | "status" | "preview"; text: string; spoken: string };

const STATUS_LINES = {
  paused: { text: BOT_PAUSED_ROW_LABEL, spoken: "paused" },
  interrupted: { text: BOT_INTERRUPTED_ROW_LABEL, spoken: "interrupted" },
  needs_model: { text: BOT_NEEDS_MODEL_LABEL, spoken: "needs an AI model" },
} as const;

/**
 * A paired Mac's Bot's one line, in the order this Mac's own Bot rows use:
 * waiting on the person, then a running turn, then why it stopped, then the
 * last message (revision 66 hosts send it). The Bot's description is never
 * the line; it is searchable and read as the row's description when there is
 * no message.
 */
export function remoteBotLine(bot: RemoteBotChoice): RemoteBotLine | null {
  if (bot.needsYou) return { kind: "waiting", text: BOT_WAITING_LINE, spoken: "needs you" };
  if (bot.working) return { kind: "working", text: BOT_WORKING_LINE, spoken: "working" };
  if (bot.status) return { kind: "status", ...STATUS_LINES[bot.status] };
  if (bot.preview) return { kind: "preview", text: bot.preview, spoken: bot.preview };
  return null;
}

/**
 * The paired Macs' Bots that match the sidebar's search; a Mac with none is
 * left out. A Mac that lists no Bots only for a reason (an old pairing) shows
 * that reason until the person searches.
 */
export function remoteBotGroupsMatching(groups: readonly RemoteBotGroup[], query: string): RemoteBotGroup[] {
  const searching = query.trim().length > 0;
  return groups
    .map(({ host, bots }) => ({ host, bots: bots.filter((bot) => matchesSearch([bot.name, bot.purpose ?? ""], query)) }))
    .filter((group) => group.bots.length > 0 || (!searching && group.host.disabledReason !== undefined));
}

/**
 * Bots that live on paired Macs, grouped by Mac, as rows in the Bots sidebar.
 * Opening one opens its chat on that Mac; nothing about a remote Bot is stored
 * or run on this one. The sidebar narrows `groups` with its search first
 * (`remoteBotGroupsMatching`) and passes every Bot as `listed`.
 */
export function RemoteBotsSection({
  groups,
  listed = groups,
  opening,
  selected = null,
  onOpen,
}: {
  groups: readonly RemoteBotGroup[];
  /**
   * Every paired Mac's Bots before search narrows `groups`. A host's unread
   * baseline is taken from these, since a search that hides some of a host's
   * Bots would leave their replies out of it.
   */
  listed?: readonly RemoteBotGroup[];
  /** `hostId/botId` of the Bot whose chat is being opened; a click on any row waits for it. */
  opening: string | null;
  /** `hostId/botId` of the Bot whose chat is open. */
  selected?: string | null;
  onOpen(hostId: string, botId: string): void;
}) {
  const seen = useRemoteBotSeen();
  // The replies a host's Bots had when this Mac first lists them start read.
  // The open Bot's chat records what it shows itself (`RemoteBotChatView`).
  React.useEffect(() => {
    for (const { host, bots } of listed) markRemoteBotHostListed(host.id, bots);
  }, [listed]);
  if (groups.length === 0) return null;
  return (
    <div className="mt-5 flex flex-col gap-5" data-remote-bots="true">
      {groups.map(({ host, bots }) => (
        <section key={host.id} aria-labelledby={`remote-bots-${host.id}`}>
          <div className="mb-1 flex items-center gap-1.5 px-2">
            <RemoteHostMarker hostLabel={host.label} stale={host.availability !== "online"} />
            <Text id={`remote-bots-${host.id}`} as="h2" variant="small-strong" color="tertiary">
              {`On ${host.label}`}
            </Text>
          </div>
          {host.disabledReason ? (
            <Text as="p" variant="small" color="tertiary" className="mb-1 px-2">
              {host.disabledReason}
            </Text>
          ) : null}
          {bots.length === 0 ? null : <ul className="flex flex-col gap-0.5">
            {bots.map((bot) => {
              const key = `${host.id}/${bot.id}`;
              const current = selected === key;
              return (
                <RemoteBotRow
                  key={bot.id}
                  host={host}
                  bot={bot}
                  busy={opening === key}
                  current={current}
                  unread={!current && isRemoteBotUnread(seen, host.id, bot.id, bot.lastReplyAt)}
                  onOpen={onOpen}
                />
              );
            })}
          </ul>}
        </section>
      ))}
    </div>
  );
}

function RemoteBotRow({
  host,
  bot,
  busy,
  current,
  unread,
  onOpen,
}: {
  host: NewChatMachine;
  bot: RemoteBotChoice;
  busy: boolean;
  current: boolean;
  unread: boolean;
  onOpen(hostId: string, botId: string): void;
}) {
  const line = remoteBotLine(bot);
  const key = `${host.id}/${bot.id}`;
  const unavailable = Boolean(host.disabledReason);
  const photoUrl = useRemoteBotPhoto(host.id, bot.id, bot.photo, !unavailable);
  const working = Boolean(bot.working) && !bot.needsYou;
  return (
    <li>
      <button
        type="button"
        data-roving-item
        data-remote-bot-row={key}
        // Only the opening row waits; the others stay reachable by click and arrow keys.
        disabled={unavailable}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        aria-current={current ? "page" : undefined}
        aria-label={`${bot.name}, on ${host.label}${line && line.kind !== "preview" ? `, ${line.spoken}` : ""}${unread ? ", unread" : ""}`}
        aria-description={line?.kind === "preview" ? line.text : bot.purpose}
        className={cn(
          "flex w-full min-w-0 items-center gap-2.5 rounded-control px-2 py-1.5 text-left outline-none transition-[background-color] duration-(--motion-duration) ease-standard hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent motion-reduce:transition-none",
          current && "bg-list-selection hover:bg-list-selection",
        )}
        onClick={() => onOpen(host.id, bot.id)}
      >
        {busy || !bot.avatar ? (
          <span className="grid size-9 shrink-0 place-items-center rounded-card bg-control text-secondary" aria-hidden="true">
            {busy ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <Bot className="size-4" />}
          </span>
        ) : (
          <span aria-hidden="true" className="shrink-0">
            <BotAvatar avatar={bot.avatar} name={bot.name} size="medium" photoUrl={photoUrl} working={working} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5" aria-hidden="true">
            <span className="truncate text-regular font-medium text-primary">{bot.name}</span>
            {/* "Needs you" outranks the dot, as on this Mac's own rows. */}
            {unread && line?.kind !== "waiting" ? <BotUnreadDot /> : null}
          </span>
          {line ? (
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5" aria-hidden="true">
              {line.kind === "waiting" ? <BotNeedsYouBadge /> : null}
              <span
                ref={line.kind === "working" ? pauseWhenUnseen : undefined}
                className={cn(
                  "block min-w-0 truncate text-small text-secondary",
                  line.kind === "working" && "agent-thinking-shimmer",
                )}
              >
                {line.text}
              </span>
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
