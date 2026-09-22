/* global clearTimeout, setTimeout */

export function waitForBoundedChild(
  child,
  { label, timeoutMs, terminationGraceMs = 5_000, forceExitGraceMs = 1_000 },
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let terminationTimer;
    let forceExitTimer;

    const cleanup = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(terminationTimer);
      clearTimeout(forceExitTimer);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onError = (error) => {
      settle(() => reject(new Error(`${label} failed to start.`, { cause: error })));
    };
    const onClose = (code, signal) => {
      if (timedOut) {
        settle(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)));
        return;
      }
      settle(() => resolve({ code, signal }));
    };
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The final bounded rejection below still settles the gate.
      }
      terminationTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The final bounded rejection below still settles the gate.
        }
        forceExitTimer = setTimeout(() => {
          settle(() => reject(new Error(`${label} did not exit after SIGKILL.`)));
        }, forceExitGraceMs);
      }, terminationGraceMs);
    }, timeoutMs);

    child.once("error", onError);
    child.once("close", onClose);
  });
}
