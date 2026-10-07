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
 * `open` returns false when the plugin has no setup entry on this Mac.
 */
export function useConnectionSetup(onSaved: () => void | Promise<void>) {
  const servers = useMcpServers();
  const presets = useMcpPresets();
  const [target, setTarget] = React.useState<SetupTarget | null>(null);

  const open = React.useCallback(
    (pluginId: string): boolean => {
      const suggestion = connectionSuggestionFor(pluginId);
      if (!suggestion) return false;
      const presetId = suggestion.setupEntry.presetId;
      const state = presets.data?.find((entry) => entry.preset.id === presetId);
      if (!state) {
        toast.error("This connection is unavailable. Reload Settings and try again.");
        return false;
      }
      const server = servers.data?.find((entry) => entry.id === state.serverId && entry.presetId === presetId);
      setTarget({ state, ...(server ? { server } : {}) });
      return true;
    },
    [presets.data, servers.data],
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

  return { open, dialog };
}
