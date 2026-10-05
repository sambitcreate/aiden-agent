import { Bot, Loader2 } from "lucide-react";
import type { RemoteBotGroup } from "../lib/hosts/new-chat-targets";
import { RemoteHostMarker } from "./sidebar-remote";
import { Text } from "./ui";

/**
 * Bots that live on paired Macs, grouped by Mac. Opening one opens its chat on
 * that Mac; nothing about a remote Bot is stored or run on this one.
 */
export function RemoteBotsSection({
  groups,
  opening,
  onOpen,
}: {
  groups: readonly RemoteBotGroup[];
  /** `hostId/botId` of the Bot whose chat is being opened. */
  opening: string | null;
  onOpen(hostId: string, botId: string): void;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="mt-10 space-y-8" data-remote-bots="true">
      {groups.map(({ host, bots }) => (
        <section key={host.id} aria-labelledby={`remote-bots-${host.id}`}>
          <div className="flex items-center gap-1.5">
            <RemoteHostMarker hostLabel={host.label} stale={host.availability !== "online"} />
            <Text id={`remote-bots-${host.id}`} as="h2" variant="small-strong" color="secondary">
              {`On ${host.label}`}
            </Text>
          </div>
          {host.disabledReason ? (
            <Text as="p" variant="small" color="tertiary" className="mt-1">
              {host.disabledReason}
            </Text>
          ) : null}
          <div className="mt-2 grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
            {bots.map((bot) => {
              const busy = opening === `${host.id}/${bot.id}`;
              return (
                <button
                  key={bot.id}
                  type="button"
                  disabled={Boolean(host.disabledReason) || opening !== null}
                  aria-busy={busy || undefined}
                  aria-label={`${bot.name}, on ${host.label}`}
                  className="flex min-h-28 items-start gap-3 rounded-card bg-well p-4 text-left outline-none transition-[background-color,box-shadow] duration-150 hover:bg-control-hover hover:shadow-control focus-visible:bg-control-hover disabled:cursor-default disabled:opacity-60 disabled:hover:bg-well disabled:hover:shadow-none"
                  onClick={() => onOpen(host.id, bot.id)}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-control text-secondary" aria-hidden="true">
                    {busy ? <Loader2 className="size-4.5 animate-spin" /> : <Bot className="size-4.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <Text as="span" variant="strong" className="block truncate">
                      {bot.name}
                    </Text>
                    <Text as="span" variant="small" color="secondary" className="mt-1 line-clamp-2 block">
                      {bot.purpose ?? `A Bot on ${host.label}.`}
                    </Text>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
