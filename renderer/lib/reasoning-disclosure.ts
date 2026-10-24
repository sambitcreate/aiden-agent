export interface ReasoningDisclosureState {
  expanded: boolean;
  userControlled: boolean;
}

export type ReasoningDisclosureLayout = "collapsed" | "preview" | "full";

/** Automatic previews stay bounded; deliberate expansion flows at full height. */
export function reasoningDisclosureLayout(
  state: ReasoningDisclosureState,
): ReasoningDisclosureLayout {
  if (!state.expanded) return "collapsed";
  return state.userControlled ? "full" : "preview";
}
