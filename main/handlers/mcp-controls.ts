// Settings controls for MCP servers that sit beside save/remove: cancelling a
// waiting browser sign-in, signing out, testing an unsaved draft, listing the
// schedules and Bots that depend on a server, and reading live status.
// Dependencies are injected so the IPC contract is exercised without Electron.

import { parseMcpServer } from "./phase2-parse.js";
import { asString } from "./voice-codec.js";
import { assertMcpPresetServer } from "../services/mcp-presets.js";
import {
  mcpCredentialConnectionSnapshot,
  sameMcpCredentialConnection,
} from "../services/mcp-credential-cleanup-core.js";
import type { McpServerDependents } from "../services/mcp-dependents.js";
import type { McpLiveStatus } from "../services/mcp-status-events.js";
import type { McpStatus } from "../../renderer/shared/mcp-status.js";
import type { McpServer } from "../services/types.js";

/** Longest API key a draft test accepts; matches what a pasted key can be. */
const MAX_DRAFT_KEY_CHARS = 8_192;

export interface McpDraftCredentials {
  /** A key pasted into an API-key preset but not saved yet. */
  apiKey?: string;
  /** The draft connects exactly like the saved server, so its stored credentials apply. */
  matchesSaved: boolean;
}

export interface McpControlDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  owner(event: Event): { isDestroyed(): boolean };
  configured(serverId: string): Promise<McpServer | undefined>;
  cancelAuthorization(serverId: string): boolean;
  signOut(server: McpServer, isCurrent: () => boolean): Promise<void>;
  testDraft(server: McpServer, credentials: McpDraftCredentials, isCurrent: () => boolean): Promise<McpStatus>;
  /**
   * Run `operation` under configured-MCP admission for the saved record a
   * draft matched: pending credential cleanup is reconciled first and the
   * operation is refused if that saved record changed since it was compared.
   */
  admitSaved<R>(saved: McpServer, operation: () => Promise<R>, isCurrent: () => boolean): Promise<R>;
  /** Stored browser sign-in state of a saved server, as `mcp:status` reports it. */
  signInState(server: McpServer): Promise<{ authorized: boolean; needsSignIn: boolean }>;
  dependents(serverId: string): Promise<McpServerDependents>;
  liveStatus(): McpLiveStatus[];
}

const INACTIVE = "MCP changes must come from the active application document.";

function usesBrowserSignIn(server: McpServer): boolean {
  const preset = assertMcpPresetServer(server);
  return preset ? preset.auth.kind === "oauth" : server.transport !== "stdio" && server.oauth === true;
}

function notConnected(error: string): McpStatus {
  return { connected: false, toolCount: 0, tools: [], serverCapabilities: null, error };
}

export function registerMcpControlHandlers<Event>(deps: McpControlDependencies<Event>): void {
  const live = (event: Event) => {
    const owner = deps.owner(event);
    const isCurrent = () => !owner.isDestroyed();
    if (!isCurrent()) throw new Error(INACTIVE);
    return isCurrent;
  };

  deps.handle("mcp:cancelAuthorize", (event, id: unknown) => {
    live(event);
    return { cancelled: deps.cancelAuthorization(asString(id, "id")) };
  });

  deps.handle("mcp:signOut", async (event, id: unknown) => {
    const isCurrent = live(event);
    const serverId = asString(id, "id");
    const configured = await deps.configured(serverId);
    if (!configured) throw new Error("This MCP server is no longer configured.");
    if (!usesBrowserSignIn(configured)) throw new Error("This MCP server does not use browser sign-in.");
    // A sign-in still waiting in the browser would otherwise store tokens again.
    deps.cancelAuthorization(serverId);
    await deps.signOut(configured, isCurrent);
    if (!isCurrent()) throw new Error(INACTIVE);
    return { authorized: false };
  });

  deps.handle("mcp:testDraft", async (event, value: unknown, key: unknown) => {
    const isCurrent = live(event);
    // The same validation as save, without persisting anything.
    const draft = parseMcpServer(value);
    const preset = assertMcpPresetServer(draft);
    if (key !== undefined && typeof key !== "string") throw new Error("Invalid API key.");
    const apiKey = typeof key === "string" ? key.trim() : "";
    if (apiKey && preset?.auth.kind !== "apiKey") throw new Error("This MCP server does not take an API key.");
    if (apiKey.length > MAX_DRAFT_KEY_CHARS) throw new Error("This API key is too long.");
    const saved = await deps.configured(draft.id);
    const matchesSaved = Boolean(
      saved &&
        sameMcpCredentialConnection(
          mcpCredentialConnectionSnapshot(saved),
          mcpCredentialConnectionSnapshot(draft),
        ),
    );
    // Stored sign-in tokens belong to the saved endpoint. A new or changed
    // endpoint must never borrow them, register a client, or overwrite them.
    if (usesBrowserSignIn(draft) && !matchesSaved) {
      return notConnected("Authorize this server to test the connection.");
    }
    const test = () => deps.testDraft(draft, { matchesSaved, ...(apiKey ? { apiKey } : {}) }, isCurrent);
    if (!matchesSaved) {
      const status = await test();
      if (!isCurrent()) throw new Error(INACTIVE);
      return status;
    }
    // Saved credentials are read only under admission for the exact saved
    // record that was compared, so a concurrent edit cannot lend them out.
    const status = await deps.admitSaved(saved!, async () => {
      const result = await test();
      if (!usesBrowserSignIn(draft)) return result;
      const { authorized, needsSignIn } = await deps.signInState(saved!);
      return { ...result, authorized, ...(needsSignIn ? { needsSignIn: true } : {}) };
    }, isCurrent);
    if (!isCurrent()) throw new Error(INACTIVE);
    return status;
  });

  deps.handle("mcp:dependents", async (event, id: unknown) => {
    live(event);
    return deps.dependents(asString(id, "id"));
  });

  deps.handle("mcp:liveStatus", (event) => {
    live(event);
    return deps.liveStatus();
  });
}
