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
  const focusedRef = React.useRef<HTMLElement | null>(null);
  const onFocusCapture = React.useCallback((event: React.FocusEvent<Section>) => {
    if (event.target instanceof HTMLElement) focusedRef.current = event.target;
  }, []);

  /** Call just before a collapse; remembers whether the header was stuck. */
  const noteCollapse = React.useCallback((automatic = false) => {
    const section = sectionRef.current;
    const header = headerRef.current;
    // Following a new message owns the scroll destination. A history reader
    // instead keeps the closing section's sticky header in view.
    if (automatic && section?.closest<HTMLElement>("[data-follow]")?.dataset.follow === "true") return;
    restorePendingRef.current = Boolean(
      section &&
        header &&
        stickyHeaderIsStuck(
          section.getBoundingClientRect().top,
          header.getBoundingClientRect().top,
        ),
    );
  }, []);
  const noteAutomaticCollapse = React.useCallback(() => noteCollapse(true), [noteCollapse]);

  /** Call once the collapsed layout is committed. Instant, so no motion. */
  const restoreAfterCollapse = React.useCallback(() => {
    const focused = focusedRef.current;
    const active = document.activeElement;
    if (focused && focused !== headerRef.current && (
      (active === focused && sectionRef.current?.contains(focused)) ||
      (!focused.isConnected && active === document.body)
    )) {
      headerRef.current?.focus({ preventScroll: true });
      focusedRef.current = null;
    }
    if (!restorePendingRef.current) return;
    restorePendingRef.current = false;
    sectionRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, []);

  return { sectionRef, headerRef, noteCollapse, noteAutomaticCollapse, restoreAfterCollapse, onFocusCapture };
}
