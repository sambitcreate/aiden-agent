/**
 * Loopback MCP server that offers Aiden's own tools to an ACP agent.
 *
 * Adapted from pi-antigravity-acp-provider src/mcp/bridge.ts @ 07e369b (MIT).
 * A tool call never runs here: it is parked and surfaced to Aiden's Pi agent
 * loop as an ordinary tool call, so approvals, hooks and the transcript treat
 * it exactly like a call the model made directly. The server binds 127.0.0.1
 * and requires an unguessable bearer token that only the agent receives.
 */
import type { McpServer } from "@agentclientprotocol/sdk";
import type { JsonObject, Tool } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Value } from "typebox/value";

import { AcpHarnessError } from "./errors.js";

const BODY_LIMIT = 1024 * 1024;
const SCHEMA_LIMIT = 64 * 1024;
const MAX_TOOLS = 64;
export const BRIDGE_SERVER_NAME = "aiden";
export const BRIDGE_TOOL_PREFIX = "aiden_";

export interface BridgeInvocation {
  id: string;
  name: string;
  arguments: JsonObject;
}

interface BridgeTool {
  mcpName: string;
  hostName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  originalSchema: Tool["parameters"];
}

export interface McpBridgeOptions {
  tools: readonly Tool[];
  onCall(invocation: BridgeInvocation): Promise<CallToolResult>;
}

export function bridgeToolFingerprint(tools: readonly Tool[]): string {
  return JSON.stringify(projectTools(tools, []).map((tool) => [tool.mcpName, tool.inputSchema]));
}

export class AcpMcpBridge {
  omissions: string[] = [];
  private readonly token = `${randomUUID()}${randomUUID()}`.replace(/-/gu, "");
  private tools: BridgeTool[];
  private server: HttpServer | undefined;
  private url: string | undefined;

  constructor(private readonly options: McpBridgeOptions) {
    this.tools = projectTools(options.tools, this.omissions);
  }

  get fingerprint(): string {
    return JSON.stringify(this.tools.map((tool) => [tool.mcpName, tool.inputSchema]));
  }

  /**
   * Replace the offered tools in place. ACP fixes a session's MCP servers at
   * creation, so the server stays up and only its catalog changes; a call to
   * a tool that left the catalog is refused.
   */
  setTools(tools: readonly Tool[]): void {
    const omissions: string[] = [];
    this.tools = projectTools(tools, omissions);
    this.omissions = omissions;
  }

  get empty(): boolean {
    return this.tools.length === 0;
  }

  /** Host tool name for a projected MCP name, used to suppress duplicate activity rows. */
  hostNameFor(mcpName: string): string | undefined {
    return this.tools.find((tool) => tool.mcpName === mcpName)?.hostName;
  }

  /** Start listening. The catalog may be empty and filled on later turns. */
  async start(): Promise<McpServer> {
    if (this.server && this.url) return this.descriptor();
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Bridge error" } }),
        );
      });
    });
    server.maxConnections = 8;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new AcpHarnessError("spawn", "The tool bridge could not start.");
    }
    this.server = server;
    this.url = `http://127.0.0.1:${address.port}/mcp`;
    return this.descriptor();
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.url = undefined;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private descriptor(): McpServer {
    if (!this.url) throw new AcpHarnessError("spawn", "The tool bridge is not listening.");
    return {
      type: "http",
      name: BRIDGE_SERVER_NAME,
      url: this.url,
      headers: [{ name: "Authorization", value: `Bearer ${this.token}` }],
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== "/mcp" || request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    if (!validBearer(request.headers.authorization, this.token)) {
      response.writeHead(401).end();
      return;
    }
    const body = await readJson(request);
    const protocol = new Server({ name: "aiden-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
    protocol.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.tools.map((tool) => ({
        name: tool.mcpName,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: "object"; properties?: Record<string, object> },
      })),
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async (call) => {
      const tool = this.tools.find((candidate) => candidate.mcpName === call.params.name);
      if (!tool) return toolError("That Aiden tool is not available in this turn.");
      const args = (call.params.arguments ?? {}) as JsonObject;
      try {
        if (!Value.Check(tool.originalSchema, args)) {
          return toolError("The arguments do not match the tool's schema.");
        }
      } catch {
        return toolError("The tool's schema could not validate these arguments.");
      }
      return this.options.onCall({ id: `acp-${randomUUID()}`, name: tool.hostName, arguments: args });
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await protocol.connect(transport);
      await transport.handleRequest(request, response, body);
    } finally {
      await transport.close();
      await protocol.close();
    }
  }
}

function projectTools(tools: readonly Tool[], omissions: string[]): BridgeTool[] {
  const output: BridgeTool[] = [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (output.length >= MAX_TOOLS) {
      omissions.push(`Tool limit ${MAX_TOOLS} reached`);
      break;
    }
    const mcpName = `${BRIDGE_TOOL_PREFIX}${tool.name}`.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);
    if (names.has(mcpName)) {
      omissions.push(`${tool.name}: duplicate projected name`);
      continue;
    }
    const inputSchema = sanitizeSchema(tool.parameters);
    if (!inputSchema || inputSchema.type !== "object" || JSON.stringify(inputSchema).length > SCHEMA_LIMIT) {
      omissions.push(`${tool.name}: schema must be a bounded object`);
      continue;
    }
    names.add(mcpName);
    output.push({
      mcpName,
      hostName: tool.name,
      description: tool.description,
      inputSchema,
      originalSchema: tool.parameters,
    });
  }
  return output;
}

const SCALAR_KEYS = [
  "type",
  "title",
  "description",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
] as const;

/** Reduce a TypeBox schema to the JSON-Schema subset Gemini-style function calling accepts. */
export function sanitizeSchema(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 16 || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    const candidate = source[key];
    if (["string", "number", "boolean"].includes(typeof candidate)) output[key] = candidate;
  }
  if (Array.isArray(source.required)) {
    output.required = source.required.filter((item): item is string => typeof item === "string");
  }
  if (Array.isArray(source.enum)) output.enum = source.enum.filter(jsonScalar);
  if (jsonValue(source.default)) output.default = source.default;
  if (typeof source.additionalProperties === "boolean") {
    output.additionalProperties = source.additionalProperties;
  } else if (source.additionalProperties && typeof source.additionalProperties === "object") {
    const additional = sanitizeSchema(source.additionalProperties, depth + 1);
    if (additional) output.additionalProperties = additional;
  }
  if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(source.properties as Record<string, unknown>)) {
      const sanitized = sanitizeSchema(schema, depth + 1);
      if (sanitized) properties[name] = sanitized;
    }
    output.properties = properties;
  }
  if (source.items) {
    const items = sanitizeSchema(source.items, depth + 1);
    if (items) output.items = items;
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = source[key];
    if (!Array.isArray(variants)) continue;
    const sanitized = variants.map((item) => sanitizeSchema(item, depth + 1)).filter((item) => item !== undefined);
    if (sanitized.length) output[key] = sanitized;
  }
  if (output.type === undefined && output.properties !== undefined) output.type = "object";
  if (output.type === undefined && output.items !== undefined) output.type = "array";
  return Object.keys(output).length > 0 ? output : undefined;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > BODY_LIMIT) throw new AcpHarnessError("invalid_input", "The tool request is too large.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validBearer(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function jsonScalar(value: unknown): value is null | string | number | boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function jsonValue(value: unknown): boolean {
  if (jsonScalar(value)) return true;
  if (Array.isArray(value)) return value.every(jsonValue);
  return Boolean(
    value && typeof value === "object" && Object.values(value as Record<string, unknown>).every(jsonValue),
  );
}
