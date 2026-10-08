// Send control while a response runs: one pill whose label sends in the current
// mode (Steer or Queue). The chevron opens the mode menu, and so does holding the
// label; keep holding, drag onto a mode, and release to send in that mode
// (Radix menu items select on pointer-up when the press began elsewhere).

import * as React from "react";
import { ChevronDown } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui";
import { cn } from "../lib/ui-utils";

export type BusySendMode = "steer" | "queue";

export const BUSY_SEND_MODES: ReadonlyArray<{
  mode: BusySendMode;
  label: string;
  detail: string;
  actionLabel: string;
}> = [
  { mode: "steer", label: "Steer", detail: "Add guidance without stopping", actionLabel: "Steer response" },
  { mode: "queue", label: "Queue", detail: "Run after this response", actionLabel: "Queue message" },
];

export const BUSY_SEND_HOLD_MS = 450;

interface Props {
  mode: BusySendMode;
  /** Nothing to send yet (empty draft, Stop settling, input locked). The menu still opens. */
  canSubmit: boolean;
  steerAvailable: boolean;
  onSubmit: (mode: BusySendMode) => void;
  onModeChange: (mode: BusySendMode) => void;
}

export function BusySendButton({
  mode,
  canSubmit,
  steerAvailable,
  onSubmit,
  onModeChange,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [holding, setHolding] = React.useState(false);
  const holdTimerRef = React.useRef<number | null>(null);
  const openedByHoldRef = React.useRef(false);
  const current = BUSY_SEND_MODES.find((entry) => entry.mode === mode) ?? BUSY_SEND_MODES[1];

  const cancelHold = React.useCallback(() => {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    setHolding(false);
  }, []);
  React.useEffect(() => cancelHold, [cancelHold]);

  const openMenu = () => {
    cancelHold();
    openedByHoldRef.current = true;
    setOpen(true);
  };

  // Picking a mode also sends the draft in that mode; with nothing to send it only switches.
  const pick = (next: BusySendMode) => {
    onModeChange(next);
    if (canSubmit) onSubmit(next);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "busy-send-button squircle-action-group squircle-control flex shrink-0 items-center shadow-control transition-opacity duration-150",
          !canSubmit && "opacity-60",
        )}
      >
        <Button
          variant="accent"
          size="small"
          className="relative overflow-hidden pr-1 pl-2.5 shadow-none hover:shadow-none active:shadow-none"
          aria-label={current.actionLabel}
          aria-disabled={!canSubmit || undefined}
          title="Click to send · hold for options"
          data-holding={holding || undefined}
          onPointerDown={(event) => {
            openedByHoldRef.current = false;
            if (event.button !== 0) return;
            cancelHold();
            setHolding(true);
            holdTimerRef.current = window.setTimeout(openMenu, BUSY_SEND_HOLD_MS);
          }}
          onPointerUp={cancelHold}
          onPointerLeave={cancelHold}
          onPointerCancel={cancelHold}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              openMenu();
            }
          }}
          onClick={(event) => {
            // A hold that opened the menu is not also a send. Keyboard clicks have no detail.
            if (event.detail !== 0 && openedByHoldRef.current) return;
            if (canSubmit) onSubmit(mode);
          }}
        >
          <span key={mode} className="busy-send-label relative">
            {current.label}
          </span>
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            variant="accent"
            size="small"
            iconOnly
            className="w-6 shadow-none hover:shadow-none active:shadow-none"
            aria-label="Choose message action"
          >
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent side="top" align="end" className="w-64">
        <DropdownMenuRadioGroup value={mode}>
          {BUSY_SEND_MODES.map((entry) => (
            <DropdownMenuRadioItem
              key={entry.mode}
              value={entry.mode}
              disabled={entry.mode === "steer" && !steerAvailable}
              onSelect={() => pick(entry.mode)}
              className="py-1.5"
            >
              <span className="flex min-w-0 flex-col">
                <span>{entry.label}</span>
                <span className="text-small text-tertiary group-data-[highlighted]:text-accent-foreground">
                  {entry.detail}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
