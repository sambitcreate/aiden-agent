import { appApi, type RendererDiagnosticReport } from "./ipc";

declare const __AIDEN_REACT_PROFILING__: boolean;

let pendingCommitCount = 0;
let pendingCommitDurationMs = 0;
let commitFlush: ReturnType<typeof setTimeout> | null = null;
const startupMilestones = new Set<string>();
const diagnosticsEnabled = __AIDEN_REACT_PROFILING__;

function report(value: RendererDiagnosticReport): void {
  if (!diagnosticsEnabled) return;
  void appApi.reportDiagnostic(value).catch(() => {
    // Diagnostics cannot change application behavior.
  });
}

export function reportStartupMilestone(
  name: "startup.shell_painted" | "startup.providers_ready" | "startup.composer_ready",
): void {
  if (!diagnosticsEnabled) return;
  if (startupMilestones.has(name)) return;
  startupMilestones.add(name);
  report({ name });
}

export function recordReactCommit(durationMs: number): void {
  if (!diagnosticsEnabled) return;
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  pendingCommitCount += 1;
  pendingCommitDurationMs += durationMs;
  if (commitFlush) return;
  commitFlush = setTimeout(() => {
    const count = pendingCommitCount;
    const total = pendingCommitDurationMs;
    pendingCommitCount = 0;
    pendingCommitDurationMs = 0;
    commitFlush = null;
    report({ name: "renderer.react_commit", count, durationMs: total });
  }, 250);
}

export function installRendererPerformanceDiagnostics(): () => void {
  if (!diagnosticsEnabled) return () => {};
  if (typeof PerformanceObserver === "undefined") return () => {};
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        report({ name: "renderer.long_task", durationMs: entry.duration });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    observer?.disconnect();
    observer = null;
  }
  return () => {
    observer?.disconnect();
    if (commitFlush) clearTimeout(commitFlush);
    commitFlush = null;
    pendingCommitCount = 0;
    pendingCommitDurationMs = 0;
  };
}

export function installRendererSchedulerDiagnostics(): () => void {
  const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  const originalCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  const originalSetTimeout = window.setTimeout.bind(window);
  const originalClearTimeout = window.clearTimeout.bind(window);
  const originalSetInterval = window.setInterval.bind(window);
  const originalClearInterval = window.clearInterval.bind(window);
  const originalScrollTo = Element.prototype.scrollTo;
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  const scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const rafs = new Set<number>();
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  let scrollWrites = 0;
  let snapshotTimer: number | null = null;

  const scheduleSnapshot = () => {
    if (snapshotTimer !== null) return;
    snapshotTimer = originalSetTimeout(() => {
      snapshotTimer = null;
      const writes = scrollWrites;
      scrollWrites = 0;
      report({
        name: "renderer.scheduler_snapshot",
        rafCount: rafs.size,
        timerCount: timeouts.size + intervals.size,
        scrollWrites: writes,
      });
    }, 50);
  };

  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    let id = 0;
    id = originalRequestAnimationFrame((time) => {
      rafs.delete(id);
      scheduleSnapshot();
      callback(time);
    });
    rafs.add(id);
    scheduleSnapshot();
    return id;
  };
  window.cancelAnimationFrame = (id: number): void => {
    rafs.delete(id);
    originalCancelAnimationFrame(id);
    scheduleSnapshot();
  };
  window.setTimeout = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
    let id = 0;
    id = originalSetTimeout(() => {
      timeouts.delete(id);
      scheduleSnapshot();
      if (typeof callback === "function") callback(...args);
    }, timeout);
    timeouts.add(id);
    scheduleSnapshot();
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: unknown): void => {
    if (typeof id === "number") timeouts.delete(id);
    originalClearTimeout(id as never);
    scheduleSnapshot();
  }) as typeof window.clearTimeout;
  window.setInterval = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = originalSetInterval(callback, timeout, ...args) as unknown as number;
    intervals.add(id);
    scheduleSnapshot();
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = ((id?: unknown): void => {
    if (typeof id === "number") intervals.delete(id);
    originalClearInterval(id as never);
    scheduleSnapshot();
  }) as typeof window.clearInterval;
  Element.prototype.scrollTo = function (
    this: Element,
    ...args: Parameters<Element["scrollTo"]>
  ): void {
    scrollWrites += 1;
    scheduleSnapshot();
    originalScrollTo.apply(this, args);
  } as Element["scrollTo"];
  Element.prototype.scrollIntoView = function (
    this: Element,
    ...args: Parameters<Element["scrollIntoView"]>
  ): void {
    scrollWrites += 1;
    scheduleSnapshot();
    originalScrollIntoView.apply(this, args);
  };
  if (scrollTopDescriptor?.get && scrollTopDescriptor.set) {
    Object.defineProperty(Element.prototype, "scrollTop", {
      ...scrollTopDescriptor,
      set(value: number) {
        scrollWrites += 1;
        scheduleSnapshot();
        scrollTopDescriptor.set?.call(this, value);
      },
    });
  }

  scheduleSnapshot();
  return () => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
    Element.prototype.scrollTo = originalScrollTo;
    Element.prototype.scrollIntoView = originalScrollIntoView;
    if (scrollTopDescriptor)
      Object.defineProperty(Element.prototype, "scrollTop", scrollTopDescriptor);
    if (snapshotTimer !== null) originalClearTimeout(snapshotTimer);
  };
}

export function reportFirstShellPaint(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => reportStartupMilestone("startup.shell_painted"));
  });
}
