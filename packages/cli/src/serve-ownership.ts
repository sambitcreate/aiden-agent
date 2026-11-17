/**
 * What `aiden serve stop` may do to the process a serve lease names. These are
 * pure decisions over what the caller observed. Signals, polling and artifact
 * cleanup stay in serve-lifecycle.ts. See docs/state-machines/serve-daemon.md.
 */

/**
 * - `daemon`: the recorded `<entry> serve`.
 * - `aiden`: a live one-shot command holding the lock legitimately.
 * - `foreign`: inspectable and not ours, so a recycled PID.
 * - `unknown`: the platform cannot show its command line.
 */
export type ServeProcessClass = "daemon" | "aiden" | "foreign" | "unknown";

/** `gone` is a PID with no process behind it. */
export type ServeOwnerObservation = ServeProcessClass | "gone";

export type ServeStopStart = "signal" | "clear_stale" | "refuse_aiden" | "refuse_unverified";

/** Only a verified daemon is ever signalled. */
export function decideServeStopStart(owner: ServeOwnerObservation): ServeStopStart {
  switch (owner) {
    case "daemon": return "signal";
    case "gone": case "foreign": return "clear_stale";
    case "aiden": return "refuse_aiden";
    case "unknown": return "refuse_unverified";
  }
}

export type ServeStopDeadline = "stopped" | "clear_stale" | "force" | "unconfirmed";

/**
 * The grace period ended. Force needs the same owner and a verified daemon, because
 * the PID may no longer be ours. A failed check here proves nothing about exit.
 */
export function decideServeStopDeadline(owner: ServeOwnerObservation, sameOwner: boolean): ServeStopDeadline {
  if (!sameOwner) return "stopped";
  if (owner === "daemon") return "force";
  return owner === "gone" || owner === "foreign" ? "clear_stale" : "unconfirmed";
}
