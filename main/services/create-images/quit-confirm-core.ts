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
