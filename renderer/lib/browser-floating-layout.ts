export interface BrowserFloatingSize { width: number; height: number }
export interface BrowserFloatingFrame extends BrowserFloatingSize { x: number; y: number }
export type BrowserFloatingEdge = "north" | "south" | "east" | "west" | "northwest" | "northeast" | "southwest" | "southeast";
export const BROWSER_FLOATING_GAP = 12;

/** The player belongs to chat content, never its toolbar or visible side surfaces. */
export function browserFloatingContentBounds(input: {
  viewport: BrowserFloatingFrame;
  toolbar?: BrowserFloatingFrame;
  composer?: BrowserFloatingFrame;
  sideSurfaces?: BrowserFloatingFrame[];
}): BrowserFloatingFrame {
  const { viewport, toolbar, composer } = input;
  const x = viewport.x;
  const y = toolbar && toolbar.width > 0 ? Math.max(viewport.y, toolbar.y + toolbar.height) : viewport.y;
  const bottom = composer && composer.width > 0 ? Math.min(viewport.y + viewport.height, composer.y) : viewport.y + viewport.height;
  let right = viewport.x + viewport.width;
  for (const surface of input.sideSurfaces ?? []) {
    if (surface.width > 0 && surface.height > 0 && surface.x < right && surface.x + surface.width > x && surface.y < bottom && surface.y + surface.height > y) right = Math.min(right, surface.x);
  }
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Preserve the page's aspect ratio while allowing the compact browser chrome. */
export function browserFloatingFrame(input: {
  source: BrowserFloatingSize; container: BrowserFloatingSize; chromeHeight: number;
  width?: number; position?: { x: number; y: number };
}): BrowserFloatingFrame {
  const { container, source, chromeHeight } = input;
  const availableWidth = Math.max(1, container.width - BROWSER_FLOATING_GAP * 2);
  const availableHeight = Math.max(1, container.height - BROWSER_FLOATING_GAP * 2);
  const ratio = Math.max(1, source.width) / Math.max(1, source.height);
  const width = Math.max(1, Math.round(Math.min(
    Math.max(input.width ?? Math.min(320, 320 * ratio), 240, 150 * ratio),
    source.width, availableWidth, Math.max(1, availableHeight - chromeHeight) * ratio,
  )));
  const height = Math.min(availableHeight, Math.round(width / ratio) + chromeHeight);
  return {
    width, height,
    x: Math.min(Math.max(input.position?.x ?? container.width - width - BROWSER_FLOATING_GAP, BROWSER_FLOATING_GAP), Math.max(BROWSER_FLOATING_GAP, container.width - width - BROWSER_FLOATING_GAP)),
    y: Math.min(Math.max(input.position?.y ?? BROWSER_FLOATING_GAP, BROWSER_FLOATING_GAP), Math.max(BROWSER_FLOATING_GAP, container.height - height - BROWSER_FLOATING_GAP)),
  };
}

export function resizeBrowserFloatingFrame(input: {
  start: BrowserFloatingFrame; edge: BrowserFloatingEdge; delta: { x: number; y: number };
  source: BrowserFloatingSize; container: BrowserFloatingSize; chromeHeight: number;
}): BrowserFloatingFrame {
  const { start, edge, delta, source, container, chromeHeight } = input;
  const west = edge.includes("west"), east = edge.includes("east"), north = edge.includes("north"), south = edge.includes("south");
  const right = start.x + start.width, bottom = start.y + start.height;
  const ratio = source.width / source.height;
  const horizontal = east || west, vertical = north || south;
  const desiredWidth = start.width + (west ? -delta.x : east ? delta.x : 0);
  const desiredHeight = start.height + (north ? -delta.y : south ? delta.y : 0);
  const widthLeads = horizontal && (!vertical || Math.abs(desiredWidth - start.width) / start.width >= Math.abs(desiredHeight - start.height) / Math.max(1, start.height - chromeHeight));
  // Keep the opposite dragged edge anchored as growth reaches the container.
  const limitWidth = west ? right - BROWSER_FLOATING_GAP : east ? container.width - start.x - BROWSER_FLOATING_GAP : container.width - BROWSER_FLOATING_GAP * 2;
  const limitHeight = north ? bottom - BROWSER_FLOATING_GAP : south ? container.height - start.y - BROWSER_FLOATING_GAP : container.height - BROWSER_FLOATING_GAP * 2;
  const requestedWidth = Math.min(widthLeads ? desiredWidth : (desiredHeight - chromeHeight) * ratio, limitWidth, Math.max(1, limitHeight - chromeHeight) * ratio);
  const sized = browserFloatingFrame({ source, container: { width: limitWidth + BROWSER_FLOATING_GAP * 2, height: limitHeight + BROWSER_FLOATING_GAP * 2 }, chromeHeight, width: requestedWidth });
  return browserFloatingFrame({ source, container, chromeHeight, width: sized.width, position: { x: west ? right - sized.width : start.x, y: north ? bottom - sized.height : start.y } });
}
