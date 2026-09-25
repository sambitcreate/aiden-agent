import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpStatus } from "../../renderer/shared/mcp-status.js";

/** Inspect only an initialized, still-owned client. Never consult another connection's cache. */
export async function inspectInitializedMcpStatus(
  client: Pick<Client, "getServerCapabilities" | "listTools">,
  isCurrent: () => boolean,
): Promise<McpStatus> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("The MCP connection was superseded.");
  };
  assertCurrent();
  // Capture before discovery: a tools/list error must not erase successful
  // initialization metadata, and the response must not alias SDK-owned state.
  const capabilities = client.getServerCapabilities();
  const serverCapabilities = capabilities === undefined ? null : structuredClone(capabilities);
  try {
    // Resources/prompts-only servers are valid MCP servers. Do not issue a
    // method they never advertised merely to test their connection.
    const tools = capabilities?.tools === undefined ? [] : (await client.listTools()).tools;
    assertCurrent();
    return { connected: true, toolCount: tools.length, tools: tools.map(({ name }) => name), serverCapabilities };
  } catch (error) {
    // Revocation must escape to the attempt owner; stale metadata is not a
    // discovery failure and must not be returned to a replacement document.
    assertCurrent();
    return {
      connected: false,
      toolCount: 0,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
      serverCapabilities,
    };
  }
}
