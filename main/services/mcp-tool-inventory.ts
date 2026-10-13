import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, CursorSchema, ListToolsResultSchema, ToolListChangedNotificationSchema, type CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

export const MCP_TOOL_INVENTORY_MAX_PAGES = 64;
export const MCP_TOOL_INVENTORY_MAX_TOOLS = 512;

/**
 * Servers end a list with an absent, `null` or empty `nextCursor`; the SDK's
 * strict page schemas reject the latter two after the request already ran.
 */
export const LenientCursorSchema = CursorSchema.nullish();

/** MCP 2026-07-28 permits any JSON value (array, null, primitive) as structured output. */
const LenientCallToolResultSchema = CallToolResultSchema.omit({ structuredContent: true });
const LenientListToolsResultSchema = ListToolsResultSchema.extend({ nextCursor: LenientCursorSchema });

/** End of a paginated list: absent, `null`, or the empty string. */
export function mcpListCursor(value: unknown): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : value as string;
}

/** Call only behind the complete-inventory guard below, not SDK per-page schema caches. */
export function callMcpTool(client: Pick<Client, "request">, params: CallToolRequest["params"], options?: RequestOptions) {
  // The public request path retains envelope validation, progress, timeout and cancellation.
  // Client.callTool additionally validates errors against the last tools/list page's schema.
  // The lenient schema keeps content/isError validation but leaves structuredContent
  // as received (a loose-object passthrough), so a tool that already ran is not
  // reported as failed for returning a non-object JSON value.
  return client.request({ method: "tools/call", params }, LenientCallToolResultSchema, options);
}

/**
 * One raw tools/list page. Client.listTools also compiles every page's output
 * schemas into the SDK's own cache, which only Client.callTool reads; callers
 * that dispatch through callMcpTool behind createMcpToolCallGuard skip it.
 */
export function listMcpToolPage(client: Pick<Client, "request">, cursor: string | undefined, options?: RequestOptions) {
  return client.request({ method: "tools/list", params: cursor === undefined ? undefined : { cursor } }, LenientListToolsResultSchema, options);
}

/**
 * Page reader for discovery: every page carries its own deadline (and total
 * cap) instead of the SDK's 60 s default, so one stalled page cannot hold a
 * whole server's discovery budget.
 */
export function boundedMcpToolPageReader(client: Pick<Client, "request">, pageTimeoutMs: number) {
  return (cursor: string | undefined, signal: AbortSignal) =>
    listMcpToolPage(client, cursor, { signal, timeout: pageTimeoutMs, maxTotalTimeout: pageTimeoutMs });
}

/** The SDK returns one tools/list page. Publish only a complete, bounded inventory. */
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

/**
 * SDK listTools replaces its cache per page; retain complete call contracts separately.
 *
 * Output schemas compile on first use, before dispatch, and anonymous schemas
 * share one Ajv. A schema that declares `$id` gets its own Ajv: Ajv registers
 * ids per instance, so unrelated tools reusing an id would otherwise collide.
 */
export function createMcpToolCallGuard(tools: readonly { name: string; outputSchema?: unknown; execution?: unknown }[]) {
  const names = new Set(tools.map(({ name }) => name));
  const schemas = new Map<string, JsonSchemaType>();
  const validators = new Map<string, JsonSchemaValidator<unknown>>();
  const requiredTasks = new Set<string>();
  let shared: AjvJsonSchemaValidator | undefined;
  for (const tool of tools) {
    if (tool.execution && typeof tool.execution === "object" &&
        (tool.execution as { taskSupport?: unknown }).taskSupport === "required") requiredTasks.add(tool.name);
    if (tool.outputSchema !== undefined) {
      if (!tool.outputSchema || typeof tool.outputSchema !== "object" || Array.isArray(tool.outputSchema)) throw new Error("Invalid MCP tool output schema.");
      schemas.set(tool.name, tool.outputSchema as JsonSchemaType);
    }
  }
  const validatorFor = (name: string): JsonSchemaValidator<unknown> | undefined => {
    const compiled = validators.get(name);
    if (compiled) return compiled;
    const schema = schemas.get(name);
    if (!schema) return undefined;
    const provider = declaresSchemaId(schema) ? new AjvJsonSchemaValidator() : (shared ??= new AjvJsonSchemaValidator());
    let validator: JsonSchemaValidator<unknown>;
    try { validator = provider.getValidator(schema); }
    catch { throw new Error("This MCP tool's output schema could not be compiled."); }
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
      if (!validate(record.structuredContent).valid) throw new Error("MCP structured content does not match the tool's output schema.");
    },
  };
}

export type McpToolCallGuard = ReturnType<typeof createMcpToolCallGuard>;

/** Guarded dispatch: the call must belong to the inventory of the client carrying it. */
export async function guardedMcpToolCall(
  guard: McpToolCallGuard,
  client: Pick<Client, "request">,
  params: CallToolRequest["params"],
  options?: RequestOptions,
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
export async function callMcpToolOnLiveClient<C extends Pick<Client, "request">>(
  discovered: { client: C; guard: McpToolCallGuard },
  live: C,
  inventoryOf: (client: C) => Promise<{ guard: McpToolCallGuard }>,
  params: CallToolRequest["params"],
  options?: RequestOptions,
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
    watch(client: Pick<Client, "setNotificationHandler">): void {
      watched.add(client);
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { entries.delete(client); });
    },
    load(client: Pick<Client, "getServerCapabilities">, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (!watched.has(client)) return untilAborted(read(), signal);
      const announcesChanges = client.getServerCapabilities()?.tools?.listChanged === true;
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
