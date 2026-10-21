// Settings controls for MCP servers that sit beside save/remove: browser
// sign-in (Authorize), cancelling a waiting sign-in, signing out, testing an unsaved draft, listing the
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
import type { McpPendingLaunchApproval, McpStatus, McpToolSummary } from "../../renderer/shared/mcp-status.js";
import type { McpServer } from "../services/types.js";

/** Longest API key a draft test accepts; matches what a pasted key can be. */
const MAX_DRAFT_KEY_CHARS = 8_192;

export interface McpDraftCredentials {
  /** A key pasted into an API-key preset but not saved yet. */
  apiKey?: string;
  /** The draft connects exactly like the saved server, so its stored credentials apply. */
  matchesSaved: boolean;
  /** The draft reaches the saved server's endpoint or command, so its stored env/header values may be used. */
  savedDestination: boolean;
}

export type { McpPendingLaunchApproval };

export interface McpControlDependencies<Event> {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  owner(event: Event): { isDestroyed(): boolean; onInvalidated?(listener: () => void): () => void };
  configured(serverId: string): Promise<McpServer | undefined>;
  /**
   * Run the browser sign-in for a server that uses it. `signal` aborts when
   * the requesting document goes away. Resolves once tokens are stored.
   */
  authorize(server: McpServer, isCurrent: () => boolean, signal: AbortSignal): Promise<{ authorized: true; connectionError?: string }>;
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
  signInState(server: McpServer): Promise<{ authorized: boolean; needsSignIn: boolean; hasSession: boolean }>;
  dependents(serverId: string): Promise<McpServerDependents>;
  liveStatus(): McpLiveStatus[];
  /** The server's full tool list from its last discovery in this process, if any. */
  toolList(serverId: string): McpToolSummary[] | undefined;
  pendingLaunchApprovals(): Promise<McpPendingLaunchApproval[]>;
  /** Approve `server` to run if it still has the launch fingerprint the user saw. */
  approveLaunch(server: McpServer, fingerprint: string): Promise<boolean>;
  /** Whether a saved local server may run (Settings tests of the saved command are gated like any launch). */
  launchApproved(server: McpServer): Promise<boolean>;
}

const INACTIVE = "MCP changes must come from the active application document.";

function usesBrowserSignIn(server: McpServer): boolean {
  const preset = assertMcpPresetServer(server);
  return preset ? preset.auth.kind === "oauth" : server.transport !== "stdio" && server.oauth === true;
}

function sameDestination(saved: McpServer, draft: McpServer): boolean {
  return saved.transport === draft.transport &&
    (draft.transport === "stdio"
      ? saved.command === draft.command && JSON.stringify(saved.args ?? []) === JSON.stringify(draft.args ?? [])
      : saved.url === draft.url);
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

  deps.handle("mcp:authorize", async (event, value: unknown) => {
    const owner = deps.owner(event);
    const isCurrent = () => !owner.isDestroyed();
    if (!isCurrent()) throw new Error("MCP authorization must come from the active application document.");
    const server = parseMcpServer(value);
    const preset = assertMcpPresetServer(server);
    if (preset && preset.auth.kind !== "oauth") throw new Error("This MCP preset uses an API key instead of OAuth.");
    if (!usesBrowserSignIn(server)) throw new Error("This MCP server does not use browser sign-in.");
    const ownerAbort = new AbortController();
    const stopWatching = owner.onInvalidated?.(() => ownerAbort.abort(new Error("The renderer document is no longer active.")));
    try {
      const result = await deps.authorize(server, isCurrent, ownerAbort.signal);
      return result.connectionError ? { authorized: true, connectionError: result.connectionError } : { authorized: true };
    } finally {
      stopWatching?.();
    }
  });

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
    const savedDestination = Boolean(saved && sameDestination(saved, draft));
    // Testing the saved command of a local server runs it: that needs the same
    // approval as any launch. A command the person typed themselves may run.
    if (draft.transport === "stdio" && savedDestination && !(await deps.launchApproved(saved!))) {
      return notConnected("Approve this server to run before testing it.");
    }
    const test = () => deps.testDraft(draft, { matchesSaved, savedDestination, ...(apiKey ? { apiKey } : {}) }, isCurrent);
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
      const { authorized, needsSignIn, hasSession } = await deps.signInState(saved!);
      return { ...result, authorized, ...(needsSignIn ? { needsSignIn: true } : {}), ...(hasSession ? { hasSession: true } : {}) };
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

  deps.handle("mcp:launchApprovals", async (event) => {
    live(event);
    return deps.pendingLaunchApprovals();
  });

  deps.handle("mcp:approveLaunch", async (event, id: unknown, fingerprint: unknown) => {
    const isCurrent = live(event);
    const serverId = asString(id, "id");
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error("Invalid launch fingerprint.");
    const configured = await deps.configured(serverId);
    if (!configured) throw new Error("This MCP server is no longer configured.");
    if (configured.transport !== "stdio") throw new Error("Only local MCP servers need approval to run.");
    if (!isCurrent()) throw new Error(INACTIVE);
    const approved = await deps.approveLaunch(configured, fingerprint);
    // The command changed after it was shown: show it again instead of approving it.
    if (!approved) throw new Error("This server’s command changed. Review it again before approving.");
    return { approved: true };
  });

  // Never connects: null until a discovery listed the server's tools.
  deps.handle("mcp:toolList", (event, id: unknown) => {
    live(event);
    return deps.toolList(asString(id, "id")) ?? null;
  });
}
