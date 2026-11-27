/** Frames that run only when the test advances time. */
export function manualFrames() {
  let queue: { id: number; callback: FrameRequestCallback }[] = [];
  let nextId = 0;
  let now = 1_000;
  const request = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    queue.push({ id: ++nextId, callback });
    return nextId;
  };
  globalThis.cancelAnimationFrame = (id) => {
    queue = queue.filter((frame) => frame.id !== id);
  };
  return {
    pending: () => queue.length,
    advance(ms: number) {
      now += ms;
      const due = queue;
      queue = [];
      for (const frame of due) frame.callback(now);
    },
    restore() {
      globalThis.requestAnimationFrame = request;
      globalThis.cancelAnimationFrame = cancel;
    },
  };
}
