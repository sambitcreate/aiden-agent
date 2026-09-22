import type { McpPresetAuth, McpPresetState, McpServer } from "./types";

export function mcpPresetCredentialReady({
  auth,
  hasStoredKey,
  draftKey,
  authorized,
}: {
  auth: McpPresetAuth;
  hasStoredKey: boolean;
  draftKey: string;
  authorized: boolean;
}): boolean {
  return auth.kind === "apiKey"
    ? hasStoredKey || Boolean(draftKey.trim())
    : authorized;
}

export function mcpPresetConnectionBadge(
  state: McpPresetState,
): { label: string; color: "green" | "red" | "secondary" } | null {
  if (!state.configured) return null;
  if (!state.ready) {
    return {
      label: state.preset.auth.kind === "oauth" ? "Needs sign-in" : "Needs key",
      color: "red",
    };
  }
  if (!state.enabled) return { label: "Disabled", color: "secondary" };
  return { label: "Configured", color: "green" };
}

export function mcpServerEditorKind(
  server: { presetId?: string; id: string },
  presetsLoaded: boolean,
  presets: McpPresetState[],
): "loading" | "preset" | "custom" | "missing-preset" {
  if (!server.presetId) return "custom";
  if (!presetsLoaded) return "loading";
  return presets.some(
    (state) => state.serverId === server.id && state.preset.id === server.presetId,
  )
    ? "preset"
    : "missing-preset";
}

/** Open a saved preset as a custom MCP editor when its catalog definition is gone. */
export function mcpServerDraftForEditor(
  server: McpServer,
  kind: ReturnType<typeof mcpServerEditorKind>,
): McpServer {
  if (kind !== "missing-preset") return server;
  const next = { ...server };
  delete next.presetId;
  return next;
}
