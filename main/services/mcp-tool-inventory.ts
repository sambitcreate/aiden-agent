import { isDeepStrictEqual } from "node:util";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { CallToolResult, ServerCapabilities, Tool } from "@earendil-works/pi-mcp";
import { mcpRequest, type McpCallOptions, type McpRequester } from "./mcp-client.js";
import { copyBoundedJson, utf8Size } from "./bounded-json.js";
import { assertBotConnectorMetadataRenewalCurrent, botConnectorForegroundLifetime } from "./bot-connector-inventory-scope.js";

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
  /** Byte size of the unprojected wire result when a foreground budget was requested. */
  replyBytes?: number;
}
export interface McpToolInventoryLimits { maxPages: number; maxTools: number; maxPageBytes: number; maxTotalBytes: number }
export const COMPOSIO_WATCH_INVENTORY_LIMITS: Readonly<McpToolInventoryLimits> = Object.freeze({ maxPages: 4, maxTools: 128, maxPageBytes: 256 * 1024, maxTotalBytes: 1024 * 1024 });

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
  maxReplyBytes?: number,
): Promise<McpToolPage> {
  let value = await mcpRequest<unknown>(client, "tools/list", cursor === undefined ? undefined : { cursor }, options);
  let replyBytes: number | undefined;
  if (maxReplyBytes !== undefined) {
    value = copyBoundedJson(value, { maxNodes: 20_000, maxDepth: 24, maxSize: maxReplyBytes, measure: utf8Size });
    if (value === undefined) throw new Error("MCP tool inventory exceeds the reply byte limit.");
    replyBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  }
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
  return { tools, ...(nextCursor === undefined ? {} : { nextCursor }), ...(replyBytes === undefined ? {} : { replyBytes }) };
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
  listPage(cursor: string | undefined, signal: AbortSignal): Promise<{ tools: readonly T[]; nextCursor?: string | null; replyBytes?: number }>;
  signal?: AbortSignal;
  assertCurrent(): void;
  limits?: McpToolInventoryLimits;
}): Promise<T[]> {
  const limits = options.limits;
  if (limits && (!Number.isSafeInteger(limits.maxPages) || limits.maxPages < 1 || limits.maxPages > MCP_TOOL_INVENTORY_MAX_PAGES
    || !Number.isSafeInteger(limits.maxTools) || limits.maxTools < 1 || limits.maxTools > MCP_TOOL_INVENTORY_MAX_TOOLS
    || !Number.isSafeInteger(limits.maxPageBytes) || limits.maxPageBytes < 1 || !Number.isSafeInteger(limits.maxTotalBytes) || limits.maxTotalBytes < limits.maxPageBytes)) throw new Error("Invalid MCP tool inventory bounds.");
  const foreground = botConnectorForegroundLifetime();
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    ...(foreground ? [foreground.signal] : []),
    AbortSignal.timeout(30_000),
  ]);
  const assertCurrent = () => { signal.throwIfAborted(); options.assertCurrent(); };
  const tools: T[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let totalBytes = 0;
  for (let page = 0; page < (limits?.maxPages ?? MCP_TOOL_INVENTORY_MAX_PAGES); page++) {
    await assertBotConnectorMetadataRenewalCurrent();
    await foreground?.assertCurrent();
    assertCurrent();
    const result = await options.listPage(cursor, signal);
    await assertBotConnectorMetadataRenewalCurrent();
    await foreground?.assertCurrent();
    assertCurrent();
    if (limits) {
      const copy = copyBoundedJson(result, { maxNodes: 20_000, maxDepth: 24, maxSize: limits.maxPageBytes + 128, measure: utf8Size });
      const bytes = result.replyBytes ?? (copy === undefined ? Infinity : Buffer.byteLength(JSON.stringify(copy), "utf8"));
      if (copy === undefined || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.maxPageBytes || (totalBytes += bytes) > limits.maxTotalBytes) throw new Error("MCP tool inventory exceeds the reply byte limit.");
    }
    if (!Array.isArray(result.tools) || tools.length + result.tools.length > (limits?.maxTools ?? MCP_TOOL_INVENTORY_MAX_TOOLS)) {
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

/** One compiled output schema, plus where its last failed check stopped. */
type JsonSchemaValidator = { check(value: unknown): boolean; firstSchemaPath(): string | undefined };

/**
 * How a tools/call result that breaks its tool's output schema is treated.
 * The tool has already run either way. `strict` rejects the result, for
 * callers that parse it (the Composio facade, connector watches, internal
 * readers). `advisory` returns it unchanged with a short diagnostic, for
 * agent-facing calls, so the model sees the data instead of an error that
 * invites it to repeat an action that already happened.
 */
export type McpOutputSchemaMode = "strict" | "advisory";

/** Guarded-call options: transport options plus the output-schema policy. */
export interface McpGuardedCallOptions extends McpCallOptions {
  /** Defaults to `strict`. Agent-facing calls pass `advisory`. */
  outputSchema?: McpOutputSchemaMode;
  /** Receives the advisory diagnostic for a non-conforming result. */
  onOutputSchemaDiagnostic?: (diagnostic: string) => void;
}

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
export function createMcpToolCallGuard(
  tools: readonly { name: string; title?: string; description?: string; inputSchema?: unknown; annotations?: unknown; outputSchema?: unknown; execution?: unknown }[],
  assertCurrent?: () => void,
) {
  // Compare the operation the model saw, including the output contract used in exact Bot grants.
  const operations = new Map(tools.map(({ name, title, description, inputSchema, outputSchema, annotations, execution }) =>
    [name, { title, description, inputSchema, outputSchema, annotations, execution }] as const));
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
      validator = {
        check: (value) => compiledSchema(value) === true,
        // A location in the listed schema, bounded. Never the instance path, which can carry data keys.
        firstSchemaPath: () => compiledSchema.errors?.[0]?.schemaPath?.slice(0, 160),
      };
    } catch { throw new Error("This MCP tool's output schema could not be compiled."); }
    validators.set(name, validator);
    return validator;
  };
  return {
    /** Inventory revision only; no tool validator compilation or RPC. */
    assertCurrent:()=>assertCurrent?.(),
    /** Whether this inventory offers `name` at all. */
    has(name: string): boolean {
      return operations.has(name);
    },
    operation: (name: string) => operations.get(name),
    assertCallable(name: string): void {
      assertCurrent?.();
      if (!operations.has(name)) throw new Error("This MCP tool is no longer offered by its server.");
      if (requiredTasks.has(name)) throw new Error("This MCP tool requires unsupported task-based execution.");
      // Compile before dispatch so an unusable schema cannot follow a side effect.
      validatorFor(name);
    },
    /**
     * Check a returned result against the tool's output schema. `strict` (the
     * default) throws; `advisory` returns a short diagnostic naming only the
     * tool and the schema rule, never the returned data.
     */
    validateResult(name: string, result: unknown, mode: McpOutputSchemaMode = "strict"): string | undefined {
      const validate = validatorFor(name);
      if (!validate) return undefined;
      const record = result && typeof result === "object" ? result as { structuredContent?: unknown; isError?: unknown } : {};
      // Tool failures may carry diagnostic JSON instead of the successful output shape.
      // Preserve that failure for the normal tool-result error path.
      if (record.isError === true) return undefined;
      let problem: string | undefined;
      if (record.structuredContent === undefined) problem = "MCP tool has an output schema but did not return structured content.";
      else if (!validate.check(record.structuredContent)) problem = "MCP structured content does not match the tool's output schema.";
      if (problem === undefined) return undefined;
      if (mode === "strict") throw new Error(problem);
      const where = record.structuredContent === undefined ? undefined : validate.firstSchemaPath();
      // The tool name and schema path come from the server; keep the diagnostic one inert line in every sink.
      return `MCP tool "${diagnosticFragment(name, 128)}": ${problem}${where ? ` First failing rule: ${diagnosticFragment(where, 160)}.` : ""} The result was used as received.`;
    },
  };
}

/** Server-provided text bounded and stripped of line breaks, terminal controls and bidi overrides. */
function diagnosticFragment(value: string, limit: number): string {
  return value.replace(/[\p{Cc}\p{Zl}\p{Zp}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "?").slice(0, limit);
}

export type McpToolCallGuard = ReturnType<typeof createMcpToolCallGuard>;

type ListedTool = Parameters<typeof createMcpToolCallGuard>[0][number];
type ToolListing = { tools?: ReadonlyMap<string, ListedTool> };
const latestToolListings = new WeakMap<object, ToolListing>();

/** Bind each execution guard to the last complete listing observed on this client. */
export async function readGuardedMcpInventory<T extends ListedTool>(
  client: object, read: () => Promise<T[]>, assertCurrent: () => void,
) {
  const startedWith = latestToolListings.get(client);
  const tools = await read();
  assertCurrent();
  const latest = latestToolListings.get(client);
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  let listing = latest;
  if (!latest?.tools || !isDeepStrictEqual(latest.tools, byName)) {
    if (latest !== startedWith) {
      // Conflicting overlapping listings cannot establish their order on the server.
      latestToolListings.set(client, {});
      throw new Error("MCP tool inventory changed during discovery.");
    }
    listing = { tools: byName };
    latestToolListings.set(client, listing);
  }
  const guard = createMcpToolCallGuard(tools, () => {
    assertCurrent();
    if (latestToolListings.get(client) !== listing) throw new Error("MCP tool inventory changed.");
  });
  return { tools, guard };
}

/** Guarded dispatch: the call must belong to the inventory of the client carrying it. */
export async function guardedMcpToolCall(
  guard: McpToolCallGuard,
  client: McpRequester,
  params: McpToolCallParams,
  options?: McpGuardedCallOptions,
) {
  const { outputSchema = "strict", onOutputSchemaDiagnostic, ...callOptions } = options ?? {};
  guard.assertCallable(params.name);
  const result = await callMcpTool(client, params, { ...callOptions, beforeSend: () => guard.assertCallable(params.name) });
  const diagnostic = guard.validateResult(params.name, result, outputSchema);
  if (diagnostic !== undefined) onOutputSchemaDiagnostic?.(diagnostic);
  return result;
}

/**
 * Call a tool on whichever client is live now. Tools are built from the
 * inventory of the client they were discovered on; after an idle reconnect
 * the server may offer different tools or schemas, so the call is checked
 * against the live client's own inventory instead.
 */
export async function callMcpToolOnLiveClient<C extends McpRequester>(
  discovered: McpToolCallGuard,
  live: C,
  inventoryOf: (client: C) => Promise<{ guard: McpToolCallGuard }>,
  params: McpToolCallParams,
  options?: McpGuardedCallOptions,
) {
  const { guard } = await inventoryOf(live);
  options?.signal?.throwIfAborted();
  if (guard !== discovered && guard.has(params.name) && !isDeepStrictEqual(guard.operation(params.name), discovered.operation(params.name))) {
    throw new Error("MCP tool description, schema or effects changed. Refresh the connection before using it.");
  }
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
  const revisions = new WeakMap<object, object>();
  const entries = new WeakMap<object, { pending: Promise<T>; expiresAt: number; settled:boolean; value?:T }>();
  return {
    /** Observe only a completed valid inventory. Never reads, joins or refreshes. */
    peek(client:McpCapabilitySource):T|undefined {const entry=entries.get(client);if(!revisions.has(client)||!entry||!entry.settled)return undefined;if(entry.expiresAt<=now()){entries.delete(client);return undefined;}return entry.value;},
    /** Capture the current live-client revision before an explicit foreground read. */
    publisher(client:McpCapabilitySource):(value:T)=>void {const revision=revisions.get(client);return value=>{if(!revision||revisions.get(client)!==revision)throw new Error("MCP tool inventory changed during its foreground read.");const announces=client.serverCapabilities?.tools?.listChanged===true;if(!announces&&options.ttlMs===undefined)return;entries.set(client,{pending:Promise.resolve(value),value,settled:true,expiresAt:announces?Infinity:now()+options.ttlMs!});};},
    /** Register before connect so a change during initialization is not missed. */
    watch(client: McpNotificationSource): void {
      revisions.set(client, {});
      client.onNotification(MCP_TOOL_LIST_CHANGED, () => {
        revisions.set(client, {});
        entries.delete(client);
      });
    },
    load(client: McpCapabilitySource, read: (assertCurrent: () => void) => Promise<T>, signal?: AbortSignal, fresh = false): Promise<T> {
      const revision = revisions.get(client);
      const assertCurrent = () => {
        if (revisions.get(client) !== revision) throw new Error("MCP tool inventory changed. Refresh the connection before using it.");
      };
      const load = async () => {
        const result = await read(assertCurrent);
        assertCurrent();
        return result;
      };
      if (!revision || fresh) return untilAborted(load(), signal);
      const announcesChanges = client.serverCapabilities?.tools?.listChanged === true;
      if (!announcesChanges && options.ttlMs === undefined) return untilAborted(load(), signal);
      let entry = entries.get(client);
      if (entry && entry.expiresAt <= now()) {
        entries.delete(client);
        entry = undefined;
      }
      if (!entry) {
        const loading = load();
        const created:{pending:Promise<T>;expiresAt:number;settled:boolean;value?:T} = { pending: loading, expiresAt: Number.POSITIVE_INFINITY,settled:false };
        entry = created;
        entries.set(client, created);
        loading.then(
          value => { created.value=value;created.settled=true;if (!announcesChanges) created.expiresAt = now() + options.ttlMs!; },
          () => { if (entries.get(client) === created) entries.delete(client); },
        );
      }
      return untilAborted(entry.pending, signal);
    },
    /** Drop a client's entry (it closed or is being replaced). */
    forget(client: object): void {
      revisions.set(client, {});
      entries.delete(client);
    },
  };
}
