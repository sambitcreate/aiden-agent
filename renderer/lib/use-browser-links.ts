import { useEffect } from "react";
import { browserApi } from "./ipc";
import { browserLinkCommand } from "./browser-links";
import { toast } from "../components/ui";

export function useBrowserLinks(workspaceId: string | null | undefined): void {
  useEffect(() => {
    if (!workspaceId) return;
    const open = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.altKey || event.shiftKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
      const command = browserLinkCommand(anchor.getAttribute("href") ?? "", event);
      if (!command) return;
      event.preventDefault();
      void browserApi.command(workspaceId, command).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not open this link."));
    };
    document.addEventListener("click", open);
    return () => document.removeEventListener("click", open);
  }, [workspaceId]);
}
