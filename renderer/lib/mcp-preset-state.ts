import type { McpLiveStatus, McpPresetAuth, McpPresetState, McpServer, McpServerDependents } from "./types";

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
): { label: string; color: "green" | "red" | "gray" } | null {
  if (!state.configured) return null;
  if (state.error) return { label: "Needs repair", color: "red" };
  if (!state.ready) {
    return {
      label: state.preset.auth.kind === "oauth" ? "Needs sign-in" : "Needs key",
      color: "red",
    };
  }
  if (!state.enabled) return { label: "Disabled", color: "gray" };
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

export type McpLiveTone = "green" | "red" | "warning" | "neutral";

/** What a configured row says about its live connection. */
export function mcpLiveStatusView(
  status: McpLiveStatus | undefined,
  enabled: boolean,
): { label: string; tone: McpLiveTone; error?: string } | null {
  if (!enabled) return null;
  if (status?.needsSignIn) return { label: "Needs sign-in", tone: "warning" };
  switch (status?.state) {
    case "connected":
      return { label: "Connected", tone: "green" };
    case "connecting":
      return { label: "Connecting…", tone: "neutral" };
    case "failed":
      return { label: "Couldn’t connect", tone: "red", error: status.error };
    case "closed":
      return { label: "Idle", tone: "neutral" };
    default:
      return { label: "Not connected yet", tone: "neutral" };
  }
}

/** One sentence naming what relies on a server, or null when nothing does. */
export function mcpDependentsSummary(dependents: McpServerDependents | undefined): string | null {
  if (!dependents) return null;
  const quote = (names: string[]) => names.map((name) => `“${name}”`).join(", ");
  const parts = [
    dependents.schedules.length
      ? `${dependents.schedules.length === 1 ? "Scheduled task" : "Scheduled tasks"} ${quote(dependents.schedules.map((task) => task.name))}`
      : null,
    dependents.bots.length
      ? `${dependents.bots.length === 1 ? "Bot" : "Bots"} ${quote(dependents.bots.map((bot) => bot.name))}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" and ") : null;
}

/** Fields that decide where and how Aiden connects; changing them re-requires approval. */
export function mcpConnectionChanged(saved: McpServer, draft: McpServer): boolean {
  // Headers and environment are part of main's connection snapshot. Main drops
  // empty maps, so an empty map and a missing one are the same connection.
  const map = (record: Record<string, string> | undefined) => {
    const entries = Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right));
    return entries.length ? entries : null;
  };
  const pick = (server: McpServer) =>
    JSON.stringify([
      server.transport,
      server.command ?? null,
      server.args ?? [],
      server.url ?? null,
      map(server.env),
      map(server.headers),
      server.oauth === true,
      server.authServerMetadataUrl ?? null,
      server.oauthClientId ?? null,
      server.oauthClientSecret ?? null,
      server.authProvider ?? null,
    ]);
  return pick(saved) !== pick(draft);
}
