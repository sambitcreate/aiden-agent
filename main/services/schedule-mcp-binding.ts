import { createHash } from "node:crypto";
import { mcpRuntimeConnectionSnapshot } from "./mcp-credential-cleanup-core.js";
import type { McpServer, ScheduledMcpServerBinding } from "./types.js";

const MCP_BINDING_DIGEST = /^[a-f0-9]{64}$/u;

export function scheduledMcpServerBinding(server: McpServer): ScheduledMcpServerBinding {
  return {
    id: server.id,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(mcpRuntimeConnectionSnapshot(server)))
      .digest("hex"),
  };
}

export function validateScheduledMcpServerBindings(
  value: unknown,
): ScheduledMcpServerBinding[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("Invalid scheduled task MCP bindings.");
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Invalid scheduled task MCP binding.");
    }
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "id" && key !== "fingerprint") ||
      typeof record.id !== "string" ||
      !record.id.trim() ||
      typeof record.fingerprint !== "string" ||
      !MCP_BINDING_DIGEST.test(record.fingerprint) ||
      seen.has(record.id)
    ) {
      throw new Error("Invalid scheduled task MCP binding.");
    }
    seen.add(record.id);
    return { id: record.id, fingerprint: record.fingerprint };
  });
}

export function assertScheduledMcpServerBindings(
  servers: readonly McpServer[],
  bindings: readonly ScheduledMcpServerBinding[],
): void {
  if (
    servers.length !== bindings.length ||
    servers.some((server, index) => {
      const expected = bindings[index];
      const actual = scheduledMcpServerBinding(server);
      return expected?.id !== actual.id || expected.fingerprint !== actual.fingerprint;
    })
  ) {
    throw new Error(
      "An approved MCP server changed after this automation was confirmed. Review and approve its connector scope again.",
    );
  }
}
