// The designApp:* channels (design mode v2, Phase 2b): the person's own
// controls for a chat's workspace apps (2c's chip and 3a's overlay call
// these), and the answer to a run-app card. Every request must come from a
// window's current main frame, for an attended desktop chat whose workspace
// has a folder, while the live flag is on. 2c adds running (the Connect
// sheet's scan), connect (a pick from it) and retry. Production wiring is in
// design-canvas-main.ts.

import { persistedChatWorkspaceId } from "../../renderer/shared/chat-workspace.js";
import { DESIGN_APP_CHANNELS } from "../../renderer/shared/design-app.js";
import type { WorkspaceGatePermission } from "../services/approval-gate/workspace-tool-approval.js";
import { isSafeWorkspaceRelativePath } from "../services/design-canvas/canvas-config.js";
import type { DesignAppConsent, DesignAppConsentOwner } from "../services/design-canvas/app-server/app-consent.js";
import { DESIGN_APP_LOG_MAX_BYTES, type DesignAppServers } from "../services/design-canvas/app-server/app-server-main.js";

const MAX_ID_CHARS = 200;
const UNAVAILABLE = "Live apps are not available.";

export interface DesignAppChat {
  id: string;
  workspaceId?: string;
  botId?: string;
  owner?: unknown;
}

export interface DesignAppHandlerDeps<Event> {
  /** The live flag. */
  enabled(): boolean;
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  /** The sender's current main-frame document; throws for a subframe or a stale document. */
  owner(event: Event): DesignAppConsentOwner;
  getChat(chatId: string): Promise<DesignAppChat | null>;
  workspace(workspaceId: string): Promise<{ id: string; folderPath?: string; permission: WorkspaceGatePermission } | null | undefined>;
  servers: Pick<DesignAppServers, "snapshot" | "start" | "stop" | "restart" | "choose" | "logs" | "running" | "connect" | "retry">;
  consent: Pick<DesignAppConsent, "answer">;
}

function chatIdOf(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_CHARS) {
    throw new Error('Expected a chat id for "chatId".');
  }
  return value;
}

function appRootOf(value: unknown): string {
  if (!isSafeWorkspaceRelativePath(value)) throw new Error('Expected an app root such as "." or "apps/web".');
  return value;
}

function optionsOf(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an options object.");
  return value as Record<string, unknown>;
}

/** A Connect pick: the row's port and pid. Main checks the pid again; it only selects (D8). */
function pickOf(value: unknown): { port: number; pid: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a running server to connect.");
  const { port, pid } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535) throw new Error('Expected a port from 1 to 65535 for "port".');
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) throw new Error('Expected a process id for "pid".');
  return { port: port as number, pid: pid as number };
}

export function registerDesignAppHandlers<Event>(deps: DesignAppHandlerDeps<Event>): void {
  /** The person's request: the flag, the sender, then the chat and its workspace folder. */
  const person = async (event: Event, chatIdArg: unknown) => {
    if (!deps.enabled()) throw new Error(UNAVAILABLE);
    const owner = deps.owner(event);
    const chatId = chatIdOf(chatIdArg);
    const chat = await deps.getChat(chatId);
    // Only an attended desktop chat runs apps: never a Bot's or a routine's.
    if (!chat || chat.botId || chat.owner) throw new Error("This chat can't run apps.");
    const workspace = await deps.workspace(persistedChatWorkspaceId(chat.workspaceId));
    if (!workspace?.folderPath) throw new Error("This chat's workspace has no folder on this computer.");
    return {
      owner,
      base: { workspaceId: workspace.id, chatId, by: "person" as const, owner, permission: workspace.permission },
    };
  };

  deps.handle(DESIGN_APP_CHANNELS.statusGet, async (event, chatId) => {
    const { base } = await person(event, chatId);
    return deps.servers.snapshot(base.workspaceId);
  });

  deps.handle(DESIGN_APP_CHANNELS.start, async (event, chatId, appRoot) => {
    const root = appRoot === undefined ? undefined : appRootOf(appRoot);
    const { base } = await person(event, chatId);
    return deps.servers.start({ ...base, ...(root !== undefined ? { appRoot: root } : {}) });
  });

  deps.handle(DESIGN_APP_CHANNELS.stop, async (event, chatId, appRoot) => {
    const root = appRootOf(appRoot);
    const { base } = await person(event, chatId);
    return deps.servers.stop(base.workspaceId, root);
  });

  deps.handle(DESIGN_APP_CHANNELS.restart, async (event, chatId, appRoot, options) => {
    const root = appRootOf(appRoot);
    const { install } = optionsOf(options);
    if (install !== undefined && typeof install !== "boolean") throw new Error('Expected a boolean for "install".');
    const { base } = await person(event, chatId);
    return deps.servers.restart({ ...base, appRoot: root, ...(install !== undefined ? { install } : {}) });
  });

  deps.handle(DESIGN_APP_CHANNELS.choose, async (event, chatId, appRoot, script) => {
    const root = appRootOf(appRoot);
    if (script !== undefined && (typeof script !== "string" || script.length === 0 || script.length > MAX_ID_CHARS)) {
      throw new Error('Expected a script name for "script".');
    }
    const { base } = await person(event, chatId);
    return deps.servers.choose({ ...base, appRoot: root, ...(script !== undefined ? { script } : {}) });
  });

  deps.handle(DESIGN_APP_CHANNELS.logs, async (event, chatId, appRoot, options) => {
    const root = appRootOf(appRoot);
    const { after, run } = optionsOf(options);
    if (after !== undefined && !(Number.isSafeInteger(after) && (after as number) >= 0)) {
      throw new Error('Expected a non-negative whole number for "after".');
    }
    if (run !== undefined && (typeof run !== "string" || run.length === 0 || run.length > MAX_ID_CHARS)) {
      throw new Error('Expected a run id for "run".');
    }
    const { base } = await person(event, chatId);
    return deps.servers.logs(base.workspaceId, root, {
      ...(after !== undefined ? { after: after as number } : {}),
      ...(run !== undefined ? { run: run as string } : {}),
      maxBytes: DESIGN_APP_LOG_MAX_BYTES,
    });
  });

  // 2c (D6): the person opened Connect running server… or pressed Refresh in it.
  deps.handle(DESIGN_APP_CHANNELS.running, async (event, chatId) => {
    const { base } = await person(event, chatId);
    return deps.servers.running({ workspaceId: base.workspaceId, owner: base.owner, permission: base.permission });
  });

  deps.handle(DESIGN_APP_CHANNELS.connect, async (event, chatId, pick) => {
    const { port, pid } = pickOf(pick);
    const { base } = await person(event, chatId);
    return deps.servers.connect({ ...base, port, pid });
  });

  deps.handle(DESIGN_APP_CHANNELS.retry, async (event, chatId, appRoot) => {
    const root = appRootOf(appRoot);
    const { base } = await person(event, chatId);
    return deps.servers.retry({ ...base, appRoot: root });
  });

  // The person's answer on a run-app card; only the window that shows the card may answer it.
  deps.handle(DESIGN_APP_CHANNELS.consentAnswer, (event, requestId, answer) => {
    if (!deps.enabled()) return false;
    let owner: DesignAppConsentOwner;
    try {
      owner = deps.owner(event);
    } catch {
      return false;
    }
    return deps.consent.answer(requestId, answer, owner);
  });
}

/**
 * The Enter path of Aiden's "Open design mode?" card: turn design mode on the
 * way the toggle does and tell every window, then, with the live flag on,
 * start the workspace's app for the window that answered (which shows the
 * run-app card first).
 */
export function createDesignModeCardEnter(deps: {
  setDesignMode(chatId: string): Promise<{ id: string; workspaceId?: string } | null>;
  broadcastEntered(chatId: string): void;
  designApp: {
    enabled(): boolean;
    entered(input: { chatId: string; workspaceId: string; owner: DesignAppConsentOwner }): void;
  };
}) {
  return (owner: DesignAppConsentOwner) => async (chatId: string): Promise<void> => {
    const chat = await deps.setDesignMode(chatId);
    deps.broadcastEntered(chatId);
    if (chat && deps.designApp.enabled()) {
      deps.designApp.entered({ chatId, workspaceId: persistedChatWorkspaceId(chat.workspaceId), owner });
    }
  };
}
