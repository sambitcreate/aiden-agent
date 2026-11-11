import type {
  AidenMcpAppView,
  AidenMcpChatProvenanceView,
  AidenMcpIssuedAppView,
  AidenMcpServerStatusView,
} from "../../renderer/shared/aiden-mcp.js";

/** The parts of an outside-app record Settings needs; never a credential digest. */
interface AidenMcpAppRecord {
  id: string;
  name: string;
  access: "read" | "supervised";
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface AidenMcpHandlerService {
  status(): Promise<AidenMcpServerStatusView>;
  setEnabled(enabled: boolean): Promise<AidenMcpServerStatusView>;
  issueApp(input: { name: string; access: "read" | "supervised" }): Promise<{ credential: string; app: AidenMcpAppRecord }>;
  listApps(): Promise<AidenMcpAppRecord[]>;
  revokeApp(appId: string): Promise<boolean>;
  chatProvenance(chatId: string): Promise<{ name: string; startedAt: number } | undefined>;
}

const MAX_APP_NAME_LENGTH = 80;

/** The name and access level from Settings → Connections → Apps using Aiden → Add app. */
export function parseAidenMcpAppInput(value: unknown): { name: string; access: "read" | "supervised" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid app details.");
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name || name.length > MAX_APP_NAME_LENGTH) throw new Error("Give the app a name of up to 80 characters.");
  if (record.access !== "read" && record.access !== "supervised") throw new Error("Choose Read only or Supervised.");
  return { name, access: record.access };
}

/** An outside app's id. Apps share the paired-device id space, so this is a `device_` id. */
export function parseAidenMcpAppId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("device_") ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error("Invalid app identifier.");
  }
  return value;
}

function parseChatId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) throw new Error("Invalid chat identifier.");
  return value;
}

function appView(app: AidenMcpAppRecord): AidenMcpAppView {
  return { id: app.id, name: app.name, access: app.access, createdAt: app.createdAt, lastSeenAt: app.lastSeenAt };
}

/**
 * Settings → Connections → Apps using Aiden: the MCP server switch, and the outside
 * apps that may use it. The credential leaves main only in the answer to
 * `remote:mcpIssueApp`; nothing here logs it, and no other channel returns it.
 */
export function registerAidenMcpHandlers<Event>(dependencies: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  /** Throws unless the event comes from the active main-window document. */
  owner(event: Event): { isDestroyed(): boolean };
  service: AidenMcpHandlerService;
}): void {
  const { handle, owner, service } = dependencies;

  handle("remote:mcpStatus", (event) => {
    owner(event);
    return service.status();
  });

  handle("remote:mcpSetEnabled", (event, enabled) => {
    if (typeof enabled !== "boolean") throw new Error("Invalid MCP server setting.");
    owner(event);
    return service.setEnabled(enabled);
  });

  handle("remote:mcpIssueApp", async (event, input): Promise<AidenMcpIssuedAppView> => {
    const parsed = parseAidenMcpAppInput(input);
    const document = owner(event);
    const issued = await service.issueApp(parsed);
    // The window that asked is gone, so nobody can see the credential: take the
    // app back rather than leave a working token nobody holds.
    if (document.isDestroyed()) {
      await service.revokeApp(issued.app.id);
      throw new Error("The window that added this app closed.");
    }
    return { credential: issued.credential, app: appView(issued.app) };
  });

  handle("remote:mcpListApps", async (event): Promise<AidenMcpAppView[]> => {
    owner(event);
    // Disconnected apps are gone from Settings; their record stays for the audit log only.
    return (await service.listApps())
      .filter((app) => app.revokedAt === undefined)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(appView);
  });

  handle("remote:mcpRevokeApp", async (event, appId) => {
    const id = parseAidenMcpAppId(appId);
    owner(event);
    return { revoked: await service.revokeApp(id) };
  });

  handle("remote:mcpChatProvenance", async (event, chatId): Promise<AidenMcpChatProvenanceView | null> => {
    const id = parseChatId(chatId);
    owner(event);
    const provenance = await service.chatProvenance(id);
    return provenance ? { name: provenance.name, startedAt: provenance.startedAt } : null;
  });
}
