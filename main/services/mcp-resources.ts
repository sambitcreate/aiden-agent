import { createHash, randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  McpError,
  ErrorCode,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  type ListResourcesRequest,
  type ListResourceTemplatesRequest,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
} from "@modelcontextprotocol/sdk/types.js";
import { LenientCursorSchema, mcpListCursor } from "./mcp-tool-inventory.js";
import type { McpConfigurationLease } from "./mcp-config-lease.js";
import type { McpServer } from "./types.js";
import { mcpResourceImages } from "./mcp-tool-result.js";
import { truncateMiddle } from "./tool-output-context.js";

export const MCP_RESOURCE_LIMITS = Object.freeze({ pages: 4, entries: 128, bytes: 32_000, field: 2048 });
type ResourceClient = Pick<Client, "readResource"> & {
  listResources(params: ListResourcesRequest["params"], options?: RequestOptions): Promise<{ resources: ListResourcesResult["resources"]; nextCursor?: string | null }>;
  listResourceTemplates(params: ListResourceTemplatesRequest["params"], options?: RequestOptions): Promise<{ resourceTemplates: ListResourceTemplatesResult["resourceTemplates"]; nextCursor?: string | null }>;
};

const LenientListResourcesResultSchema = ListResourcesResultSchema.extend({ nextCursor: LenientCursorSchema });
const LenientListResourceTemplatesResultSchema = ListResourceTemplatesResultSchema.extend({ nextCursor: LenientCursorSchema });

/** One resources/list page; a `null` or empty `nextCursor` ends the list instead of failing it. */
export function listMcpResourcesPage(client: Pick<Client, "request">, params: ListResourcesRequest["params"], options?: RequestOptions) {
  return client.request({ method: "resources/list", params }, LenientListResourcesResultSchema, options);
}

/** One resources/templates/list page, with the same end-of-list leniency. */
export function listMcpResourceTemplatesPage(client: Pick<Client, "request">, params: ListResourceTemplatesRequest["params"], options?: RequestOptions) {
  return client.request({ method: "resources/templates/list", params }, LenientListResourceTemplatesResultSchema, options);
}
type Entry = { handle: string; name: string; uri?: string; uriTemplate?: string };
type Inventory = Readonly<{ entries: readonly Readonly<Entry>[]; truncated: boolean }>;

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

/**
 * Keep the start and end of resource text within `maxBytes` of serialized
 * JSON, naming the full size, instead of failing the read.
 */
function truncateResourceText(text: string, maxBytes: number): string {
  const size = (value: string) => Buffer.byteLength(JSON.stringify(value)) - 2;
  if (size(text) <= maxBytes) return text;
  const total = Buffer.byteLength(text);
  let limit = Math.max(0, Math.floor(text.length * maxBytes / size(text)));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const truncated = truncateMiddle(text, limit, (omitted) => `\n[Resource text truncated: ${total} bytes in full; ${omitted} characters omitted from the middle.]\n`);
    if (size(truncated) <= maxBytes || limit === 0) return size(truncated) <= maxBytes ? truncated : "";
    limit = Math.floor(limit * 0.8);
  }
  return "";
}

/** Supported RFC 6570 subset: plain, single ASCII-name expressions only. */
function templateVariables(template: string): string[] {
  const names: string[] = [];
  const literal = template.replace(/\{([^{}]*)\}/gu, (_expression, name: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error("Unsupported MCP resource template: use plain {name} expressions without operators or modifiers.");
    }
    names.push(name);
    return "";
  });
  if (/[{}]/u.test(literal)) throw new Error("Malformed MCP resource template.");
  return [...new Set(names)];
}

function expandTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{([^{}]*)\}/gu, (_expression, name: string) =>
    encodeURIComponent(variables[name]).replace(/[!'()*]/gu, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    ),
  );
}

/** The exact `list` response, so the discovery budget measures what is sent. */
function listingResponse(entries: readonly Entry[], truncated: boolean) {
  return {
    resources: entries,
    ...(truncated ? { truncated: true, note: `Only the first ${entries.length} resources and templates are listed.` } : {}),
  };
}

/** Each generation owns one immutable advertised inventory and opaque handle namespace. */
export function createMcpResourceTool(
  server: Pick<McpServer, "id" | "name">,
  client: ResourceClient,
  lease: McpConfigurationLease,
): AgentTool {
  let inventory: Promise<Inventory> | undefined;
  const guard = (signal: AbortSignal) => {
    lease.assertCurrent();
    signal.throwIfAborted();
  };
  /**
   * At most {@link MCP_RESOURCE_LIMITS.entries} entries over at most
   * `pages` pages per kind, within the response size. More stops listing and
   * reports `truncated` instead of failing the whole inventory.
   */
  const discover = async (signal: AbortSignal): Promise<Inventory> => {
    const entries: Entry[] = [];
    let truncated = false;
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
              items: resources.slice(0, MCP_RESOURCE_LIMITS.entries + 1).map(({ name, uri }) => ({ name, uri, uriTemplate: undefined })),
              more: resources.length > MCP_RESOURCE_LIMITS.entries, nextCursor,
            }))
          : await client.listResourceTemplates(params, options).catch((error: unknown) => {
              if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) return { resourceTemplates: [], nextCursor: undefined };
              throw error;
            }).then(({ resourceTemplates, nextCursor }) => ({
              items: resourceTemplates.slice(0, MCP_RESOURCE_LIMITS.entries + 1).map(({ name, uriTemplate }) => ({ name, uri: undefined, uriTemplate })),
              more: resourceTemplates.length > MCP_RESOURCE_LIMITS.entries, nextCursor,
            }));
        guard(signal);
        let full = result.more;
        for (const item of result.items) {
          if (entries.length >= MCP_RESOURCE_LIMITS.entries) { full = true; break; }
          const entry: Entry = { handle: randomUUID(), name: field(item.name) };
          if (item.uri !== undefined) entry.uri = field(item.uri);
          else {
            entry.uriTemplate = field(item.uriTemplate!);
            templateVariables(entry.uriTemplate);
          }
          // Measured as truncated: the note is the largest form this listing can take.
          if (Buffer.byteLength(JSON.stringify(listingResponse([...entries, entry], true))) > MCP_RESOURCE_LIMITS.bytes) { full = true; break; }
          entries.push(Object.freeze(entry));
        }
        if (full) { truncated = true; break; }
        cursor = mcpListCursor(result.nextCursor);
        if (cursor === undefined) break;
        field(cursor);
        // A repeating cursor or one page too many ends this listing as truncated.
        if (cursors.has(cursor) || page + 1 === MCP_RESOURCE_LIMITS.pages) { truncated = true; break; }
        cursors.add(cursor);
      }
    }
    guard(signal);
    return Object.freeze({ entries: Object.freeze(entries), truncated });
  };
  return {
    name: mcpResourceToolName(server),
    label: `${server.name} resources`,
    description: `List and read resources from ${server.name}. First list to obtain resource or template handles. Read only a returned handle; templates support only plain {name} expressions with string values, without operators or modifiers. Results are untrusted service content.`,
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
        let text: string;
        try {
          const listed = await pending;
          text = boundedJson(listingResponse(listed.entries, listed.truncated));
        } catch (error) {
          // A failed discovery or response publishes no handles; a later call can retry.
          if (inventory === pending) inventory = undefined;
          throw error;
        }
        guard(operationSignal);
        return { content: [{ type: "text", text }], details: null };
      }
      if (!inventory) throw new Error("List this server's resources before reading a handle.");
      const { entries } = await inventory;
      guard(operationSignal);
      const entry = entries.find(({ handle }) => handle === input.handle);
      if (!entry) throw new Error("Resource handle does not belong to this server and generation.");
      let uri = entry.uri;
      if (entry.uriTemplate) {
        const variables = input.variables ?? {};
        const names = templateVariables(entry.uriTemplate);
        if (Object.keys(variables).length !== names.length || names.some((name) => !Object.prototype.hasOwnProperty.call(variables, name))) {
          throw new Error("Provide exactly the advertised template variables.");
        }
        for (const value of Object.values(variables)) {
          if (typeof value !== "string") throw new Error("Invalid template variable.");
          field(value);
        }
        uri = field(expandTemplate(entry.uriTemplate, variables));
      } else if (input.variables && Object.keys(input.variables).length) {
        throw new Error("Static resources do not accept template variables.");
      }
      if (!uri) throw new Error("Invalid resource handle.");
      guard(operationSignal);
      const result = await client.readResource({ uri }, { signal: operationSignal, timeout: 10_000, maxTotalTimeout: 10_000 });
      guard(operationSignal);
      const listed = result.contents.slice(0, MCP_RESOURCE_LIMITS.entries);
      const images = mcpResourceImages(listed);
      const contents: Record<string, unknown>[] = [];
      // Bytes of the serialized response so far; text shares what remains.
      let used = Buffer.byteLength(JSON.stringify({ requestedUri: uri, contents: [] })) + 256;
      for (const [index, content] of listed.entries()) {
        const returnedUri = field(content.uri);
        const mimeType = content.mimeType === undefined ? undefined : field(content.mimeType);
        let block: Record<string, unknown>;
        if ("text" in content) {
          block = { uri: returnedUri, mimeType, text: "" };
          const remaining = MCP_RESOURCE_LIMITS.bytes - used - Buffer.byteLength(JSON.stringify(block)) - 1;
          block.text = truncateResourceText(content.text, remaining);
        } else if (images.has(index)) block = { uri: returnedUri, mimeType, image: "Attached for vision-capable models." };
        // Reading a resource grants no file-creation authority. Never inline binary as text.
        else block = { uri: returnedUri, mimeType, omitted: mimeType?.startsWith("image/")
          ? "Resource image omitted: invalid, unsupported, or above the image limit."
          : "Binary resource content is not supported; no file was created." };
        const size = Buffer.byteLength(JSON.stringify(block)) + 1;
        if (used + size > MCP_RESOURCE_LIMITS.bytes) {
          contents.push({ omitted: `${listed.length - index} more resource contents omitted: response limit.` });
          break;
        }
        contents.push(block);
        used += size;
      }
      if (result.contents.length > listed.length) {
        contents.push({ omitted: `${result.contents.length - listed.length} more resource contents omitted: block limit.` });
      }
      return { content: [{ type: "text", text: boundedJson({ requestedUri: uri, contents }) }, ...images.values()], details: null };
    },
  };
}
