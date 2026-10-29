// The video the agent recorded of a browser tab, under its activity line, so
// the owner can watch what the agent saw without hunting for the file. The
// bytes stay on this computer and load only when Play is pressed.

import * as React from "react";
import { FolderOpen, Play, Video } from "lucide-react";
import { Button } from "./ui";
import { browserApi } from "../lib/ipc";
import {
  browserRecordingDurationLabel,
  type BrowserRecordingRecapV1,
} from "../shared/browser-recording";

const IS_MAC = typeof navigator !== "undefined" && /Mac/u.test(navigator.userAgent);

type Playback =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; url: string }
  | { phase: "missing" };

/** `1.2 MB`, `640 KB`: a size people read at a glance. */
export function browserRecordingSizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function BrowserRecordingCard({ recording }: { recording: BrowserRecordingRecapV1 }) {
  const [playback, setPlayback] = React.useState<Playback>({ phase: "idle" });
  const [revealFailed, setRevealFailed] = React.useState(false);
  const urlRef = React.useRef<string | undefined>(undefined);
  // A load that finishes after the card left the screen is dropped, never turned into a URL.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = undefined;
    };
  }, []);

  const play = async () => {
    setPlayback({ phase: "loading" });
    try {
      const video = await browserApi.recording(recording.id);
      if (!mountedRef.current) return;
      if (!video) {
        setPlayback({ phase: "missing" });
        return;
      }
      const url = URL.createObjectURL(new Blob([video.data as BlobPart], { type: video.mimeType }));
      urlRef.current = url;
      setPlayback({ phase: "ready", url });
    } catch {
      if (mountedRef.current) setPlayback({ phase: "missing" });
    }
  };

  const reveal = async () => {
    try {
      await browserApi.revealRecording(recording.id);
      setRevealFailed(false);
    } catch {
      setRevealFailed(true);
    }
  };

  const duration = browserRecordingDurationLabel(recording.durationMs);
  const title = `Browser recording, ${duration}`;
  return (
    <section aria-label={title} className="browser-recording-card max-w-full rounded-card bg-well px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-small text-secondary">
          <Video aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">Browser recording</span>
          <span className="shrink-0 text-tertiary">
            {duration} · {browserRecordingSizeLabel(recording.sizeBytes)}
          </span>
        </p>
        <Button variant="transparent" size="small" onClick={() => void reveal()}>
          <FolderOpen aria-hidden="true" />
          {IS_MAC ? "Show in Finder" : "Show in folder"}
        </Button>
      </div>
      {playback.phase === "ready" ? (
        <video
          aria-label={title}
          className="mt-2.5 max-h-[360px] w-full rounded-control bg-black object-contain"
          controls
          autoPlay
          playsInline
          src={playback.url}
        />
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button size="small" disabled={playback.phase === "loading"} onClick={() => void play()}>
            <Play aria-hidden="true" />
            {playback.phase === "loading" ? "Loading…" : "Play"}
          </Button>
          {playback.phase === "missing" ? (
            <span role="status" className="text-small text-secondary">
              This recording is no longer on this computer.
            </span>
          ) : null}
        </div>
      )}
      {revealFailed && playback.phase !== "missing" ? (
        <p role="status" className="mt-2 text-small text-secondary">
          This recording is no longer on this computer.
        </p>
      ) : null}
    </section>
  );
}
