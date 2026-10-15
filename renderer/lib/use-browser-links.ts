import { useEffect } from "react";
import type { BrowserCommand } from "../shared/browser";
import { browserApi } from "./ipc";
import { resolveLinkOpen } from "./browser-link-routing";
import { toast } from "../components/ui";

export function useBrowserLinks(workspaceId: string | null | undefined): void {
  useEffect(() => {
    if (!workspaceId) return;
    const open = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.altKey || event.shiftKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
      const route = resolveLinkOpen({
        href: anchor.getAttribute("href") ?? "",
        modifiers: { metaKey: event.metaKey, ctrlKey: event.ctrlKey },
        preference: "browser",
        browserAvailable: true,
      });
      const command: BrowserCommand | null =
        route?.kind === "browser" || route?.kind === "external"
          ? { action: "open_link", url: route.url }
          : route?.kind === "file"
            ? { action: "open_file", path: route.path }
            : null;
      if (!command) return;
      event.preventDefault();
      void browserApi.command(workspaceId, command).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not open this link."));
    };
    document.addEventListener("click", open);
    return () => document.removeEventListener("click", open);
  }, [workspaceId]);
}
