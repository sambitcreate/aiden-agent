// The window's main areas, in the order F6 visits them: the sidebar, the
// conversation, the message box and the side panel. ⇧F6 goes the other way.
// An area opts in with `data-focus-region`; one that is closed, hidden or
// absent on this page is skipped. Focus lands on the area's own entry point:
// `data-focus-region-entry` when it names one, the selected tab, the sidebar's
// current row, or else the first thing that takes focus.
//
// ⌥↑ and ⌥↓ step through the replies in the conversation, from the
// conversation itself or from an empty message box, landing on the reply's
// actions (Copy, Fork) so they can be used straight away.

import * as React from "react";
import { typingRedirectBlockedByOverlay, isReservedTypingSurface } from "./composer-type-focus";

export const FOCUS_REGIONS = ["sidebar", "chat", "composer", "panel"] as const;
export type FocusRegion = (typeof FOCUS_REGIONS)[number];

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function shown(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  // Not in test DOMs, which lay nothing out.
  return typeof element.checkVisibility !== "function" || element.checkVisibility();
}

/** The shown element for an area, if this page has one. */
export function focusRegionElement(region: FocusRegion, root: ParentNode = document): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(`[data-focus-region="${region}"]`)) {
    // A closed side panel stays mounted as it animates away. (On the area only:
    // a row that is a tooltip trigger also says data-state="closed".)
    if (element.getAttribute("data-state") !== "closed" && shown(element)) return element;
  }
  return null;
}

/** The area that holds `element`, if any. */
export function focusRegionOf(element: Element | null): FocusRegion | null {
  const region = element?.closest("[data-focus-region]")?.getAttribute("data-focus-region");
  return (FOCUS_REGIONS as readonly string[]).includes(region ?? "") ? (region as FocusRegion) : null;
}

function regionEntry(element: HTMLElement): HTMLElement | null {
  if (element.hasAttribute("data-focus-region-entry")) return element;
  const candidates = [
    element.querySelector<HTMLElement>("[data-focus-region-entry]"),
    element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'),
    element.querySelector<HTMLElement>("[data-roving-item]:not([tabindex='-1'])"),
    ...Array.from(element.querySelectorAll<HTMLElement>(TABBABLE)).filter(
      (candidate) => candidate.getAttribute("role") !== "separator",
    ),
  ];
  return candidates.find((candidate): candidate is HTMLElement => candidate !== null && shown(candidate)) ?? null;
}

/** Move focus into `region`. False when the page has no such area or it holds nothing to focus. */
export function focusRegion(region: FocusRegion, root: ParentNode = document): boolean {
  const element = focusRegionElement(region, root);
  const entry = element ? regionEntry(element) : null;
  if (!entry) return false;
  entry.focus({ preventScroll: entry === element });
  const doc = (root as Node).nodeType === Node.DOCUMENT_NODE ? (root as Document) : null;
  return doc ? doc.activeElement === entry : true;
}

/**
 * Focus `region` as soon as it is on screen, for a moment after something that
 * covered the window (onboarding) goes away. If the page changes under it (a
 * new page's message box replaces the old one), it focuses the new one. It
 * stops once anything else takes focus, or after `timeoutMs`. Returns a cancel
 * function.
 */
export function focusRegionWhenShown(region: FocusRegion, timeoutMs = 2000): () => void {
  const started = performance.now();
  let frame = 0;
  let focused: Element | null = null;
  const attempt = () => {
    if (performance.now() - started >= timeoutMs) return;
    const active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement || !active.isConnected) {
      if (focusRegion(region)) focused = document.activeElement;
    } else if (active !== focused) {
      return;
    }
    frame = requestAnimationFrame(attempt);
  };
  frame = requestAnimationFrame(attempt);
  return () => cancelAnimationFrame(frame);
}

/** Focus the next (1) or previous (-1) area after the one holding `from`. */
export function cycleFocusRegion(
  direction: 1 | -1,
  from: Element | null,
  root: ParentNode = document,
): FocusRegion | null {
  const current = focusRegionOf(from);
  const count = FOCUS_REGIONS.length;
  // From outside every area, F6 starts at the first and ⇧F6 at the last.
  let index = current ? FOCUS_REGIONS.indexOf(current) : direction === 1 ? -1 : count;
  for (let step = 0; step < count; step += 1) {
    index = (index + direction + count) % count;
    const region = FOCUS_REGIONS[index]!;
    if (region !== current && focusRegion(region, root)) return region;
  }
  return null;
}

const REPLY = "[data-transcript-reply]";

/**
 * Focus the reply after (1) or before (-1) the one holding `from` in the
 * conversation; from outside a reply, ⌥↑ starts at the latest reply.
 */
export function stepReply(direction: 1 | -1, from: Element | null, root: ParentNode = document): HTMLElement | null {
  const conversation = focusRegionElement("chat", root);
  if (!conversation) return null;
  const replies = Array.from(conversation.querySelectorAll<HTMLElement>(REPLY));
  if (replies.length === 0) return null;
  const currentReply = from?.closest<HTMLElement>(REPLY);
  const index = currentReply ? replies.indexOf(currentReply) : -1;
  const next =
    index >= 0
      ? replies[index + direction]
      : direction === -1
        ? replies[replies.length - 1]
        : null;
  if (!next) return null;
  // The reply's own actions (Copy, then Fork) when it has them, else the reply.
  const action = next.querySelector<HTMLElement>(
    "[data-message-actions]:not([aria-hidden='true']) button:not([disabled]), button[data-message-action]:not([disabled])",
  );
  const target = action ?? next;
  if (!action && !target.hasAttribute("tabindex")) target.tabIndex = -1;
  target.focus();
  if (!action) target.scrollIntoView?.({ block: "nearest" });
  return target;
}

function keyIsPlain(event: KeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

function isEmptyMessageBox(element: Element | null): boolean {
  return (
    element instanceof HTMLTextAreaElement &&
    element.hasAttribute("data-message-draft") &&
    element.value === "" &&
    (element.getAttribute("data-message-draft") ?? "") === ""
  );
}

/** Listens for F6, ⇧F6, ⌥↑ and ⌥↓ across the window. */
export function useFocusRegionKeys(): void {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const active = document.activeElement;
      if (typingRedirectBlockedByOverlay(document, active)) return;
      if (event.key === "F6" && keyIsPlain(event)) {
        if (cycleFocusRegion(event.shiftKey ? -1 : 1, active)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !isReservedTypingSurface(active)
      ) {
        // Inside the message box ⌥↑ moves the caret; it steps replies only while the box is empty.
        const fromConversation = focusRegionOf(active) === "chat";
        if (!fromConversation && !isEmptyMessageBox(active)) return;
        const direction = event.key === "ArrowUp" ? -1 : 1;
        // ⌥↓ past the latest reply comes back to the message box.
        if (
          stepReply(direction, fromConversation ? active : null) ||
          (fromConversation && direction === 1 && focusRegion("composer"))
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
