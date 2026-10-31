import { Bot, Loader2 } from "lucide-react";
import type { RemoteBotGroup } from "../lib/hosts/new-chat-targets";
import { matchesSearch } from "../lib/search-fold";
import { RemoteHostMarker } from "./sidebar-remote";
import { cn } from "../lib/ui-utils";
import { BOT_INTERRUPTED_ROW_LABEL, BOT_PAUSED_ROW_LABEL } from "../main/bots/bot-session-state";
import { Text } from "./ui";

/** The paired Macs' Bots that match the sidebar's search; a Mac with none is left out. */
export function remoteBotGroupsMatching(groups: readonly RemoteBotGroup[], query: string): RemoteBotGroup[] {
  return groups
    .map(({ host, bots }) => ({ host, bots: bots.filter((bot) => matchesSearch([bot.name, bot.purpose ?? ""], query)) }))
    .filter((group) => group.bots.length > 0);
}

/**
 * Bots that live on paired Macs, grouped by Mac, as rows in the Bots sidebar.
 * Opening one opens its chat on that Mac; nothing about a remote Bot is stored
 * or run on this one. The sidebar narrows `groups` with its search first
 * (`remoteBotGroupsMatching`).
 */
export function RemoteBotsSection({
  groups,
  opening,
  selected = null,
  onOpen,
}: {
  groups: readonly RemoteBotGroup[];
  /** `hostId/botId` of the Bot whose chat is being opened. */
  opening: string | null;
  /** `hostId/botId` of the Bot whose chat is open. */
  selected?: string | null;
  onOpen(hostId: string, botId: string): void;
}) {
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
          <ul className="flex flex-col gap-0.5">
            {bots.map((bot) => {
              const status = bot.working
                ? { label: "Working…", spoken: ", working" }
                : bot.status === "paused"
                  ? { label: BOT_PAUSED_ROW_LABEL, spoken: ", paused" }
                  : bot.status === "interrupted"
                    ? { label: BOT_INTERRUPTED_ROW_LABEL, spoken: ", interrupted" }
                    : null;
              const busy = opening === `${host.id}/${bot.id}`;
              const current = selected === `${host.id}/${bot.id}`;
              return (
                <li key={bot.id}>
                  <button
                    type="button"
                    data-roving-item
                    disabled={Boolean(host.disabledReason) || opening !== null}
                    aria-busy={busy || undefined}
                    aria-current={current ? "page" : undefined}
                    aria-label={`${bot.name}, on ${host.label}${status?.spoken ?? ""}`}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2.5 rounded-control px-2 py-1.5 text-left outline-none transition-[background-color] duration-(--motion-duration) ease-standard hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent motion-reduce:transition-none",
                      current && "bg-list-selection hover:bg-list-selection",
                    )}
                    onClick={() => onOpen(host.id, bot.id)}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-card bg-control text-secondary" aria-hidden="true">
                      {busy ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <Bot className="size-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-regular font-medium text-primary">{bot.name}</span>
                      <span
                        className={cn("mt-0.5 block truncate text-small text-secondary", bot.working && "agent-thinking-shimmer")}
                      >
                        {status?.label ?? bot.purpose ?? `A Bot on ${host.label}.`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
