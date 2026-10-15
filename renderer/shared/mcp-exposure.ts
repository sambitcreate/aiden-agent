/**
 * How an MCP server's tools reach the model. Shared by the desktop main
 * process, the renderer (Settings) and the Aiden CLI.
 *
 * - `auto` (default): behind codemode / tool_search when the turn has them,
 *   otherwise declared directly.
 * - `direct`: always declared directly, even in codemode turns (scripts can
 *   still call them).
 * - `hidden`: offered to no model surface. Settings can still test and sign in.
 *
 * `hiddenTools` lists raw remote tool names withheld everywhere the server's
 * other tools are offered.
 */
export const MCP_EXPOSURES = ["auto", "direct", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

export const MCP_HIDDEN_TOOLS_LIMITS = Object.freeze({ count: 512, nameChars: 256 });

interface ExposureFields {
  exposure?: unknown;
  hiddenTools?: unknown;
}

function isExposure(value: unknown): value is McpExposure {
  return typeof value === "string" && (MCP_EXPOSURES as readonly string[]).includes(value);
}

function validToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MCP_HIDDEN_TOOLS_LIMITS.nameChars &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/** Throws on an unknown exposure or a malformed, oversized or duplicated hidden-tool list. */
export function validateMcpExposureFields(server: ExposureFields): void {
  if (server.exposure !== undefined && !isExposure(server.exposure)) {
    throw new Error("MCP exposure must be auto, direct or hidden.");
  }
  if (server.hiddenTools === undefined) return;
  const list = server.hiddenTools;
  if (!Array.isArray(list) || list.length > MCP_HIDDEN_TOOLS_LIMITS.count || !list.every(validToolName)) {
    throw new Error(`Hidden MCP tools must be at most ${MCP_HIDDEN_TOOLS_LIMITS.count} tool names of 1–${MCP_HIDDEN_TOOLS_LIMITS.nameChars} characters.`);
  }
  if (new Set(list).size !== list.length) throw new Error("Hidden MCP tools must not repeat a tool name.");
}

/**
 * Normalized fields for a parsed server: `auto` and an empty list are the
 * defaults and are omitted, so untouched servers keep their stored shape.
 */
export function normalizeMcpExposureFields(server: ExposureFields): { exposure?: McpExposure; hiddenTools?: string[] } {
  validateMcpExposureFields(server);
  const exposure = server.exposure as McpExposure | undefined;
  const hiddenTools = server.hiddenTools as string[] | undefined;
  return {
    ...(exposure && exposure !== "auto" ? { exposure } : {}),
    ...(hiddenTools?.length ? { hiddenTools: [...hiddenTools] } : {}),
  };
}

export function mcpServerExposure(server: { exposure?: McpExposure }): McpExposure {
  return isExposure(server.exposure) ? server.exposure : "auto";
}

/** False when the server is switched off for the model (its tools are offered nowhere). */
export function mcpServerOffersTools(server: { exposure?: McpExposure }): boolean {
  return mcpServerExposure(server) !== "hidden";
}

export function isMcpToolHidden(server: { exposure?: McpExposure; hiddenTools?: readonly string[] }, toolName: string): boolean {
  return !mcpServerOffersTools(server) || (server.hiddenTools?.includes(toolName) ?? false);
}

/** The part of a server's remote inventory the model may be offered. */
export function mcpToolsOfferedToModel<T>(
  server: { exposure?: McpExposure; hiddenTools?: readonly string[] },
  tools: readonly T[],
  /** The raw remote tool name of an entry (default: its `name`). */
  nameOf: (tool: T) => string = (tool) => (tool as { name: string }).name,
): T[] {
  if (!mcpServerOffersTools(server)) return [];
  if (!server.hiddenTools?.length) return [...tools];
  const hidden = new Set(server.hiddenTools);
  return tools.filter((tool) => !hidden.has(nameOf(tool)));
}
