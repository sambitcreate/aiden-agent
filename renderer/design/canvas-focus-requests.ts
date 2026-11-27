// Aiden's canvas_focus requests, kept for a few seconds per chat. When Aiden
// opens design mode from its card and focuses its first frames in the same
// reply, the request can arrive before the canvas has loaded; the canvas
// takes it from here once it mounts.

import * as React from "react";
import { designCanvasApi } from "../lib/ipc";

/**
 * One focus request: the frames to fit (the whole page when empty), the page
 * they are on, and main's `focusId` for the page change, which the canvas
 * echoes back in its view reports.
 */
export type CanvasFocusRequest = { ids: string[]; pageId?: string; focusId?: number; at: number };

const latest = new Map<string, CanvasFocusRequest>();
let installed = false;

/** Parses a `designCanvas:focus` payload; null for another shape. */
export function canvasFocusFrom(payload: unknown): { chatId: string; request: CanvasFocusRequest } | null {
  if (!payload || typeof payload !== "object") return null;
  const { chatId, frameIds, pageId, focusId } = payload as { chatId?: unknown; frameIds?: unknown; pageId?: unknown; focusId?: unknown };
  if (typeof chatId !== "string") return null;
  const ids = Array.isArray(frameIds) ? frameIds.filter((id): id is string => typeof id === "string") : [];
  return {
    chatId,
    request: {
      ids,
      ...(typeof pageId === "string" && pageId.length > 0 ? { pageId } : {}),
      ...(typeof focusId === "number" && Number.isSafeInteger(focusId) && focusId >= 0 ? { focusId } : {}),
      at: Date.now(),
    },
  };
}

/** Mounted once with the chat area, so a request is kept even while the canvas is still loading. */
export function useCanvasFocusRequests(enabled: boolean): void {
  React.useEffect(() => {
    if (!enabled || installed) return;
    installed = true;
    designCanvasApi.onDesignCanvasFocus((payload) => {
      const parsed = canvasFocusFrom(payload);
      if (parsed) latest.set(parsed.chatId, parsed.request);
    });
  }, [enabled]);
}

/**
 * The chat's newest focus request, once, however old: the canvas still
 * applies an old request's page change and only skips fitting its frames.
 */
export function takeCanvasFocus(chatId: string): CanvasFocusRequest | null {
  const request = latest.get(chatId);
  latest.delete(chatId);
  return request ?? null;
}

/** Forgets a request the canvas already acted on. */
export function forgetCanvasFocus(chatId: string): void {
  latest.delete(chatId);
}
