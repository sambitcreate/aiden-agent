import * as React from "react";
import { usePresence } from "../lib/use-presence";

export interface ComposerPopoverPresenceChildProps {
  presenceState?: "visible" | "exiting";
  presenceRef?: React.Ref<HTMLDivElement>;
}

export function ComposerPopoverPresence<P extends ComposerPopoverPresenceChildProps>({
  present,
  immediate = false,
  children,
}: {
  present: boolean;
  immediate?: boolean;
  children: React.ReactElement<P> | null;
}) {
  const lastContentRef = React.useRef(children);
  const ref = React.useRef<HTMLDivElement>(null);
  const { rendered, exiting } = usePresence(present, ref);
  React.useLayoutEffect(() => {
    if (present && children) lastContentRef.current = children;
  }, [children, present]);

  // An immediate close (a command ran, the draft was sent) skips the exit.
  if (!rendered || (!present && immediate)) return null;
  const content = present ? children : lastContentRef.current;
  return content
    ? React.cloneElement(content, {
        presenceState: exiting ? "exiting" : "visible",
        presenceRef: ref,
      } as Partial<P>)
    : null;
}
