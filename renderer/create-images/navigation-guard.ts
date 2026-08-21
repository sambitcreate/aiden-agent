export interface CreateImagesNavigationDecision {
  allowed: boolean;
  message?: string;
}

let flushBeforeNavigation: (() => Promise<CreateImagesNavigationDecision>) | undefined;

declare global {
  interface Window {
    __aidenFlushCreateImagesForLifecycle?: () => Promise<boolean>;
  }
}

export function registerCreateImagesNavigationGuard(
  flush: () => Promise<CreateImagesNavigationDecision>,
): () => void {
  flushBeforeNavigation = flush;
  if (typeof window !== "undefined") {
    window.__aidenFlushCreateImagesForLifecycle = async () => {
      const timeout = new Promise<CreateImagesNavigationDecision>((resolve) => {
        window.setTimeout(
          () => resolve({ allowed: false, message: "Autosave is still running." }),
          2_500,
        );
      });
      return (await Promise.race([flush(), timeout])).allowed;
    };
  }
  return () => {
    if (flushBeforeNavigation === flush) {
      flushBeforeNavigation = undefined;
      if (typeof window !== "undefined") delete window.__aidenFlushCreateImagesForLifecycle;
    }
  };
}

export async function requestCreateImagesNavigation(): Promise<CreateImagesNavigationDecision> {
  return flushBeforeNavigation ? flushBeforeNavigation() : { allowed: true };
}
