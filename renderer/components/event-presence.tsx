import * as React from "react";
import { usePresence } from "../lib/use-presence";

export function EventPresence({
  present,
  className,
  children,
}: {
  present: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const lastContentRef = React.useRef(children);
  const { rendered, exiting } = usePresence(present, ref);

  if (present) lastContentRef.current = children;

  if (!rendered) return null;
  return (
    <div
      ref={ref}
      className={`agent-event-presence ${className ?? ""}`}
      data-presence={exiting ? "exiting" : "visible"}
      aria-hidden={exiting ? "true" : undefined}
    >
      {present ? children : lastContentRef.current}
    </div>
  );
}
