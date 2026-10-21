// MCP test support: serve an official-SDK `Server` fixture to Pi's MCP client over
// an in-memory pair. Production MCP client code never imports this module.
import type { JsonRpcMessage } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Connect `server` and return the client end of the pair, ready for `McpClient.connect`. */
export async function connectSdkServer(server: Server): Promise<InMemoryTransport> {
  const { client, server: serverSide } = createInMemoryTransportPair();
  const bridge: Transport = {
    start: () => serverSide.start(),
    send: (message) => serverSide.send(message as JsonRpcMessage),
    close: () => serverSide.close(),
  };
  serverSide.onMessage((message) => bridge.onmessage?.(message as JSONRPCMessage));
  serverSide.onError((error) => bridge.onerror?.(error));
  serverSide.onClose(() => bridge.onclose?.());
  await server.connect(bridge);
  return client;
}
