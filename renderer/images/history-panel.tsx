import { FolderOpen } from "lucide-react";
import { Button, EmptyState, Text } from "../components/ui";
import type { GalleryItem } from "../shared/images/ipc-types";
import { groupGalleryByRun, imageCountLabel, relativeTime, runStateLabel } from "./gallery-core";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * The workflow's generated images, newest run first. Each run has a Save All for its images;
 * a thumbnail opens the viewer over the whole history. No live region: the run headline is
 * the editor's only status.
 */
export function HistoryPanel({
  status,
  items,
  saveFolderLabel,
  now = Date.now(),
  onOpen,
  onSaveAll,
  onRevealFolder,
  onRetry,
}: {
  status: "loading" | "ready" | "error";
  items: readonly GalleryItem[];
  saveFolderLabel: string;
  now?: number;
  onOpen(index: number): void;
  onSaveAll(assetIds: string[]): void;
  onRevealFolder(): void;
  onRetry(): void;
}) {
  if (status === "loading" && items.length === 0) {
    return <Text variant="small" color="secondary" className="p-3">Loading images…</Text>;
  }
  if (status === "error" && items.length === 0) {
    return (
      <EmptyState
        placement="inline"
        title="Images couldn't be loaded"
        description="Your images are still saved. Try again in a moment."
        action={<Button size="small" variant="muted" onClick={onRetry}>Try Again</Button>}
      />
    );
  }
  const footer = saveFolderLabel ? (
    <footer className="image-history-footer flex items-center gap-2">
      <Text variant="small" color="secondary" className="min-w-0 flex-1">Saved to {saveFolderLabel}</Text>
      <Button size="small" variant="transparent" onClick={onRevealFolder}>
        <FolderOpen aria-hidden="true" />
        Show Folder
      </Button>
    </footer>
  ) : null;
  if (items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <EmptyState
          placement="inline"
          className="flex-1"
          title="No images yet"
          description={`Run the workflow and every image it makes appears here${saveFolderLabel ? `, and is saved to ${saveFolderLabel}` : ""}.`}
        />
        {footer}
      </div>
    );
  }
  const groups = groupGalleryByRun(items);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {groups.map((group) => {
          const when = relativeTime(group.createdAt, now, (timestamp) => dateFormat.format(timestamp));
          const count = imageCountLabel(group.entries.length);
          const heading = [when, runStateLabel(group.runState), count].filter(Boolean).join(" · ");
          return (
            <section key={group.runId} aria-label={`Run ${heading}`} className="flex flex-col gap-2">
              <header className="flex items-center gap-2">
                <Text as="h3" variant="small" color="secondary" className="min-w-0 flex-1" truncate>{heading}</Text>
                <Button
                  size="small"
                  variant="transparent"
                  aria-label={`Save all ${count} from this run…`}
                  onClick={() => onSaveAll(group.entries.map((entry) => entry.item.assetId))}
                >
                  Save All…
                </Button>
              </header>
              <ul className="image-history-grid" aria-label="Images from this run">
                {group.entries.map(({ item, index }) => (
                  <li key={item.assetId}>
                    <button type="button" className="image-thumb" aria-label={`Open image ${index + 1} of ${items.length}`} onClick={() => onOpen(index)}>
                      {item.thumbUrl ? <img src={item.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {footer}
    </div>
  );
}
