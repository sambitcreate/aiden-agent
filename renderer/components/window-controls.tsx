import * as React from "react";
import { Button } from "./ui";
import { windowControlsApi } from "../lib/ipc";
import {
  setWindowControlsState,
  setWindowControlsWidth,
  useWindowChrome,
  useWindowControlsSnapshot,
} from "../lib/window-chrome";

// Glyphs drawn for these controls: 24px grid, 2px rounded strokes, like the
// app's other custom icons. Lucide has no restore glyph.
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-3.5"
    >
      {children}
    </svg>
  );
}

const MinimizeGlyph = () => <Glyph><path d="M6 12h12" /></Glyph>;
const MaximizeGlyph = () => <Glyph><rect x="6" y="6" width="12" height="12" rx="2" /></Glyph>;
const RestoreGlyph = () => (
  <Glyph>
    <rect x="5" y="9" width="10" height="10" rx="2" />
    <path d="M9 9V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2" />
  </Glyph>
);
const CloseGlyph = () => <Glyph><path d="M7 7l10 10M17 7 7 17" /></Glyph>;

/**
 * Minimize, maximize/restore and close, drawn by Aiden at the right end of the
 * 52px top bar when the Linux window has no desktop title bar. Hidden in full
 * screen. Clicks go to the main process, which owns the window; closing takes
 * the same guarded path as any other close.
 */
export function WindowControls() {
  const chrome = useWindowChrome();
  const { maximized, fullScreen } = useWindowControlsSnapshot();
  const clusterRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (chrome !== "aiden") return;
    let active = true;
    void windowControlsApi.state().then((state) => {
      if (active && state) setWindowControlsState(state);
    }, () => undefined);
    const stop = windowControlsApi.onStateChanged(setWindowControlsState);
    return () => {
      active = false;
      stop();
    };
  }, [chrome]);

  React.useLayoutEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster) {
      setWindowControlsWidth(0);
      return;
    }
    const measure = () => setWindowControlsWidth(cluster.getBoundingClientRect().width);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(cluster);
    return () => {
      observer?.disconnect();
      setWindowControlsWidth(0);
    };
  }, [chrome, fullScreen]);

  if (chrome !== "aiden" || fullScreen) return null;

  const toggleMaximize = () => {
    void windowControlsApi.toggleMaximize().then((state) => {
      if (state) setWindowControlsState(state);
    }, () => undefined);
  };

  return (
    <div
      ref={clusterRef}
      role="group"
      aria-label="Window"
      data-window-controls
      // Above every dialog layer, including setup's own dialogs (z-70), so the
      // window can always be minimized or closed.
      className="no-drag pointer-events-auto fixed right-0 top-0 z-[80] flex h-13 items-center gap-1 pl-1 pr-3"
      // A window action is not a click outside an open dialog or popover: keep
      // the press from reaching their outside-press listeners on the document,
      // so minimizing never closes a dialog and loses what was typed in it.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span aria-hidden="true" className="mr-1 h-4 w-px bg-separator" />
      <Button
        iconOnly
        size="small"
        variant="bar"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void windowControlsApi.minimize().catch(() => undefined)}
      >
        <MinimizeGlyph />
      </Button>
      <Button
        iconOnly
        size="small"
        variant="bar"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={toggleMaximize}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </Button>
      <Button
        iconOnly
        size="small"
        variant="bar"
        aria-label="Close"
        title="Close window"
        data-window-close
        onClick={() => void windowControlsApi.close().catch(() => undefined)}
      >
        <CloseGlyph />
      </Button>
    </div>
  );
}
