// Whether a Bot's chat is open in front of the person right now.
//
// The Bot live view knows which documents show which Bot's chat; the window
// layer knows which of them is focused and whether the person is at the Mac.
// The handler registration sets the probe, and the delivery funnel asks it, so
// neither has to import the other. With no probe set, nothing is in front and
// every message alerts as before.

let probe: ((botId: string) => boolean) | undefined;

/** Install the probe; the returned function removes it if it is still the one installed. */
export function setBotChatInFrontProbe(next: (botId: string) => boolean): () => void {
  probe = next;
  return () => {
    if (probe === next) probe = undefined;
  };
}

/** True only while that Bot's chat is in a focused window and the person is at the Mac. */
export function botChatInFront(botId: string): boolean {
  try {
    return probe?.(botId) === true;
  } catch {
    return false;
  }
}
