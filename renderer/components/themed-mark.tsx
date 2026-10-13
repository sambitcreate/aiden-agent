// Shared rendering for monochrome brand marks. A mark is drawn as a CSS mask
// filled with `currentColor`, so it follows Aiden's semantic text colors in
// every theme; a missing mark falls back to a neutral initial tile.

import type * as React from "react";
import { cn } from "../lib/ui-utils";

const THEMED_MARK_STYLE = {
  backgroundColor: "currentColor",
  WebkitMaskPosition: "center",
  maskPosition: "center",
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
  WebkitMaskSize: "contain",
  maskSize: "contain",
} as const;

type MarkProps = Omit<React.HTMLAttributes<HTMLSpanElement>, "style" | "children">;

/** A mono SVG mark painted in `currentColor`. Callers add their own `data-*` hook. */
export function ThemedMark({
  iconUrl,
  className,
  ...props
}: MarkProps & { iconUrl: string }) {
  return (
    <span
      aria-hidden="true"
      {...props}
      className={cn("inline-block shrink-0", className)}
      style={{
        ...THEMED_MARK_STYLE,
        WebkitMaskImage: `url("${iconUrl}")`,
        maskImage: `url("${iconUrl}")`,
      }}
    />
  );
}

/** Neutral initial shown when no mark exists for a label. */
export function MarkInitial({
  label,
  className,
  ...props
}: MarkProps & { label: string }) {
  const initial = label.trim().charAt(0).toLocaleUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      {...props}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[28%] bg-control text-[0.62em] font-semibold leading-none text-secondary",
        className,
      )}
    >
      {initial}
    </span>
  );
}
