// Create-flow connection chips: optional, toggleable, with a one-tap Skip.
// Selection uses a soft fill and a check, never a coloured border.

import { Check } from "lucide-react";
import { Button } from "../ui";
import { cn } from "../../lib/ui-utils";
import type { BotConnectionSuggestion } from "../../shared/bot-connections";
import { ConnectionIconTile } from "./connect-card";

/** Next selection after pressing a chip; never mutates the previous set. */
export function toggleConnection(selected: ReadonlySet<string>, pluginId: string): Set<string> {
  const next = new Set(selected);
  if (next.has(pluginId)) next.delete(pluginId);
  else next.add(pluginId);
  return next;
}

export interface ConnectionChipsProps {
  /** Usually `rankConnections(answer, preset.suggestedConnections)`. */
  suggestions: readonly BotConnectionSuggestion[];
  selected: ReadonlySet<string>;
  onToggle: (pluginId: string) => void;
  /** Shows a Skip action when provided. */
  onSkip?: () => void;
}

export function ConnectionChips({ suggestions, selected, onToggle, onSkip }: ConnectionChipsProps) {
  return (
    <div role="group" aria-label="Suggested connections" className="flex flex-wrap items-center gap-2">
      {suggestions.map((suggestion) => {
        const pressed = selected.has(suggestion.pluginId);
        return (
          <Button
            key={suggestion.pluginId}
            variant={pressed ? "muted" : "transparent"}
            size="large"
            aria-label={`Connect ${suggestion.name}`}
            aria-pressed={pressed}
            data-connection-chip={suggestion.pluginId}
            className={cn("pl-1.5 pr-3", pressed ? "bg-list-selection" : "bg-control/40")}
            onClick={() => onToggle(suggestion.pluginId)}
          >
            <ConnectionIconTile suggestion={suggestion} size="small" />
            <span className="text-regular">{suggestion.chipLabel}</span>
            {pressed ? <Check aria-hidden className="size-3.5 text-secondary" /> : null}
          </Button>
        );
      })}
      {onSkip ? (
        <Button variant="transparent" size="large" aria-label="Skip" onClick={onSkip}>
          Skip
        </Button>
      ) : null}
    </div>
  );
}
