import * as React from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger, Text } from "../components/ui";
import type { GalleryItem } from "../shared/images/ipc-types";
import { openContextMenuFromKeyboard } from "../lib/keyboard-context-menu";
import { imageCountLabel } from "./gallery-core";
import { gridMove, tileLabel, type GridKey, type LibraryDaySection } from "./library-core";

const GRID_KEYS = new Set<string>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

export interface LibraryTileActions {
  open(index: number): void;
  saveAs(item: GalleryItem): void;
  copy(item: GalleryItem): void;
  reveal(item: GalleryItem): void;
  openWorkflow(item: GalleryItem): void;
  canOpenWorkflow(item: GalleryItem): boolean;
  revealLabel: string;
}

/** The thumbnail of this image, wherever the current filters and sort put it, or null when it is not shown. */
export const libraryTileFor = (grid: HTMLElement | null, assetId: string) =>
  Array.from(grid?.querySelectorAll<HTMLButtonElement>("[data-library-asset]") ?? []).find((tile) => tile.dataset.libraryAsset === assetId) ?? null;

/**
 * The library's day sections of thumbnails. The grid is one Tab stop: the arrow keys, Home
 * and End move between thumbnails across sections, ↩ or Space opens one in the viewer, and
 * right-click (or ⇧F10) opens its menu.
 */
export function LibraryGrid({
  sections,
  count,
  focusIndex,
  onFocusIndexChange,
  actions,
  gridRef,
}: {
  sections: readonly LibraryDaySection[];
  count: number;
  focusIndex: number;
  onFocusIndexChange(index: number): void;
  actions: LibraryTileActions;
  gridRef: React.RefObject<HTMLDivElement | null>;
}) {
  const headingPrefix = React.useId();
  const [menuItem, setMenuItem] = React.useState<GalleryItem | null>(null);
  const items = React.useMemo(() => sections.flatMap((section) => section.entries.map((entry) => entry.item)), [sections]);
  const active = Math.min(Math.max(focusIndex, 0), Math.max(count - 1, 0));

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Shift+F10 and the Menu key open the focused thumbnail's menu (macOS sends no contextmenu for them).
    openContextMenuFromKeyboard(event);
    if (event.defaultPrevented) return;
    if (!GRID_KEYS.has(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    const from = (event.target as HTMLElement).closest<HTMLElement>("[data-library-index]");
    if (!from) return;
    event.preventDefault();
    const tiles = Array.from(gridRef.current?.querySelectorAll<HTMLElement>("[data-library-index]") ?? []);
    const rects = tiles.map((tile) => {
      const box = tile.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    });
    const next = gridMove(rects, Number(from.dataset.libraryIndex), event.key as GridKey);
    if (next < 0) return;
    onFocusIndexChange(next);
    tiles[next]?.focus();
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={gridRef}
          className="flex flex-col gap-5"
          onKeyDown={onKeyDown}
          onContextMenu={(event) => {
            const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-library-index]");
            const item = tile ? items[Number(tile.dataset.libraryIndex)] : undefined;
            // Only a thumbnail has a menu; preventing the event keeps it closed elsewhere.
            if (!item) {
              event.preventDefault();
              return;
            }
            setMenuItem(item);
          }}
        >
          {sections.map((section) => (
            <section key={section.key} aria-labelledby={`${headingPrefix}-${section.key}`} className="flex flex-col gap-2">
              <header className="flex items-baseline gap-2">
                <Text as="h3" id={`${headingPrefix}-${section.key}`} variant="small-strong" color="secondary">{section.label}</Text>
                <Text variant="small" color="tertiary">{imageCountLabel(section.entries.length)}</Text>
              </header>
              <ul className="image-library-grid">
                {section.entries.map(({ item, index }) => (
                  <li key={item.assetId}>
                    <button
                      type="button"
                      className="image-thumb"
                      data-library-index={index}
                      data-library-asset={item.assetId}
                      tabIndex={index === active ? 0 : -1}
                      aria-label={tileLabel(item, index, count)}
                      onFocus={() => {
                        if (index !== focusIndex) onFocusIndexChange(index);
                      }}
                      onClick={() => actions.open(index)}
                    >
                      {item.thumbUrl ? <img src={item.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuItem ? (
          <>
            <ContextMenuItem onSelect={() => actions.saveAs(menuItem)}>Save…</ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.copy(menuItem)}>Copy Image</ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.reveal(menuItem)}>{actions.revealLabel}</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!actions.canOpenWorkflow(menuItem)} onSelect={() => actions.openWorkflow(menuItem)}>
              Open Workflow
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
