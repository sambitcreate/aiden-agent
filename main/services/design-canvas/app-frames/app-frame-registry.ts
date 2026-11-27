// Which main-window frames are live app frames (design mode v2 Phase 3a, D2,
// S69, S70). A frame becomes one only through admission: the renderer placed
// it as an `app` node, main recorded its one-use name token and the origin it
// expects, it is a fresh direct child of the main frame, the main frame
// started the navigation, and the navigation goes to exactly that origin.
//
// Membership is by Chromium's `frameTreeNodeId`, which lasts as long as the
// `<iframe>` element and is never reused. It is sticky: no navigation, name
// change or main-document load removes a frame. Only ids gone from the main
// window's frame tree are pruned, and only when the set is full; a live frame
// is never evicted, and a full set refuses new frames.

import {
  APP_FRAME_BLOCKED_HOSTS,
  type DesignAppFrameEvent,
} from "../../../../renderer/shared/design-canvas/app-frame-events.js";
import { appFrameName, parseAppFrameName } from "../../../../renderer/shared/design-canvas/app-frame.js";
import { isLoopbackHttpOrigin, type AppContextKind, type AppFrameRef } from "./app-network-policy.js";

export const APP_FRAME_REGISTRY_CAP = 512;
export const APP_FRAME_RECORD_TTL_MS = 30_000;
export const APP_FRAME_WAITING_RECORDS = 12;
const BLOCKED_COALESCE_MS = 250;
const MAX_WALK = 64;

type Placement = { name: string; frameId: string; mountToken: string; expectedOrigin: string; expiresAt: number };

export type AdmitNavigation = {
  frame: { readonly frameTreeNodeId: number; readonly name: string; readonly url: string };
  targetUrl: string;
  isDirectChild: boolean;
  initiator: "main-frame" | "none" | "other";
  /** The frame is (or was) on an `aiden-design:` page, per v1's guard. */
  designFrame: boolean;
};

type Schedule = (callback: () => void, ms: number) => unknown;

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    return null;
  }
}

export class AppFrameRegistry {
  private readonly members = new Map<number, { frameId: string; mountToken: string; origin: string }>();
  private readonly waiting = new Map<string, Placement>();
  private readonly exportContents = new Set<number>();
  /** When each export window last started a request, for its settle (D18). */
  private readonly exportActivity = new Map<number, number>();
  private readonly listeners = new Set<(event: DesignAppFrameEvent) => void>();
  private readonly admitListeners = new Set<(origin: string) => void>();
  private readonly pendingBlocked = new Map<number, { count: number; hosts: string[] }>();
  private readonly totals = new Map<number, { count: number; hosts: string[] }>();
  private readonly cap: number;
  private readonly now: () => number;
  private readonly schedule: Schedule;

  constructor(
    private readonly options: {
      mainContents(): unknown;
      /** `frameTreeNodeId`s in the main window's frame tree, or null with no window. */
      liveIds(): ReadonlySet<number> | null;
      /** The renderer's own origin; a loopback frame on it isn't a backstop. */
      rendererOrigin?: string;
      cap?: number;
      now?: () => number;
      schedule?: Schedule;
    },
  ) {
    this.cap = options.cap ?? APP_FRAME_REGISTRY_CAP;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  }

  /** The window this registry decides for, through the caller's getter. */
  mainContents(): unknown {
    return this.options.mainContents();
  }

  private prune(): void {
    if (this.members.size < this.cap) return;
    const live = this.options.liveIds();
    if (!live) return;
    for (const id of [...this.members.keys()]) {
      if (!live.has(id)) {
        this.members.delete(id);
        this.totals.delete(id);
        this.pendingBlocked.delete(id);
      }
    }
  }

  private hasRoom(): boolean {
    this.prune();
    return this.members.size < this.cap;
  }

  private dropExpired(): void {
    const at = this.now();
    for (const [name, record] of this.waiting) if (record.expiresAt <= at) this.waiting.delete(name);
  }

  /** Main recorded the renderer's placement; the frame may now be admitted once (D2). */
  expectPlacement(record: { frameId: string; mountToken: string; expectedOrigin: string }): "ok" | "too-many-frames" {
    if (!this.hasRoom()) return "too-many-frames";
    this.dropExpired();
    const name = appFrameName(record.frameId, record.mountToken);
    this.waiting.delete(name);
    while (this.waiting.size >= APP_FRAME_WAITING_RECORDS) {
      const oldest = this.waiting.keys().next().value;
      if (oldest === undefined) break;
      this.waiting.delete(oldest);
    }
    this.waiting.set(name, { name, ...record, expiresAt: this.now() + APP_FRAME_RECORD_TTL_MS });
    return "ok";
  }

  /**
   * Admission for a main-window subframe navigation. `not-candidate` when the
   * frame's name isn't an app frame name at all; `refused` when it is but a
   * condition fails. The record is consumed by the first navigation naming it.
   */
  admit(navigation: AdmitNavigation): "app" | "refused" | "not-candidate" {
    let name: string;
    let id: number;
    let currentUrl: string;
    try {
      name = navigation.frame.name;
      id = navigation.frame.frameTreeNodeId;
      currentUrl = navigation.frame.url;
    } catch {
      return "refused";
    }
    const parsed = parseAppFrameName(name);
    if (!parsed) return "not-candidate";
    const record = this.waiting.get(name);
    if (record) this.waiting.delete(name);
    if (!record || record.expiresAt <= this.now()) return "refused";
    if (this.members.has(id)) return "refused";
    if (!navigation.isDirectChild || navigation.designFrame) return "refused";
    if (navigation.initiator !== "main-frame") return "refused";
    if (currentUrl !== "" && currentUrl !== "about:blank") return "refused";
    if (originOf(navigation.targetUrl) !== record.expectedOrigin) return "refused";
    if (!this.hasRoom()) return "refused";
    this.members.set(id, { frameId: parsed.frameId, mountToken: parsed.mountToken, origin: record.expectedOrigin });
    for (const listener of this.admitListeners) {
      try {
        listener(record.expectedOrigin);
      } catch {
        // A listener's failure never undoes an admission.
      }
    }
    return "app";
  }

  isAppFrame(frameTreeNodeId: number): boolean {
    return this.members.has(frameTreeNodeId);
  }

  /** The canvas frame an admitted frame shows, for events. */
  frameInfo(frameTreeNodeId: number): { frameId: string; mountToken: string } | null {
    const member = this.members.get(frameTreeNodeId);
    return member ? { frameId: member.frameId, mountToken: member.mountToken } : null;
  }

  /** The registered frame a frame belongs to: itself or its nearest registered ancestor. */
  registeredAncestor(frame: AppFrameRef | null): number | null {
    let current: AppFrameRef | null = frame;
    for (let depth = 0; current && depth < MAX_WALK; depth++) {
      try {
        const id = current.frameTreeNodeId;
        if (this.members.has(id)) return id;
        current = current.parent;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Whether a frame is in app context (D2): it or an ancestor is registered,
   * or, in the main window, it is a subframe on a non-renderer loopback origin,
   * its chain doesn't reach the main frame, or reading it throws.
   */
  appContext(frame: AppFrameRef | null, inMainWindow: boolean): AppContextKind | null {
    if (!frame) return null;
    let current: AppFrameRef | null = frame;
    let backstop = false;
    for (let depth = 0; depth < MAX_WALK; depth++) {
      if (!current) return inMainWindow ? "backstop" : null;
      try {
        if (this.members.has(current.frameTreeNodeId)) return "registered";
        if (current.isMainFrame) return backstop ? "backstop" : null;
        if (inMainWindow) {
          const origin = current.origin;
          if (isLoopbackHttpOrigin(origin) && origin !== this.options.rendererOrigin) backstop = true;
        }
        current = current.parent;
      } catch {
        return inMainWindow ? "backstop" : null;
      }
    }
    return inMainWindow ? "backstop" : null;
  }

  addExportContents(webContentsId: number): () => void {
    this.exportContents.add(webContentsId);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.exportContents.delete(webContentsId);
      this.exportActivity.delete(webContentsId);
    };
  }

  isExportContents(webContentsId: number): boolean {
    return this.exportContents.has(webContentsId);
  }

  /** A request started in `webContentsId`; recorded only for a registered export window. */
  noteExportRequest(webContentsId: number): void {
    if (this.exportContents.has(webContentsId)) this.exportActivity.set(webContentsId, this.now());
  }

  /** When the export window last started a request, or undefined when none has. */
  lastExportRequest(webContentsId: number): number | undefined {
    return this.exportActivity.get(webContentsId);
  }

  /** A blocked request or navigation in app context; counted for its registered frame only. */
  reportBlocked(frame: AppFrameRef | null, hostOrScheme: string): void {
    const id = this.registeredAncestor(frame);
    if (id === null) return;
    this.reportBlockedFor(id, hostOrScheme);
  }

  reportBlockedFor(frameTreeNodeId: number, hostOrScheme: string): void {
    if (!this.members.has(frameTreeNodeId)) return;
    const pending = this.pendingBlocked.get(frameTreeNodeId);
    const total = this.totals.get(frameTreeNodeId) ?? { count: 0, hosts: [] };
    total.count += 1;
    if (hostOrScheme && !total.hosts.includes(hostOrScheme) && total.hosts.length < APP_FRAME_BLOCKED_HOSTS) {
      total.hosts.push(hostOrScheme);
    }
    this.totals.set(frameTreeNodeId, total);
    if (pending) return;
    this.pendingBlocked.set(frameTreeNodeId, total);
    this.schedule(() => {
      this.pendingBlocked.delete(frameTreeNodeId);
      const info = this.frameInfo(frameTreeNodeId);
      const latest = this.totals.get(frameTreeNodeId);
      if (!info || !latest) return;
      this.emit({ kind: "blocked", ...info, count: latest.count, hosts: [...latest.hosts] });
    }, BLOCKED_COALESCE_MS);
  }

  /** Sends an event for a registered frame (navigation-refused, dialog-suppressed). */
  emitFor(
    frameTreeNodeId: number,
    event: { kind: "navigation-refused"; url: string } | { kind: "dialog-suppressed"; dialog: Extract<DesignAppFrameEvent, { kind: "dialog-suppressed" }>["dialog"] },
  ): void {
    const info = this.frameInfo(frameTreeNodeId);
    if (!info) return;
    this.emit({ ...event, ...info } as DesignAppFrameEvent);
  }

  private emit(event: DesignAppFrameEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One listener's failure doesn't stop the others.
      }
    }
  }

  onEvent(listener: (event: DesignAppFrameEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called with the expected origin after each admission (S76). */
  onAdmit(listener: (origin: string) => void): () => void {
    this.admitListeners.add(listener);
    return () => this.admitListeners.delete(listener);
  }
}
