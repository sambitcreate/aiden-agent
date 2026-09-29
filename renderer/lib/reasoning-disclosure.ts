export const REASONING_PREVIEW_MS = 1_000;

export interface ReasoningDisclosureState {
  expanded: boolean;
  userControlled: boolean;
}

export type ReasoningDisclosureEvent = { type: "preview-elapsed" } | { type: "toggle" };

/**
 * Streaming reasoning previews open so the disclosure is discoverable. Stored
 * responses start closed, matching Pi's inspect-on-demand transcript behavior.
 */
export function initialReasoningDisclosure(streaming: boolean): ReasoningDisclosureState {
  return { expanded: streaming, userControlled: false };
}

/** Explicit user intent always wins over the one-time automatic preview. */
export function reduceReasoningDisclosure(
  state: ReasoningDisclosureState,
  event: ReasoningDisclosureEvent,
): ReasoningDisclosureState {
  if (event.type === "toggle") {
    return { expanded: !state.expanded, userControlled: true };
  }
  if (state.userControlled || !state.expanded) return state;
  return { expanded: false, userControlled: false };
}

export type ReasoningDisclosureLayout = "collapsed" | "preview" | "full";

/**
 * The automatic streaming preview is a short, tail-following window. Once the
 * reader deliberately opens a disclosure it flows at full height inside the
 * transcript, with a sticky header, so long reasoning reads like prose instead
 * of a cramped nested scroller.
 */
export function reasoningDisclosureLayout(
  state: ReasoningDisclosureState,
): ReasoningDisclosureLayout {
  if (!state.expanded) return "collapsed";
  return state.userControlled ? "full" : "preview";
}
