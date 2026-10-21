import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { CallToolResult, ServerCapabilities, Tool } from "@earendil-works/pi-mcp";
import { mcpRequest, type McpCallOptions, type McpRequester } from "./mcp-client.js";

export const MCP_TOOL_INVENTORY_MAX_PAGES = 64;
export const MCP_TOOL_INVENTORY_MAX_TOOLS = 512;

export type McpToolCallParams = { name: string; arguments?: Record<string, unknown> };

/** Servers end a list with an absent, `null` or empty `nextCursor`. */
export function mcpListCursor(value: unknown): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : value as string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A tools/call result as received. `content` defaults to empty (servers that
 * only return `structuredContent` omit it) and `structuredContent` may be any
 * JSON value (MCP 2026-07-28), so a tool that already ran is not reported as
 * failed for returning a non-object value.
 */
export function parseMcpCallToolResult(value: unknown): CallToolResult {
  if (!isRecord(value) || (value.content !== undefined && !Array.isArray(value.content)) ||
      (value.isError !== undefined && typeof value.isError !== "boolean")) {
    throw new Error("Invalid MCP tools/call result.");
  }
  return (value.content === undefined ? { ...value, content: [] } : value) as unknown as CallToolResult;
}

/** Call only behind the complete-inventory guard below. */
export async function callMcpTool(client: McpRequester, params: McpToolCallParams, options?: McpCallOptions): Promise<CallToolResult> {
  return parseMcpCallToolResult(await mcpRequest<unknown>(client, "tools/call", {
    name: params.name,
    ...(params.arguments === undefined ? {} : { arguments: params.arguments }),
  }, options));
}

export interface McpToolPage {
  tools: Tool[];
  nextCursor?: string;
}

/** Why a listed tool's input schema cannot be offered, or undefined when its root is usable. */
export function mcpToolInputSchemaProblem(schema: unknown): string | undefined {
  if (!isRecord(schema)) return "its input schema is not an object";
  if (schema.type !== "object") return "its input schema root is not type \"object\"";
  if (schema.properties !== undefined && !isRecord(schema.properties)) return "its input schema properties are not an object";
  if (schema.required !== undefined &&
      (!Array.isArray(schema.required) || !schema.required.every((entry) => typeof entry === "string"))) {
    return "its input schema required list is not a list of names";
  }
  return undefined;
}

/** Reports a listed tool that was left out of the inventory. */
export type McpSkippedToolReporter = (toolName: string, reason: string) => void;

/**
 * One raw tools/list page; a `null` or empty `nextCursor` ends the list. A
 * tool whose input schema root is unusable is left out (and reported), so one
 * bad tool cannot make every model request that carries the server's tools fail.
 */
export async function listMcpToolPage(
  client: McpRequester,
  cursor: string | undefined,
  options?: McpCallOptions,
  onSkip?: McpSkippedToolReporter,
): Promise<McpToolPage> {
  const value = await mcpRequest<unknown>(client, "tools/list", cursor === undefined ? undefined : { cursor }, options);
  if (!isRecord(value) || !Array.isArray(value.tools)) throw new Error("Invalid MCP tools/list result.");
  const tools: Tool[] = [];
  for (const tool of value.tools) {
    if (!isRecord(tool) || typeof tool.name !== "string") throw new Error("Invalid entry in MCP tools/list result.");
    const problem = mcpToolInputSchemaProblem(tool.inputSchema);
    if (problem) onSkip?.(tool.name, problem);
    else tools.push(tool as unknown as Tool);
  }
  const nextCursor = mcpListCursor(value.nextCursor);
  if (nextCursor !== undefined && typeof nextCursor !== "string") throw new Error("Invalid MCP tools/list cursor.");
  return { tools, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

/**
 * Page reader for discovery: every page carries its own deadline, so one
 * stalled page cannot hold a whole server's discovery budget.
 */
export function boundedMcpToolPageReader(client: McpRequester, pageTimeoutMs: number, onSkip?: McpSkippedToolReporter) {
  return (cursor: string | undefined, signal: AbortSignal) =>
    listMcpToolPage(client, cursor, { signal, timeoutMs: pageTimeoutMs }, onSkip);
}

/** One tools/list page at a time; publish only a complete, bounded inventory. */
export async function listMcpToolInventory<T extends { name: string }>(options: {
  listPage(cursor: string | undefined, signal: AbortSignal): Promise<{ tools: readonly T[]; nextCursor?: string | null }>;
  signal?: AbortSignal;
  assertCurrent(): void;
}): Promise<T[]> {
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(30_000),
  ]);
  const assertCurrent = () => { signal.throwIfAborted(); options.assertCurrent(); };
  const tools: T[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MCP_TOOL_INVENTORY_MAX_PAGES; page++) {
    assertCurrent();
    const result = await options.listPage(cursor, signal);
    assertCurrent();
    if (!Array.isArray(result.tools) || tools.length + result.tools.length > MCP_TOOL_INVENTORY_MAX_TOOLS) {
      throw new Error("MCP tool inventory exceeds the tool limit or is invalid.");
    }
    for (const tool of result.tools) {
      if (!tool || typeof tool.name !== "string" || !tool.name || names.has(tool.name)) {
        throw new Error("MCP tool inventory contains an invalid or duplicate tool name.");
      }
      names.add(tool.name);
      tools.push(tool);
    }
    const next = mcpListCursor(result.nextCursor);
    if (next === undefined) return tools;
    if (typeof next !== "string" || next.length > 4096 || cursors.has(next)) {
      throw new Error("MCP tool inventory contains an invalid or repeated pagination cursor.");
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error("MCP tool inventory exceeds the page limit.");
}

function declaresSchemaId(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(declaresSchemaId);
  if (!value || typeof value !== "object") return false;
  return Object.prototype.hasOwnProperty.call(value, "$id") || Object.values(value).some(declaresSchemaId);
}

type JsonSchemaValidator = (value: unknown) => boolean;

/** The validator configuration MCP clients use for tool output schemas. */
function createOutputSchemaAjv(): Ajv {
  const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true });
  addFormats(ajv);
  return ajv;
}

/**
 * Retain the complete call contracts of one inventory.
 *
 * Output schemas compile on first use, before dispatch, and anonymous schemas
 * share one Ajv. A schema that declares `$id` gets its own Ajv: Ajv registers
 * ids per instance, so unrelated tools reusing an id would otherwise collide.
 */
export function createMcpToolCallGuard(tools: readonly { name: string; outputSchema?: unknown; execution?: unknown }[]) {
  const names = new Set(tools.map(({ name }) => name));
  const schemas = new Map<string, object>();
  const validators = new Map<string, JsonSchemaValidator>();
  const requiredTasks = new Set<string>();
  let shared: Ajv | undefined;
  for (const tool of tools) {
    if (tool.execution && typeof tool.execution === "object" &&
        (tool.execution as { taskSupport?: unknown }).taskSupport === "required") requiredTasks.add(tool.name);
    if (tool.outputSchema !== undefined) {
      if (!tool.outputSchema || typeof tool.outputSchema !== "object" || Array.isArray(tool.outputSchema)) throw new Error("Invalid MCP tool output schema.");
      schemas.set(tool.name, tool.outputSchema);
    }
  }
  const validatorFor = (name: string): JsonSchemaValidator | undefined => {
    const compiled = validators.get(name);
    if (compiled) return compiled;
    const schema = schemas.get(name);
    if (!schema) return undefined;
    const ajv = declaresSchemaId(schema) ? createOutputSchemaAjv() : (shared ??= createOutputSchemaAjv());
    let validator: JsonSchemaValidator;
    try {
      const compiledSchema: ValidateFunction = ajv.compile(schema);
      validator = (value) => compiledSchema(value) === true;
    } catch { throw new Error("This MCP tool's output schema could not be compiled."); }
    validators.set(name, validator);
    return validator;
  };
  return {
    /** Whether this inventory offers `name` at all. */
    has(name: string): boolean {
      return names.has(name);
    },
    assertCallable(name: string): void {
      if (requiredTasks.has(name)) throw new Error("This MCP tool requires unsupported task-based execution.");
      // Compile before dispatch so an unusable schema cannot follow a side effect.
      validatorFor(name);
    },
    validateResult(name: string, result: unknown): void {
      const validate = validatorFor(name);
      if (!validate) return;
      const record = result && typeof result === "object" ? result as { structuredContent?: unknown; isError?: unknown } : {};
      // Tool failures may carry diagnostic JSON instead of the successful output shape.
      // Preserve that failure for the normal tool-result error path.
      if (record.isError === true) return;
      if (record.structuredContent === undefined) throw new Error("MCP tool has an output schema but did not return structured content.");
      if (!validate(record.structuredContent)) throw new Error("MCP structured content does not match the tool's output schema.");
    },
  };
}

export type McpToolCallGuard = ReturnType<typeof createMcpToolCallGuard>;

/** Guarded dispatch: the call must belong to the inventory of the client carrying it. */
export async function guardedMcpToolCall(
  guard: McpToolCallGuard,
  client: McpRequester,
  params: McpToolCallParams,
  options?: McpCallOptions,
) {
  if (!guard.has(params.name)) throw new Error("This MCP tool is no longer offered by its server.");
  guard.assertCallable(params.name);
  const result = await callMcpTool(client, params, options);
  guard.validateResult(params.name, result);
  return result;
}

/**
 * Call a tool on whichever client is live now. Tools are built from the
 * inventory of the client they were discovered on; after an idle reconnect
 * the server may offer different tools or schemas, so the call is checked
 * against the live client's own inventory instead.
 */
export async function callMcpToolOnLiveClient<C extends McpRequester>(
  discovered: { client: C; guard: McpToolCallGuard },
  live: C,
  inventoryOf: (client: C) => Promise<{ guard: McpToolCallGuard }>,
  params: McpToolCallParams,
  options?: McpCallOptions,
) {
  const guard = live === discovered.client ? discovered.guard : (await inventoryOf(live)).guard;
  return guardedMcpToolCall(guard, live, params, options);
}

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export const MCP_TOOL_LIST_CHANGED = "notifications/tools/list_changed";

/** A client whose server notifications can be observed (Pi's `McpClient`). */
export interface McpNotificationSource {
  onNotification(method: string, listener: (params: unknown) => void): unknown;
}

/** A client exposing the capabilities its server declared at initialization. */
export interface McpCapabilitySource {
  readonly serverCapabilities?: Pick<ServerCapabilities, "tools">;
}

/** Re-list servers that cannot announce changes at most this often. */
export const MCP_TOOL_INVENTORY_TTL_MS = 30_000;

/**
 * Reuse one tool inventory per live client. A server that promised
 * notifications/tools/list_changed (watched before connect) keeps its entry
 * until it announces a change. With `ttlMs`, a server that cannot announce
 * changes keeps its entry for that long after the read completed; without it
 * such servers are re-listed on every load. Failed reads are never retained,
 * and `forget` drops a closed client's entry. Callers still check their own
 * lease and generation after every load.
 */
export function createMcpToolInventoryCache<T>(options: { ttlMs?: number; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const watched = new WeakSet<object>();
  const entries = new WeakMap<object, { pending: Promise<T>; expiresAt: number }>();
  return {
    /** Register before connect so a change during initialization is not missed. */
    watch(client: McpNotificationSource): void {
      watched.add(client);
      client.onNotification(MCP_TOOL_LIST_CHANGED, () => { entries.delete(client); });
    },
    load(client: McpCapabilitySource, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (!watched.has(client)) return untilAborted(read(), signal);
      const announcesChanges = client.serverCapabilities?.tools?.listChanged === true;
      if (!announcesChanges && options.ttlMs === undefined) return untilAborted(read(), signal);
      let entry = entries.get(client);
      if (entry && entry.expiresAt <= now()) {
        entries.delete(client);
        entry = undefined;
      }
      if (!entry) {
        const loading = read();
        const created = { pending: loading, expiresAt: Number.POSITIVE_INFINITY };
        entry = created;
        entries.set(client, created);
        loading.then(
          () => { if (!announcesChanges) created.expiresAt = now() + options.ttlMs!; },
          () => { if (entries.get(client) === created) entries.delete(client); },
        );
      }
      return untilAborted(entry.pending, signal);
    },
    /** Drop a client's entry (it closed or is being replaced). */
    forget(client: object): void {
      entries.delete(client);
    },
  };
}
