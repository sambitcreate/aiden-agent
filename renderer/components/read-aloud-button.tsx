// Read-aloud speaker action for the latest response footer.
//
// States follow the plan's footer contract: not configured opens settings,
// generating/playing turns the button into stop/cancel, and a second click
// always stops rather than cycling through hidden modes.

import { Loader2, Pause, Play, Square, Volume2 } from "lucide-react";
import { cn } from "../lib/ui-utils";

export interface ReadAloudActionProps {
  /** True when the active job belongs to this response. */
  active: boolean;
  phase: "not-configured" | "ready" | "busy" | "playing" | "paused" | "error";
  omissions: readonly string[];
  error?: string;
  onActivate: () => void;
  onStop: () => void;
  onTogglePause: () => void;
  className?: string;
}

export function ReadAloudButton({
  active,
  phase,
  omissions,
  error,
  onActivate,
  onStop,
  onTogglePause,
  className,
}: ReadAloudActionProps) {
  const omissionNotice = omissions.length > 0 ? omissions.join(", ") : null;

  const { icon, label, action } =
    phase === "playing"
      ? {
          icon: <Square aria-hidden="true" className="size-3.5" />,
          label: "Stop reading aloud",
          action: onStop,
        }
      : phase === "busy"
        ? {
            icon: (
              <Loader2
                aria-hidden="true"
                className="size-3.5 animate-spin motion-reduce:animate-none"
              />
            ),
            label: "Cancel speech generation",
            action: onStop,
          }
        : phase === "paused"
          ? {
              icon: <Play aria-hidden="true" className="size-3.5" />,
              label: "Resume reading aloud",
              action: onTogglePause,
            }
          : phase === "error"
            ? {
                icon: <Volume2 aria-hidden="true" className="size-3.5" />,
                label: "Retry reading aloud",
                action: onActivate,
              }
            : phase === "not-configured"
              ? {
                  icon: <Volume2 aria-hidden="true" className="size-3.5" />,
                  label: "Set up read aloud",
                  action: onActivate,
                }
              : {
                  icon: <Volume2 aria-hidden="true" className="size-3.5" />,
                  label: "Read response aloud",
                  action: onActivate,
                };

  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          action();
        }}
        aria-label={label}
        title={label}
        data-active={active}
        data-read-aloud-phase={phase}
        className={cn(
          "inline-flex items-center gap-1 squircle-control px-1.5 py-1 text-tertiary",
          "transition-[background-color,box-shadow,color] duration-150 ease-out hover:bg-list-hover hover:text-secondary active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none",
          active && "text-secondary",
          className,
        )}
      >
        {icon}
      </button>
      {active && phase === "playing" ? (
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            onTogglePause();
          }}
          aria-label="Pause reading aloud"
          title="Pause reading aloud"
          data-active={active}
          className={cn(
            "inline-flex items-center gap-1 squircle-control px-1.5 py-1 text-tertiary",
            "transition-[background-color,box-shadow,color] duration-150 ease-out hover:bg-list-hover hover:text-secondary active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none",
            className,
          )}
        >
          <Pause aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
      {active && phase === "paused" ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop reading aloud"
          title="Stop reading aloud"
          data-active={active}
          className={cn(
            "squircle-control px-1.5 py-1 text-tertiary hover:bg-list-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
            className,
          )}
        >
          <Square aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
      {omissionNotice ? <span className="text-mini text-tertiary">{omissionNotice}</span> : null}
      {error ? (
        <span className="text-mini text-secondary" role="alert">
          {error}
        </span>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {active ? label : ""}
      </span>
    </span>
  );
}
