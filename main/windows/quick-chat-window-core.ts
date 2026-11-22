// Pure geometry calculations for the Floating Chat Starter (Quick Chat) window.
// Keeping this dependency-free allows deterministic unit testing across
// displays, scale factors, small screens, and mode transitions.

import type { QuickChatWindowMode } from "../../renderer/shared/quick-chat.js";

export interface RectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Transparent outer shadow padding around the visible floating card (`px-14 pt-10 pb-[68px]`). */
export const QUICK_CHAT_SHADOW_MARGIN = 56;

export const QUICK_CHAT_STAGE_SIZES: Record<QuickChatWindowMode, { width: number; height: number }> = {
  // 512x132 visible starter bar + 56px L/R, 40px top, 68px bottom shadow gutter (zero shadow clip).
  starter: { width: 624, height: 240 },
  // Expands upward when ModelPicker / WorkspacePicker popover is open so nothing clips.
  "starter-popover": { width: 624, height: 600 },
  // 460x592 visible mini-modal + 56px L/R, 40px top, 68px bottom shadow gutter.
  modal: { width: 572, height: 700 },
};

/**
 * Clamp a floating stage to fit inside the display's usable workArea, shrinking
 * the stage gracefully on small displays while preserving integer coordinates.
 */
export function clampBoundsToWorkArea(
  desired: RectBounds,
  workArea: RectBounds,
): RectBounds {
  const width = Math.max(1, Math.min(Math.round(desired.width), Math.round(workArea.width)));
  const height = Math.max(1, Math.min(Math.round(desired.height), Math.round(workArea.height)));
  const minX = Math.round(workArea.x);
  const maxX = Math.round(workArea.x + workArea.width - width);
  const minY = Math.round(workArea.y);
  const maxY = Math.round(workArea.y + workArea.height - height);
  const x = Math.min(Math.max(Math.round(desired.x), minX), Math.max(minX, maxX));
  const y = Math.min(Math.max(Math.round(desired.y), minY), Math.max(minY, maxY));
  return { x, y, width, height };
}

/**
 * Compute initial centered placement on the cursor display. Places the starter
 * bar horizontally centered and in the lower-middle zone (~72% down) so upward
 * expansion to `starter-popover` or `modal` feels anchored and stays on-screen.
 */
export function computeQuickChatInitialBounds(
  workArea: RectBounds,
  mode: QuickChatWindowMode,
): RectBounds {
  const target = QUICK_CHAT_STAGE_SIZES[mode];
  const width = Math.min(target.width, workArea.width);
  const height = Math.min(target.height, workArea.height);
  const x = workArea.x + (workArea.width - width) / 2;
  const starterAnchorBottomY =
    workArea.y +
    Math.max(
      workArea.height * 0.72,
      Math.min(workArea.height, QUICK_CHAT_STAGE_SIZES["starter-popover"].height),
    );
  const anchorBottomY =
    mode === "modal"
      ? workArea.y + (workArea.height + height) / 2
      : starterAnchorBottomY;
  const y = anchorBottomY - height;
  return clampBoundsToWorkArea({ x, y, width, height }, workArea);
}

/**
 * Compute target bounds when transitioning between `starter`, `starter-popover`,
 * and `modal`. Anchors the bottom edge and horizontal center of the current
 * window so the composer bar stays visually anchored as the card grows upward.
 */
export function computeQuickChatTransitionBounds(
  current: RectBounds,
  workArea: RectBounds,
  nextMode: QuickChatWindowMode,
): RectBounds {
  const target = QUICK_CHAT_STAGE_SIZES[nextMode];
  const width = Math.min(target.width, workArea.width);
  const height = Math.min(target.height, workArea.height);
  const centerX = current.x + current.width / 2;
  const bottomY = current.y + current.height;
  return clampBoundsToWorkArea(
    {
      x: centerX - width / 2,
      y: bottomY - height,
      width,
      height,
    },
    workArea,
  );
}

export function shouldHideQuickChatOnBlur(input: {
  mode: QuickChatWindowMode;
  keepOpenOnBlur: boolean;
  now: number;
  suppressBlurUntil: number;
}): boolean {
  if (input.now < input.suppressBlurUntil) return false;
  if (input.mode === "modal") return !input.keepOpenOnBlur;
  return true;
}

/**
 * Tracks an in-flight `lastWorkspaceId` settings write so concurrent
 * `settings:get` reads from Quick Chat observe the latest active project
 * workspace immediately before durable persistence settles on disk.
 */
export function createPendingLastWorkspaceTracker() {
  let seq = 0;
  let pending: string | undefined;
  return {
    beginWrite(workspaceId: string): number {
      seq += 1;
      pending = workspaceId;
      return seq;
    },
    settleWrite(token: number): void {
      if (token === seq) pending = undefined;
    },
    overlay<T extends { lastWorkspaceId?: string }>(settings: T): T {
      return pending !== undefined ? { ...settings, lastWorkspaceId: pending } : settings;
    },
  };
}
