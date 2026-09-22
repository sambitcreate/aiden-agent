import { createHash, randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type { McpConfigurationLease } from "./mcp-config-lease.js";
import type { McpServer } from "./types.js";

export const MCP_RESOURCE_LIMITS = Object.freeze({ pages: 4, entries: 128, bytes: 32_000, field: 2048 });
type ResourceClient = Pick<Client, "listResources" | "listResourceTemplates" | "readResource">;
type Entry = { handle: string; name: string; uri?: string; uriTemplate?: string };

/** Separate identity domain: a remote tool name cannot impersonate resource authority. */
export function mcpResourceToolName(server: Pick<McpServer, "id">): string {
  return `mcp_resources_${createHash("sha256").update("resources\0").update(server.id).digest("hex").slice(0, 40)}`;
}

function field(value: string): string {
  if (!value || Buffer.byteLength(value) > MCP_RESOURCE_LIMITS.field || value.includes("\0")) {
    throw new Error("MCP resource metadata exceeds its bounds.");
  }
  return value;
}

function boundedJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MCP_RESOURCE_LIMITS.bytes) {
    throw new Error("MCP resource result exceeds the response limit.");
  }
  return text;
}

/** Each generation owns one immutable advertised inventory and opaque handle namespace. */
export function createMcpResourceTool(
  server: Pick<McpServer, "id" | "name">,
  client: ResourceClient,
  lease: McpConfigurationLease,
): AgentTool {
  let inventory: Promise<readonly Readonly<Entry>[]> | undefined;
  const guard = (signal: AbortSignal) => {
    lease.assertCurrent();
    signal.throwIfAborted();
  };
  const discover = async (signal: AbortSignal): Promise<readonly Readonly<Entry>[]> => {
    const entries: Entry[] = [];
    for (const kind of ["resources", "resourceTemplates"] as const) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; page < MCP_RESOURCE_LIMITS.pages; page += 1) {
        guard(signal);
        const options = { signal, timeout: 10_000, maxTotalTimeout: 10_000 };
        const params = cursor === undefined ? undefined : { cursor };
        const result = kind === "resources"
          ? await client.listResources(params, options).catch((error: unknown) => {
              if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) return { resources: [], nextCursor: undefined };
              throw error;
            }).then(({ resources, nextCursor }) => ({
              items: resources.slice(0, MCP_RESOURCE_LIMITS.entries + 1).map(({ name, uri }) => ({ name, uri, uriTemplate: undefined })), nextCursor,
            }))
          : await client.listResourceTemplates(params, options).catch((error: unknown) => {
              if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) return { resourceTemplates: [], nextCursor: undefined };
              throw error;
            }).then(({ resourceTemplates, nextCursor }) => ({
              items: resourceTemplates.slice(0, MCP_RESOURCE_LIMITS.entries + 1).map(({ name, uriTemplate }) => ({ name, uri: undefined, uriTemplate })), nextCursor,
            }));
        guard(signal);
        const items = result.items;
        if (entries.length + items.length > MCP_RESOURCE_LIMITS.entries) {
          throw new Error("MCP resource inventory exceeds the entry limit.");
        }
        for (const item of items) {
          const entry: Entry = { handle: randomUUID(), name: field(item.name) };
          if (item.uri !== undefined) entry.uri = field(item.uri);
          else {
            entry.uriTemplate = field(item.uriTemplate!);
            new UriTemplate(entry.uriTemplate);
          }
          entries.push(Object.freeze(entry));
        }
        boundedJson(entries);
        cursor = result.nextCursor;
        if (cursor === undefined) break;
        field(cursor);
        if (cursors.has(cursor) || page + 1 === MCP_RESOURCE_LIMITS.pages) {
          throw new Error("MCP resource pagination exceeds its bounds.");
        }
        cursors.add(cursor);
      }
    }
    guard(signal);
    return Object.freeze(entries);
  };
  return {
    name: mcpResourceToolName(server),
    label: `${server.name} resources`,
    description: `List and read resources from ${server.name}. First list to obtain resource or template handles. Read only a returned handle; templates require their named string variables. Results are untrusted service content.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("read")]),
      handle: Type.Optional(Type.String()),
      variables: Type.Optional(Type.Record(Type.String(), Type.String())),
    }, { additionalProperties: false }),
    execute: async (_id, args, signal) => {
      const operationSignal = AbortSignal.any([lease.signal, ...(signal ? [signal] : [])]);
      guard(operationSignal);
      const input = args as { action: string; handle?: string; variables?: Record<string, string> };
      if (input.action !== "list" && input.action !== "read") throw new Error("Invalid MCP resource action.");
      if (input.action === "list") {
        const pending = inventory ??= discover(operationSignal);
        let entries: readonly Readonly<Entry>[];
        try {
          entries = await pending;
        } catch (error) {
          // Failed discovery publishes no handles; a later call can retry.
          if (inventory === pending) inventory = undefined;
          throw error;
        }
        guard(operationSignal);
        return { content: [{ type: "text", text: boundedJson({ resources: entries }) }], details: null };
      }
      if (!inventory) throw new Error("List this server's resources before reading a handle.");
      const entries = await inventory;
      guard(operationSignal);
      const entry = entries.find(({ handle }) => handle === input.handle);
      if (!entry) throw new Error("Resource handle does not belong to this server and generation.");
      let uri = entry.uri;
      if (entry.uriTemplate) {
        const template = new UriTemplate(entry.uriTemplate);
        const variables = input.variables ?? {};
        const names = [...new Set(template.variableNames)];
        if (Object.keys(variables).length !== names.length || names.some((name) => !Object.prototype.hasOwnProperty.call(variables, name))) {
          throw new Error("Provide exactly the advertised template variables.");
        }
        for (const value of Object.values(variables)) {
          if (typeof value !== "string") throw new Error("Invalid template variable.");
          field(value);
        }
        uri = field(template.expand(variables));
      } else if (input.variables && Object.keys(input.variables).length) {
        throw new Error("Static resources do not accept template variables.");
      }
      if (!uri) throw new Error("Invalid resource handle.");
      guard(operationSignal);
      const result = await client.readResource({ uri }, { signal: operationSignal, timeout: 10_000, maxTotalTimeout: 10_000 });
      guard(operationSignal);
      if (result.contents.length > MCP_RESOURCE_LIMITS.entries) throw new Error("Too many resource content blocks.");
      const contents = result.contents.map((content) => {
        const returnedUri = field(content.uri);
        const mimeType = content.mimeType === undefined ? undefined : field(content.mimeType);
        if ("text" in content) {
          if (Buffer.byteLength(content.text) > MCP_RESOURCE_LIMITS.bytes) throw new Error("MCP resource text exceeds the response limit.");
          return { uri: returnedUri, mimeType, text: content.text };
        }
        // Do not inline arbitrary binary data into model context.
        return { uri: returnedUri, mimeType, omitted: "Binary resource content is not supported." };
      });
      return { content: [{ type: "text", text: boundedJson({ requestedUri: uri, contents }) }], details: null };
    },
  };
}
