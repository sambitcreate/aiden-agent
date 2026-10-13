// Builds the `mcp:presets` response. One malformed saved preset record must
// not take the whole Plugins directory down, so each preset resolves on its own
// and a failure becomes that preset's `error` instead of rejecting the call.

export interface McpPresetStateRecord<Preset> {
  preset: Preset;
  serverId: string;
  configured: boolean;
  enabled: boolean;
  ready: boolean;
  /** Why the saved record for this preset is unusable; the user can repair or remove it. */
  error?: string;
}

export async function buildMcpPresetStates<
  Preset extends { id: string },
  Server extends { id: string; presetId?: string; enabled: boolean },
>({
  presets,
  servers,
  serverIdFor,
  validate,
  isReady,
}: {
  presets: readonly Preset[];
  servers: readonly Server[];
  serverIdFor: (preset: Preset) => string;
  /** Throws when a saved record cannot be used as this preset. */
  validate: (server: Server) => void;
  isReady: (preset: Preset, serverId: string, existing: Server | undefined) => Promise<boolean>;
}): Promise<McpPresetStateRecord<Preset>[]> {
  return Promise.all(
    presets.map(async (preset) => {
      const serverId = serverIdFor(preset);
      const existing = servers.find((s) => s.id === serverId && s.presetId === preset.id);
      const base = {
        preset,
        serverId,
        configured: Boolean(existing),
        enabled: existing?.enabled ?? true,
      };
      try {
        if (existing) validate(existing);
        return { ...base, ready: await isReady(preset, serverId, existing) };
      } catch (error) {
        return {
          ...base,
          ready: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}
