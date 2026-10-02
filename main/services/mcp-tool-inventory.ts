import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";

export const MCP_TOOL_INVENTORY_MAX_PAGES = 64;
export const MCP_TOOL_INVENTORY_MAX_TOOLS = 512;

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

/** SDK listTools replaces its cache per page; retain complete call contracts separately. */
export function createMcpToolCallGuard(tools: readonly { name: string; outputSchema?: unknown; execution?: unknown }[]) {
  const validators = new Map<string, JsonSchemaValidator<unknown>>();
  const requiredTasks = new Set<string>();
  for (const tool of tools) {
    if (tool.execution && typeof tool.execution === "object" &&
        (tool.execution as { taskSupport?: unknown }).taskSupport === "required") requiredTasks.add(tool.name);
    if (tool.outputSchema !== undefined) {
      if (!tool.outputSchema || typeof tool.outputSchema !== "object" || Array.isArray(tool.outputSchema)) throw new Error("Invalid MCP tool output schema.");
      // Separate providers also prevent schema $id collisions between unrelated tools.
      validators.set(tool.name, new AjvJsonSchemaValidator().getValidator(tool.outputSchema as JsonSchemaType));
    }
  }
  return {
    assertCallable(name: string): void {
      if (requiredTasks.has(name)) throw new Error("This MCP tool requires unsupported task-based execution.");
    },
    validateResult(name: string, result: unknown): void {
      const validate = validators.get(name);
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
