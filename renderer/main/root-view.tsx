import { Outlet, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { appApi, onNotification } from "../lib/ipc";
import { useTheme } from "../lib/use-theme";
import { WorkspaceProvider } from "../lib/workspace-context";
import { WorkspaceTerminalProvider } from "../components/terminal-drawer";
import { EnvironmentPanelProvider, useEnvironmentPanel } from "../components/environment-panel";
import { toast } from "../components/ui";
import {
  consumeRendererLifecycleUnloadApproval,
  rendererLifecycleGuarded,
} from "../lib/lifecycle-guard";

export function RootView() {
  useTheme();
  return (
    <WorkspaceProvider>
      <WorkspaceTerminalProvider>
        <EnvironmentPanelProvider>
          <RootContent />
        </EnvironmentPanelProvider>
      </WorkspaceTerminalProvider>
    </WorkspaceProvider>
  );
}

function RootContent() {
  const navigate = useNavigate();
  const environmentPanel = useEnvironmentPanel();
  const navigationBlockedReason = environmentPanel.gitOperationBusy
    ? "Wait for the current Git operation to finish before leaving the chat."
    : environmentPanel.editorState.saving
      ? "Wait for the open file to finish saving before leaving the chat."
      : environmentPanel.editorState.dirty
        ? "Save or discard the open file's edits before leaving the chat."
        : null;
  React.useEffect(() => {
    void appApi.setCloseGuard({
      dirty: environmentPanel.editorState.dirty,
      gitBusy: environmentPanel.gitOperationBusy,
      path: environmentPanel.editorState.path ?? undefined,
      saving: environmentPanel.editorState.saving,
    });
  }, [
    environmentPanel.editorState.dirty,
    environmentPanel.editorState.path,
    environmentPanel.editorState.saving,
    environmentPanel.gitOperationBusy,
  ]);

  React.useEffect(() => () => {
    void appApi.setCloseGuard({ dirty: false, gitBusy: false, saving: false });
  }, []);

  React.useEffect(() => {
    const preventUnprotectedUnload = (event: BeforeUnloadEvent) => {
      if (consumeRendererLifecycleUnloadApproval()) return;
      if (!rendererLifecycleGuarded()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnprotectedUnload);
    return () => window.removeEventListener("beforeunload", preventUnprotectedUnload);
  }, []);

  React.useEffect(() => {
    return onNotification<{ path: string }>("app:navigate", (payload) => {
      if (!payload?.path) return;
      if (navigationBlockedReason) {
        toast.info(navigationBlockedReason);
        return;
      }
      void navigate({ to: payload.path });
    });
  }, [navigate, navigationBlockedReason]);

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

  return <div data-app-focus-root tabIndex={-1} className="relative h-full outline-none"><Outlet /></div>;
}
