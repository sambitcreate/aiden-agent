// Bot bubble overlays: one see-through, click-through panel per display that
// has heads, over every app (macOS, "Float over other apps" on). Set up like
// Quick Chat: an auxiliary panel on all Spaces and over full-screen apps,
// `skipTransformProcessType` so Aiden keeps its Dock icon. An overlay exists
// only while its display has heads. Heads never take keyboard focus from the
// app the person is in: the panel is focusable only while a mini chat is open,
// so keyboard moves on heads work only then. A crashed or hung overlay drops
// back to click-through at once and is rebuilt (a few times a minute at most).
//
// Also the window side of the bubble IPC (`BotBubbleWindowPort`): the shrink
// capture, Open in Aiden, pointer pass-through and the overlay's size.

import type { IpcMainInvokeEvent } from "electron";
import {
  BOT_BUBBLE_CHANNELS,
  type BotBubbleOverlayInfo,
  type BotBubbleRect,
  type BotBubbleState,
  type BotBubbleTransition,
} from "../../renderer/shared/bot-bubbles.js";
import { BOT_BUBBLES_NOTIFICATION_CHANNELS } from "../../renderer/bot-bubbles-preload-channels.js";
import type { BotBubbleWindowPort } from "../handlers/bot-bubbles.js";
import {
  BaseWindow,
  BrowserWindow,
  logger,
  registerBroadcastReceiver,
  screen,
} from "../platform.js";
import {
  botBubbleService,
  startBotBubbleService,
  stopBotBubbleService,
} from "../services/bot-bubbles/bot-bubbles-main.js";
import { rendererDocumentOwner } from "../services/renderer-document-owner.js";
import { markAuxiliaryWindow } from "./auxiliary-windows.js";
import type { BotBubbleOverlayAccess } from "./bot-bubbles-overlay-access.js";
import {
  isBotBubbleOverlayWebContents,
  registerBotBubbleOverlayWebContents,
} from "./bot-bubbles-overlay-registry.js";
import {
  CoverWaits,
  PendingTransitions,
  allowOverlayRebuild,
  isZoomShortcut,
  overlayCssSize,
  scaleRect,
  botBubbleOverlayWindowOptions,
  bubbleDisplayId,
  captureRect,
  displaysNeedingOverlay,
  growTargetRect,
  overlayIgnoresMouse,
  releaseOverlayFocus,
  windowRectToOverlay,
  type OverlayDisplay,
} from "./bot-bubbles-window-core.js";
import {
  botBubbleOverlayHears,
  isTrustedBotBubbleSender,
  withoutFragment,
} from "./bot-bubbles-window-security.js";
import { getBotBubblesPreloadPath, getWindowUrl } from "./window-paths.js";

/** How the overlays reach the main window (owned by `main/index.ts`). */
export interface BotBubbleMainWindowAccess {
  /** The main window if it exists now. */
  current(): BrowserWindow | null;
  /** Create or show, focus and wait for the main window; null if it never became ready. */
  reveal(): Promise<BrowserWindow | null>;
  /** Open a link from a Bot reply in the default browser, through main's URL guard. */
  openExternal(url: string): void;
}

interface Overlay {
  window: BrowserWindow;
  displayId: number;
  workArea: BotBubbleRect;
  loaded: Promise<boolean>;
  flags: { interactive: boolean; dragging: boolean };
  /** Set while the overlay waits to go away after its last head left (a grow may still be playing). */
  releaseTimer: NodeJS.Timeout | null;
  /** Shrink and grow animations wait here until the page listens. */
  transitions: PendingTransitions<BotBubbleTransition>;
  /** The open mini chat this overlay was last focused for, so a later sync doesn't steal focus back. */
  focusedFor: string | null;
}

/** The grow plays this long before the main window comes forward. */
const GROW_MS = 280;
/** An overlay whose last head left lingers this long, so a grow or close can finish drawing. */
const RELEASE_DELAY_MS = 700;

const overlays = new Map<number, Overlay>();
let overlayUrl = "";
let mainWindowAccess: BotBubbleMainWindowAccess | null = null;
let destroying = false;
let stopListening: (() => void) | null = null;
/** display id → recent rebuild times, and displays left without an overlay after a crash loop. */
const rebuilds = new Map<number, number[]>();
const blockedDisplays = new Set<number>();
/** Shrinks whose still picture an overlay is putting over the chat (see `coverChat`). */
const coverWaits = new CoverWaits();

function liveDisplays(): OverlayDisplay[] {
  return screen.getAllDisplays().map((display) => ({ id: display.id, workArea: display.workArea }));
}

/** The Bots whose heads one display's overlay draws. */
function botIdsOnDisplay(displayId: number): Set<string> {
  const displays = liveDisplays();
  const primary = screen.getPrimaryDisplay().id;
  return new Set(
    botBubbleService()
      .current()
      .bubbles.filter(
        (bubble) => bubbleDisplayId(bubble.placement.displayId, displays, primary) === displayId,
      )
      .map((bubble) => bubble.botId),
  );
}

function overlayForWebContents(id: number): Overlay | null {
  for (const overlay of overlays.values()) {
    if (!overlay.window.isDestroyed() && overlay.window.webContents.id === id) return overlay;
  }
  return null;
}

function applyMouse(overlay: Overlay): void {
  if (overlay.window.isDestroyed()) return;
  overlay.window.setIgnoreMouseEvents(overlayIgnoresMouse(overlay.flags), { forward: true });
}

/** Back to click-through: a page that went away can't say the pointer left a head. */
function resetPointer(overlay: Overlay): void {
  overlay.flags = { interactive: false, dragging: false };
  applyMouse(overlay);
}

function overlayZoom(overlay: Overlay): number {
  return overlay.window.isDestroyed() ? 1 : overlay.window.webContents.getZoomFactor();
}

function overlayInfoOf(overlay: Overlay): BotBubbleOverlayInfo {
  return {
    displayId: overlay.displayId,
    ...overlayCssSize(overlay.workArea, overlayZoom(overlay)),
    primary: overlay.displayId === screen.getPrimaryDisplay().id,
  };
}

function holdsOpenChat(overlay: Overlay, state: BotBubbleState): boolean {
  const open = state.bubbles.find((bubble) => bubble.botId === state.openBotId);
  return Boolean(
    open &&
    bubbleDisplayId(open.placement.displayId, liveDisplays(), screen.getPrimaryDisplay().id) ===
      overlay.displayId,
  );
}

/**
 * Only the overlay holding the open mini chat may take keyboard focus; every
 * other overlay is unfocusable, so clicking or dragging a head never takes
 * typing away from another app.
 */
function applyFocus(overlay: Overlay, state: BotBubbleState): void {
  const window = overlay.window;
  if (window.isDestroyed()) return;
  if (state.host === "overlay" && holdsOpenChat(overlay, state)) {
    // Focus once per opened chat (or when its head arrives on this display),
    // not on every change while the person works in another app.
    if (overlay.focusedFor === state.openBotId) return;
    const openBotId = state.openBotId;
    void overlay.loaded.then((ok) => {
      const current = botBubbleService().current();
      if (
        !ok ||
        window.isDestroyed() ||
        current.openBotId !== openBotId ||
        !holdsOpenChat(overlay, current)
      )
        return;
      overlay.focusedFor = openBotId;
      window.setFocusable(true);
      window.focus();
    });
    return;
  }
  overlay.focusedFor = null;
  const how = releaseOverlayFocus({
    isFocused: () => window.isFocused(),
    setFocusable: (focusable) => window.setFocusable(focusable),
    passKeyOn: () => passKeyOn(overlay),
    blur: () => window.blur(),
  });
  if (how === "blurred")
    logger.debug("bot-bubbles", "The overlay kept the keyboard; it was blurred instead.");
}

/**
 * Take key-window status off an overlay that stays on screen. Electron's
 * `blur()` does it on macOS by ordering the window out and back in, which
 * blinks every head on the display when a mini chat closes. Instead a 1 px,
 * see-through panel takes the key window and goes away at once: closing a key
 * panel gives the keyboard back to the app in front, and the overlay (already
 * unfocusable) is never picked as the next key window. It is not a
 * BrowserWindow, so it loads nothing and no app-window rule sees it.
 */
function passKeyOn(overlay: Overlay): void {
  if (process.platform !== "darwin") return;
  const sink = new BaseWindow({
    x: Math.round(overlay.workArea.x),
    y: Math.round(overlay.workArea.y),
    width: 1,
    height: 1,
    type: "panel",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    show: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    fullscreenable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
  });
  try {
    // Where the overlay is: every Space and over full-screen apps, so showing it never switches Space.
    sink.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    sink.setAlwaysOnTop(true, "floating");
    sink.setIgnoreMouseEvents(true);
    sink.showInactive();
    sink.focus();
  } finally {
    sink.destroy();
  }
}

/** A crashed, hung or failed page: click-through now, then a fresh overlay unless it keeps failing. */
function recoverOverlay(overlay: Overlay, reason: string): void {
  if (overlays.get(overlay.displayId) !== overlay) return;
  overlay.transitions.reset();
  resetPointer(overlay);
  const { displayId } = overlay;
  // Not from inside the window's own event.
  setImmediate(() => {
    destroyOverlay(overlay);
    const next = allowOverlayRebuild(rebuilds.get(displayId) ?? [], Date.now());
    rebuilds.set(displayId, next.times);
    if (!next.allowed) {
      blockedDisplays.add(displayId);
      logger.warn(
        "bot-bubbles",
        "A bubble overlay keeps failing; leaving heads off that display.",
        { reason, displayId },
      );
      return;
    }
    logger.warn("bot-bubbles", "Rebuilding a bubble overlay.", { reason });
    syncOverlays(botBubbleService().current());
  });
}

function createOverlay(display: OverlayDisplay): Overlay {
  const window = new BrowserWindow(
    botBubbleOverlayWindowOptions({
      preload: getBotBubblesPreloadPath(),
      workArea: display.workArea,
    }),
  );
  // Never an app window: it must not keep Aiden open or receive app UI.
  markAuxiliaryWindow(window);
  // Bot notifications only for this overlay's heads; appearance and bubble notices always.
  registerBroadcastReceiver(window, BOT_BUBBLES_NOTIFICATION_CHANNELS, (channel, payload) =>
    botBubbleOverlayHears(channel, payload, botIdsOnDisplay(display.id)),
  );
  // `skipTransformProcessType` keeps Aiden's Dock icon when showing over full-screen Spaces.
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  // Above normal windows, like Quick Chat.
  window.setAlwaysOnTop(true, "floating");

  registerBotBubbleOverlayWebContents(window.webContents.id);
  const overlay: Overlay = {
    window,
    displayId: display.id,
    workArea: display.workArea,
    loaded: Promise.resolve(false),
    flags: { interactive: false, dragging: false },
    releaseTimer: null,
    transitions: new PendingTransitions(),
    focusedFor: null,
  };
  applyMouse(overlay);

  const contents = window.webContents;
  contents.on("render-process-gone", (_event, details) =>
    recoverOverlay(overlay, `render-process-gone:${details.reason}`),
  );
  window.on("unresponsive", () => recoverOverlay(overlay, "unresponsive"));
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    // A reload: the new page must ask for pointer events and say it listens again.
    overlay.transitions.reset();
    resetPointer(overlay);
  });
  contents.on("did-finish-load", () => {
    resetPointer(overlay);
    // Pinch zoom off; the page lays out in its own CSS pixels either way.
    void contents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
  });
  // ⌘+ / ⌘- would zoom every Aiden page of this origin, the main window too; the overlay ignores them.
  contents.on("before-input-event", (event, input) => {
    if (isZoomShortcut(input)) event.preventDefault();
  });
  contents.on("zoom-changed", () => {
    if (!contents.isDestroyed())
      contents.send(BOT_BUBBLE_CHANNELS.overlayInfoChanged, overlayInfoOf(overlay));
  });

  window.on("close", (event) => {
    // ⌘W on a focused mini chat tucks it away instead of closing the overlay.
    if (destroying) return;
    event.preventDefault();
    void botBubbleService()
      .open(null)
      .catch(() => undefined);
  });
  window.on("closed", () => {
    if (overlays.get(display.id) === overlay) overlays.delete(display.id);
    if (overlay.releaseTimer) clearTimeout(overlay.releaseTimer);
  });

  overlay.loaded = new Promise<boolean>((resolve) => {
    window.webContents.once("did-finish-load", () => resolve(true));
    window.once("closed", () => resolve(false));
    window.webContents.once("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame) return;
      logger.warn("bot-bubbles", "The bubble overlay failed to load.", { code, description });
      resolve(false);
      recoverOverlay(overlay, "did-fail-load");
    });
  });
  void overlay.loaded.then((ok) => {
    if (!ok || window.isDestroyed() || overlays.get(display.id) !== overlay) return;
    // Heads never take focus.
    window.showInactive();
    applyMouse(overlay);
    applyFocus(overlay, botBubbleService().current());
  });

  overlayUrl = getWindowUrl("bot-bubbles.html");
  // Links in a Bot's replies open in the browser, as they do in the main window;
  // the overlay itself never leaves its page.
  window.webContents.setWindowOpenHandler(({ url }) => {
    mainWindowAccess?.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, destination) => {
    if (destination === overlayUrl) return;
    // An in-page link stays an in-page link; never hand the overlay's own page to the browser.
    if (withoutFragment(destination) === withoutFragment(overlayUrl)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    mainWindowAccess?.openExternal(destination);
  });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  void window.loadURL(overlayUrl);
  return overlay;
}

function destroyOverlay(overlay: Overlay): void {
  if (overlay.releaseTimer) clearTimeout(overlay.releaseTimer);
  overlay.releaseTimer = null;
  if (overlays.get(overlay.displayId) === overlay) overlays.delete(overlay.displayId);
  if (overlay.window.isDestroyed()) return;
  destroying = true;
  try {
    overlay.window.destroy();
  } finally {
    destroying = false;
  }
}

function overlayForBot(state: BotBubbleState, botId: string): Overlay | null {
  const bubble = state.bubbles.find((entry) => entry.botId === botId);
  if (!bubble) return null;
  return (
    overlays.get(
      bubbleDisplayId(bubble.placement.displayId, liveDisplays(), screen.getPrimaryDisplay().id),
    ) ?? null
  );
}

/** Make the overlays match the state: one per display with heads, none unless the host is the overlay. */
function syncOverlays(state: BotBubbleState): void {
  if (destroying) return;
  if (state.host !== "overlay") {
    for (const overlay of [...overlays.values()]) destroyOverlay(overlay);
    // Turning the switch off and on is the way back for a display left off after a crash loop.
    blockedDisplays.clear();
    rebuilds.clear();
    return;
  }
  const displays = liveDisplays();
  const needed = displaysNeedingOverlay(state, displays, screen.getPrimaryDisplay().id);
  for (const display of displays) {
    if (!needed.has(display.id) || blockedDisplays.has(display.id)) continue;
    const existing = overlays.get(display.id);
    if (existing) {
      if (existing.releaseTimer) clearTimeout(existing.releaseTimer);
      existing.releaseTimer = null;
      continue;
    }
    overlays.set(display.id, createOverlay(display));
  }
  for (const overlay of overlays.values()) {
    if (needed.has(overlay.displayId) || overlay.releaseTimer) continue;
    overlay.releaseTimer = setTimeout(() => {
      overlay.releaseTimer = null;
      const current = botBubbleService().current();
      if (
        !displaysNeedingOverlay(current, liveDisplays(), screen.getPrimaryDisplay().id).has(
          overlay.displayId,
        )
      ) {
        destroyOverlay(overlay);
      }
    }, RELEASE_DELAY_MS);
  }

  // Opening a mini chat focuses its overlay so the composer can type; closing it gives focus back.
  // Every sync, so focus follows an open chat whose head moved to another display.
  for (const overlay of overlays.values()) applyFocus(overlay, state);
}

function onDisplaysChanged(): void {
  const displays = liveDisplays();
  void botBubbleService()
    .displaysChanged(new Set(displays.map((display) => display.id)), screen.getPrimaryDisplay().id)
    .catch((error: unknown) =>
      logger.warn("bot-bubbles", "Could not move heads off a removed display.", error),
    );
  for (const overlay of [...overlays.values()]) {
    const display = displays.find((entry) => entry.id === overlay.displayId);
    if (!display) {
      destroyOverlay(overlay);
      continue;
    }
    overlay.workArea = display.workArea;
    if (overlay.window.isDestroyed()) continue;
    overlay.window.setBounds(display.workArea, false);
    overlay.window.webContents.send(BOT_BUBBLE_CHANNELS.overlayInfoChanged, overlayInfoOf(overlay));
  }
  syncOverlays(botBubbleService().current());
}

/**
 * Load the saved heads and keep the overlays in step with them and the
 * displays. Called once from `main/index.ts` after the app is ready.
 */
export function startBotBubbles(access: BotBubbleMainWindowAccess): void {
  mainWindowAccess = access;
  if (stopListening) return;
  const service = startBotBubbleService();
  const stopChanges = service.onChange((state) => syncOverlays(state));
  screen.on("display-removed", onDisplaysChanged);
  screen.on("display-added", onDisplaysChanged);
  screen.on("display-metrics-changed", onDisplaysChanged);
  stopListening = () => {
    stopChanges();
    screen.removeListener("display-removed", onDisplaysChanged);
    screen.removeListener("display-added", onDisplaysChanged);
    screen.removeListener("display-metrics-changed", onDisplaysChanged);
  };
  void service
    .ready()
    .then(() => {
      if (!stopListening) return;
      // Name a real display for every head, then draw them.
      onDisplaysChanged();
    })
    .catch(() => undefined);
}

/** The last app window closed: the overlays go; the next bubble change draws them again. */
export function releaseBotBubbleOverlays(): void {
  for (const overlay of [...overlays.values()]) destroyOverlay(overlay);
  overlays.clear();
}

/** Quit: every overlay goes and nothing draws them again. */
export function destroyBotBubbleOverlays(): void {
  stopListening?.();
  stopListening = null;
  stopBotBubbleService();
  releaseBotBubbleOverlays();
}

export { isBotBubbleOverlayWebContents };

/** What the overlay-scoped Bot IPC guard needs (see `bot-bubbles-overlay-access.ts`). */
export function botBubbleOverlayAccess(
  approvalBotId: (waitId: string) => string | null = () => null,
): BotBubbleOverlayAccess<IpcMainInvokeEvent> {
  return {
    isOverlayEvent: (event) => isBotBubbleOverlayWebContents(event.sender.id),
    isTrustedOverlayEvent: isBotBubbleOverlayEvent,
    bubbledBotIds: (event) => {
      const overlay = overlayForWebContents(event.sender.id);
      return overlay ? botIdsOnDisplay(overlay.displayId) : new Set();
    },
    approvalBotId,
  };
}

/** Whether the overlay page with this id draws this Bot's head now (its display's heads). */
export function botBubbleOverlayDrawsBot(webContentsId: number, botId: string): boolean {
  const overlay = overlayForWebContents(webContentsId);
  return overlay !== null && botIdsOnDisplay(overlay.displayId).has(botId);
}

export function isBotBubbleOverlayEvent(event: IpcMainInvokeEvent): boolean {
  if (overlays.size === 0 || !overlayUrl) return false;
  try {
    rendererDocumentOwner(event, () => new Error("Invalid Bot bubble sender."));
    const frame = event.senderFrame;
    if (!frame || frame.isDestroyed()) return false;
    const ids = new Set(
      [...overlays.values()]
        .filter((overlay) => !overlay.window.isDestroyed())
        .map((overlay) => overlay.window.webContents.id),
    );
    const trusted = isTrustedBotBubbleSender(ids, overlayUrl, {
      webContentsId: event.sender.id,
      frameUrl: frame.url,
      isMainFrame: frame === event.sender.mainFrame,
    });
    if (!trusted) releasePointerFor(event);
    return trusted;
  } catch {
    releasePointerFor(event);
    return false;
  }
}

/**
 * A refused request from an overlay window can't be trusted to say the pointer
 * left a head, so that overlay goes back to click-through rather than
 * swallowing every click on its display.
 */
function releasePointerFor(event: IpcMainInvokeEvent): void {
  const overlay = overlayForWebContents(event.sender.id);
  if (overlay) resetPointer(overlay);
}

function senderOverlay(event: IpcMainInvokeEvent): Overlay {
  const overlay = overlayForWebContents(event.sender.id);
  if (!overlay) throw new Error("This bubble overlay is no longer active.");
  return overlay;
}

function sendTransition(overlay: Overlay, transition: BotBubbleTransition): void {
  const now = overlay.transitions.offer(transition, Date.now());
  if (now && !overlay.window.isDestroyed())
    overlay.window.webContents.send(BOT_BUBBLE_CHANNELS.transition, now);
}

async function showChatInMainWindow(botId: string): Promise<void> {
  const window = await mainWindowAccess?.reveal();
  if (!window || window.isDestroyed()) return;
  window.webContents.send(BOT_BUBBLE_CHANNELS.showChat, { botId });
}

export const botBubbleWindowPort: BotBubbleWindowPort<IpcMainInvokeEvent> = {
  async capture(event, rect) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return null;
    const zoom = event.sender.getZoomFactor();
    const [width = 0, height = 0] = window.getContentSize();
    const area = captureRect(
      { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom },
      { width, height },
    );
    if (!area) return null;
    const image = await event.sender.capturePage(area);
    if (image.isEmpty()) return null;
    // One pixel per point is plenty for a quarter-second shrink.
    return image.resize({ width: area.width }).toDataURL();
  },

  coverChat(event, botId, rect, image) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return Promise.resolve(false);
    // The new head goes on the display under the main window (`displayIdFor`): its overlay takes the picture.
    const overlay = overlays.get(screen.getDisplayMatching(window.getBounds()).id);
    // No overlay there yet, or its page isn't listening: the shrink plays after the bubble instead.
    if (!overlay || overlay.window.isDestroyed() || !overlay.transitions.listening)
      return Promise.resolve(false);
    const contents = overlay.window.webContents;
    const { cover, shown } = coverWaits.start(contents.id);
    const target = scaleRect(
      windowRectToOverlay(
        rect,
        window.getContentBounds(),
        overlay.workArea,
        event.sender.getZoomFactor(),
      ),
      overlayZoom(overlay),
    );
    contents.send(BOT_BUBBLE_CHANNELS.transition, {
      botId,
      kind: "shrink",
      rect: target,
      image,
      cover,
    } satisfies BotBubbleTransition);
    return shown.then(() => true);
  },

  transitionShown(event, cover) {
    coverWaits.settle(cover, event.sender.id);
  },

  playShrink(event, botId, rect, image) {
    const window = BrowserWindow.fromWebContents(event.sender);
    const overlay = overlayForBot(botBubbleService().current(), botId);
    if (!window || window.isDestroyed() || !overlay) return;
    const target = scaleRect(
      windowRectToOverlay(
        rect,
        window.getContentBounds(),
        overlay.workArea,
        event.sender.getZoomFactor(),
      ),
      overlayZoom(overlay),
    );
    sendTransition(overlay, { botId, kind: "shrink", rect: target, image });
  },

  async bringBack(botId, close) {
    const before = botBubbleService().current();
    const overlay = before.host === "overlay" ? overlayForBot(before, botId) : null;
    const main = mainWindowAccess?.current() ?? null;
    let delay = 0;
    if (overlay && main && !main.isDestroyed() && main.isVisible() && !main.isMinimized()) {
      sendTransition(overlay, {
        botId,
        kind: "grow",
        rect: scaleRect(
          growTargetRect(main.getContentBounds(), overlay.workArea),
          overlayZoom(overlay),
        ),
        image: null,
      });
      delay = GROW_MS;
    }
    const state = await close();
    setTimeout(() => {
      void showChatInMainWindow(botId).catch((error: unknown) =>
        logger.warn("bot-bubbles", "Could not show the Bot's chat in Aiden.", error),
      );
    }, delay);
    return state;
  },

  displayIdFor(event) {
    const window = BrowserWindow.fromWebContents(event.sender);
    const overlay = overlayForWebContents(event.sender.id);
    if (overlay) return overlay.displayId;
    if (!window || window.isDestroyed()) return screen.getPrimaryDisplay().id;
    return screen.getDisplayMatching(window.getBounds()).id;
  },

  setInteractive(event, interactive) {
    const overlay = senderOverlay(event);
    overlay.flags.interactive = interactive;
    applyMouse(overlay);
  },

  setDragging(event, dragging) {
    const overlay = senderOverlay(event);
    overlay.flags.dragging = dragging;
    applyMouse(overlay);
  },

  overlayInfo(event) {
    const overlay = senderOverlay(event);
    // The page asks once it listens: play the animations that waited for it, after this reply.
    const waiting = overlay.transitions.markReady(Date.now());
    if (waiting.length > 0) {
      setTimeout(() => {
        for (const transition of waiting) {
          if (!overlay.window.isDestroyed())
            overlay.window.webContents.send(BOT_BUBBLE_CHANNELS.transition, transition);
        }
      }, 0);
    }
    return overlayInfoOf(overlay);
  },
};
