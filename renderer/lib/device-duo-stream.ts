/**
 * Adapted from t3code packages/client-runtime/src/device/stream.ts (`setDuoPanels`) @ a6ec88f7 (MIT).
 *
 * The iPhone Duo 3D view shows both displays at once, so it needs more than the
 * one elected feed. While attached, this module replaces the parent client's
 * video with video-only feeds that share its host, grant and input socket:
 *
 * - With `supportsPhysicalOrientation`, the hub elects the active display, so
 *   one active feed (`/helper/<dev>/stream.avcc`) is enough. It is reopened when
 *   `screenId` changes to pick up the elected surface's seed and codec.
 * - Otherwise two fixed feeds (`/helper/<dev>/panel/1|3/stream.avcc`) run. Only
 *   the active display's frames are retained; an inactive LCD's shutdown black
 *   frame never overwrites its last useful image.
 *
 * Detaching resumes the parent's own video. HID never reconnects.
 */
import type { DeviceFrameSink, DeviceScreenSize, DeviceStreamStatus } from "./device-stream";

export type DuoPanelFeedId = 1 | 3;

export interface DuoPanelSinks {
  readonly cover: DeviceFrameSink;
  readonly inner: DeviceFrameSink;
  /** Invalidate captured input synchronously, before React can commit the new layout. */
  readonly onScreen?: (screen: DeviceScreenSize) => void;
}

export interface DuoFeed {
  start(): void;
  stop(): void;
}

export interface DuoFeedEvents {
  onStatus(status: DeviceStreamStatus, detail?: string): void;
  onUnauthorized(): void;
}

/** What the parent stream client lends the panel feeds. */
export interface DuoPanelHost {
  screen(): DeviceScreenSize | null;
  /** The parent is a running iOS client that may own panel feeds. */
  canAttach(): boolean;
  /** The parent's flat-canvas sink; the active display always reaches it. */
  readonly primary: DeviceFrameSink;
  /** Stops the parent's own video read. HID stays connected. */
  pausePrimaryVideo(): void;
  resumePrimaryVideo(): void;
  /** A video-only client on the same host and grant. `null` is the elected active display. */
  openFeed(panel: DuoPanelFeedId | null, sink: DeviceFrameSink, events: DuoFeedEvents): DuoFeed;
  /** A panel cannot be decoded or is not served; the owner should return to the flat view. */
  onUnavailable(detail?: string): void;
  onUnauthorized(): void;
}

export interface DuoPanelFeeds {
  /** Attach (or detach with null) the 3D view's per-display sinks. */
  set(panels: DuoPanelSinks | null): void;
  /** Called with every accepted screen config, after the parent stored it. */
  screenChanged(previous: DeviceScreenSize | null, next: DeviceScreenSize): void;
  attached(): boolean;
  /** The parent stopped; release every feed without resuming video. */
  stop(): void;
}

export function createDuoPanelFeeds(host: DuoPanelHost): DuoPanelFeeds {
  let sinks: DuoPanelSinks | null = null;
  let feeds: DuoFeed[] = [];
  const stopFeeds = () => {
    for (const feed of feeds) feed.stop();
    feeds = [];
  };
  const start = (panels: DuoPanelSinks) => {
    stopFeeds();
    // Physical handoff elects a native surface. Fixed-panel encoders can keep
    // an inactive shutdown frame after election, so one active feed is used
    // instead of decoding a third stream alongside the two fixed feeds.
    const ids: ReadonlyArray<DuoPanelFeedId | null> = host.screen()?.supportsPhysicalOrientation ? [null] : [1, 3];
    feeds = ids.map((id) =>
      host.openFeed(
        id,
        {
          present(source, width, height) {
            if (id === null) return host.primary.present(source, width, height);
            // An inactive native LCD can emit its shutdown black frame. Retain its last useful image.
            if (host.screen()?.screenId !== id) return true;
            const retained = (id === 1 ? panels.cover : panels.inner).present(source, width, height);
            const primary = host.primary.present(source, width, height);
            return retained && primary;
          },
        },
        {
          onStatus: (status, detail) => {
            if (status === "error") host.onUnavailable(detail);
          },
          onUnauthorized: () => host.onUnauthorized(),
        },
      ),
    );
    for (const feed of feeds) feed.start();
  };
  return {
    set(panels) {
      if (!host.canAttach() || sinks === panels) return;
      if (panels && !host.screen()?.supportsHingeAngle) return;
      sinks = panels;
      host.pausePrimaryVideo();
      stopFeeds();
      if (!panels) {
        host.resumePrimaryVideo();
        return;
      }
      start(panels);
    },
    screenChanged(previous, next) {
      sinks?.onScreen?.(next);
      // A surface election can leave an existing decoder on the former encoder
      // description. Reopen only video to acquire the elected surface's seed and
      // codec configuration; HID and the viewer stay.
      if (sinks && next.supportsPhysicalOrientation && previous && next.screenId !== previous.screenId) start(sinks);
    },
    attached: () => sinks !== null,
    stop() {
      stopFeeds();
      sinks = null;
    },
  };
}
