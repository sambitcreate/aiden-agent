import { COMPOSIO_SERVICE_SERVER_ID, COMPOSIO_SERVICE_TOOL_NAME } from "../../renderer/shared/composio-service.js";

export const COMPOSIO_SERVICE_ACCESS_IDENTITY = "composio-service-v1";
export type BotConnectionAccessIdentity = typeof COMPOSIO_SERVICE_ACCESS_IDENTITY;

interface ConnectionCapabilityIdentity {
  sourceId: string;
  accessIdentity?: BotConnectionAccessIdentity;
}

/** Only the host's trusted fixed-preset path authors this private marker. */
export function isComposioServiceCapability(connection: ConnectionCapabilityIdentity): boolean {
  return connection.sourceId === COMPOSIO_SERVICE_SERVER_ID && connection.accessIdentity === COMPOSIO_SERVICE_ACCESS_IDENTITY;
}

export function parseBotConnectionAccessIdentity(value: unknown, connection: { sourceId: string; tools: readonly { name: string; effect: string }[] }): BotConnectionAccessIdentity | undefined {
  if (value === undefined) return undefined;
  if (value !== COMPOSIO_SERVICE_ACCESS_IDENTITY || connection.sourceId !== COMPOSIO_SERVICE_SERVER_ID
    || connection.tools.length > 1 || connection.tools.some((tool) => tool.name !== COMPOSIO_SERVICE_TOOL_NAME || tool.effect !== "mutating")) {
    throw new Error("Invalid host-owned Bot connection access identity.");
  }
  return value;
}

/** A broader service allowance is a new choice, distinct from the old raw-tool choice. */
export function botConnectionCapabilityIdentity(connection: ConnectionCapabilityIdentity): string {
  return isComposioServiceCapability(connection) ? `${connection.sourceId}\0${COMPOSIO_SERVICE_ACCESS_IDENTITY}` : connection.sourceId;
}
