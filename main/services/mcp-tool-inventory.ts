import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, ListToolsResultSchema, ToolListChangedNotificationSchema, type CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

export const MCP_TOOL_INVENTORY_MAX_PAGES = 64;
export const MCP_TOOL_INVENTORY_MAX_TOOLS = 512;

/** Call only behind the complete-inventory guard below, not SDK per-page schema caches. */
export function callMcpTool(client: Pick<Client, "request">, params: CallToolRequest["params"], options?: RequestOptions) {
  // The public request path retains envelope validation, progress, timeout and cancellation.
  // Client.callTool additionally validates errors against the last tools/list page's schema.
  return client.request({ method: "tools/call", params }, CallToolResultSchema, options);
}

/**
 * One raw tools/list page. Client.listTools also compiles every page's output
 * schemas into the SDK's own cache, which only Client.callTool reads; callers
 * that dispatch through callMcpTool behind createMcpToolCallGuard skip it.
 */
export function listMcpToolPage(client: Pick<Client, "request">, cursor: string | undefined, options?: RequestOptions) {
  return client.request({ method: "tools/list", params: cursor === undefined ? undefined : { cursor } }, ListToolsResultSchema, options);
}

/** The SDK returns one tools/list page. Publish only a complete, bounded inventory. */
export async function listMcpToolInventory<T extends { name: string }>(options: {
  listPage(cursor: string | undefined, signal: AbortSignal): Promise<{ tools: readonly T[]; nextCursor?: string }>;
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
    if (result.nextCursor === undefined) return tools;
    if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 4096 || cursors.has(result.nextCursor)) {
      throw new Error("MCP tool inventory contains an invalid or repeated pagination cursor.");
    }
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
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
      if (!record.structuredContent) throw new Error("MCP tool has an output schema but did not return structured content.");
      if (record.structuredContent && !validate(record.structuredContent).valid) throw new Error("MCP structured content does not match the tool's output schema.");
    },
  };
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

/**
 * Reuse one tool inventory per live client, but only when the server promised
 * notifications/tools/list_changed and the client was watched before connect.
 * A change notification drops the entry; failed reads are never retained.
 * Callers still check their own lease and generation after every load.
 */
export function createMcpToolInventoryCache<T>() {
  const watched = new WeakSet<object>();
  const entries = new WeakMap<object, Promise<T>>();
  return {
    /** Register before connect so a change during initialization is not missed. */
    watch(client: Pick<Client, "setNotificationHandler">): void {
      watched.add(client);
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { entries.delete(client); });
    },
    load(client: Pick<Client, "getServerCapabilities">, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (!watched.has(client) || client.getServerCapabilities()?.tools?.listChanged !== true) return untilAborted(read(), signal);
      let pending = entries.get(client);
      if (!pending) {
        const loading = read();
        pending = loading;
        entries.set(client, loading);
        loading.catch(() => { if (entries.get(client) === loading) entries.delete(client); });
      }
      return untilAborted(pending, signal);
    },
  };
}
