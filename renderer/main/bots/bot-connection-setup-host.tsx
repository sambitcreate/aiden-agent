import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onNotification } from "../../lib/ipc";
import { useConnectionSetup } from "./use-connection-setup";

/**
 * Opens a Bot connection's setup wherever the person is in the app, when main
 * asks for it (`bots:connections:setup`, for example a paired phone's "Finish
 * on your Mac"). Mounted once at the app root, so the request is never lost
 * because the Bots list happens to be closed.
 */
export function BotConnectionSetupHost({
  initialPluginId = null,
}: {
  initialPluginId?: string | null;
} = {}) {
  const qc = useQueryClient();
  const connectionSetup = useConnectionSetup(() => {
    void qc.invalidateQueries({ queryKey: ["bot-live-summary"] });
  });
  const openSetup = connectionSetup.open;
  const initialOpenedRef = React.useRef(false);
  React.useLayoutEffect(() => {
    if (initialOpenedRef.current || !initialPluginId) return;
    initialOpenedRef.current = true;
    openSetup(initialPluginId);
  }, [initialPluginId, openSetup]);
  React.useEffect(
    () =>
      onNotification("bots:connections:setup", (payload: { pluginId?: unknown }) => {
        if (typeof payload?.pluginId === "string") openSetup(payload.pluginId);
      }),
    [openSetup],
  );
  return connectionSetup.dialog;
}
