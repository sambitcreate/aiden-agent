import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Info } from "lucide-react";
import { cn } from "../lib/ui-utils";

/** Pointer rest before a hovered hint opens, and grace before it closes. */
const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 120;

/**
 * A small ⓘ button that explains one thing in at most two short sentences.
 *
 * It opens on hover (after a short delay) and on keyboard focus without taking
 * focus, and click, Enter or Space pins it open until the next press, Escape,
 * blur or an outside click. Use it only where a concise explanation would
 * otherwise be a paragraph on the page.
 */
export function InfoHint({
  topic,
  children,
  side = "bottom",
  align = "start",
  className,
}: {
  /** What the hint explains; the button is named "About <topic>". */
  topic: string;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  // A pinned hint (opened by click, Enter or Space) ignores pointer leave.
  const pinnedRef = React.useRef(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentId = React.useId();

  const clearTimer = () => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  };
  const show = (pinned: boolean) => {
    clearTimer();
    if (pinned) pinnedRef.current = true;
    setOpen(true);
  };
  const hide = () => {
    clearTimer();
    pinnedRef.current = false;
    setOpen(false);
  };
  const toggle = () => {
    if (open && pinnedRef.current) hide();
    else show(true);
  };

  React.useEffect(() => clearTimer, []);

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) hide();
      }}
    >
      <PopoverPrimitive.Anchor asChild>
        <button
          ref={triggerRef}
          type="button"
          aria-label={`About ${topic}`}
          aria-expanded={open}
          aria-describedby={open ? contentId : undefined}
          data-slot="info-hint"
          className={cn(
            "info-hint inline-grid size-[1.125rem] shrink-0 cursor-default place-items-center rounded-full text-tertiary outline-none transition-colors duration-(--motion-duration) ease-standard hover:bg-control hover:text-primary aria-expanded:bg-control aria-expanded:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
            className,
          )}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            clearTimer();
            if (!open) timerRef.current = setTimeout(() => show(false), OPEN_DELAY_MS);
          }}
          onPointerLeave={() => {
            clearTimer();
            if (open && !pinnedRef.current && document.activeElement !== triggerRef.current) {
              timerRef.current = setTimeout(hide, CLOSE_DELAY_MS);
            }
          }}
          onFocus={() => {
            if (!open) show(false);
          }}
          onBlur={hide}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            // Handle the key here so a pinned hint toggles once, not on keydown and click.
            event.preventDefault();
            toggle();
          }}
        >
          <Info aria-hidden="true" className="size-3.5" />
        </button>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          id={contentId}
          role="tooltip"
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          data-slot="popover-content"
          // The hint explains its button; focus stays there.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // The button handles its own presses.
            if (triggerRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
          onPointerEnter={clearTimer}
          onPointerLeave={() => {
            if (!pinnedRef.current && document.activeElement !== triggerRef.current) {
              timerRef.current = setTimeout(hide, CLOSE_DELAY_MS);
            }
          }}
          className="info-hint-content z-[70] max-w-64 origin-[var(--radix-popover-content-transform-origin)] rounded-popover bg-popover px-3 py-2.5 text-small text-secondary shadow-popover outline-none [&_b]:font-semibold [&_b]:text-primary [&_p+p]:mt-1.5"
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
