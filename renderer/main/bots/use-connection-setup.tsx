import * as React from "react";
import { PresetSetupDialog } from "../../components/settings/mcp-preset-setup";
import { toast } from "../../components/ui";
import { useMcpPresets, useMcpServers } from "../../lib/queries";
import type { McpPresetState, McpServer } from "../../lib/types";
import { connectionSuggestionFor } from "../../shared/bot-connections";

interface SetupTarget {
  state: McpPresetState;
  server?: McpServer;
}

/**
 * The existing preset setup dialog, opened for a Bot connection by plugin id.
 * `open` returns false, after telling the person why, when the plugin has no
 * setup entry on this Mac; callers add no message of their own.
 */
export function useConnectionSetup(onSaved: () => void | Promise<void>) {
  const servers = useMcpServers();
  const presets = useMcpPresets();
  const [target, setTarget] = React.useState<SetupTarget | null>(null);

  const open = React.useCallback(
    (pluginId: string): boolean => {
      const suggestion = connectionSuggestionFor(pluginId);
      if (!suggestion) {
        toast.error("This connection can't be set up from here.");
        return false;
      }
      const presetId = suggestion.setupEntry.presetId;
      const state = presets.data?.find((entry) => entry.preset.id === presetId);
      if (!state) {
        toast.error(`${suggestion.name} isn't available to connect right now. Try again in a moment.`);
        return false;
      }
      const server = servers.data?.find((entry) => entry.id === state.serverId && entry.presetId === presetId);
      setTarget({ state, ...(server ? { server } : {}) });
      return true;
    },
    [presets.data, servers.data],
  );

  /**
   * Suggestions whose own preset is set up, switched on, and signed in. Apps
   * reached through Composio are not reported: Aiden can't see inside it.
   */
  const isConnected = React.useCallback(
    (pluginId: string): boolean => {
      const suggestion = connectionSuggestionFor(pluginId);
      if (suggestion?.setupEntry.kind !== "mcp-preset") return false;
      const state = presets.data?.find((entry) => entry.preset.id === suggestion.setupEntry.presetId);
      return Boolean(state?.configured && state.enabled && state.ready);
    },
    [presets.data],
  );

  const dialog = target ? (
    <PresetSetupDialog
      state={target.state}
      {...(target.server ? { server: target.server } : {})}
      open
      onOpenChange={(next) => {
        if (!next) setTarget(null);
      }}
      onSaved={onSaved}
    />
  ) : null;

  return { open, dialog, isConnected };
}
