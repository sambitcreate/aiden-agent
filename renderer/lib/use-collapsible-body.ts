import * as React from "react";
import { prefersReducedMotion } from "./appearance-runtime";

/**
 * Keeps a collapsing body laid out until its grid-row transition finishes, and lays out an
 * expanding body at 0fr for one frame so the rows grow instead of appearing at full height.
 */
export function useCollapsibleBody(collapsed: boolean, body: React.RefObject<HTMLDivElement | null>) {
  const [rendered, setRendered] = React.useState(!collapsed);
  const [opened, setOpened] = React.useState(!collapsed);

  React.useLayoutEffect(() => {
    if (collapsed) {
      setOpened(false);
      if (prefersReducedMotion()) setRendered(false);
      return;
    }
    setRendered(true);
  }, [collapsed]);

  React.useLayoutEffect(() => {
    if (collapsed || !rendered || opened) return;
    // Commit the 0fr layout before switching to 1fr so the transition has a start value.
    void body.current?.offsetHeight;
    setOpened(true);
  }, [body, collapsed, opened, rendered]);

  const onTransitionEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (collapsed && event.target === event.currentTarget) setRendered(false);
  };

  return { hidden: !rendered, open: opened && !collapsed, onTransitionEnd };
}
