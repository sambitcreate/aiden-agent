// The newest words of a live transcript, kept in view at the end of the
// one-line pill: older words slide off the start under a soft fade.

import * as React from "react";
import type { LiveTranscriptSnapshot } from "../lib/live-pcm-capture";
import { cn } from "../lib/ui-utils";

export function LiveTranscriptTail({ transcript }: { transcript: LiveTranscriptSnapshot }) {
  const viewport = React.useRef<HTMLSpanElement>(null);
  const line = React.useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = React.useState(false);
  React.useLayoutEffect(() => {
    // The line overflows toward the start, which scrollWidth does not count.
    const width = viewport.current?.clientWidth ?? 0;
    setClipped((line.current?.offsetWidth ?? 0) > width + 1);
  }, [transcript.committed, transcript.tentative]);
  return (
    <span
      ref={viewport}
      aria-label="Live transcription"
      className={cn(
        "flex min-w-0 max-w-48 justify-end overflow-hidden whitespace-nowrap text-small",
        clipped && "[mask-image:linear-gradient(to_right,transparent,#000_1.5rem)]",
      )}
    >
      <span ref={line} className="shrink-0">
        <span className="text-primary">{transcript.committed}</span>
        {transcript.committed && transcript.tentative ? " " : null}
        <span className="text-tertiary">{transcript.tentative}</span>
      </span>
    </span>
  );
}
