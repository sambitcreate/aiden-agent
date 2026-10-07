// Transcript connect card appended by the Bot's `suggest_connection` tool.
// Neutral surface, icon in the shared squircle tile, no coloured borders.

import { Button } from "../ui";
import { McpPresetIcon } from "../settings/mcp-preset-icons";
import {
  connectionSuggestionFor,
  type BotConnectionSuggestion,
  type ConnectCardEntry,
} from "../../shared/bot-connections";

export function ConnectionIconTile({
  suggestion,
  size = "medium",
}: {
  suggestion: BotConnectionSuggestion;
  size?: "small" | "medium";
}) {
  return (
    <span
      aria-hidden
      className={
        size === "small"
          ? "squircle-control flex size-6 shrink-0 items-center justify-center bg-well text-strong"
          : "squircle-control flex size-9 shrink-0 items-center justify-center bg-well text-strong"
      }
    >
      <McpPresetIcon
        presetId={suggestion.iconId}
        name={suggestion.name}
        className={size === "small" ? "size-3.5" : "size-5"}
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
        className="flex max-w-md items-center gap-3 rounded-2xl bg-control/50 px-3 py-2.5"
      >
        <ConnectionIconTile suggestion={suggestion} size="small" />
        <span className="min-w-0 flex-1 truncate text-regular text-primary">{suggestion.name}</span>
        {connected ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-status-green-surface px-2 py-0.5 text-small font-medium text-status-green">
            Connected <span aria-hidden>✓</span>
          </span>
        ) : (
          <span className="shrink-0 text-small text-secondary">Not connected</span>
        )}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={title}
      data-connect-card-status="pending"
      className="flex max-w-md flex-col gap-3 rounded-2xl bg-control/50 p-4"
    >
      <div className="flex min-w-0 items-start gap-3">
        <ConnectionIconTile suggestion={suggestion} />
        <div className="min-w-0 flex-1">
          <p className="text-strong font-medium text-primary">{title}</p>
          <p className="mt-0.5 text-regular leading-snug text-secondary [overflow-wrap:anywhere]">
            {card.reason}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="accent"
          size="medium"
          aria-label={title}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => onConnect(card.pluginId)}
        >
          {connectLabel}
        </Button>
        <Button
          variant="transparent"
          size="medium"
          aria-label={`Not now for ${suggestion.name}`}
          onClick={() => onDismiss(card.pluginId)}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
