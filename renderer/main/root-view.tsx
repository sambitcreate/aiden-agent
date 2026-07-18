import { Outlet, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { Status } from "@glaze/core/components";
import { useTheme, useConnection, useEnvironment } from "@glaze/core/hooks";
import { onNotification } from "../lib/ipc";

export function RootView() {
  useTheme();
  const navigate = useNavigate();

  // IPC connection and environment
  const connectionQuery = useConnection();
  const environmentQuery = useEnvironment();

  // Menu "Settings…" (Cmd+,) navigates the main window in-app.
  React.useEffect(() => {
    const unsub = onNotification<{ path: string }>("app:navigate", (payload) => {
      if (payload?.path) void navigate({ to: payload.path });
    });
    return unsub;
  }, [navigate]);

  // Cleanup IPC connection on unmount
  React.useEffect(() => {
    return () => {
      console.log("[RootView] cleanup - disconnecting IPC client");
      window.glazeAPI?.glaze?.ipc?.disconnect();
    };
  }, []);

  return (
    <div className="h-full relative [&:not(:has([data-toolbar]))_.drag-region]:z-50">
      {/* Draggable top bar - fallback for when no toolbar is present */}
      <div className="drag-region fixed top-0 left-0 right-0 h-13" />
      <Outlet />

      <div className="flex flex-col items-end gap-1 mt-2 fixed bottom-12 right-2">
        {import.meta.env.DEV ? (
          <>
            {connectionQuery.error ? <Status variant="error">Backend disconnected</Status> : null}
            {environmentQuery.data ? null : <Status variant="error">Dev Server not found</Status>}
          </>
        ) : null}
      </div>
    </div>
  );
}
