// Builds the `mcp:presets` response. One malformed saved preset record must
// not take the whole Plugins directory down, so each preset resolves on its own
// and a failure becomes that preset's `error` instead of rejecting the call.

export interface McpPresetStateRecord<Preset> {
  preset: Preset;
  serverId: string;
  configured: boolean;
  enabled: boolean;
  ready: boolean;
  /** Stored sign-in stopped working (refresh rejected); shown instead of signed in. */
  needsSignIn?: boolean;
  /** Why the saved record for this preset is unusable; the user can repair or remove it. */
  error?: string;
  /**
   * The saved record itself failed validation (as opposed to a credential lookup
   * failing), so setup must rebuild it from the preset's official settings.
   */
  invalidRecord?: boolean;
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
  needsSignIn,
}: {
  presets: readonly Preset[];
  servers: readonly Server[];
  serverIdFor: (preset: Preset) => string;
  /** Throws when a saved record cannot be used as this preset. */
  validate: (server: Server) => void;
  isReady: (preset: Preset, serverId: string, existing: Server | undefined) => Promise<boolean>;
  needsSignIn?: (preset: Preset, serverId: string) => boolean;
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
      const failed = (error: unknown, invalidRecord: boolean) => ({
        ...base,
        ready: false,
        error: error instanceof Error ? error.message : String(error),
        ...(invalidRecord ? { invalidRecord: true } : {}),
      });
      try {
        if (existing) validate(existing);
      } catch (error) {
        return failed(error, true);
      }
      try {
        const ready = await isReady(preset, serverId, existing);
        return existing && needsSignIn?.(preset, serverId)
          ? { ...base, ready, needsSignIn: true }
          : { ...base, ready };
      } catch (error) {
        return failed(error, false);
      }
    }),
  );
}
