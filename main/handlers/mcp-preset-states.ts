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
  /** OAuth presets: a browser sign-in is stored (usable or not), so Sign out can remove it. */
  hasSession?: boolean;
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
  signIn,
}: {
  presets: readonly Preset[];
  servers: readonly Server[];
  serverIdFor: (preset: Preset) => string;
  /** Throws when a saved record cannot be used as this preset. */
  validate: (server: Server) => void;
  isReady: (preset: Preset, serverId: string, existing: Server | undefined) => Promise<boolean>;
  /** OAuth sign-in state of a saved preset record; undefined for presets without browser sign-in. */
  signIn?: (preset: Preset, serverId: string, existing: Server) => Promise<{ needsSignIn: boolean; hasSession: boolean } | undefined>;
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
        const state = existing ? await signIn?.(preset, serverId, existing) : undefined;
        return {
          ...base,
          ready,
          ...(state?.needsSignIn ? { needsSignIn: true } : {}),
          ...(state?.hasSession ? { hasSession: true } : {}),
        };
      } catch (error) {
        return failed(error, false);
      }
    }),
  );
}
