/** Honest quit copy: what quitting does to image requests that are already on the wire. */
export function imageRunQuitConfirmation(inFlightRequests: number): {
  title: string;
  message: string;
  detail: string;
  buttons: [string, string];
  defaultId: 0;
  cancelId: 0;
} | null {
  if (!Number.isSafeInteger(inFlightRequests) || inFlightRequests <= 0) return null;
  const plural = inFlightRequests === 1 ? "" : "s";
  return {
    title: "Image requests in progress",
    message: `${inFlightRequests} image request${plural} in progress.`,
    detail: "Quitting cancels them. Requests already sent may still be billed by the provider.",
    buttons: ["Keep Aiden Open", `Quit and Cancel Request${plural}`],
    defaultId: 0,
    cancelId: 0,
  };
}

/**
 * The one quit decision every path shares (window close that quits, Cmd+Q, quit with no window).
 * `show` displays the prompt and returns the pressed button index. True means go ahead and quit.
 */
export function imageRunsAllowQuit(
  inFlightRequests: number,
  show: (prompt: NonNullable<ReturnType<typeof imageRunQuitConfirmation>>) => number,
  alreadyConfirmedRequests = 0,
): boolean {
  // Requests the user already agreed to cancel need no second question. Anything beyond that count started since.
  if (inFlightRequests <= alreadyConfirmedRequests) return true;
  const prompt = imageRunQuitConfirmation(inFlightRequests);
  if (!prompt) return true;
  return show(prompt) === 1;
}

/**
 * How many in-flight requests the user already agreed to cancel on a last-window close, so the quit that
 * close triggers does not ask again. It is a count, never a flag: only a confirmation that covered
 * requests counts, and a quit with more in flight than were confirmed asks about the live total.
 */
export class ImageQuitCoverage {
  private covered = 0;

  /** The close prompt was answered "quit" (or was not needed). It covers requests only when the close quits the app. */
  recordWindowCloseConfirmation(closeQuitsApp: boolean, confirmedInFlight: number): void {
    this.covered = closeQuitsApp && Number.isSafeInteger(confirmedInFlight) && confirmedInFlight > 0 ? confirmedInFlight : 0;
  }

  /** The close or quit that was confirmed did not happen (declined, vetoed, retried): nothing stays confirmed. */
  clear(): void {
    this.covered = 0;
  }

  /** The before-quit it confirmed takes the coverage; a later quit starts from nothing. */
  consume(): number {
    const covered = this.covered;
    this.covered = 0;
    return covered;
  }
}
