import { parseMcpServer } from "./phase2-parse.js";
import { assertMcpPresetServer } from "../services/mcp-presets.js";
import { mcpProviderGrantBinding } from "../services/mcp-provider-auth-core.js";
import type { McpServer } from "../services/types.js";

/** A separate active-document action; ordinary config saves and imports never grant credentials. */
export function registerMcpProviderAuthHandler<Event>(dependencies: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  owner(event: Event): { isDestroyed(): boolean };
  publish(server: McpServer, allowed: boolean, isCurrent: () => boolean): Promise<void>;
}): void {
  dependencies.handle("mcp:providerAuth", async (event, value: unknown, allowed: unknown) => {
    const owner = dependencies.owner(event);
    const isCurrent = () => !owner.isDestroyed();
    if (!isCurrent()) throw new Error("MCP credential approval requires the active application document.");
    if (typeof allowed !== "boolean") throw new Error("Choose whether to allow the provider credential.");
    const parsed = parseMcpServer(value);
    assertMcpPresetServer(parsed);
    mcpProviderGrantBinding(parsed);
    await dependencies.publish(parsed, allowed, isCurrent);
    if (!isCurrent()) throw new Error("MCP credential approval requires the active application document.");
    return { authorized: allowed };
  });
}

/**
 * Settings → Providers' "Let custom connectors use this key". The trust
 * decision lives with the provider; main refuses anything but a saved API key.
 */
export function registerProviderKeySharingHandler<Event>(dependencies: {
  handle(channel: string, handler: (event: Event, ...args: unknown[]) => unknown): void;
  owner(event: Event): { isDestroyed(): boolean };
  set(providerId: string, allowed: boolean, isCurrent: () => boolean): Promise<void>;
}): void {
  dependencies.handle("providers:setConnectorKeySharing", async (event, providerId: unknown, allowed: unknown) => {
    const owner = dependencies.owner(event);
    const isCurrent = () => !owner.isDestroyed();
    if (typeof providerId !== "string" || !providerId || providerId.length > 200) throw new Error("Choose a provider.");
    if (typeof allowed !== "boolean") throw new Error("Choose whether custom connectors may use this key.");
    await dependencies.set(providerId, allowed, isCurrent);
    return { connectorKeySharing: allowed };
  });
}
