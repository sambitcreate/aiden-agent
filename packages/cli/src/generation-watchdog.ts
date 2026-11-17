/** Provider/tool silence is bounded independently from the total generation lifetime. */
const INACTIVITY_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 6 * 60 * 60 * 1000;

export function createGenerationWatchdog(expired: (reason: "inactive" | "deadline") => void) {
  let disposed = false;
  let idle: ReturnType<typeof setTimeout>;
  let deadline: ReturnType<typeof setTimeout>;
  const dispose = () => {
    disposed = true;
    clearTimeout(idle);
    clearTimeout(deadline);
  };
  const expire = (reason: "inactive" | "deadline") => {
    if (disposed) return;
    dispose();
    expired(reason);
  };
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => expire("inactive"), INACTIVITY_MS);
    idle.unref?.();
  };
  armIdle();
  deadline = setTimeout(() => expire("deadline"), MAX_DURATION_MS);
  deadline.unref?.();
  return {
    activity(event: { type: string }) {
      if (!disposed && (event.type === "message_update" || event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" || event.type === "tool_execution_end")) armIdle();
    },
    dispose,
  };
}
