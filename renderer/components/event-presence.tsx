import * as React from "react";

const EXIT_MS = 180;

export function EventPresence({
  present,
  className,
  children,
}: {
  present: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const lastContentRef = React.useRef(children);
  const [rendered, setRendered] = React.useState(present);
  const [exiting, setExiting] = React.useState(false);

  if (present) lastContentRef.current = children;

  React.useEffect(() => {
    if (present) {
      setRendered(true);
      setExiting(false);
      return;
    }
    if (!rendered) return;
    if (document.documentElement.dataset.reduceMotion === "true") {
      setRendered(false);
      setExiting(false);
      return;
    }
    setExiting(true);
    const timer = window.setTimeout(() => {
      setRendered(false);
      setExiting(false);
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [present, rendered]);

  if (!rendered) return null;
  return (
    <div
      className={`agent-event-presence ${className ?? ""}`}
      data-presence={exiting ? "exiting" : "visible"}
      aria-hidden={exiting ? "true" : undefined}
    >
      {present ? children : lastContentRef.current}
    </div>
  );
}
