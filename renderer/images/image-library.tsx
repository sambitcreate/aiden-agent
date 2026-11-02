import { FolderOpen, Workflow } from "lucide-react";
import * as React from "react";
import { Button, EmptyState, Text } from "../components/ui";
import { GALLERY_MAX_ITEMS, SAVE_ALL_MAX_IMAGES, type GalleryItem } from "../shared/images/ipc-types";
import type { ImageModelOption } from "../shared/images/port";
import { imageCountLabel, viewerPosition } from "./gallery-core";
import {
  EMPTY_LIBRARY_FILTERS,
  filterLibrary,
  libraryFacets,
  saveAllSelection,
  sectionByDay,
  workflowAvailable,
  type LibraryFilters,
} from "./library-core";
import { LibraryGrid, libraryTileFor } from "./library-grid";
import { LibraryToolbar } from "./library-toolbar";
import type { GalleryState } from "./use-gallery";
import { ImageViewer, type ViewerAction } from "./viewer/image-viewer";
import { REVEAL_LABEL, type ImageActions } from "./viewer/use-image-actions";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const numberFormat = new Intl.NumberFormat();

/**
 * All Images: every workflow's generated images in day sections, with search, workflow and
 * model filters, a sort, Save All for what is shown, and the viewer over the filtered set.
 */
export function ImageLibrary({
  gallery,
  models = [],
  actions,
  liveWorkflowIds,
  onOpenWorkflow,
  now = Date.now(),
}: {
  gallery: Pick<GalleryState, "status" | "items" | "saveFolderLabel"> & { refresh(): void };
  models?: readonly ImageModelOption[];
  actions: ImageActions;
  /** The workflows that exist now, or null while they are loading. */
  liveWorkflowIds: ReadonlySet<string> | null;
  onOpenWorkflow(workflowId: string): void;
  now?: number;
}) {
  const [filters, setFilters] = React.useState<LibraryFilters>(EMPTY_LIBRARY_FILTERS);
  const [focusIndex, setFocusIndex] = React.useState(0);
  const [viewing, setViewing] = React.useState<string | null>(null);
  const grid = React.useRef<HTMLDivElement>(null);
  const { items, status, saveFolderLabel } = gallery;

  const shown = React.useMemo(() => filterLibrary(items, filters, models), [items, filters, models]);
  const facets = React.useMemo(() => libraryFacets(items, filters, models), [items, filters, models]);
  const sections = React.useMemo(() => sectionByDay(shown, now, (timestamp) => dateFormat.format(timestamp)), [shown, now]);
  const viewerIndex = viewerPosition(shown, viewing);
  // The viewer hands focus back to the thumbnail of the image it closed on, found by asset id:
  // a gallery refresh or a new run's images can move it to another position meanwhile.
  const lastViewed = React.useRef<string | null>(null);
  const view = (index: number) => {
    const item = shown[index];
    if (!item) return;
    lastViewed.current = item.assetId;
    setViewing(item.assetId);
  };

  const changeFilters = (next: LibraryFilters) => {
    setFilters(next);
    setFocusIndex(0);
  };
  const clearFilters = () => changeFilters({ ...EMPTY_LIBRARY_FILTERS, sort: filters.sort });
  const canOpenWorkflow = React.useCallback((item: GalleryItem) => workflowAvailable(item, liveWorkflowIds), [liveWorkflowIds]);
  const openWorkflow = React.useCallback(
    (item: GalleryItem) => {
      if (!workflowAvailable(item, liveWorkflowIds)) return;
      setViewing(null);
      onOpenWorkflow(item.workflowId);
    },
    [liveWorkflowIds, onOpenWorkflow],
  );
  const viewerActions = React.useMemo<ViewerAction[]>(
    () => [{ id: "open-workflow", label: "Open Workflow", icon: <Workflow aria-hidden="true" />, disabled: (item) => !canOpenWorkflow(item), onSelect: openWorkflow }],
    [canOpenWorkflow, openWorkflow],
  );

  const footer = saveFolderLabel ? (
    // Leading-aligned: the app's floating Live control sits in the bottom-right corner.
    <footer className="image-history-footer image-library-footer flex flex-wrap items-center gap-x-2">
      <Text variant="small" color="secondary" className="min-w-0">
        Saved to {saveFolderLabel}
        {items.length >= GALLERY_MAX_ITEMS ? ` · Showing the newest ${numberFormat.format(GALLERY_MAX_ITEMS)} images` : ""}
      </Text>
      <Button size="small" variant="transparent" onClick={actions.revealFolder}>
        <FolderOpen aria-hidden="true" />
        Show Folder
      </Button>
    </footer>
  ) : null;

  if (items.length === 0) {
    let body: React.ReactNode;
    if (status === "loading") body = <Text variant="small" color="secondary" className="px-6 py-4">Loading images…</Text>;
    else if (status === "error") {
      body = (
        <EmptyState
          role="alert"
          title="Images couldn't be loaded"
          description="Your images are still saved. Try again in a moment."
          action={<Button size="small" variant="muted" onClick={gallery.refresh}>Try Again</Button>}
        />
      );
    } else {
      body = (
        <EmptyState
          title="No images yet"
          description={`Run any workflow and every image it makes lands here${saveFolderLabel ? `, and is saved to ${saveFolderLabel} automatically` : ""}.`}
        />
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
        {footer}
      </div>
    );
  }

  const selection = saveAllSelection(shown);
  const countText = shown.length === items.length ? imageCountLabel(items.length) : `${numberFormat.format(shown.length)} of ${imageCountLabel(items.length)}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 px-6 pb-3">
        <LibraryToolbar filters={filters} onFiltersChange={changeFilters} facets={facets} />
        <div className="flex min-h-7 items-center gap-2">
          <Text variant="small" color="secondary" role="status" className="min-w-0 flex-1" truncate>{countText}</Text>
          {selection.capped ? (
            <Text variant="small" color="secondary">Saves the first {SAVE_ALL_MAX_IMAGES} of {numberFormat.format(selection.total)}</Text>
          ) : null}
          {shown.length > 0 ? (
            <Button
              size="small"
              variant="muted"
              aria-label={selection.capped ? `Save the first ${SAVE_ALL_MAX_IMAGES} of ${selection.total} images…` : `Save all ${imageCountLabel(selection.total)}…`}
              onClick={() => actions.saveAll(selection.assetIds)}
            >
              Save All…
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        {shown.length === 0 ? (
          <EmptyState
            title="No matching images"
            description="Nothing matches this search and these filters."
            action={<Button size="small" variant="muted" onClick={clearFilters}>Clear Filters</Button>}
          />
        ) : (
          <LibraryGrid
            sections={sections}
            count={shown.length}
            focusIndex={focusIndex}
            onFocusIndexChange={setFocusIndex}
            gridRef={grid}
            actions={{
              open: view,
              saveAs: (item) => actions.saveAs(item.assetId),
              copy: (item) => actions.copy(item.assetId),
              reveal: (item) => actions.reveal(item.assetId),
              openWorkflow,
              canOpenWorkflow,
              revealLabel: REVEAL_LABEL,
            }}
          />
        )}
      </div>
      {footer}
      <ImageViewer
        items={shown}
        index={viewerIndex}
        onIndexChange={view}
        onClose={() => {
          const at = shown.findIndex((entry) => entry.assetId === lastViewed.current);
          if (at >= 0) setFocusIndex(at);
          setViewing(null);
        }}
        actions={actions}
        models={models}
        saveFolderLabel={saveFolderLabel}
        extraActions={viewerActions}
        returnFocus={() => (lastViewed.current === null ? null : libraryTileFor(grid.current, lastViewed.current))}
      />
    </div>
  );
}
