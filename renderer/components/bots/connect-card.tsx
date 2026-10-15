// Transcript connect card appended by the Bot's `suggest_connection` tool.
// The shared Bot notice card, with the app's icon in the squircle tile; no coloured borders.

import { Badge, Button } from "../ui";
import { cn } from "../../lib/ui-utils";
import { BotNoticeCard } from "./bot-notice-card";
import { McpPresetIcon } from "../settings/mcp-preset-icons";
import {
  connectionSuggestionFor,
  type BotConnectionSuggestion,
  type ConnectCardEntry,
} from "../../shared/bot-connections";

export function ConnectionIconTile({
  suggestion,
  size = "medium",
  className,
}: {
  suggestion: BotConnectionSuggestion;
  size?: "small" | "medium";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "squircle-control flex shrink-0 items-center justify-center bg-well text-strong",
        size === "small" ? "size-6" : "size-8",
        className,
      )}
    >
      <McpPresetIcon
        presetId={suggestion.iconId}
        name={suggestion.name}
        className={size === "small" ? "size-3.5" : "size-4.5"}
      />
    </span>
  );
}

export interface ConnectCardProps {
  card: ConnectCardEntry;
  onConnect: (pluginId: string) => void;
  onDismiss: (pluginId: string) => void;
  /** Visible Connect text; phones use "Finish on your Mac". The accessible name stays "Connect {name}". */
  connectLabel?: string;
  /** Setup or a connection request is in progress. */
  busy?: boolean;
}

export function ConnectCard({
  card,
  onConnect,
  onDismiss,
  connectLabel = "Connect",
  busy = false,
}: ConnectCardProps) {
  const suggestion = connectionSuggestionFor(card.pluginId);
  if (!suggestion) return null;
  const title = `Connect ${suggestion.name}`;

  if (card.status !== "pending") {
    const connected = card.status === "connected";
    return (
      <div
        role="group"
        aria-label={suggestion.name}
        data-connect-card-status={card.status}
        className="flex min-w-0 max-w-md items-center gap-3 rounded-card bg-well px-3 py-2.5"
      >
        <ConnectionIconTile suggestion={suggestion} size="small" className="bg-control" />
        <span className="min-w-0 flex-1 truncate text-regular text-primary">{suggestion.name}</span>
        {connected ? (
          <Badge color="green">
            Connected <span aria-hidden>✓</span>
          </Badge>
        ) : (
          <span className="shrink-0 text-small text-secondary">Not connected</span>
        )}
      </div>
    );
  }

  return (
    <div data-connect-card-status="pending" className="max-w-md">
      <BotNoticeCard
        label={title}
        iconTile={<ConnectionIconTile suggestion={suggestion} className="bg-control" />}
        title={title}
        actions={
          <>
            <Button
              variant="transparent"
              size="small"
              aria-label={`Not now for ${suggestion.name}`}
              onClick={() => onDismiss(card.pluginId)}
            >
              Not now
            </Button>
            <Button
              variant="accent"
              size="small"
              aria-label={title}
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() => onConnect(card.pluginId)}
            >
              {connectLabel}
            </Button>
          </>
        }
      >
        {card.reason}
      </BotNoticeCard>
    </div>
  );
}
