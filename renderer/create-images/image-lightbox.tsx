import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Download, Maximize2, Minus, Move, Plus, X } from "lucide-react";
import { Button } from "../components/ui";
import {
  createImagesAssetGrantUrl,
  type CreateImagesAssetGrantView,
} from "../shared/create-images/ipc";
import {
  clampCreateImagesLightboxOffset,
  createImagesLightboxFitZoom,
  createImagesLightboxPan,
  createImagesLightboxZoomAtPoint,
  CREATE_IMAGES_LIGHTBOX_MAX_ZOOM,
  CREATE_IMAGES_LIGHTBOX_MIN_ZOOM,
  CREATE_IMAGES_LIGHTBOX_ZOOM_FACTOR,
  type CreateImagesImageLightboxSize,
  type CreateImagesImageLightboxView,
} from "./image-lightbox-core";

export interface CreateImagesImageLightboxProps {
  open: boolean;
  asset?: CreateImagesAssetGrantView;
  label: string;
  onOpenChange(open: boolean): void;
  onImageLoad?(assetId: string, token: string): void;
  onImageError?(assetId: string, token: string): void;
  onSave?(): void;
  returnFocus?: () => HTMLElement | null;
}

interface DragOrigin {
  pointerId: number;
  clientX: number;
  clientY: number;
  view: CreateImagesImageLightboxView;
}

const EMPTY_SIZE: CreateImagesImageLightboxSize = { width: 1, height: 1 };
const INITIAL_VIEW: CreateImagesImageLightboxView = {
  zoom: 1,
  offset: { x: 0, y: 0 },
};

function zoomLabel(zoom: number): string {
  const percent = Math.round(zoom * 100);
  return percent >= 1000 ? `${(percent / 1000).toFixed(1)}k%` : `${percent}%`;
}

export function CreateImagesImageLightbox({
  open,
  asset,
  label,
  onOpenChange,
  onImageLoad,
  onImageError,
  onSave,
  returnFocus,
}: CreateImagesImageLightboxProps) {
  const [stageElement, setStageElement] = React.useState<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const dragOriginRef = React.useRef<DragOrigin | undefined>(undefined);
  const [dragging, setDragging] = React.useState(false);
  const [viewport, setViewport] = React.useState<CreateImagesImageLightboxSize>(EMPTY_SIZE);
  const [view, setView] = React.useState<CreateImagesImageLightboxView>(INITIAL_VIEW);
  const [fitMode, setFitMode] = React.useState(true);
  const imageSize = asset?.asset ?? EMPTY_SIZE;
  const fitZoom = createImagesLightboxFitZoom(imageSize, viewport);

  React.useEffect(() => {
    if (!open) return;
    setFitMode(true);
    setDragging(false);
    dragOriginRef.current = undefined;
    setView({ zoom: 1, offset: { x: 0, y: 0 } });
  }, [asset?.asset.assetId, open]);

  React.useLayoutEffect(() => {
    if (!open || !stageElement) return;
    const measure = () => {
      const rect = stageElement.getBoundingClientRect();
      setViewport({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stageElement);
    return () => observer.disconnect();
  }, [open, stageElement]);

  React.useEffect(() => {
    if (!open) return;
    if (fitMode) {
      setView({ zoom: fitZoom, offset: { x: 0, y: 0 } });
      return;
    }
    setView((current) => ({
      ...current,
      offset: clampCreateImagesLightboxOffset(current.offset, imageSize, viewport, current.zoom),
    }));
  }, [fitMode, fitZoom, imageSize, open, viewport]);

  const applyZoom = React.useCallback(
    (nextZoom: number, anchor = { x: 0, y: 0 }) => {
      setFitMode(false);
      setView((current) =>
        createImagesLightboxZoomAtPoint(current, nextZoom, anchor, imageSize, viewport),
      );
    },
    [imageSize, viewport],
  );

  const fitImage = React.useCallback(() => {
    setFitMode(true);
    setView({ zoom: fitZoom, offset: { x: 0, y: 0 } });
  }, [fitZoom]);

  const showActualSize = React.useCallback(() => {
    setFitMode(false);
    setView({ zoom: 1, offset: { x: 0, y: 0 } });
  }, []);

  const panBy = React.useCallback(
    (x: number, y: number) => {
      setFitMode(false);
      setView((current) => createImagesLightboxPan(current, { x, y }, imageSize, viewport));
    },
    [imageSize, viewport],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      applyZoom(view.zoom * CREATE_IMAGES_LIGHTBOX_ZOOM_FACTOR);
    } else if (event.key === "-") {
      event.preventDefault();
      applyZoom(view.zoom / CREATE_IMAGES_LIGHTBOX_ZOOM_FACTOR);
    } else if (event.key === "0") {
      event.preventDefault();
      showActualSize();
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      fitImage();
    } else if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const distance = event.shiftKey ? 96 : 36;
      if (event.key === "ArrowLeft") panBy(distance, 0);
      else if (event.key === "ArrowRight") panBy(-distance, 0);
      else if (event.key === "ArrowUp") panBy(0, distance);
      else panBy(0, -distance);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="create-images-lightbox-overlay" />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className="create-images-lightbox"
          aria-describedby="create-images-lightbox-instructions"
          onKeyDown={handleKeyDown}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            requestAnimationFrame(() => closeRef.current?.focus());
          }}
          onCloseAutoFocus={(event) => {
            const target = returnFocus?.();
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">Inspect {label}</DialogPrimitive.Title>
          <DialogPrimitive.Description id="create-images-lightbox-instructions" className="sr-only">
            Use plus and minus to zoom, F to fit, 0 for actual size, arrow keys to pan, and Escape
            to close.
          </DialogPrimitive.Description>

          <header className="create-images-lightbox-heading">
            <div className="min-w-0">
              <div className="truncate text-small-strong font-medium text-primary">{label}</div>
              {asset ? (
                <div className="mt-0.5 text-mini tabular-nums text-tertiary">
                  {asset.asset.width.toLocaleString()} × {asset.asset.height.toLocaleString()} ·{" "}
                  {asset.asset.mediaType === "image/png" ? "PNG" : "JPEG"}
                </div>
              ) : (
                <div className="mt-0.5 text-mini text-tertiary">Loading secure preview…</div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {onSave ? (
                <Button
                  iconOnly
                  size="small"
                  variant="transparent"
                  disabled={!asset}
                  aria-label="Save image"
                  title="Save image"
                  onClick={onSave}
                >
                  <Download />
                </Button>
              ) : null}
              <DialogPrimitive.Close asChild>
                <Button
                  ref={closeRef}
                  iconOnly
                  size="small"
                  variant="transparent"
                  aria-label="Close image inspector"
                  title="Close · Esc"
                >
                  <X />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </header>

          <div
            ref={setStageElement}
            className="create-images-lightbox-stage create-images-preview-grid"
            data-dragging={dragging ? "true" : "false"}
            data-pannable={view.zoom > fitZoom + 0.001 ? "true" : "false"}
            onWheel={(event) => {
              if (!asset) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              const anchor = {
                x: event.clientX - rect.left - rect.width / 2,
                y: event.clientY - rect.top - rect.height / 2,
              };
              applyZoom(view.zoom * Math.exp(-event.deltaY * 0.0015), anchor);
            }}
            onDoubleClick={() => (Math.abs(view.zoom - 1) < 0.001 ? fitImage() : showActualSize())}
            onPointerDown={(event) => {
              if (!asset || event.button !== 0 || view.zoom <= fitZoom + 0.001) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              dragOriginRef.current = {
                pointerId: event.pointerId,
                clientX: event.clientX,
                clientY: event.clientY,
                view,
              };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const origin = dragOriginRef.current;
              if (!origin || origin.pointerId !== event.pointerId) return;
              setFitMode(false);
              setView(
                createImagesLightboxPan(
                  origin.view,
                  { x: event.clientX - origin.clientX, y: event.clientY - origin.clientY },
                  imageSize,
                  viewport,
                ),
              );
            }}
            onPointerUp={(event) => {
              if (dragOriginRef.current?.pointerId !== event.pointerId) return;
              dragOriginRef.current = undefined;
              setDragging(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              dragOriginRef.current = undefined;
              setDragging(false);
            }}
          >
            {asset ? (
              <img
                className="create-images-lightbox-image"
                src={createImagesAssetGrantUrl(asset.token, "original")}
                alt={label}
                draggable={false}
                style={{
                  width: asset.asset.width,
                  height: asset.asset.height,
                  transform: `translate(-50%, -50%) translate3d(${view.offset.x}px, ${view.offset.y}px, 0) scale(${view.zoom})`,
                }}
                onLoad={() => onImageLoad?.(asset.asset.assetId, asset.token)}
                onError={() => onImageError?.(asset.asset.assetId, asset.token)}
              />
            ) : (
              <div className="create-images-lightbox-loading" role="status">
                Loading image preview…
              </div>
            )}
          </div>

          <div className="create-images-lightbox-toolbar" role="toolbar" aria-label="Image zoom">
            <Button
              iconOnly
              size="small"
              variant="transparent"
              disabled={!asset || view.zoom <= CREATE_IMAGES_LIGHTBOX_MIN_ZOOM + 0.001}
              aria-label="Zoom out"
              title="Zoom out · −"
              onClick={() => applyZoom(view.zoom / CREATE_IMAGES_LIGHTBOX_ZOOM_FACTOR)}
            >
              <Minus />
            </Button>
            <span className="create-images-lightbox-zoom" aria-live="polite">
              {zoomLabel(view.zoom)}
            </span>
            <Button
              iconOnly
              size="small"
              variant="transparent"
              disabled={!asset || view.zoom >= CREATE_IMAGES_LIGHTBOX_MAX_ZOOM - 0.001}
              aria-label="Zoom in"
              title="Zoom in · +"
              onClick={() => applyZoom(view.zoom * CREATE_IMAGES_LIGHTBOX_ZOOM_FACTOR)}
            >
              <Plus />
            </Button>
            <span className="create-images-lightbox-divider" aria-hidden="true" />
            <Button
              size="small"
              variant={fitMode ? "filled" : "transparent"}
              disabled={!asset}
              onClick={fitImage}
              title="Fit image · F"
            >
              <Maximize2 />
              Fit
            </Button>
            <Button
              size="small"
              variant={!fitMode && Math.abs(view.zoom - 1) < 0.001 ? "filled" : "transparent"}
              disabled={!asset}
              onClick={showActualSize}
              title="Actual size · 0"
            >
              1:1
            </Button>
          </div>

          <div className="create-images-lightbox-hint" aria-hidden="true">
            <Move /> Drag to pan · scroll to zoom
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
