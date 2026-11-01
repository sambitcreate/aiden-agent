import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { Button, Dialog } from "../../components/ui";
import type { GalleryItem } from "../../shared/images/ipc-types";
import type { ImageModelOption } from "../../shared/images/port";
import { ownValue } from "../run-view-core";
import type { ImageActions } from "./use-image-actions";
import { REVEAL_LABEL } from "./use-image-actions";
import { stepIndex } from "./viewer-core";
import { ViewerFilmstrip, ViewerPanel, type ViewerAction } from "./viewer-panel";
import { ViewerStage, type StageZoom } from "./viewer-stage";

export type { ViewerAction } from "./viewer-panel";

export interface ImageViewerProps {
  /** The set being viewed: one node's images, a workflow's history, or the whole library. */
  items: readonly GalleryItem[];
  /** The viewed image; null while the viewer is closed. */
  index: number | null;
  onIndexChange(index: number): void;
  onClose(): void;
  actions: ImageActions;
  /** The configured image models, for display names in Details. */
  models?: readonly ImageModelOption[];
  saveFolderLabel?: string;
  /** Host actions on the viewed image, such as Use as Input or Open Workflow. */
  extraActions?: readonly ViewerAction[];
  returnFocus?: () => HTMLElement | null;
}

const isTextEntry = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

const stageAlt = (item: GalleryItem, index: number) => {
  const prompt = item.prompt?.trim();
  if (!prompt) return `Generated image ${index + 1}`;
  return prompt.length > 120 ? `${prompt.slice(0, 119)}…` : prompt;
};

/**
 * The full-window image viewer. Shows the thumbnail at once and swaps to the original once it
 * has decoded; ← and → step, Home and End jump, Esc closes.
 */
export function ImageViewer({
  items,
  index,
  onIndexChange,
  onClose,
  actions,
  models,
  saveFolderLabel,
  extraActions,
  returnFocus,
}: ImageViewerProps) {
  const open = index !== null && items.length > 0;
  const active = open ? Math.min(Math.max(index, 0), items.length - 1) : 0;
  const item = open ? items[active] : undefined;
  const [originals, setOriginals] = React.useState<Record<string, string>>({});
  const [zoom, setZoom] = React.useState<StageZoom | null>(null);
  const navigation = React.useRef({ active, count: items.length, onIndexChange });
  navigation.current = { active, count: items.length, onIndexChange };

  const assetId = item?.assetId;
  const loaded = assetId !== undefined && ownValue(originals, assetId) !== undefined;
  React.useEffect(() => {
    if (assetId === undefined || loaded) return;
    let cancelled = false;
    void (async () => {
      const url = await actions.view(assetId);
      if (!url || cancelled) return;
      // Decode before the swap, so the thumbnail never blanks while the original loads.
      const image = document.createElement("img");
      image.src = url;
      try {
        await image.decode();
      } catch {
        return;
      }
      if (!cancelled) setOriginals((current) => ({ ...current, [assetId]: url }));
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId, loaded, actions]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTextEntry(event.target)) return;
      const { active: current, count, onIndexChange: change } = navigation.current;
      const next =
        event.key === "ArrowLeft" ? stepIndex(current, -1, count)
        : event.key === "ArrowRight" ? stepIndex(current, 1, count)
        : event.key === "Home" ? 0
        : event.key === "End" ? count - 1
        : null;
      if (next === null) return;
      event.preventDefault();
      if (next !== current) change(next);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={item?.nodeTitle ?? "Generated image"}
      confirmHidden
      size="full"
      returnFocus={returnFocus}
    >
      {item ? (
        <div className="image-viewer">
          <div className="image-viewer-main">
            <ViewerStage
              item={item}
              src={ownValue(originals, item.assetId) ?? item.thumbUrl}
              alt={stageAlt(item, active)}
              onDragOut={() => actions.drag(item.assetId)}
              onZoomState={setZoom}
            />
            <div role="toolbar" aria-label="Viewer" className="flex items-center justify-center gap-1">
              <Button size="small" variant="transparent" iconOnly aria-label="Previous image" disabled={active === 0} onClick={() => onIndexChange(active - 1)}>
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Button size="small" variant="transparent" iconOnly aria-label="Next image" disabled={active >= items.length - 1} onClick={() => onIndexChange(active + 1)}>
                <ChevronRight aria-hidden="true" />
              </Button>
              <Button size="small" variant="transparent" aria-pressed={zoom?.actual ?? false} disabled={!zoom || (!zoom.actual && !zoom.zoomable)} onClick={() => zoom?.toggle()}>
                {zoom?.actual ? "Fit to Window" : "Actual Size"}
              </Button>
            </div>
            <ViewerFilmstrip items={items} index={active} onSelect={onIndexChange} />
          </div>
          <ViewerPanel
            item={item}
            index={active}
            count={items.length}
            models={models}
            saveFolderLabel={saveFolderLabel}
            revealLabel={REVEAL_LABEL}
            actions={extraActions}
            onSave={() => actions.saveAs(item.assetId)}
            onCopy={() => actions.copy(item.assetId)}
            onReveal={() => actions.reveal(item.assetId)}
          />
        </div>
      ) : null}
    </Dialog>
  );
}
