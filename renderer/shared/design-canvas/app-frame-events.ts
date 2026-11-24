// Main → renderer events for live app frames (design mode v2 Phase 3a, D16,
// S61), and the `designCanvas:appFrameMount` reply. Counts, refused
// navigations and dialog notices come from main, never from the page.

import { parseAppFrameName } from "./app-frame.js";

export const DESIGN_APP_FRAME_CHANNEL = "designCanvas:appFrame";
export const DESIGN_APP_FRAME_MOUNT_CHANNEL = "designCanvas:appFrameMount";

export const APP_FRAME_DIALOG_KINDS = ["alert", "confirm", "prompt", "print", "beforeunload"] as const;
export type AppFrameDialogKind = (typeof APP_FRAME_DIALOG_KINDS)[number];

/** At most this many distinct hosts travel with a `blocked` event. */
export const APP_FRAME_BLOCKED_HOSTS = 20;
const HOST_CHARS = 253;
const URL_CHARS = 2048;
const MAX_COUNT = 1_000_000_000;

export type DesignAppFrameEvent =
  | { kind: "blocked"; frameId: string; mountToken: string; count: number; hosts: string[] }
  | { kind: "navigation-refused"; frameId: string; mountToken: string; url: string }
  | { kind: "dialog-suppressed"; frameId: string; mountToken: string; dialog: AppFrameDialogKind };

export type DesignAppFrameMountError = "live-off" | "app-not-running" | "too-many-frames" | "unavailable";
export type DesignAppFrameMountResult = { origin: string } | { error: DesignAppFrameMountError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frameKey(value: Record<string, unknown>): { frameId: string; mountToken: string } | null {
  const { frameId, mountToken } = value;
  if (typeof frameId !== "string" || typeof mountToken !== "string") return null;
  // The name format carries both rules (id and token shapes).
  return parseAppFrameName(`aiden-app:${frameId}:${mountToken}`) ? { frameId, mountToken } : null;
}

/** A main → renderer event, checked field by field; anything else is null. */
export function parseDesignAppFrameEvent(value: unknown): DesignAppFrameEvent | null {
  if (!isRecord(value)) return null;
  const key = frameKey(value);
  if (!key) return null;
  switch (value.kind) {
    case "blocked": {
      const { count, hosts } = value;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) return null;
      if (!Array.isArray(hosts)) return null;
      const kept = hosts
        .filter((host): host is string => typeof host === "string" && host.length > 0 && host.length <= HOST_CHARS)
        .slice(0, APP_FRAME_BLOCKED_HOSTS);
      return { kind: "blocked", ...key, count, hosts: kept };
    }
    case "navigation-refused": {
      const { url } = value;
      if (typeof url !== "string" || url.length === 0 || url.length > URL_CHARS) return null;
      return { kind: "navigation-refused", ...key, url };
    }
    case "dialog-suppressed": {
      const { dialog } = value;
      if (typeof dialog !== "string" || !(APP_FRAME_DIALOG_KINDS as readonly string[]).includes(dialog)) return null;
      return { kind: "dialog-suppressed", ...key, dialog: dialog as AppFrameDialogKind };
    }
    default:
      return null;
  }
}

/** The mount reply as the renderer reads it; an unknown shape is `unavailable`. */
export function parseDesignAppFrameMountResult(value: unknown): DesignAppFrameMountResult {
  if (isRecord(value)) {
    if (typeof value.origin === "string" && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/u.test(value.origin)) {
      return { origin: value.origin };
    }
    if (
      value.error === "live-off" ||
      value.error === "app-not-running" ||
      value.error === "too-many-frames" ||
      value.error === "unavailable"
    ) {
      return { error: value.error };
    }
  }
  return { error: "unavailable" };
}
