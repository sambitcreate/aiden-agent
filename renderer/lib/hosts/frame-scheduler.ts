/**
 * Runs `flush` once, before the next paint, and returns a cancel. Remote
 * surfaces use it to coalesce bursts of host traffic into one render per
 * frame.
 */
export type FrameScheduler = (flush: () => void) => () => void;

/**
 * The document's animation frame. Where there is none (a test or a worker),
 * the flush runs on the next task instead, which still coalesces a burst.
 * A hidden window gets no frames; what waits for one stays bounded by its
 * caller.
 */
export const animationFrame: FrameScheduler = (flush) => {
  const request = globalThis.requestAnimationFrame;
  if (typeof request === "function") {
    const handle = request.call(globalThis, () => flush());
    return () => globalThis.cancelAnimationFrame?.(handle);
  }
  const handle = setTimeout(flush, 0);
  return () => clearTimeout(handle);
};
