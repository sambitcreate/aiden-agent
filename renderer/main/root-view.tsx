import { Outlet, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { onNotification } from "../lib/ipc";
import { useTheme } from "../lib/use-theme";
import { WorkspaceProvider } from "../lib/workspace-context";
import { WorkspaceTerminalProvider } from "../components/terminal-drawer";

export function RootView() {
  useTheme();
  const navigate = useNavigate();

  React.useEffect(() => {
    return onNotification<{ path: string }>("app:navigate", (payload) => {
      if (payload?.path) void navigate({ to: payload.path });
    });
  }, [navigate]);

  React.useEffect(() => {
    const syncFocus = () => document.documentElement.classList.toggle("window-blurred", !document.hasFocus());
    syncFocus();
    window.addEventListener("focus", syncFocus);
    window.addEventListener("blur", syncFocus);
    return () => {
      window.removeEventListener("focus", syncFocus);
      window.removeEventListener("blur", syncFocus);
    };
  }, []);

  return <WorkspaceProvider><WorkspaceTerminalProvider><div className="relative h-full"><Outlet /></div></WorkspaceTerminalProvider></WorkspaceProvider>;
}
