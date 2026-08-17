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
