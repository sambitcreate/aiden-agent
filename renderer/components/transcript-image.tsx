import * as React from "react";
import { transcriptImagesApi } from "../lib/ipc";
import type { TranscriptImage as LoadedImage } from "../shared/transcript-images";
import { Button } from "./ui";

/** Only a click starts IPC. The original URL is never an image/preload/CSS source. */
export function TranscriptImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const [image, setImage] = React.useState<LoadedImage | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const descriptionId = React.useId();
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Relative paths would resolve against the development loopback or installed
  // file document. Keep the Markdown sanitizer's other scheme decisions intact.
  if (!src || !/^(?:https?:\/\/|\/\/)/iu.test(src)) {
    return alt ? <span className="text-secondary">{alt}</span> : null;
  }
  const load = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const loaded = await transcriptImagesApi.load(src);
      if (mounted.current) setImage(loaded);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "This image could not be loaded.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  if (image) {
    return <img src={`data:${image.mimeType};base64,${image.data}`} alt={alt ?? ""} title={title}
      width={image.width} height={image.height} decoding="async"
      onError={() => { setImage(null); setError("This image could not be decoded."); }}
      className="inline-block h-auto max-h-[32rem] max-w-full rounded-card object-contain" />;
  }
  let host = "External image";
  try { host = new URL(src.startsWith("//") ? `https:${src}` : src).host; } catch { /* Main validates on click. */ }
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-2 rounded-card bg-control px-3 py-2 align-middle" title={title}>
      <span id={descriptionId} className="min-w-0 break-words text-small text-secondary">{alt || "External image"} <span className="text-tertiary">({host})</span></span>
      <Button size="small" variant="muted" disabled={loading} aria-describedby={descriptionId} onClick={(event) => {
        // Markdown can put an image inside a link. Loading it must not also
        // activate that enclosing link or the transcript's delegated router.
        event.preventDefault();
        event.stopPropagation();
        void load();
      }}>
        {loading ? "Loading image…" : "Load image"}
      </Button>
      {error ? <span role="status" className="basis-full text-small text-secondary">{error}</span> : null}
    </span>
  );
}
