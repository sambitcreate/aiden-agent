// Create-flow connection chips: each one starts that app's setup now.
// A new Bot gets Full access, which already covers every app connected on this
// Mac, so a chip is a "connect now" shortcut rather than a per-Bot selection.
// A connected app shows a check on a soft fill, never a coloured border.

import { Check } from "lucide-react";
import { Button } from "../ui";
import type { BotConnectionSuggestion } from "../../shared/bot-connections";
import { ConnectionIconTile } from "./connect-card";

export interface ConnectionChipsProps {
  /** Usually `rankConnections(answer, preset.suggestedConnections)`. */
  suggestions: readonly BotConnectionSuggestion[];
  /** Plugin ids already connected on this Mac. */
  connected: ReadonlySet<string>;
  /** Opens the setup for a suggestion that is not connected yet. */
  onConnect: (pluginId: string) => void;
  disabled?: boolean;
}

export function ConnectionChips({ suggestions, connected, onConnect, disabled = false }: ConnectionChipsProps) {
  return (
    <ul aria-label="Suggested connections" className="flex flex-wrap items-center gap-2">
      {suggestions.map((suggestion) => {
        if (connected.has(suggestion.pluginId)) {
          return (
            <li
              key={suggestion.pluginId}
              data-connection-chip={suggestion.pluginId}
              data-connected="true"
              className="squircle-control inline-flex h-9 items-center gap-2 bg-list-selection pl-1.5 pr-3 text-regular text-primary"
            >
              <ConnectionIconTile suggestion={suggestion} size="small" />
              <span>{suggestion.chipLabel}</span>
              <Check aria-hidden="true" className="size-3.5 text-status-green" />
              <span className="sr-only">connected</span>
            </li>
          );
        }
        return (
          <li key={suggestion.pluginId}>
            <Button
              variant="filled"
              size="large"
              aria-label={`Connect ${suggestion.name}`}
              data-connection-chip={suggestion.pluginId}
              className="pl-1.5 pr-3"
              disabled={disabled}
              onClick={() => onConnect(suggestion.pluginId)}
            >
              <ConnectionIconTile suggestion={suggestion} size="small" />
              <span className="text-regular">{suggestion.chipLabel}</span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
