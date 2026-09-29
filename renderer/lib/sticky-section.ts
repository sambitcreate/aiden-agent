import * as React from "react";

/**
 * A sticky header is "stuck" once its section has scrolled above it. Collapsing
 * from that position would otherwise leave the reader wherever the vanished
 * body used to be, so the section is scrolled back to the header's resting
 * position after it closes.
 */
export function stickyHeaderIsStuck(sectionTop: number, headerTop: number): boolean {
  return headerTop - sectionTop > 1;
}

export function useStickySectionCollapse<
  Section extends HTMLElement,
  Header extends HTMLElement,
>() {
  const sectionRef = React.useRef<Section>(null);
  const headerRef = React.useRef<Header>(null);
  const restorePendingRef = React.useRef(false);

  /** Call just before a collapse; remembers whether the header was stuck. */
  const noteCollapse = React.useCallback(() => {
    const section = sectionRef.current;
    const header = headerRef.current;
    restorePendingRef.current = Boolean(
      section &&
        header &&
        stickyHeaderIsStuck(
          section.getBoundingClientRect().top,
          header.getBoundingClientRect().top,
        ),
    );
  }, []);

  /** Call once the collapsed layout is committed. Instant, so no motion. */
  const restoreAfterCollapse = React.useCallback(() => {
    if (!restorePendingRef.current) return;
    restorePendingRef.current = false;
    sectionRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, []);

  return { sectionRef, headerRef, noteCollapse, restoreAfterCollapse };
}
